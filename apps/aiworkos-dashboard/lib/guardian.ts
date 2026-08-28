// OS Guardian（第1弾・可視化のみ）。
//
// ■ 何のためか
// これまで見えていたのは「最後に動いた」だけだった。/status の「サービス稼働状況」は
// service_health の last_ok_at しか持たないため、走って落ちたのか、そもそも走らなかったのか、
// 画面からは区別がつかない。job_heartbeats は成功と失敗を別の列に持っているので、
// 「最後に正常成功したか」まで言い切れる。ここはその判定だけをする。
//
// ■ やらないこと
// 自動修復・通知・リトライは持たない（第1弾は可視化に限る）。
// 新しいテーブルも閾値も作らない。閾値は lib/advisor/watchlist.ts の WATCHED_JOBS が唯一の正で、
// 朝のPush通知（/api/cron/daily-todo）とホームの「今朝の気づき」（/api/advisor）が
// 同じ値を見ている。ここで別の数字を持つと、画面と通知で言い分が食い違う。
//
// ■ データの読み方でひとつ注意
// last_exit_code / fail_note は「最後の実行」ではなく「最後の失敗」に紐づく
// （SQL関数 record_job_heartbeats が失敗イベントのときだけ書き、成功では触らない）。
// 実際 claude-usage は last_ok_at が last_fail_at より新しいのに last_exit_code=1 のまま。
// そのため exit コードは「いま失敗している」ときだけ出す。最新の実行が成功しているのに
// exit 1 と併記すると、直っているものを落ちているように見せてしまう。

import { WATCHED_JOBS } from "./advisor/watchlist";

/**
 * ジョブの状態。
 *
 * 「基準なし」は推測を避けるために要る。job_heartbeats には打刻しているが
 * WATCHED_JOBS に載っていないジョブ（＝何時間止まったら異常とみなすかが
 * どこにも定義されていないジョブ）があり、それを勝手に48時間などとみなして
 * 「正常」「警告」と言い切ると、根拠の無い判定になる。
 * 成功しているのは事実として出し、期限の判定だけを保留する。
 */
export type GuardianState = "正常" | "警告" | "異常" | "未実行" | "基準なし";

export type GuardianRow = {
  job: string;
  label: string;
  /** 最終実行時刻。成功と失敗の新しいほう。 */
  last_run_at: string | null;
  /** 最終成功時刻。 */
  last_ok_at: string | null;
  /** 最終失敗時刻。 */
  last_fail_at: string | null;
  /** 最終結果。最後の実行が成功だったか失敗だったか。一度も走っていなければ null。 */
  last_result: "成功" | "失敗" | null;
  /**
   * 最後の失敗の終了コード。last_result が「失敗」のときだけ入れる。
   * （この列は最後の失敗に紐づくため、成功しているジョブに併記すると嘘になる）
   */
  last_exit_code: number | null;
  state: GuardianState;
  /** その状態だと判断した理由。データから言えることだけを書く。 */
  reason: string;
  /** 何時間の途絶で警告にするか。定義が無ければ null。 */
  stale_hours: number | null;
  /** WATCHED_JOBS に載っている（＝朝の通知の対象）か。 */
  watched: boolean;
};

export type HeartbeatRow = {
  job: string;
  last_ok_at: string | null;
  last_fail_at: string | null;
  last_exit_code: number | null;
};

/** job_heartbeats から取る列。 */
export const GUARDIAN_SELECT = "job,last_ok_at,last_fail_at,last_exit_code";

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 経過時間を「3時間前」「2日前」のように。 */
function ago(iso: string, now: Date): string {
  const hours = Math.floor((now.getTime() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return "1時間以内";
  if (hours < 48) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

/**
 * 1ジョブぶんの状態を出す。
 *
 * 判定はこの順で、既存データから言えることだけを使う。
 *   ① 成功も失敗も無い       → 未実行
 *   ② 失敗が成功より新しい   → 異常（走って落ちて、まだ復旧していない）
 *   ③ 閾値が無い             → 基準なし（成功しているのは事実だが、期限を判断できない）
 *   ④ 成功が閾値より古い     → 警告
 *   ⑤ それ以外               → 正常
 *
 * ★失敗を「未実行」や「正常」に見せないこと。②を①③④⑤より先に置いているのはそのため。
 */
export function judgeGuardian(
  def: { job: string; label: string; staleHours: number | null },
  row: HeartbeatRow | undefined,
  now: Date
): GuardianRow {
  const okAt = row?.last_ok_at ?? null;
  const failAt = row?.last_fail_at ?? null;
  const okMs = ms(okAt);
  const failMs = ms(failAt);

  const base = {
    job: def.job,
    label: def.label,
    last_ok_at: okAt,
    last_fail_at: failAt,
    stale_hours: def.staleHours,
    watched: def.staleHours !== null,
  };

  // ① 一度も打刻が無い
  if (okMs === null && failMs === null) {
    return {
      ...base,
      last_run_at: null,
      last_result: null,
      last_exit_code: null,
      state: "未実行",
      reason: "成功・失敗のどちらの記録もありません",
    };
  }

  const failedAfterOk = failMs !== null && (okMs === null || failMs > okMs);
  const lastRunAt = failedAfterOk ? failAt : okAt;

  // ② 走って落ちて、まだ成功していない
  if (failedAfterOk && failAt) {
    const code = row?.last_exit_code ?? null;
    return {
      ...base,
      last_run_at: lastRunAt,
      last_result: "失敗",
      last_exit_code: code,
      state: "異常",
      reason: okAt
        ? `${ago(failAt, now)}に${code === null ? "失敗" : `exit ${code}`}。最後の成功はその前（${ago(okAt, now)}）`
        : `${ago(failAt, now)}に${code === null ? "失敗" : `exit ${code}`}。まだ一度も成功していません`,
    };
  }

  // ここから先は「最後の実行は成功」。
  const hours = okAt ? Math.floor((now.getTime() - new Date(okAt).getTime()) / 3_600_000) : 0;

  // ③ 閾値が定義されていない
  if (def.staleHours === null) {
    return {
      ...base,
      last_run_at: lastRunAt,
      last_result: "成功",
      last_exit_code: null,
      state: "基準なし",
      reason: `最後の実行は成功（${okAt ? ago(okAt, now) : "—"}）。監視対象に登録されておらず、途絶の基準がありません`,
    };
  }

  // ④ 成功しているが古い
  if (hours >= def.staleHours) {
    return {
      ...base,
      last_run_at: lastRunAt,
      last_result: "成功",
      last_exit_code: null,
      state: "警告",
      reason: `最後の成功から${hours}時間（基準 ${def.staleHours}時間）。走っていない可能性があります`,
    };
  }

  // ⑤ 正常
  return {
    ...base,
    last_run_at: lastRunAt,
    last_result: "成功",
    last_exit_code: null,
    state: "正常",
    reason: `${okAt ? ago(okAt, now) : "—"}に成功（基準 ${def.staleHours}時間以内）`,
  };
}

/**
 * 心拍の行を状態の一覧にする。
 *
 * 対象は「WATCHED_JOBS に載っているもの」＋「載っていないが打刻があるもの」の和集合。
 * 前者は行が無くても未実行として必ず出す（登録したのに一度も動いていないジョブを
 * 一覧から消してしまうと、いちばん気づきたい状態が見えなくなる）。
 * 後者を混ぜるのは、打刻しているのに誰も見ていないジョブの存在自体を隠さないため。
 */
export function buildGuardianRows(beats: HeartbeatRow[], now: Date): GuardianRow[] {
  const byJob = new Map(beats.map((b) => [b.job, b]));

  const defs: Array<{ job: string; label: string; staleHours: number | null }> = WATCHED_JOBS.map(
    (w) => ({ job: w.job, label: w.label, staleHours: w.staleHours })
  );
  const known = new Set(defs.map((d) => d.job));
  for (const b of beats) {
    if (known.has(b.job)) continue;
    // ラベルが無いジョブはジョブ名をそのまま見出しにする（勝手な名前を付けない）。
    defs.push({ job: b.job, label: b.job, staleHours: null });
  }

  const rows = defs.map((d) => judgeGuardian(d, byJob.get(d.job), now));

  // 気づきたい順に並べる。異常 → 警告 → 未実行 → 基準なし → 正常。
  // 同じ状態なら最終実行が古いものを上に（放置されているものほど上に来る）。
  const order: Record<GuardianState, number> = {
    異常: 0,
    警告: 1,
    未実行: 2,
    基準なし: 3,
    正常: 4,
  };
  return rows.sort((a, b) => {
    const d = order[a.state] - order[b.state];
    if (d !== 0) return d;
    const am = ms(a.last_run_at) ?? 0;
    const bm = ms(b.last_run_at) ?? 0;
    return am - bm;
  });
}

/** 状態ごとの件数。画面の見出しに出す。 */
export function summarize(rows: GuardianRow[]): Record<GuardianState, number> {
  const out: Record<GuardianState, number> = {
    正常: 0,
    警告: 0,
    異常: 0,
    未実行: 0,
    基準なし: 0,
  };
  for (const r of rows) out[r.state] += 1;
  return out;
}

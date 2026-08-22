// 「何を、何日止まったら止まっているとみなすか」の一覧。
//
// ここが唯一の正。朝のPush通知（/api/cron/daily-todo）と、ホームの
// 「今朝の気づき」（/api/advisor）の両方がここを読む。閾値が2か所にあると、
// 片方だけ直して食い違い、どちらの言い分が正しいのか分からなくなる。
//
// 閾値はその仕組みの自然な間隔に合わせる。鳴りっぱなしになると通知そのものを
// 無視するようになり、本当に止まった時に気づけなくなる——それがいちばん怖い。

import { hoursSince } from "./types";

/** launchd で回している定期実行ジョブの心拍。 */
export const WATCHED_JOBS: Array<{ job: string; label: string; staleHours: number }> = [
  // Mac上のジョブはMacを閉じている間は打刻できない。週末に閉じっぱなしでも
  // 誤報しないよう毎日のジョブは48時間まで待つ（Macを開けば次の実行で消える）。
  { job: "nippo-aggregate", label: "日報録の自動集計", staleHours: 48 },
  { job: "notion-sync", label: "Notion→Supabaseの同期", staleHours: 48 },
  { job: "giji", label: "議事エージェント", staleHours: 48 },
  { job: "tanaoroshi", label: "日次営業インテリジェンス", staleHours: 48 },
  // 進捗は2026-08-04にlaunchd登録。止まると盤面が古いまま固まるが、
  // カード自体は「最終取得 MM/DD」と出して古い値を隠さないので、
  // 通知と画面の二重で気づける。
  { job: "shinchoku", label: "進捗エージェント（セッションの盤面）", staleHours: 48 },
  // 盤面だけを更新する軽い実行（2時間おき）。Macを開いている間しか走らないので、
  // 週末に閉じっぱなしでも誤報しないよう36時間まで待つ。本編（22:30）が止まっても
  // こちらが生きていれば画面は今日の状態を保てるので、別々に見る意味がある。
  { job: "shinchoku-board", label: "盤面の随時更新", staleHours: 36 },
  // 週次バックアップは1回飛ばしたら気づきたいので8日。
  { job: "aiworkos-backup", label: "週次バックアップ", staleHours: 24 * 8 },
  // AI基盤のgitバックアップも週次。2026-08-17にlaunchdの週次発火自体が
  // 飛んだ（Macがスリープ/DarkWakeのままで起きず、GUIのLaunchAgentが
  // 発火する隙が無かった）のに、aiworkos-backupと違いここが監視対象に
  // 入っておらず誰も気づけなかった（2026-08-19判明）。同じ8日閾値で追加する。
  { job: "ai-git-backup", label: "AI基盤の週次gitバックアップ", staleHours: 24 * 8 },
  { job: "ramen-x-followers", label: "ラーメンXのフォロワー記録", staleHours: 48 },
  // X監視ダイジェスト（毎朝6時）。/news の右カラムの中身。止まると右カラムが
  // 古い日付のまま固まるが、カード側が「取得 M/D HH:MM」を出すので画面でも気づける。
  { job: "x-digest", label: "X監視ダイジェストの収集", staleHours: 48 },
];

/**
 * 「走ったが落ちた」を何時間以内なら「たった今落ちた」として扱うか。
 *
 * staleHours（48時間）とは別に持つ。48時間の鈍さは「Macが閉じていて走らなかった」
 * ときに誤報しないためのもので、走って落ちたと分かっているものにまで効かせる理由が無い。
 * 実測（2026-08-02夜〜）では棚卸と議事が2晩連続で exit 1 のまま落ちていたのに、
 * 経過が32時間で48時間に届かず、丸3日近く誰にも知らされなかった。
 *
 * これは「出すか出さないか」の線ではなく、言い方を変える線。失敗は次に成功するまで
 * 出し続ける（下の judgeJob を参照）。ここで打ち切ると、失敗から24時間〜成功から48時間の
 * 間に誰も何も言わない谷ができてしまい、直そうとした穴がそのまま残る。
 */
export const JOB_FAILED_ALERT_HOURS = 24;

/** job_heartbeats から取る列。2か所の select がずれないようにここで持つ。 */
export const JOB_HEARTBEAT_SELECT = "job,last_ok_at,last_fail_at,last_exit_code";

export type JobHeartbeat = {
  job: string;
  last_ok_at: string | null;
  last_fail_at: string | null;
  last_exit_code: number | null;
};

export type JobVerdict = {
  job: string;
  /** failed = 走ったが落ちた / stale = 打刻が途絶えた（走らなかった可能性を含む） */
  kind: "failed" | "stale";
  /** 朝のPush通知に入れる一行。 */
  push: string;
  /** ホームのカードの見出し。 */
  title: string;
  /** カードに出す根拠。日付と数字で言い切れることだけ。 */
  facts: string[];
};

/** UTCのタイムスタンプを日本時間の「MM/DD HH:MM」にする（落ちた時刻は体感と合わせたい）。 */
function jstStamp(iso: string): string {
  const t = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000).toISOString();
  return `${Number(t.slice(5, 7))}/${Number(t.slice(8, 10))} ${t.slice(11, 16)}`;
}

/**
 * 1ジョブぶんの判定。ここが唯一の正。
 * 朝のPush通知（/api/cron/daily-todo）とホームのカード（/api/advisor）の両方が呼ぶ。
 * 同じ判定を2か所に書くと、片方だけ直したときに言い分が食い違う。
 *
 * 規則は2段。
 *   ① last_fail_at が last_ok_at より新しいなら、staleHours を待たずに alert。
 *      「走ったが落ちた」ことがログではなくデータで分かっている状態なので、待つ理由が無い。
 *      これは次に成功するまで出し続ける。誤報を避けるための鈍さ（②）は「打刻が無い」
 *      という消極的な事実に対するもので、落ちたという積極的な事実には要らない。
 *      JOB_FAILED_ALERT_HOURS を過ぎたものは言い方だけ変える（「たった今落ちた」→
 *      「落ちたまま復旧していない」）。出すのをやめると、失敗から24時間〜成功から
 *      48時間の間に何も言わない谷ができ、直そうとした穴が残ってしまう。
 *   ② それ以外は従来どおり last_ok_at の途絶（staleHours）だけを見る。
 *      打刻が無いのはMacを閉じていただけかもしれないので、鈍いままでよい。
 * 行が無いジョブ・一度も成功していないジョブは黙る（動いていたものが止まった時だけ言う）。
 */
export function judgeJob(
  w: { job: string; label: string; staleHours: number },
  row: JobHeartbeat | undefined,
  now: Date
): JobVerdict | null {
  if (!row) return null;

  const failedAfterOk =
    row.last_fail_at !== null &&
    (row.last_ok_at === null ||
      new Date(row.last_fail_at).getTime() > new Date(row.last_ok_at).getTime());

  if (failedAfterOk && row.last_fail_at) {
    const failHours = hoursSince(row.last_fail_at, now);
    const fresh = failHours < JOB_FAILED_ALERT_HOURS;
    const code = row.last_exit_code;
    const codeText = code === null ? "エラー" : `exit ${code}`;
    const elapsed = fresh ? `${failHours}時間前` : `${Math.floor(failHours / 24)}日前`;
    return {
      job: w.job,
      kind: "failed",
      push: fresh
        ? `${w.label}が失敗しています（${codeText}）`
        : `${w.label}が${Math.floor(failHours / 24)}日、失敗したままです（${codeText}）`,
      title: fresh ? `${w.label}が失敗しています` : `${w.label}が失敗したままです`,
      facts: [
        `${jstStamp(row.last_fail_at)} に ${codeText} で落ちました（${elapsed}）`,
        row.last_ok_at
          ? `最後に成功したのは ${jstStamp(row.last_ok_at)}`
          : "まだ一度も成功していません",
        `走って落ちた場合は、次に成功するまで出し続けます（走らなかっただけの場合の${w.staleHours}時間とは別の規則です）`,
      ],
    };
  }

  if (!row.last_ok_at) return null;

  const hours = hoursSince(row.last_ok_at, now);
  if (hours < w.staleHours) return null;

  return {
    job: w.job,
    kind: "stale",
    push: `${w.label}が${Math.floor(hours / 24)}日止まっています`,
    title: `${w.label}が止まっています`,
    facts: [
      `最後に成功したのは ${row.last_ok_at.slice(0, 16).replace("T", " ")}（${Math.floor(hours / 24)}日前）`,
      `${w.staleHours}時間を超えたら出すようにしています`,
    ],
  };
}

/**
 * Claudeのスケジュールタスク側。job_heartbeats を打てないので、
 * 各タスクが自分で更新する service_health を見る。
 *
 * notify: 朝のPush通知に含めるか。
 *   eight（人脈DBの取込）は月1回の手動運用なので、毎朝鳴らすと邪魔になる。
 *   ただし「6日半止まっている」ことに自分では気づけないため、
 *   ホームのカードには7日で出す（2026-08-03 吉井さんと相談して決めた）。
 */
export const WATCHED_SERVICES: Array<{
  service: string;
  label: string;
  staleDays: number;
  notify: boolean;
}> = [
  { service: "plaud", label: "PLAUD会議の自動登録", staleDays: 3, notify: true },
  { service: "news", label: "ニュース取得", staleDays: 3, notify: true },
  { service: "notion", label: "Notionの記憶同期", staleDays: 3, notify: true },
  { service: "eight", label: "Eightの取込", staleDays: 7, notify: false },
];

/** 一行日記が何日ぶん入っていなければ滞りとみなすか。 */
export const DIARY_STALE_THRESHOLD_DAYS = 3;

/** 健康データが何日ぶん入っていなければ滞りとみなすか。 */
export const HEALTH_STALE_THRESHOLD_DAYS = 3;

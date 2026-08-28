"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ORG_CATEGORIES, normalizeOrgCategory, type OrgCategory } from "@/lib/categories";
import {
  MUNICIPALITY_SUBCATEGORIES,
  municipalitySubcategory,
} from "@/lib/municipalities";
import type { GuardianRow, GuardianState } from "@/lib/guardian";
import type { AuditResult } from "@/lib/memoryAudit";

// レイアウト方針（2026-07-30 吉井さん指摘「縦に長すぎる」への対応）:
//   - スマホ(既定)は1カラムのまま。lg以上で2カラムに段組みし、横幅の余りを使う。
//   - 監視の主役（稼働状況・記憶の成長・次に攻める団体・取込ジョブ）は開いたまま、
//     参照用の一覧（提案・ニュース・団体別記憶・Notion）は折りたたみを既定にする。
//   - 文字サイズは rem / Tailwindのクラスのみ（px直指定はPCで拡大されないため禁止）。

// ── 型定義 ────────────────────────────────────────────────
type ByType = {
  type: string;
  count: number;
  last: string | null;
  d1: number; // 直近24時間の増加
  d7: number; // 直近7日の増加
};
type ByOrg = { org: string; count: number };
type Daily = { d: string; count: number };
type JobSummary = { status: string; count: number };
type JobRecent = {
  id: string;
  kind: string;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};
type RefineRecent = {
  id: string;
  organization: string;
  title: string | null;
  updated_at: string;
  msgs: number;
};
type Proposal = {
  organization: string;
  edited: boolean;
  created_at: string;
  updated_at: string;
};
type NewsTheme = {
  theme: string;
  category: string | null;
  count: number;
  last_fetch: string | null;
  last_pub: string | null;
};
type Stakeholder = { category: string; count: number };
type Service = {
  service: string;
  label: string;
  last_ok_at: string | null;
  note: string | null;
};
type OrgStatus = {
  name: string;
  meetings: number;
  last_meeting: string | null;
  has_proposal: boolean;
  has_refine: boolean;
  // /api/status が stakeholders / weekly_reports から突合して付ける正準8分類。
  // 突合できなかった団体は "その他"（APIが必ず入れるが、古いキャッシュ対策で optional）。
  category?: string;
  // Notion「顧客CRM」のページID。/api/status が突合して付ける。
  // null＝顧客CRMに未登録（会議記録だけがある団体）。この場合は
  // 更新すべきNotionページが存在しないので「対象外にする」を出さない。
  notion_page_id?: string | null;
  // 顧客CRM側の団体名。法人格の有無で行の表示名と食い違うことがあるため、
  // 確認時に「どのページのステータスを変えるのか」を正直に見せる用。
  crm_name?: string | null;
  // 会派の並び順（dashboard_stats が返す）。議員以外は99。
  party_rank?: number;
};

// 優先順位（★1〜3）。ホームの「次に攻める相手」と同じ org_priority を読む。
// 順位を決めるのはこの画面（全団体が見える）で、ホームはその結果を上位だけ映す。
type StarMap = Record<string, number>;

// 対象外にした団体（GET /api/status/exclude）。
type ExcludedOrg = { notion_page_id: string; name: string; category: string | null };
type NewsRecent = {
  title: string;
  theme: string;
  pub_date: string | null;
  link: string;
};

type Stats = {
  generated_at: string;
  memory_total: number;
  memory_last24h: number;
  memory_last7d: number;
  db_size_mb: number;
  memory_by_type: ByType[];
  memory_by_org: ByOrg[];
  memory_daily: Daily[];
  jobs_summary: JobSummary[];
  jobs_recent: JobRecent[];
  services: Service[];
  org_status: OrgStatus[];
  news_recent: NewsRecent[];
  proposal_last7d: number;
  refine_sessions: number;
  refine_messages: number;
  refine_last7d: number;
  refine_recent: RefineRecent[];
  proposals: Proposal[];
  learning_total: number;
  news_by_theme: NewsTheme[];
  stakeholders: Stakeholder[];
};

type NotionDb = {
  key: string;
  label: string;
  ok: boolean;
  error?: string;
  last_edited?: string | null;
  recent?: { last_edited?: string; title: string }[];
};
type NotionState = { connected: boolean; dbs: NotionDb[] };

type ApiResponse = {
  ok: boolean;
  error?: string;
  stats?: Stats;
  notion?: NotionState;
};

// ── 表示ヘルパ ────────────────────────────────────────────
const TYPE_STYLE: Record<string, string> = {
  成果物: "bg-purple-100 text-purple-800",
  日記: "bg-emerald-100 text-emerald-800",
  会議: "bg-blue-100 text-blue-800",
  学び: "bg-orange-100 text-orange-800",
  学会: "bg-rose-100 text-rose-800",
};
const JOB_STATUS: Record<string, { label: string; style: string }> = {
  queued: { label: "待機中", style: "bg-gray-100 text-gray-600" },
  running: { label: "実行中", style: "bg-blue-100 text-blue-700" },
  done: { label: "完了", style: "bg-emerald-100 text-emerald-800" },
  error: { label: "エラー", style: "bg-rose-100 text-rose-700" },
};
const KIND_LABEL: Record<string, string> = {
  eight: "Eight",
  plaud: "PLAUD",
  slides: "スライド清書",
  proposal: "提案書",
};

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / 3600000;
}
function agoLabel(iso: string | null | undefined): string {
  const h = hoursSince(iso);
  if (h === null) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}分前`;
  if (h < 24) return `${Math.round(h)}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

// 要対応の異常だけを集める（平常時は空 → ストリップは出さない）
function computeAlerts(data: ApiResponse | null, stats: Stats | undefined): string[] {
  const alerts: string[] = [];
  if (data && data.ok === false) {
    alerts.push("Supabaseに接続できません");
    return alerts;
  }
  if (!stats) return alerts;
  const stuck = stats.jobs_recent.filter((j) => {
    if (j.status === "queued" || j.status === "running") {
      const h = hoursSince(j.updated_at);
      return h !== null && h > 6;
    }
    return false;
  });
  if (stuck.length > 0) alerts.push(`取込ジョブ ${stuck.length}件が停滞`);
  const staleServices = stats.services.filter((s) => {
    const h = hoursSince(s.last_ok_at);
    return h !== null && h > 72; // 未実行(null)は除外。稼働していたのに72h止まったものだけ
  });
  if (staleServices.length > 0) {
    alerts.push(`${staleServices.map((s) => s.label).join("・")} が停滞`);
  }
  return alerts;
}

// ── 小物コンポーネント ────────────────────────────────────
// グリッドの1マスぶんのセクション。span で2カラムぶち抜き、fold で折りたたみにできる。
function Section({
  title,
  hint,
  children,
  span,
  fold,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  span?: boolean;
  /** true=折りたたみ可（既定で閉じる）。監視の主役ではない参照用の一覧に使う */
  fold?: boolean;
}) {
  const spanClass = span ? "lg:col-span-2" : "";
  const card = (
    <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
      {children}
    </div>
  );

  if (!fold) {
    return (
      <section className={spanClass}>
        <div className="mb-1.5 flex items-baseline justify-between gap-2 px-1">
          <h2 className="text-sm font-semibold text-gray-500">{title}</h2>
          {hint && <span className="text-xs text-gray-400">{hint}</span>}
        </div>
        {card}
      </section>
    );
  }

  return (
    <details className={`group ${spanClass}`}>
      <summary className="mb-1.5 flex cursor-pointer list-none items-baseline gap-2 px-1 [&::-webkit-details-marker]:hidden">
        <span className="text-xs text-gray-400 transition group-open:rotate-90" aria-hidden>
          ▶
        </span>
        <h2 className="text-sm font-semibold text-gray-500">{title}</h2>
        {hint && <span className="ml-auto text-xs text-gray-400">{hint}</span>}
      </summary>
      {card}
    </details>
  );
}

// ── メイン ────────────────────────────────────────────────
export default function StatusPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  // 裏の自動更新が失敗している間だけ立てる。dataは前回取得のまま保持する
  // （エラーオブジェクトで差し替えると、1回の失敗で画面全体が消えるため）。
  const [staleWarn, setStaleWarn] = useState(false);
  // OS Guardian（ジョブの成否）。/api/status とは別に取る。
  // dashboard_stats が落ちても、ジョブの状態だけは見えていてほしいため。
  const [guardian, setGuardian] = useState<{
    rows: GuardianRow[];
    checked_at: string;
  } | null>(null);
  const [guardianError, setGuardianError] = useState<string | null>(null);
  // 記憶の健康診断。これも /api/status とは別に取る。
  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);

  // silent=true は自動更新用（ボタンの「更新中」表示を出さず裏で差し替える）
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const json = (await res.json()) as ApiResponse;
      setData(json);
      setFetchedAt(new Date());
      setStaleWarn(false);
    } catch {
      if (silent) {
        // 表示は前回取得のものを保持し、注意書きだけ添える
        setStaleWarn(true);
      } else {
        setData({ ok: false, error: "通信エラーが発生しました" });
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadGuardian = useCallback(async () => {
    try {
      const res = await fetch("/api/guardian", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `取得失敗 ${res.status}`);
      setGuardian(json);
      setGuardianError(null);
    } catch (e) {
      // ★空配列を入れて「ジョブが0本」に見せない。監視が読めないことを表に出す。
      setGuardianError(e instanceof Error ? e.message : "ジョブの状態を取得できませんでした");
      setGuardian(null);
    }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const res = await fetch("/api/memory-audit", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `取得失敗 ${res.status}`);
      setAudit(json);
      setAuditError(null);
    } catch (e) {
      // ★空データを入れて「不整合ゼロ」に見せない。
      setAuditError(e instanceof Error ? e.message : "記憶の監査データを取得できませんでした");
      setAudit(null);
    }
  }, []);

  useEffect(() => {
    load();
    void loadGuardian();
    void loadAudit();
    // 60秒ごとに裏で自動更新。開きっぱなしでも鮮度を保つ。
    const timer = setInterval(() => {
      load(true);
      void loadGuardian();
    }, 60000);
    // タブに戻った瞬間にも更新（スリープ復帰・アプリ切替後の古い表示を防ぐ）
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        load(true);
        void loadGuardian();
        // 記憶の健康診断は全件を走査するので60秒ごとには回さない。
        // タブに戻ってきたときだけ取り直す（中身は日単位でしか変わらない）。
        void loadAudit();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, loadGuardian, loadAudit]);

  const stats = data?.stats;
  const healthy = data?.ok === true && !!stats;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))] lg:max-w-6xl">
      <header className="mb-4">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <div className="mt-2 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">
              連携ダッシュボード
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              記憶がどれだけ育ったか・連携が動いているかを一目で確認
            </p>
          </div>
          <button
            type="button"
            onClick={() => load()}
            disabled={loading}
            className="shrink-0 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition active:bg-indigo-700 disabled:opacity-40"
          >
            {loading ? "更新中" : "更新"}
          </button>
        </div>
      </header>

      {/* 要対応ストリップ（異常がある時だけ出る） */}
      {(() => {
        const alerts = computeAlerts(data, stats);
        if (alerts.length === 0) return null;
        return (
          <div className="mb-4 rounded-2xl border border-rose-300 bg-rose-50 p-4 shadow-sm">
            <p className="text-sm font-bold text-rose-800">
              ⚠️ {alerts.length}件 要対応
            </p>
            <ul className="mt-1 space-y-0.5">
              {alerts.map((a, i) => (
                <li key={i} className="text-xs text-rose-700">
                  ・{a}
                </li>
              ))}
            </ul>
          </div>
        );
      })()}

      {/* 接続ヘルス */}
      <div
        className={`flex items-center gap-3 rounded-2xl border p-4 shadow-sm ${
          healthy
            ? "border-emerald-200 bg-emerald-50"
            : loading
              ? "border-gray-200 bg-white"
              : "border-rose-200 bg-rose-50"
        }`}
      >
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg ${
            healthy ? "bg-emerald-100" : loading ? "bg-gray-100" : "bg-rose-100"
          }`}
        >
          {healthy ? "✅" : loading ? "⏳" : "⚠️"}
        </span>
        <div className="min-w-0">
          <p className="text-base font-bold text-gray-900">
            {healthy
              ? "Supabase 接続 正常"
              : loading
                ? "接続を確認中…"
                : "Supabase 接続エラー"}
          </p>
          <p className="text-xs text-gray-500">
            {healthy
              ? `記憶 ${stats!.memory_total}件（24h +${stats!.memory_last24h}）・ DB ${stats!.db_size_mb}MB ・ 取得 ${
                  fetchedAt ? fmtDateTime(fetchedAt.toISOString()) : ""
                }`
              : data?.error ?? "…"}
          </p>
        </div>
      </div>

      {/* 自動更新の失敗中。表示は消さず、鮮度だけ正直に伝える */}
      {staleWarn && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
          更新できませんでした（表示は前回取得のもの
          {fetchedAt ? `・${fmtDateTime(fetchedAt.toISOString())}時点` : ""}）
        </p>
      )}

      {/* OS Guardian：ジョブが「最後に正常成功したか」。
          /api/status とは独立して出す。dashboard_stats が落ちている時ほど
          ジョブの状態を見たいので、道連れにしない。 */}
      <section className="mt-4">
        <div className="mb-1.5 flex items-baseline justify-between gap-2 px-1">
          <h2 className="text-sm font-semibold text-gray-500">ジョブの成否</h2>
          <span className="text-xs text-gray-400">
            {guardian ? `${guardian.rows.length}本・${fmtDateTime(guardian.checked_at)}時点` : "最後に正常成功したか"}
          </span>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
          <GuardianPanel
            rows={guardian?.rows ?? null}
            error={guardianError}
            onRetry={() => void loadGuardian()}
          />
        </div>
      </section>

      {/* 記憶の健康診断。直さず、事実だけ並べる。 */}
      <section className="mt-4">
        <div className="mb-1.5 flex items-baseline justify-between gap-2 px-1">
          <h2 className="text-sm font-semibold text-gray-500">記憶の健康診断</h2>
          <span className="text-xs text-gray-400">
            {audit ? `${audit.total}chunk${audit.truncated ? "以上" : ""}` : "重複・欠損・表記揺れ"}
          </span>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
          <MemoryAuditPanel
            audit={audit}
            error={auditError}
            onRetry={() => void loadAudit()}
          />
        </div>
      </section>

      {/* Memory 2.0 Shadow。新しい数え方を旧方式の横に並べるだけ。
          本番の検索・RAG・AI回答はまだ旧方式のまま動いている。 */}
      <section className="mt-4">
        <div className="mb-1.5 flex items-baseline justify-between gap-2 px-1">
          <h2 className="text-sm font-semibold text-gray-500">Memory 2.0 Shadow</h2>
          <span className="text-xs text-gray-400">
            {audit ? `実体${audit.shadow.canonicalDocuments}件` : "新しい数え方との比較"}
          </span>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
          <MemoryShadowPanel
            audit={audit}
            error={auditError}
            onRetry={() => void loadAudit()}
          />
        </div>
      </section>

      {loading && !stats && (
        <div className="flex flex-col items-center gap-3 py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600" />
          <p className="text-sm text-gray-500">読み込み中…</p>
        </div>
      )}

      {stats && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:items-start">
          {/* サービス稼働状況 */}
          <Section title="サービス稼働状況" hint="各連携の最終正常稼働">
            <ServicesPanel services={stats.services} />
          </Section>

          {/* 記憶の成長 */}
          <Section title="記憶の成長" hint={`合計 ${stats.memory_total} 件`}>
            {/* 今日/今週どれだけ脳が育ったか（横並びにして縦を詰める） */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="flex flex-1 items-baseline justify-center gap-1 rounded-xl bg-indigo-50 px-3 py-1.5">
                <span className="text-xl font-bold text-indigo-700">
                  +{stats.memory_last24h}
                </span>
                <span className="text-xs font-medium text-indigo-500">今日</span>
              </div>
              <div className="flex flex-1 items-baseline justify-center gap-1 rounded-xl bg-indigo-50 px-3 py-1.5">
                <span className="text-xl font-bold text-indigo-700">
                  +{stats.memory_last7d}
                </span>
                <span className="text-xs font-medium text-indigo-500">今週</span>
              </div>
              {/* 今週の動き（記憶→提案の転換） */}
              <span className="w-full text-center text-xs text-gray-500 sm:w-auto sm:flex-1">
                今週： 提案{" "}
                <span className="font-semibold text-gray-700">+{stats.proposal_last7d}</span> ・ 壁打ち{" "}
                <span className="font-semibold text-gray-700">+{stats.refine_last7d}</span>
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
              {stats.memory_by_type.map((t) => (
                <div
                  key={t.type}
                  className="rounded-xl border border-gray-100 bg-gray-50 px-2.5 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        TYPE_STYLE[t.type] ?? "bg-gray-200 text-gray-700"
                      }`}
                    >
                      {t.type}
                    </span>
                    <span className="ml-auto text-base font-bold text-gray-900">
                      {t.count}
                    </span>
                  </div>
                  {/* 成長の差分と鮮度は1行にまとめる（増えていれば緑で強調） */}
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[0.6875rem]">
                    <span
                      className={`font-semibold ${
                        t.d1 > 0 ? "text-emerald-600" : "text-gray-300"
                      }`}
                    >
                      {t.d1 > 0 ? `+${t.d1}` : "±0"}
                      <span className="font-normal text-gray-400">今日</span>
                    </span>
                    <span
                      className={`font-semibold ${
                        t.d7 > 0 ? "text-emerald-600" : "text-gray-300"
                      }`}
                    >
                      {t.d7 > 0 ? `+${t.d7}` : "±0"}
                      <span className="font-normal text-gray-400">今週</span>
                    </span>
                    <span className="ml-auto text-gray-400">{agoLabel(t.last)}</span>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* 次に攻める団体（カテゴリー別。横幅を使うので2カラムぶち抜き） */}
          <Section title="次に攻める団体" hint="カテゴリー別 ・ 提案がまだの団体を上に" span>
            <OrgPanel orgs={stats.org_status} onChanged={() => load(true)} />
          </Section>

          {/* 日次アクティビティ */}
          <Section title="登録アクティビティ" hint="直近14日">
            <DailyChart daily={stats.memory_daily} />
          </Section>

          {/* 取込ジョブ */}
          <Section title="取込ジョブ (Eight / PLAUD / スライド)" hint="状態は直近7日">
            <JobsPanel summary={stats.jobs_summary} recent={stats.jobs_recent} />
          </Section>

          {/* 壁打ち */}
          <Section
            fold
            title="壁打ち"
            hint={`${stats.refine_sessions}件${stats.refine_last7d > 0 ? `（今週 +${stats.refine_last7d}）` : ""} / ${stats.refine_messages} 発言`}
          >
            {stats.refine_recent.length === 0 ? (
              <p className="text-sm text-gray-400">まだ壁打ちの記録はありません。</p>
            ) : (
              <ul className="space-y-2">
                {stats.refine_recent.map((r) => (
                  <li
                    key={r.id}
                    className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-teal-100 px-2 py-0.5 text-xs font-semibold text-teal-800">
                        {r.organization}
                      </span>
                      <span className="ml-auto text-xs text-gray-400">
                        {r.msgs}往復 ・ {fmtDateTime(r.updated_at)}
                      </span>
                    </div>
                    {r.title && (
                      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-gray-600">
                        {r.title}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* 提案キャッシュ */}
          <Section fold title="生成済みの提案" hint={`${stats.proposals.length}件`}>
            {stats.proposals.length === 0 ? (
              <p className="text-sm text-gray-400">まだ提案はありません。</p>
            ) : (
              <ul className="space-y-2">
                {stats.proposals.map((p) => (
                  <li
                    key={p.organization}
                    className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
                  >
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
                      {p.organization}
                    </span>
                    {p.edited && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                        手直し済
                      </span>
                    )}
                    <span className="ml-auto text-xs text-gray-400">
                      {fmtDateTime(p.updated_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* 直近ニュース見出し（営業ネタ） */}
          <Section fold title="直近ニュース" hint="新しい順">
            {stats.news_recent.length === 0 ? (
              <p className="text-sm text-gray-400">ニュースはまだありません。</p>
            ) : (
              <ul className="space-y-2">
                {stats.news_recent.map((n, i) => (
                  <li key={i}>
                    <a
                      href={n.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block active:opacity-70"
                    >
                      <span className="line-clamp-2 text-sm leading-snug text-gray-700">
                        {n.title}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                        <span className="rounded bg-gray-100 px-1.5 py-0.5">{n.theme}</span>
                        {fmtDate(n.pub_date)}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* ニュース収集パイプライン */}
          <Section fold title="ニュース収集パイプライン" hint="テーマ別の鮮度">
            <NewsPanel themes={stats.news_by_theme} />
          </Section>

          {/* 団体別・ステークホルダー */}
          <Section fold title="団体別の記憶" hint={`上位${stats.memory_by_org.length}団体`}>
            <div className="flex flex-wrap gap-1.5">
              {stats.memory_by_org.map((o) => (
                <span
                  key={o.org}
                  className="rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600"
                >
                  {o.org} <span className="font-semibold text-gray-800">{o.count}</span>
                </span>
              ))}
            </div>
            {stats.stakeholders.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-gray-100 pt-3">
                {stats.stakeholders.map((s) => (
                  <span
                    key={s.category}
                    className="rounded-md bg-indigo-50 px-2 py-1 text-xs text-indigo-700"
                  >
                    {s.category} {s.count}
                  </span>
                ))}
              </div>
            )}
          </Section>

          {/* Notion 連携 */}
          <Section fold title="Notion 連携">
            <NotionPanel notion={data?.notion} />
          </Section>

          <p className="text-center text-xs text-gray-400 lg:col-span-2">
            集計時刻 {fmtDateTime(stats.generated_at)}
          </p>
        </div>
      )}

      <div className="mt-6 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
      </div>
    </main>
  );
}

// ── 日次バーチャート ──────────────────────────────────────
// 直近14日を連続で並べ、登録の無い日も0本で埋める（間隔が歪まないように）。
// 日付はRPCがUTCで集計するのでUTC基準で生成する。
function fillDaily(daily: Daily[], days = 14): Daily[] {
  const map = new Map(daily.map((d) => [d.d, d.count]));
  const now = new Date();
  const out: Daily[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)
    );
    const key = dt.toISOString().slice(0, 10);
    out.push({ d: key, count: map.get(key) ?? 0 });
  }
  return out;
}

function DailyChart({ daily }: { daily: Daily[] }) {
  const series = fillDaily(daily);
  const max = Math.max(...series.map((d) => d.count), 1);
  return (
    <div className="flex items-end gap-1" style={{ height: 120 }}>
      {series.map((d, i) => (
        <div key={d.d} className="flex flex-1 flex-col items-center justify-end gap-1">
          <span className="text-[0.6875rem] font-medium text-gray-500 tabular-nums">
            {d.count > 0 ? d.count : ""}
          </span>
          <div
            className={`w-full rounded-t ${d.count > 0 ? "bg-indigo-500" : "bg-gray-200"}`}
            style={{ height: `${d.count > 0 ? Math.max(4, (d.count / max) * 88) : 2}px` }}
            title={`${d.d}: ${d.count}件`}
          />
          {/* ラベルは3日おきに間引く（文字を大きくしたぶん、全部出すと潰れるため） */}
          <span className="h-4 whitespace-nowrap text-[0.6875rem] text-gray-400">
            {i % 3 === 0 ? d.d.slice(5) : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── 取込ジョブパネル ──────────────────────────────────────
function JobsPanel({
  summary,
  recent,
}: {
  summary: JobSummary[];
  recent: JobRecent[];
}) {
  const total = summary.reduce((a, b) => a + b.count, 0);
  const stuck = recent.filter((j) => {
    if (j.status === "queued" || j.status === "running") {
      const h = hoursSince(j.updated_at);
      return h !== null && h > 6;
    }
    return false;
  });

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {summary.length === 0 ? (
          // 集計(jobs_summary)は直近7日だけ。下の一覧はそれより古いものも出るので、
          // 「ジョブが一件も無い」と誤読されないよう期間を明示する。
          <p className="text-sm text-gray-400">直近7日のジョブはありません。</p>
        ) : (
          summary.map((s) => {
            const meta = JOB_STATUS[s.status] ?? { label: s.status, style: "bg-gray-100 text-gray-600" };
            return (
              <span
                key={s.status}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${meta.style}`}
              >
                {meta.label} {s.count}
              </span>
            );
          })
        )}
      </div>

      {stuck.length > 0 && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          ⚠️ {stuck.length}件が6時間以上「待機中／実行中」のままです。実行ワーカー（Mac）が
          止まっていないか確認してください。
        </p>
      )}

      {/* 直近ジョブは件数が読めればよいので、伸びすぎないよう枠内スクロールにする
          （段組みの相手側が短いとき、この欄だけで縦が伸びるのを防ぐ） */}
      {recent.length > 0 && (
        <ul className="mt-2 max-h-[13rem] space-y-1.5 overflow-y-auto">
          {recent.map((j) => {
            const meta = JOB_STATUS[j.status] ?? { label: j.status, style: "bg-gray-100 text-gray-600" };
            return (
              <li
                key={j.id}
                className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
              >
                <span className="text-sm font-medium text-gray-800">
                  {KIND_LABEL[j.kind] ?? j.kind}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.style}`}>
                  {meta.label}
                </span>
                <span className="ml-auto text-xs text-gray-400">
                  {fmtDateTime(j.created_at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {total > 0 && (
        <p className="mt-2 text-xs text-gray-400">
          直近{recent.length}件を表示 ・ 累計 {total} 件
        </p>
      )}
    </>
  );
}

// ── 次に攻める団体パネル ──────────────────────────────────
// 追加フォームの選択肢。RPC dashboard_stats の org_status が stakeholders から拾うのは
// この4種のみ（会議記録がある団体は種別に関わらず拾う）。ここに無い種別で登録すると
// 一覧に出ず迷子になるため、選択肢は据え置きにしている。
// ※表示側のカテゴリー分けは lib/categories.ts の正準8分類（ORG_CATEGORIES）を使う。
const ADD_CATEGORIES = ["自治体", "事業者", "銀行", "議員"] as const;

// 1団体ぶんの行。名前・状態・会議数・最終接点・次の一手を1行に畳む（縦を詰めるため）。
//
// 「対象外にする」は削除ではない。押すとNotion「顧客CRM」のステータスが「対象外」に
// なり、この一覧から外れるだけ。名刺（人脈DB）も会議記録もそのまま残る。
// 顧客CRMに未登録の団体（notion_page_id が null）は触るべきNotionページが無いので
// ボタンを出さず、押せない理由をその場に出す（操作できるように見せかけない）。
function OrgRow({
  o,
  onExclude,
  busy,
  stars,
  starBusy,
  onStar,
}: {
  o: OrgStatus;
  onExclude: (o: OrgStatus) => void;
  busy: boolean;
  stars: number;
  starBusy: boolean;
  onStar: (n: number) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [whyDisabled, setWhyDisabled] = useState(false);
  const stale = (() => {
    const h = hoursSince(o.last_meeting);
    return h !== null && h > 24 * 30; // 30日超で「間が空いている」
  })();
  // CRM側の名前が行の表示名と違うとき（法人格の有無など）は、どのページを
  // 触るのかを確認文に出す。黙って別名のページを更新しない。
  const crmName = o.crm_name && o.crm_name !== o.name ? o.crm_name : null;

  return (
    <li
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-1.5 ${
        stars >= 3
          ? "border-amber-300 bg-amber-50"
          : o.has_proposal
          ? "border-gray-100 bg-gray-50"
          : "border-rose-200 bg-rose-50"
      }`}
    >
      {/* 優先順位。ホームの「次に攻める相手」の並びがこれで決まる。
          同じ数を押すと解除。 */}
      <span className="inline-flex shrink-0 items-center">
        {[1, 2, 3].map((n) => (
          <button
            key={n}
            type="button"
            disabled={starBusy}
            onClick={() => onStar(stars === n ? 0 : n)}
            aria-label={`優先度★${n}`}
            title={stars === n ? "押すと解除" : `★${n}にする（★3が最優先）`}
            className={`px-0.5 text-sm leading-none transition active:scale-90 disabled:opacity-40 ${
              n <= stars ? "text-amber-500" : "text-gray-300"
            }`}
          >
            ★
          </button>
        ))}
      </span>
      {/* 団体名は最低7remを確保する。狭い画面では名前を潰すのではなく、
          後ろのバッジ・導線が次の行へ折り返す（「熊...」のような潰れ防止）。 */}
      <span className="min-w-[7rem] flex-1 basis-[7rem] truncate text-sm font-semibold text-gray-800">
        {o.name}
      </span>
      {o.has_proposal ? (
        <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[0.6875rem] font-medium text-emerald-700">
          提案済
        </span>
      ) : (
        <span className="shrink-0 rounded-full bg-rose-100 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-rose-700">
          提案なし
        </span>
      )}
      {o.has_refine && (
        <span className="shrink-0 rounded-full bg-teal-100 px-1.5 py-0.5 text-[0.6875rem] font-medium text-teal-700">
          壁打ち済
        </span>
      )}
      <span className="shrink-0 text-[0.6875rem] text-gray-400">会議{o.meetings}</span>
      <span
        className={`shrink-0 text-[0.6875rem] ${stale ? "text-amber-600" : "text-gray-400"}`}
        title={stale ? "最終接点から30日以上空いています" : undefined}
      >
        {fmtDate(o.last_meeting)}
        {stale ? "⚠" : ""}
      </span>
      {/* 提案がまだの団体は、その場で次の一手へ */}
      {!o.has_proposal && (
        <span className="flex shrink-0 gap-1.5 text-[0.6875rem]">
          <Link
            href={`/agent?org=${encodeURIComponent(o.name)}`}
            className="font-semibold text-indigo-600 active:opacity-70"
          >
            提案→
          </Link>
          <Link
            href={`/refine?org=${encodeURIComponent(o.name)}`}
            className="font-semibold text-teal-600 active:opacity-70"
          >
            壁打ち→
          </Link>
        </span>
      )}
      {/* 一覧から外す導線。指で押せる幅を確保しつつ、常時は控えめな見た目にする */}
      {o.notion_page_id ? (
        <button
          type="button"
          onClick={() => setConfirming((v) => !v)}
          disabled={busy}
          aria-expanded={confirming}
          title="この団体を一覧から外す（削除ではありません）"
          className="shrink-0 rounded-md border border-gray-300 px-1.5 py-0.5 text-[0.6875rem] text-gray-500 active:bg-gray-100 disabled:opacity-40"
        >
          {busy ? "処理中" : "対象外にする"}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setWhyDisabled((v) => !v)}
          title="Notion顧客CRMに未登録のため、ここからは除外できません"
          className="shrink-0 rounded-md border border-dashed border-gray-300 px-1.5 py-0.5 text-[0.6875rem] text-gray-400"
        >
          対象外にできません
        </button>
      )}

      {whyDisabled && !o.notion_page_id && (
        <p className="basis-full rounded-md bg-white px-2 py-1.5 text-[0.6875rem] leading-relaxed text-gray-500">
          この団体はNotion「顧客CRM」に未登録で、会議記録からだけ一覧に出ています。
          変更すべきページが無いため、ここからは除外できません。
          除外したい場合は、先に顧客CRMへ登録してください。
        </p>
      )}

      {/* 確認。何が起きて何が起きないかを、実際の挙動どおりに書く */}
      {confirming && o.notion_page_id && (
        <div className="basis-full rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5">
          <p className="text-[0.6875rem] leading-relaxed text-gray-700">
            <span className="font-semibold">{o.name}</span> を「次に攻める団体」から外します。
            <span className="font-semibold">削除ではありません。</span>
            Notion「顧客CRM」
            {crmName && (
              <>
                の<span className="font-semibold">「{crmName}」</span>
              </>
            )}
            のステータスが「対象外」になるだけで、団体ページも名刺（人脈DB）も
            会議記録もそのまま残ります。下の「対象外にした団体」から、または
            Notionでステータスを戻せば一覧に復活します。
          </p>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                onExclude(o);
              }}
              disabled={busy}
              className="rounded-md bg-amber-600 px-2.5 py-1 text-[0.6875rem] font-semibold text-white active:bg-amber-700 disabled:opacity-40"
            >
              対象外にする
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md px-2 py-1 text-[0.6875rem] text-gray-500 active:opacity-70"
            >
              やめる
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// ── 並び順 ────────────────────────────────────────────────
// カテゴリーごとに「見たい順番」が違うので、ここで切り替える。
//   自治体   … 小分類（政令市/特別区/市役所/その他）に分けたうえで、提案なしを上に
//   事業者・委託会社・銀行 … あいうえお順（件数が少なくうちに名前で探せるように）
//   議員     … 会派順（dashboard_stats の party_rank。自由民主党→公明党→…）
//   それ以外 … 従来どおり 提案なしを上に、次に会議数の多い順
//
// 日本語の並びは localeCompare("ja") を使う。単純な文字コード順だと
// カタカナ・漢字が期待どおりに並ばない。
function byPriority(a: OrgStatus, b: OrgStatus): number {
  return Number(a.has_proposal) - Number(b.has_proposal) || b.meetings - a.meetings;
}
function byName(a: OrgStatus, b: OrgStatus): number {
  return a.name.localeCompare(b.name, "ja");
}
function byParty(a: OrgStatus, b: OrgStatus): number {
  return (a.party_rank ?? 99) - (b.party_rank ?? 99) || byPriority(a, b);
}

const NAME_ORDER_CATEGORIES: ReadonlySet<string> = new Set(["事業者", "委託会社", "銀行"]);

function sorterFor(cat: OrgCategory): (a: OrgStatus, b: OrgStatus) => number {
  if (cat === "議員") return byParty;
  if (NAME_ORDER_CATEGORIES.has(cat)) return byName;
  return byPriority;
}

// 画面に出す1カテゴリー分。sections は自治体だけ複数になる（小分類）。
type OrgSection = { label: string | null; list: OrgStatus[] };
type OrgGroup = { cat: OrgCategory; total: number; noProposal: number; sections: OrgSection[] };

// 団体を正準8分類ごとに束ねる。分類は /api/status が stakeholders / weekly_reports から
// 突合して付けた値。どれにも当たらなければ「その他」（自治体などへ推測で寄せない）。
function groupByCategory(orgs: OrgStatus[]): OrgGroup[] {
  const groups = new Map<OrgCategory, OrgStatus[]>();
  for (const o of orgs) {
    const cat = normalizeOrgCategory(o.category) ?? "その他";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(o);
  }
  // 空カテゴリーは出さない。順番は ORG_CATEGORIES の定義順（＝正準の並び）に従う。
  return ORG_CATEGORIES.filter((c) => groups.has(c)).map((c) => {
    const list = groups.get(c)!.slice().sort(sorterFor(c));
    const noProposal = list.filter((o) => !o.has_proposal).length;

    // 自治体だけ、政令市/特別区/市役所/その他 に細分する（判定は lib/municipalities.ts）。
    // 0件の小分類は出さない。
    const sections: OrgSection[] =
      c === "自治体"
        ? MUNICIPALITY_SUBCATEGORIES.map((sub) => ({
            label: sub,
            list: list.filter((o) => municipalitySubcategory(o.name) === sub),
          })).filter((s) => s.list.length > 0)
        : [{ label: null, list }];

    return { cat: c, total: list.length, noProposal, sections };
  });
}

function OrgPanel({ orgs, onChanged }: { orgs: OrgStatus[]; onChanged: () => void }) {
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>("自治体");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 対象外まわり。
  //   excluded  … 対象外にした団体（GET /api/status/exclude）
  //   hidden    … 対象外にした直後の楽観的な非表示。/api/status の再取得が
  //               返ってくるまでの数百msだけ効く（押したのに残る、を防ぐ）
  const [excluded, setExcluded] = useState<ExcludedOrg[] | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<string | null>(null); // 処理中のページID
  const [exErr, setExErr] = useState<string | null>(null);
  const [stars, setStars] = useState<StarMap>({});
  const [starBusy, setStarBusy] = useState<string | null>(null);
  // ★の読み込み結果。ロード成功前は押させない（既存の順位を空の状態から
  // 上書きしてしまう事故を防ぐ）。失敗は黙らず「読み込めませんでした」を出す。
  const [starsReady, setStarsReady] = useState(false);
  const [starsError, setStarsError] = useState(false);
  // 対象外リストの取得失敗フラグ。取れないのに「対象外なし」に見せない。
  const [excludedError, setExcludedError] = useState(false);

  const loadStars = useCallback(async () => {
    try {
      const res = await fetch("/api/next-targets?all=true", { cache: "no-store" });
      const json = await res.json();
      if (res.ok && Array.isArray(json?.targets)) {
        const m: StarMap = {};
        for (const t of json.targets as { name: string; stars: number }[]) {
          if (t.stars > 0) m[t.name] = t.stars;
        }
        setStars(m);
        setStarsReady(true);
        setStarsError(false);
      } else {
        throw new Error("failed");
      }
    } catch {
      // ★が取れなくても一覧は出す（付随情報で本体を止めない）が、
      // 失敗中である事実は表示し、★の操作は止める。
      setStarsError(true);
    }
  }, []);

  // ★の設定。押した瞬間に反映し、失敗したら元に戻す（実態と食い違わせない）。
  async function setStarFor(name: string, n: number) {
    if (starBusy || !starsReady) return;
    setStarBusy(name);
    const before = stars[name] ?? 0;
    setStars((prev) => {
      const next = { ...prev };
      if (n === 0) delete next[name];
      else next[name] = n;
      return next;
    });
    try {
      const res = await fetch("/api/next-targets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, stars: n }),
      });
      if (!res.ok) throw new Error("failed");
    } catch {
      setStars((prev) => {
        const next = { ...prev };
        if (before === 0) delete next[name];
        else next[name] = before;
        return next;
      });
      setExErr("優先順位の保存に失敗しました");
    } finally {
      setStarBusy(null);
    }
  }

  const loadExcluded = useCallback(async () => {
    try {
      const res = await fetch("/api/status/exclude", { cache: "no-store" });
      const json = await res.json();
      if (res.ok && Array.isArray(json?.orgs)) {
        setExcluded(json.orgs as ExcludedOrg[]);
        setExcludedError(false);
      } else {
        throw new Error("failed");
      }
    } catch {
      // 一覧が取れなくても本体の表示は続けるが、失敗は黙らず表示する
      setExcludedError(true);
    }
  }, []);

  useEffect(() => {
    loadExcluded();
    loadStars();
  }, [loadExcluded, loadStars]);

  // exclude=true で対象外へ、false で戻す。どちらもNotionが正。
  async function setExcludedState(pageId: string, exclude: boolean) {
    if (pending) return;
    setPending(pageId);
    setExErr(null);
    // 楽観的に画面へ反映（サーバー側もNotion更新→写しへライトスルーで即時化している）
    setHidden((prev) => {
      const next = new Set(prev);
      if (exclude) next.add(pageId);
      else next.delete(pageId);
      return next;
    });
    try {
      const res = await fetch("/api/status/exclude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notion_page_id: pageId, exclude }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        // 失敗したら楽観的な表示を取り消す（実態と食い違わせない）
        setHidden((prev) => {
          const next = new Set(prev);
          if (exclude) next.delete(pageId);
          else next.add(pageId);
          return next;
        });
        setExErr((json && json.error) || "更新に失敗しました");
        return;
      }
      if (json?.warning) setExErr(json.warning);
      await loadExcluded();
      onChanged(); // /api/status を取り直して一覧を実態に合わせる
    } catch {
      setHidden((prev) => {
        const next = new Set(prev);
        if (exclude) next.delete(pageId);
        else next.add(pageId);
        return next;
      });
      setExErr("通信エラーが発生しました");
    } finally {
      setPending(null);
    }
  }

  const visible = orgs.filter((o) => !(o.notion_page_id && hidden.has(o.notion_page_id)));
  const groups = groupByCategory(visible);

  async function add() {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/stakeholders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, name: n }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setErr((d && d.error) || "追加に失敗しました");
      } else {
        setName("");
        setShowAdd(false);
        onChanged(); // 一覧を再取得して新団体を反映
      }
    } catch {
      setErr("通信エラーが発生しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {/* 提案団体を追加 */}
      {showAdd ? (
        <div className="mb-3 rounded-xl border border-indigo-200 bg-indigo-50 p-3">
          <div className="flex gap-2">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="shrink-0 rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900"
            >
              {ADD_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
              placeholder="団体名（例: 千葉市）"
              className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={add}
              disabled={busy || !name.trim()}
              className="shrink-0 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white active:bg-indigo-700 disabled:opacity-40"
            >
              {busy ? "追加中" : "追加"}
            </button>
          </div>
          {err && <p className="mt-2 text-xs text-rose-600">{err}</p>}
          <button
            type="button"
            onClick={() => {
              setShowAdd(false);
              setErr(null);
            }}
            className="mt-2 text-xs text-gray-500 active:opacity-70"
          >
            閉じる
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="mb-2 w-full rounded-xl border border-dashed border-indigo-300 py-1.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
        >
          ＋ 提案団体を追加
        </button>
      )}

      {exErr && (
        <p className="mb-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs leading-relaxed text-rose-700">
          {exErr}
        </p>
      )}

      {starsError && (
        <p className="mb-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs leading-relaxed text-rose-700">
          優先順位（★）を読み込めませんでした。既存の順位を空の状態で上書きしないよう、★は一時的に押せません。
        </p>
      )}

      {groups.length === 0 ? (
        <p className="text-sm text-gray-400">団体はまだありません。上の「追加」から登録できます。</p>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.cat}>
              <div className="mb-1 flex items-baseline gap-2 border-b border-gray-100 pb-0.5">
                <h3 className="text-xs font-bold text-gray-600">{g.cat}</h3>
                <span className="text-[0.6875rem] text-gray-400">
                  {g.total}団体
                  {g.noProposal > 0 ? ` ・ 提案なし ${g.noProposal}` : " ・ 全て提案済"}
                </span>
              </div>
              {g.sections.map((s, i) => (
                <div key={s.label ?? i} className={s.label ? "mt-1" : undefined}>
                  {s.label && (
                    <p className="mb-0.5 text-[0.6875rem] font-semibold text-gray-500">
                      {s.label}
                      <span className="ml-1 font-normal text-gray-400">{s.list.length}</span>
                    </p>
                  )}
                  {/* 横幅がある画面では団体を横に並べて縦を詰める */}
                  <ul className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                    {s.list.map((o) => (
                      <OrgRow
                        key={o.name}
                        o={o}
                        busy={pending === o.notion_page_id}
                        stars={stars[o.name] ?? 0}
                        starBusy={starBusy === o.name || !starsReady}
                        onStar={(n) => setStarFor(o.name, n)}
                        onExclude={(org) =>
                          org.notion_page_id && setExcludedState(org.notion_page_id, true)
                        }
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
          {/* 突合できなかった団体は「その他」に出る。ここが増えたら
              stakeholders / weekly_reports 側の登録漏れのサイン。 */}
          {groups.some((g) => g.cat === "その他") && (
            <p className="text-[0.6875rem] leading-relaxed text-gray-400">
              ※「その他」は stakeholders・週報のどちらにも種別の登録が無い団体です
              （推測で分類していません）。
            </p>
          )}
        </div>
      )}

      {/* 対象外リストの取得失敗。0件と読み違えさせない */}
      {excludedError && (
        <p className="mt-3 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs leading-relaxed text-rose-700">
          対象外にした団体の一覧を読み込めませんでした（対象外が無いわけではありません）。
        </p>
      )}

      {/* 対象外にした団体。ここから元に戻せる（＝一方通行にしない） */}
      {excluded && excluded.length > 0 && (
        <details className="group mt-3 rounded-xl border border-gray-200 bg-gray-50 px-2.5 py-2">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden">
            <span className="text-xs text-gray-400 transition group-open:rotate-90" aria-hidden>
              ▶
            </span>
            <span className="text-xs font-bold text-gray-600">
              対象外にした団体（{excluded.length}）
            </span>
          </summary>
          <p className="mt-1.5 text-[0.6875rem] leading-relaxed text-gray-500">
            一覧から外しているだけで、Notionの団体ページ・名刺・会議記録は残っています。
            「戻す」を押すとステータスが空欄に戻り、「次に攻める団体」へ復活します。
          </p>
          <ul className="mt-1.5 grid gap-1 sm:grid-cols-2 xl:grid-cols-3">
            {excluded.map((e) => (
              <li
                key={e.notion_page_id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5"
              >
                <span className="min-w-[7rem] flex-1 basis-[7rem] truncate text-sm text-gray-700">
                  {e.name}
                </span>
                {e.category && (
                  <span className="shrink-0 text-[0.6875rem] text-gray-400">{e.category}</span>
                )}
                <button
                  type="button"
                  onClick={() => setExcludedState(e.notion_page_id, false)}
                  disabled={pending === e.notion_page_id}
                  className="shrink-0 rounded-md border border-indigo-300 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-indigo-600 active:bg-indigo-50 disabled:opacity-40"
                >
                  {pending === e.notion_page_id ? "処理中" : "戻す"}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ── OS Guardian（ジョブの成否）パネル ──────────────────────
//
// 「最後に動いた」ではなく「最後に正常成功したか」を出す。
// 判定は lib/guardian.ts（閾値の正は lib/advisor/watchlist.ts）。ここは見せ方だけ。

const GUARDIAN_STYLE: Record<GuardianState, { dot: string; chip: string }> = {
  異常: { dot: "bg-rose-500", chip: "bg-rose-100 text-rose-700" },
  警告: { dot: "bg-amber-400", chip: "bg-amber-100 text-amber-800" },
  未実行: { dot: "bg-gray-300", chip: "bg-gray-100 text-gray-600" },
  基準なし: { dot: "bg-sky-300", chip: "bg-sky-100 text-sky-700" },
  // 別監視は「見られている」側なので、緑寄り（安心side）の色にする。
  // 基準なし（水色）と同じ見た目にすると、区別を足した意味が無くなる。
  別監視: { dot: "bg-teal-400", chip: "bg-teal-100 text-teal-700" },
  正常: { dot: "bg-emerald-500", chip: "bg-emerald-100 text-emerald-700" },
};

function GuardianPanel({
  rows,
  error,
  onRetry,
}: {
  rows: GuardianRow[] | null;
  error: string | null;
  onRetry: () => void;
}) {
  // ★取得失敗を「ジョブなし」に見せない。読めなかったことをそのまま出す。
  if (error) {
    return (
      <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
        <p className="font-bold">ジョブの状態を取得できませんでした</p>
        <p className="mt-0.5 text-xs">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 w-full rounded-lg border border-rose-300 bg-white py-1.5 text-xs font-bold text-rose-700 active:bg-rose-100"
        >
          再読み込み
        </button>
      </div>
    );
  }
  if (rows === null) {
    return <p className="text-sm text-gray-400">読み込み中…</p>;
  }
  if (rows.length === 0) {
    return <p className="text-sm text-gray-400">対象のジョブがありません。</p>;
  }

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.state] = (acc[r.state] ?? 0) + 1;
    return acc;
  }, {});
  const order: GuardianState[] = ["異常", "警告", "未実行", "基準なし", "別監視", "正常"];

  return (
    <div>
      {/* 状態ごとの件数。まず全体を1行で掴めるように。 */}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {order
          .filter((st) => (counts[st] ?? 0) > 0)
          .map((st) => (
            <span
              key={st}
              className={`rounded-full px-2 py-0.5 text-xs font-bold ${GUARDIAN_STYLE[st].chip}`}
            >
              {st} {counts[st]}
            </span>
          ))}
      </div>

      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.job}
            className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${GUARDIAN_STYLE[r.state].dot}`} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">
                {r.label}
              </span>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-bold ${GUARDIAN_STYLE[r.state].chip}`}
              >
                {r.state}
              </span>
              {/* どこが見ているか。状態だけだと「別監視」の中身が分からない。 */}
              {r.external_monitor && (
                <span className="shrink-0 text-xs text-gray-500">{r.external_monitor}</span>
              )}
            </div>
            {/* 最終実行・最終成功・最終結果。3つを並べて出すのがこの画面の要。 */}
            <dl className="mt-1 grid grid-cols-3 gap-1 text-xs">
              <div>
                <dt className="text-gray-400">最終実行</dt>
                <dd className="tabular-nums text-gray-700">{fmtDateTime(r.last_run_at)}</dd>
              </div>
              <div>
                <dt className="text-gray-400">最終成功</dt>
                <dd className="tabular-nums text-gray-700">{fmtDateTime(r.last_ok_at)}</dd>
              </div>
              <div>
                <dt className="text-gray-400">最終結果</dt>
                <dd
                  className={
                    r.last_result === "失敗"
                      ? "font-bold text-rose-700"
                      : r.last_result === "成功"
                      ? "text-emerald-700"
                      : "text-gray-400"
                  }
                >
                  {r.last_result ?? "—"}
                  {/* exit コードは失敗しているときだけ。成功に併記すると直っているものを
                      落ちているように見せてしまう（この列は最後の失敗に紐づくため）。 */}
                  {r.last_result === "失敗" && r.last_exit_code !== null
                    ? ` (exit ${r.last_exit_code})`
                    : ""}
                </dd>
              </div>
            </dl>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">{r.reason}</p>
          </li>
        ))}
      </ul>

      <p className="mt-2 border-t border-gray-100 pt-2 text-xs leading-relaxed text-gray-400">
        「基準なし」は打刻はあるが、どこからも監視されていないジョブです。止まってよい時間が
        決まっていないため、正常とも警告とも判定できません。
        「別監視」はこの一覧では判定していませんが、専用の検知器が見ているジョブです
        （横に「どこが・何日で」を出しています）。
      </p>
    </div>
  );
}

// ── Memory 2.0 Shadow パネル ──────────────────────────────
//
// 2026-08-28のmigrationで入った canonical_document_id / source_document_id /
// chunk_index を使って数え直した結果を、旧方式の横に並べるだけ。
// **本番の検索・RAG・AI回答は何も変えていない。** 置き換えの前に、
// 「置き換えたら数字がどう動くか」を先に見えるようにするためのもの。
//
// 差分は「エラー」ではない。旧方式が過剰に統合していた分も、新方式が
// 同じ実体として束ねた分も、どちらも差として出る。

function MemoryShadowPanel({
  audit,
  error,
  onRetry,
}: {
  audit: AuditResult | null;
  error: string | null;
  onRetry: () => void;
}) {
  // ★取得失敗を「0件」に見せない。記憶の監査と同じ扱いにする。
  if (error) {
    return (
      <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
        <p className="font-bold">Shadowの比較データを取得できませんでした</p>
        <p className="mt-0.5 text-xs">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 w-full rounded-lg border border-rose-300 bg-white py-1.5 text-xs font-bold text-rose-700 active:bg-rose-100"
        >
          再読み込み
        </button>
      </div>
    );
  }
  if (!audit) return <p className="text-sm text-gray-400">読み込み中…</p>;

  const s = audit.shadow;
  const h = s.health;

  return (
    <div className="space-y-3">
      {/* 健全性は正常のときも出す。異常のときだけ表示すると「見えない＝正常」なのか
          「読めていない」のか区別が付かず、静かに壊れたときに気づけない。 */}
      <div
        className={`rounded-lg border px-2.5 py-2 ${
          h.healthy ? "border-emerald-200 bg-emerald-50" : "border-rose-300 bg-rose-50"
        }`}
      >
        <p className={`text-xs font-bold ${h.healthy ? "text-emerald-800" : "text-rose-800"}`}>
          同一性の健全性：{h.healthy ? "異常なし" : "異常あり"}
        </p>
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[0.6875rem]">
          {[
            { label: "4列の未設定", n: h.canonicalNull + h.sourceDocumentNull + h.chunkIndexNull + h.ingestSchemeNull },
            { label: "版の中の番号衝突", n: h.collisions.length },
            { label: "実体をまたぐ取込文書", n: h.variantsSpanningCanonicals.length },
            { label: "別version（正常）", n: s.multiVariant.length, ok: true },
          ].map((x) => (
            <div key={x.label} className="flex items-baseline justify-between gap-2">
              <span className={h.healthy ? "text-emerald-900/70" : "text-rose-900/70"}>{x.label}</span>
              <span
                className={`font-bold tabular-nums ${
                  x.n === 0 || x.ok
                    ? h.healthy
                      ? "text-emerald-700"
                      : "text-gray-500"
                    : "text-rose-700"
                }`}
              >
                {x.n}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ★列が欠けている・版の中で番号がぶつかっているなら、内訳まで出す。 */}
      {!h.healthy && (
        <div className="rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-2 text-xs text-rose-800">
          <p className="font-bold">同一性の列が壊れています</p>
          <ul className="mt-1 space-y-0.5">
            {h.canonicalNull > 0 && <li>実体ID（canonical）が未設定：{h.canonicalNull}行</li>}
            {h.sourceDocumentNull > 0 && <li>取り込み文書IDが未設定：{h.sourceDocumentNull}行</li>}
            {h.chunkIndexNull > 0 && <li>chunk_index が未設定：{h.chunkIndexNull}行</li>}
            {h.ingestSchemeNull > 0 && <li>ingest_scheme が未設定：{h.ingestSchemeNull}行</li>}
            {h.collisions.length > 0 && (
              <li>
                同じ取り込み文書の中で chunk_index が衝突：{h.collisions.length}組
                <span className="block truncate text-rose-900/60">
                  例: {h.collisions.slice(0, 2).map((c) => `${c.sourceDocumentId.slice(0, 40)}#${c.chunkIndex}`).join(" / ")}
                </span>
              </li>
            )}
            {h.variantsSpanningCanonicals.length > 0 && (
              <li>1つの取り込み文書が複数の実体にまたがっている：{h.variantsSpanningCanonicals.length}件</li>
            )}
          </ul>
        </div>
      )}

      {/* 全体の数 */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "chunk", value: s.chunks },
          { label: "実体", value: s.canonicalDocuments },
          { label: "取り込み文書", value: s.sourceDocuments },
        ].map((x) => (
          <div key={x.label} className="rounded-lg bg-gray-50 px-2 py-1.5 text-center">
            <p className="text-[0.6875rem] text-gray-500">{x.label}</p>
            <p className="text-base font-bold tabular-nums text-gray-900">{x.value}</p>
          </div>
        ))}
      </div>

      {/* 旧方式との比較 */}
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[24rem] text-xs">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="pb-1 pr-2 font-bold">種別</th>
              <th className="pb-1 pr-2 text-right font-bold">chunk</th>
              <th className="pb-1 pr-2 text-right font-bold">旧方式</th>
              <th className="pb-1 pr-2 text-right font-bold">実体</th>
              <th className="pb-1 pr-2 text-right font-bold">取込文書</th>
              <th className="pb-1 text-right font-bold">差</th>
            </tr>
          </thead>
          <tbody>
            {s.bySourceType.map((t) => (
              <tr key={t.sourceType} className="border-b border-gray-100 last:border-0">
                <td className="py-1 pr-2 text-gray-700">{t.sourceType}</td>
                <td className="py-1 pr-2 text-right tabular-nums text-gray-600">{t.chunks}</td>
                <td className="py-1 pr-2 text-right tabular-nums text-gray-600">
                  {t.oldDocuments ?? "—"}
                </td>
                <td className="py-1 pr-2 text-right font-bold tabular-nums text-gray-900">
                  {t.canonicalDocuments}
                </td>
                <td className="py-1 pr-2 text-right tabular-nums text-gray-600">
                  {t.sourceDocuments}
                </td>
                <td
                  className={`py-1 text-right tabular-nums ${
                    t.diff === null || t.diff === 0 ? "text-gray-300" : "font-bold text-indigo-600"
                  }`}
                >
                  {t.diff === null ? "—" : t.diff === 0 ? "0" : t.diff > 0 ? `+${t.diff}` : t.diff}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs leading-relaxed text-gray-400">
        差は不具合ではありません。旧方式が別の文書を1つに潰していた分は＋に、
        新方式が同じ実体として束ねた分は−に出ます。
      </p>

      {/* 同じ実体に複数の取り込み文書があるもの */}
      <div>
        <p className="mb-1 text-xs font-bold text-gray-600">
          同じ実体に複数の取り込み文書があります
          <span className="ml-1 font-normal text-gray-400">（{s.multiVariant.length}件）</span>
        </p>
        {s.multiVariant.length === 0 ? (
          <p className="text-xs text-gray-400">ありません。</p>
        ) : (
          <ul className="space-y-1.5">
            {s.multiVariant.slice(0, 8).map((m) => (
              <li
                key={m.canonicalDocumentId}
                className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2"
              >
                <p className="truncate text-[0.6875rem] font-bold text-gray-700">
                  {m.canonicalDocumentId}
                </p>
                <p className="text-[0.6875rem] text-gray-500">
                  {m.variantCount}版 / 全{m.chunks}chunk
                </p>
                <ul className="mt-1 space-y-1">
                  {m.variants.map((v) => (
                    <li key={v.sourceDocumentId} className="border-l-2 border-gray-300 pl-2">
                      <p className="truncate text-[0.6875rem] text-gray-700">
                        {v.title ?? "(題なし)"}
                      </p>
                      <p className="truncate text-[0.625rem] text-gray-400">
                        {v.sourceType} / {v.organization ?? "団体なし"} / {v.eventDate ?? "日付なし"}
                        {" / "}
                        {v.chunks}chunk
                      </p>
                      <p className="truncate text-[0.625rem] text-gray-400">{v.sourceDocumentId}</p>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs leading-relaxed text-gray-400">
          これらは重複でも削除対象でもありません。同じ実体について取り込み文書が
          複数ある、という事実だけを出しています。どれを正とするかはまだ決めていません。
        </p>
      </div>
    </div>
  );
}

// ── 記憶の健康診断パネル ──────────────────────────────────
//
// 「確定した不整合」と「要確認の候補」を必ず分けて出す。混ぜると、機械が
// 決めてよいことと人が決めることの境目が消える。判定は lib/memoryAudit.ts。

function MemoryAuditPanel({
  audit,
  error,
  onRetry,
}: {
  audit: AuditResult | null;
  error: string | null;
  onRetry: () => void;
}) {
  // ★取得失敗を「不整合ゼロ」に見せない。
  if (error) {
    return (
      <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
        <p className="font-bold">記憶の監査データを取得できませんでした</p>
        <p className="mt-0.5 text-xs">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 w-full rounded-lg border border-rose-300 bg-white py-1.5 text-xs font-bold text-rose-700 active:bg-rose-100"
        >
          再読み込み
        </button>
      </div>
    );
  }
  if (!audit) return <p className="text-sm text-gray-400">読み込み中…</p>;

  return (
    <div className="space-y-3">
      {audit.truncated && (
        <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
          取得上限に達しました。以下の件数は「これ以上」の意味です。
        </p>
      )}

      {/* source_type別。チャンク数と文書数を必ず並べて出す
          （1会議26チャンクを26会議と数えた事故を繰り返さないため）。 */}
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[22rem] text-xs">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="pb-1 pr-2 font-bold">種別</th>
              <th className="pb-1 pr-2 text-right font-bold">chunk</th>
              <th className="pb-1 pr-2 text-right font-bold">文書</th>
              <th className="pb-1 pr-2 text-right font-bold">団体空</th>
              <th className="pb-1 text-right font-bold">位置なし</th>
            </tr>
          </thead>
          <tbody>
            {audit.bySourceType.map((t) => (
              <tr key={t.source_type} className="border-b border-gray-100 last:border-0">
                <td className="py-1 pr-2 text-gray-700">{t.source_type}</td>
                <td className="py-1 pr-2 text-right font-bold tabular-nums text-gray-900">
                  {t.chunks}
                </td>
                <td className="py-1 pr-2 text-right tabular-nums text-gray-600">{t.docs}</td>
                <td className="py-1 pr-2 text-right tabular-nums text-gray-600">{t.org_null}</td>
                <td className="py-1 text-right tabular-nums text-gray-600">{t.pos_missing}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 確定した不整合 */}
      <div>
        <p className="mb-1 text-xs font-bold text-rose-700">確定した不整合</p>
        {audit.confirmed.length === 0 ? (
          <p className="text-xs text-gray-400">ありません。</p>
        ) : (
          <ul className="space-y-1.5">
            {audit.confirmed.map((c) => (
              <li key={c.key} className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 text-xs font-bold text-rose-800">{c.label}</span>
                  <span className="shrink-0 text-xs font-bold tabular-nums text-rose-700">
                    {c.count}
                  </span>
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-rose-900/70">{c.detail}</p>
                {c.samples.length > 0 && (
                  <p className="mt-0.5 truncate text-[0.6875rem] text-rose-900/50">
                    例: {c.samples.join(" / ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 要確認の候補（機械では決められないもの） */}
      <div>
        <p className="mb-1 text-xs font-bold text-amber-700">要確認の候補</p>
        {audit.candidates.length === 0 ? (
          <p className="text-xs text-gray-400">ありません。</p>
        ) : (
          <ul className="space-y-1.5">
            {audit.candidates.map((c) => (
              <li key={c.key} className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 text-xs font-bold text-amber-800">{c.label}</span>
                  <span className="shrink-0 text-xs font-bold tabular-nums text-amber-700">
                    {c.count}
                  </span>
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-amber-900/70">{c.detail}</p>
                {c.samples.length > 0 && (
                  <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-amber-900/50">
                    例: {c.samples.join(" / ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* chunkが多い文書 */}
      <div>
        <p className="mb-1 text-xs font-bold text-gray-500">chunkが多い文書</p>
        <ul className="space-y-1">
          {audit.heavyDocs.map((d) => (
            <li key={d.doc} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-gray-700">
                {d.doc.replace(/__/, "  ")}
              </span>
              <span className="shrink-0 text-gray-400">{d.source_type}</span>
              <span className="shrink-0 font-bold tabular-nums text-gray-900">{d.chunks}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 border-t border-gray-100 pt-2 text-xs leading-relaxed text-gray-400">
          「chunk」は行数、「文書」は資料名＋日付で束ねた実数です。この2つを取り違えると、
          1会議26chunkを26会議と数える類の誤りが起きます。ここでは何も直していません。
        </p>
      </div>
    </div>
  );
}

// ── サービス稼働状況パネル ────────────────────────────────
const SERVICE_ICON: Record<string, string> = {
  plaud: "🎙️",
  eight: "📇",
  news: "📰",
  notion: "📝",
};

function ServicesPanel({ services }: { services: Service[] }) {
  if (services.length === 0) {
    return <p className="text-sm text-gray-400">稼働情報はまだありません。</p>;
  }
  return (
    <ul className="space-y-2">
      {services.map((s) => {
        const h = hoursSince(s.last_ok_at);
        // 未実行=グレー / 72時間以内=緑 / それ以上=黄
        const dot =
          h === null ? "bg-gray-300" : h <= 72 ? "bg-emerald-500" : "bg-amber-400";
        return (
          <li
            key={s.service}
            className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
          >
            <span className="text-base" aria-hidden>
              {SERVICE_ICON[s.service] ?? "🔌"}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
              {s.label}
            </span>
            <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
            <span className="shrink-0 text-xs text-gray-500">
              {s.last_ok_at ? `${agoLabel(s.last_ok_at)} 正常` : "未実行"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ── ニュースパネル（カテゴリ別グループ表示） ──────────────
const NEWS_CATEGORY_ORDER = ["生成AI", "自治体DX", "法人OS", "ロビー活動／他"];

function NewsThemeRow({ t }: { t: NewsTheme }) {
  const h = hoursSince(t.last_fetch);
  const stale = h !== null && h > 48;
  return (
    <li className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${stale ? "bg-amber-400" : "bg-emerald-500"}`}
        title={stale ? "48時間以上更新なし" : "新しい"}
      />
      <span className="min-w-0 flex-1 truncate text-sm text-gray-700">{t.theme}</span>
      <span className="shrink-0 text-xs font-semibold text-gray-800">{t.count}</span>
      <span className="shrink-0 text-xs text-gray-400" title={`最終取得 ${fmtDateTime(t.last_fetch)}`}>
        {agoLabel(t.last_fetch)}
      </span>
    </li>
  );
}

function NewsPanel({ themes }: { themes: NewsTheme[] }) {
  if (themes.length === 0) {
    return <p className="text-sm text-gray-400">収集済みニュースはありません。</p>;
  }
  // カテゴリでグループ化（定義順→未分類は最後）
  const groups = new Map<string, NewsTheme[]>();
  for (const t of themes) {
    const c = t.category ?? "その他";
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(t);
  }
  const cats = [
    ...NEWS_CATEGORY_ORDER.filter((c) => groups.has(c)),
    ...[...groups.keys()].filter((c) => !NEWS_CATEGORY_ORDER.includes(c)),
  ];
  return (
    <div className="space-y-4">
      {cats.map((c) => (
        <div key={c}>
          <p className="mb-1.5 text-xs font-bold text-gray-500">{c}</p>
          <ul className="space-y-2">
            {groups
              .get(c)!
              .sort((a, b) => b.count - a.count)
              .map((t) => (
                <NewsThemeRow key={t.theme} t={t} />
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ── Notionパネル ──────────────────────────────────────────
function NotionPanel({ notion }: { notion: NotionState | undefined }) {
  if (!notion || !notion.connected) {
    return (
      <div>
        <p className="text-sm leading-relaxed text-gray-600">
          Notionは<span className="font-semibold">未接続</span>です。以下を設定すると、
          一行日記・学び・会議DBの「最新の登録」をここに表示できます。
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-gray-500">
          <li>Notionでインテグレーションを作成しトークンを取得</li>
          <li>対象の3つのDBをそのインテグレーションに共有（接続）</li>
          <li>
            <code className="rounded bg-gray-100 px-1">.env.local</code> に{" "}
            <code className="rounded bg-gray-100 px-1">NOTION_TOKEN</code> と各DBの{" "}
            <code className="rounded bg-gray-100 px-1">NOTION_DB_DIARY</code> /{" "}
            <code className="rounded bg-gray-100 px-1">NOTION_DB_LEARNING</code> /{" "}
            <code className="rounded bg-gray-100 px-1">NOTION_DB_MEETING</code> を追加
          </li>
        </ol>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {notion.dbs.map((db) => (
        <div key={db.key} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-800">{db.label}</span>
            {db.ok ? (
              <span className="ml-auto text-xs text-gray-400">
                最終更新 {agoLabel(db.last_edited)}
              </span>
            ) : (
              <span className="ml-auto rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-700">
                {db.error ?? "取得失敗"}
              </span>
            )}
          </div>
          {db.ok && db.recent && db.recent.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {db.recent.map((r, i) => (
                <li key={i} className="truncate text-xs text-gray-500">
                  ・{r.title}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

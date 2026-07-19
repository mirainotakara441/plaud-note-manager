"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

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
  error: { label: "エラー", style: "bg-red-100 text-red-700" },
};
const KIND_LABEL: Record<string, string> = {
  eight: "Eight",
  plaud: "PLAUD",
  slides: "スライド清書",
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

// ── 小物コンポーネント ────────────────────────────────────
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="text-sm font-semibold text-gray-500">{title}</h2>
        {hint && <span className="text-xs text-gray-400">{hint}</span>}
      </div>
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        {children}
      </div>
    </section>
  );
}

// ── メイン ────────────────────────────────────────────────
export default function StatusPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  // silent=true は自動更新用（ボタンの「更新中」表示を出さず裏で差し替える）
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const json = (await res.json()) as ApiResponse;
      setData(json);
      setFetchedAt(new Date());
    } catch {
      setData({ ok: false, error: "通信エラーが発生しました" });
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // 60秒ごとに裏で自動更新。開きっぱなしでも鮮度を保つ。
    const timer = setInterval(() => load(true), 60000);
    // タブに戻った瞬間にも更新（スリープ復帰・アプリ切替後の古い表示を防ぐ）
    const onVisible = () => {
      if (document.visibilityState === "visible") load(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const stats = data?.stats;
  const healthy = data?.ok === true && !!stats;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
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

      {/* 接続ヘルス */}
      <div
        className={`flex items-center gap-3 rounded-2xl border p-4 shadow-sm ${
          healthy
            ? "border-emerald-200 bg-emerald-50"
            : loading
              ? "border-gray-200 bg-white"
              : "border-red-200 bg-red-50"
        }`}
      >
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg ${
            healthy ? "bg-emerald-100" : loading ? "bg-gray-100" : "bg-red-100"
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

      {loading && !stats && (
        <div className="flex flex-col items-center gap-3 py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600" />
          <p className="text-sm text-gray-500">読み込み中…</p>
        </div>
      )}

      {stats && (
        <>
          {/* サービス稼働状況 */}
          <Section title="サービス稼働状況" hint="各連携の最終正常稼働">
            <ServicesPanel services={stats.services} />
          </Section>

          {/* 記憶の成長 */}
          <Section title="記憶の成長" hint={`合計 ${stats.memory_total} 件`}>
            {/* 今日/今週どれだけ脳が育ったか */}
            <div className="mb-3 flex gap-2">
              <div className="flex-1 rounded-xl bg-indigo-50 p-3 text-center">
                <p className="text-2xl font-bold text-indigo-700">
                  +{stats.memory_last24h}
                </p>
                <p className="mt-0.5 text-xs font-medium text-indigo-500">今日ふえた</p>
              </div>
              <div className="flex-1 rounded-xl bg-indigo-50 p-3 text-center">
                <p className="text-2xl font-bold text-indigo-700">
                  +{stats.memory_last7d}
                </p>
                <p className="mt-0.5 text-xs font-medium text-indigo-500">今週ふえた</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {stats.memory_by_type.map((t) => (
                <div
                  key={t.type}
                  className="rounded-xl border border-gray-100 bg-gray-50 p-3"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        TYPE_STYLE[t.type] ?? "bg-gray-200 text-gray-700"
                      }`}
                    >
                      {t.type}
                    </span>
                    <span className="ml-auto text-lg font-bold text-gray-900">
                      {t.count}
                    </span>
                  </div>
                  {/* 成長の差分（増えていれば緑で強調） */}
                  <div className="mt-2 flex items-center gap-2 text-xs">
                    <span
                      className={`font-semibold ${
                        t.d1 > 0 ? "text-emerald-600" : "text-gray-300"
                      }`}
                    >
                      {t.d1 > 0 ? `+${t.d1}` : "±0"}
                      <span className="ml-0.5 font-normal text-gray-400">今日</span>
                    </span>
                    <span
                      className={`font-semibold ${
                        t.d7 > 0 ? "text-emerald-600" : "text-gray-300"
                      }`}
                    >
                      {t.d7 > 0 ? `+${t.d7}` : "±0"}
                      <span className="ml-0.5 font-normal text-gray-400">今週</span>
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-gray-400">
                    最終 {fmtDate(t.last)}（{agoLabel(t.last)}）
                  </p>
                </div>
              ))}
            </div>
          </Section>

          {/* 日次アクティビティ */}
          <Section title="登録アクティビティ" hint="直近">
            <DailyChart daily={stats.memory_daily} />
          </Section>

          {/* 取込ジョブ */}
          <Section title="取込ジョブ (Eight / PLAUD / スライド)" hint="状態は直近7日">
            <JobsPanel summary={stats.jobs_summary} recent={stats.jobs_recent} />
          </Section>

          {/* 壁打ち */}
          <Section
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
          <Section title="生成済みの提案">
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

          {/* ニュース収集パイプライン */}
          <Section title="ニュース収集パイプライン" hint="テーマ別の鮮度">
            <NewsPanel themes={stats.news_by_theme} />
          </Section>

          {/* 団体別・ステークホルダー */}
          <Section title="団体別の記憶">
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
          <Section title="Notion 連携">
            <NotionPanel notion={data?.notion} />
          </Section>

          <p className="mt-6 text-center text-xs text-gray-400">
            集計時刻 {fmtDateTime(stats.generated_at)}
          </p>
        </>
      )}
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
          <span className="text-[9px] font-medium text-gray-500 tabular-nums">
            {d.count > 0 ? d.count : ""}
          </span>
          <div
            className={`w-full rounded-t ${d.count > 0 ? "bg-indigo-500" : "bg-gray-200"}`}
            style={{ height: `${d.count > 0 ? Math.max(4, (d.count / max) * 88) : 2}px` }}
            title={`${d.d}: ${d.count}件`}
          />
          {/* ラベルは1日おき（14本で潰れないように） */}
          <span className="h-3 text-[9px] text-gray-400">
            {i % 2 === 0 ? d.d.slice(5) : ""}
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
          <p className="text-sm text-gray-400">ジョブはまだありません。</p>
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

      {recent.length > 0 && (
        <ul className="mt-3 space-y-2">
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

// ── ニュースパネル ────────────────────────────────────────
function NewsPanel({ themes }: { themes: NewsTheme[] }) {
  if (themes.length === 0) {
    return <p className="text-sm text-gray-400">収集済みニュースはありません。</p>;
  }
  return (
    <ul className="space-y-2">
      {themes.map((t) => {
        const h = hoursSince(t.last_fetch);
        const stale = h !== null && h > 48;
        return (
          <li
            key={t.theme}
            className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${stale ? "bg-amber-400" : "bg-emerald-500"}`}
              title={stale ? "48時間以上更新なし" : "新しい"}
            />
            <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
              {t.theme}
            </span>
            <span className="shrink-0 text-xs font-semibold text-gray-800">{t.count}</span>
            <span className="shrink-0 text-xs text-gray-400" title={`最終取得 ${fmtDateTime(t.last_fetch)}`}>
              {agoLabel(t.last_fetch)}
            </span>
          </li>
        );
      })}
    </ul>
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
              <span className="ml-auto rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">
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

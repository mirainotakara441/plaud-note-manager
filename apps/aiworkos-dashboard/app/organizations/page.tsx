"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// 団体別攻略：団体を選ぶと、その団体の「いまの状態・課題・打ち手・基礎データ」
// （タイムライン以外）と、会議・週報・成果物の時系列（タイムライン）を
// 1画面で確認できるミニCRM的なページ。
// 日記は意味検索で「関連しそうな日記」として時系列側に別枠で補助表示する。
// データは /api/organizations（一覧）・/api/organizations/profile（タイムライン以外）・
// /api/organizations/timeline（タイムライン）。閲覧専用（読み取りのみ）。

type Organization = { name: string; count: number };

type TimelineEntry = {
  id: string;
  kind: "会議" | "成果物" | "週報";
  date: string;
  title: string;
  summary: string;
  url?: string;
};

type DiaryResult = {
  id: string;
  source_type: string;
  source_id: string;
  organization: string | null;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
  similarity: number;
};

type TimelineResponse = {
  organization: string;
  timeline: TimelineEntry[];
  relatedDiaries: DiaryResult[];
};

type ProfileWeek = {
  weekStart: string;
  category: string;
  organization: string | null;
  exact: boolean;
  summary: string;
};

type ProfileNote = {
  id: string;
  source: "週報" | "会議";
  date: string;
  label: string;
  text: string;
  latest?: boolean;
};

type ProfileResponse = {
  organization: string;
  status: {
    headline: ProfileWeek | null;
    recent: ProfileWeek[];
    fallback: { date: string; label: string; text: string } | null;
  };
  issues: ProfileNote[];
  tactics: ProfileNote[];
  basics: {
    master: { registered: boolean; category: string | null };
    meetingCount: number;
    weeklyCount: number;
    deliverableCount: number;
    firstContactDate: string | null;
    lastContactDate: string | null;
    daysSinceLastContact: number | null;
  };
  sparse: boolean;
  notes: string[];
};

const KIND_BADGE: Record<TimelineEntry["kind"], string> = {
  会議: "bg-blue-100 text-blue-700",
  週報: "bg-cyan-100 text-cyan-700",
  成果物: "bg-amber-100 text-amber-700",
};

const SOURCE_BADGE: Record<ProfileNote["source"], string> = {
  週報: "bg-cyan-100 text-cyan-700",
  会議: "bg-blue-100 text-blue-700",
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

function errorMessage(json: unknown, fallback: string): string {
  return json &&
    typeof json === "object" &&
    "error" in json &&
    typeof (json as { error?: unknown }).error === "string"
    ? (json as { error: string }).error
    : fallback;
}

function SectionHeading({ title, note }: { title: string; note: string }) {
  return (
    <div className="mb-3 border-l-4 border-indigo-500 pl-3">
      <h2 className="text-lg font-bold leading-tight text-gray-900">{title}</h2>
      <p className="text-xs text-gray-500">{note}</p>
    </div>
  );
}

function BlockCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-base font-bold text-gray-900">{title}</h3>
        {hint && <span className="text-xs text-gray-400">{hint}</span>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function EmptyLine({ text }: { text: string }) {
  return (
    <p className="rounded-xl border border-dashed border-gray-200 bg-gray-50/60 p-3 text-sm text-gray-500">
      {text}
    </p>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-gray-50 px-3 py-2">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-0.5 text-sm font-bold text-gray-900">{value}</p>
    </div>
  );
}

function NoteRow({ note }: { note: ProfileNote }) {
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${SOURCE_BADGE[note.source]}`}
        >
          {note.source}
        </span>
        {note.latest && (
          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
            最新
          </span>
        )}
        <span className="text-xs text-gray-500">{formatDate(note.date)}</span>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-gray-800">{note.text}</p>
      <p className="mt-1 text-[11px] text-gray-400">出所：{note.label}</p>
    </li>
  );
}

function ProfileBlock({ profile }: { profile: ProfileResponse }) {
  const { status, issues, tactics, basics, notes } = profile;
  // 主役に据えた週報は「直近の推移」から外す（同じ週に別団体名の週報が
  // 部分一致で入ることがあるので、週＋団体名の組で判定する）
  const olderWeeks = status.headline
    ? status.recent.filter(
        (w) =>
          !(
            w.weekStart === status.headline?.weekStart &&
            w.organization === status.headline?.organization
          )
      )
    : status.recent;

  return (
    <div className="space-y-4">
      {notes.length > 0 && (
        <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50/70 p-3">
          <p className="text-xs font-semibold text-amber-800">
            {profile.sparse ? "情報が少ない団体です" : "データについての注記"}
          </p>
          <ul className="mt-1 space-y-0.5">
            {notes.map((n) => (
              <li key={n} className="text-xs leading-relaxed text-amber-900">
                ・{n}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 状態 */}
      <BlockCard
        title="状態"
        hint={
          status.headline
            ? "週報の最新週が主役"
            : status.fallback
              ? "週報が無いため会議メモから"
              : undefined
        }
      >
        {status.headline ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-cyan-100 px-2 py-0.5 text-[11px] font-semibold text-cyan-700">
                {status.headline.weekStart} 週
              </span>
              <span className="text-xs text-gray-500">
                {status.headline.category}
              </span>
              {!status.headline.exact && status.headline.organization && (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">
                  {status.headline.organization}
                </span>
              )}
            </div>
            <p className="mt-2 text-sm leading-relaxed text-gray-800">
              {status.headline.summary}
            </p>
            {olderWeeks.length > 0 && (
              <div className="mt-3 border-t border-gray-100 pt-3">
                <p className="text-xs font-semibold text-gray-500">
                  直近の推移
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {olderWeeks.map((w) => (
                    <li key={`${w.weekStart}-${w.organization ?? ""}`} className="text-sm">
                      <span className="mr-2 text-xs text-gray-400">
                        {w.weekStart}
                      </span>
                      {!w.exact && w.organization && (
                        <span className="mr-1 text-xs text-gray-400">
                          [{w.organization}]
                        </span>
                      )}
                      <span className="text-gray-700">
                        {truncate(w.summary, 90)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : status.fallback ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                会議メモより
              </span>
              <span className="text-xs text-gray-500">
                {formatDate(status.fallback.date)}
              </span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-gray-800">
              {truncate(status.fallback.text, 300)}
            </p>
            <p className="mt-1 text-[11px] text-gray-400">
              出所：{status.fallback.label}
            </p>
          </>
        ) : (
          <EmptyLine text="状態を示す記録（週報・会議）がまだありません。" />
        )}
      </BlockCard>

      {/* 課題 */}
      <BlockCard title="課題" hint="週報の気づき＋会議メモの課題">
        {issues.length > 0 ? (
          <ul className="space-y-2">
            {issues.map((n) => (
              <NoteRow key={n.id} note={n} />
            ))}
          </ul>
        ) : (
          <EmptyLine text="課題として記録された記述は見つかりませんでした。" />
        )}
      </BlockCard>

      {/* 施策 */}
      <BlockCard title="施策（進行中の打ち手）" hint="直近3週の週報＋最新会議のアクション">
        {tactics.length > 0 ? (
          <ul className="space-y-2">
            {tactics.map((n) => (
              <NoteRow key={n.id} note={n} />
            ))}
          </ul>
        ) : (
          <EmptyLine text="打ち手として記録された記述は見つかりませんでした。" />
        )}
      </BlockCard>

      {/* 基礎データ */}
      <BlockCard title="基礎データ" hint="登録済みの記録から機械的に集計">
        <div className="flex flex-wrap items-center gap-2">
          {basics.master.registered ? (
            <>
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                マスタ登録あり
              </span>
              {basics.master.category && (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">
                  {basics.master.category}
                </span>
              )}
            </>
          ) : (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">
              マスタ未登録
            </span>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <StatTile label="会議" value={`${basics.meetingCount} 件`} />
          <StatTile label="週報" value={`${basics.weeklyCount} 週`} />
          <StatTile label="成果物" value={`${basics.deliverableCount} 件`} />
          <StatTile
            label="最終接点"
            value={
              basics.lastContactDate
                ? `${formatDate(basics.lastContactDate)}${
                    basics.daysSinceLastContact !== null
                      ? `（${basics.daysSinceLastContact}日前）`
                      : ""
                  }`
                : "記録なし"
            }
          />
        </div>
        {basics.firstContactDate && (
          <p className="mt-2 text-xs text-gray-500">
            初回接点：{formatDate(basics.firstContactDate)}
          </p>
        )}
      </BlockCard>
    </div>
  );
}

function TimelineCard({ entry }: { entry: TimelineEntry }) {
  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${KIND_BADGE[entry.kind]}`}
        >
          {entry.kind}
        </span>
        <span className="text-xs text-gray-500">{formatDate(entry.date)}</span>
      </div>
      <h3 className="mt-2 text-base font-bold leading-snug text-gray-900">
        {entry.title}
      </h3>
      <p className="mt-1.5 text-sm leading-relaxed text-gray-700">
        {truncate(entry.summary, 150)}
      </p>
    </article>
  );
}

function DiaryCard({ diary }: { diary: DiaryResult }) {
  return (
    <article className="rounded-xl border border-dashed border-emerald-200 bg-emerald-50/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
          日記
        </span>
        {diary.event_date && (
          <span className="text-xs text-gray-500">{formatDate(diary.event_date)}</span>
        )}
        <span className="ml-auto text-xs font-medium text-emerald-600">
          類似度 {Math.round(diary.similarity * 100)}%
        </span>
      </div>
      <h4 className="mt-2 text-sm font-bold leading-snug text-gray-900">
        {diary.title}
      </h4>
      <p className="mt-1 text-sm leading-relaxed text-gray-700">
        {truncate(diary.content, 150)}
      </p>
    </article>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10">
      <div
        className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600"
        role="status"
        aria-label={label}
      />
      <p className="text-sm text-gray-500">{label}</p>
    </div>
  );
}

function OrganizationsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const presetOrg = searchParams.get("org") ?? "";

  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [selected, setSelected] = useState(presetOrg);

  const [data, setData] = useState<TimelineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/organizations");
        const json: unknown = await res.json().catch(() => null);
        if (!active) return;
        if (!res.ok) {
          setOrgsError(errorMessage(json, "団体一覧の取得に失敗しました"));
          return;
        }
        const list =
          json && typeof json === "object" && Array.isArray((json as { organizations?: unknown }).organizations)
            ? ((json as { organizations: Organization[] }).organizations)
            : [];
        setOrgs(list);
      } catch {
        if (active) setOrgsError("団体一覧の取得に失敗しました");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const loadTimeline = useCallback(async (org: string) => {
    if (!org) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(
        `/api/organizations/timeline?org=${encodeURIComponent(org)}`,
        { cache: "no-store" }
      );
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(errorMessage(json, "取得に失敗しました"));
        return;
      }
      setData(json as TimelineResponse);
    } catch {
      setError("通信エラーが発生しました。接続を確認してください。");
    } finally {
      setLoading(false);
    }
  }, []);

  // 「タイムライン以外」はタイムラインと独立に取得する（片方が落ちても
  // もう片方は表示できるようにするため）。
  const loadProfile = useCallback(async (org: string) => {
    if (!org) return;
    setProfileLoading(true);
    setProfileError(null);
    setProfile(null);
    try {
      const res = await fetch(
        `/api/organizations/profile?org=${encodeURIComponent(org)}`,
        { cache: "no-store" }
      );
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setProfileError(errorMessage(json, "状態・課題・施策の取得に失敗しました"));
        return;
      }
      setProfile(json as ProfileResponse);
    } catch {
      setProfileError("通信エラーが発生しました。接続を確認してください。");
    } finally {
      setProfileLoading(false);
    }
  }, []);

  const load = useCallback(
    (org: string) => {
      loadProfile(org);
      loadTimeline(org);
    },
    [loadProfile, loadTimeline]
  );

  useEffect(() => {
    if (presetOrg) load(presetOrg);
  }, [presetOrg, load]);

  function handleSelect(org: string) {
    setSelected(org);
    router.push(org ? `/organizations?org=${encodeURIComponent(org)}` : "/organizations");
    if (org) load(org);
  }

  const sortedOrgs = useMemo(() => {
    if (!orgs) return [];
    return [...orgs].sort((a, b) => b.count - a.count);
  }, [orgs]);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link
          href="/"
          className="text-sm font-medium text-indigo-600 active:opacity-70"
        >
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          団体別攻略
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          団体を選ぶと、いまの状態・課題・施策（タイムライン以外）と、会議・週報・成果物の時系列（タイムライン）を1画面で確認できます
        </p>
      </header>

      {/* 団体セレクタ */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <label
          htmlFor="org-select"
          className="block text-sm font-medium text-gray-600"
        >
          団体を選択
        </label>
        <select
          id="org-select"
          value={selected}
          onChange={(e) => handleSelect(e.target.value)}
          disabled={!orgs}
          className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
        >
          <option value="">
            {orgs ? "団体を選んでください" : "読み込み中..."}
          </option>
          {sortedOrgs.map((o) => (
            <option key={o.name} value={o.name}>
              {o.name}（会議 {o.count}件）
            </option>
          ))}
        </select>
        {orgsError && <p className="mt-2 text-sm text-red-600">{orgsError}</p>}
      </div>

      {!selected && !loading && !profileLoading && (
        <div className="mt-6 rounded-xl border border-dashed border-gray-300 bg-white/60 p-6 text-center">
          <p className="text-sm leading-relaxed text-gray-600">
            団体を選んでください。
            <br />
            状態・課題・施策・基礎データと、時系列の記録をまとめて表示します。
          </p>
        </div>
      )}

      {/* ① タイムライン以外 */}
      {selected && (
        <section className="mt-8" aria-live="polite">
          <SectionHeading
            title="タイムライン以外"
            note="いまの状態・課題・施策・基礎データ（時系列ではない要約）"
          />
          {profileLoading && <Spinner label="状態を集計中…" />}
          {!profileLoading && profileError && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {profileError}
            </div>
          )}
          {!profileLoading && !profileError && profile && (
            <ProfileBlock profile={profile} />
          )}
        </section>
      )}

      {/* ② タイムライン */}
      {selected && (
        <section className="mt-10" aria-live="polite">
          <SectionHeading
            title="タイムライン"
            note="会議・週報・成果物を日付降順で。関連しそうな日記も参考表示"
          />

          {loading && <Spinner label="読み込み中…" />}

          {!loading && error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {error}
            </div>
          )}

          {!loading && !error && data && (
            <div className="space-y-8">
              <div>
                {data.timeline.length > 0 ? (
                  <div className="space-y-3">
                    {data.timeline.map((entry) => (
                      <TimelineCard key={entry.id} entry={entry} />
                    ))}
                  </div>
                ) : (
                  <p className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-500">
                    記録がありません。
                  </p>
                )}
              </div>

              <div>
                <h3 className="mb-1 text-base font-bold text-gray-900">
                  関連しそうな日記
                </h3>
                <p className="mb-3 text-xs text-gray-400">
                  ※AIが意味的に関連しそうと判断した日記です。時系列本体とは確度が異なる参考情報です。
                </p>
                {data.relatedDiaries.length > 0 ? (
                  <div className="space-y-3">
                    {data.relatedDiaries.map((diary) => (
                      <DiaryCard key={diary.id} diary={diary} />
                    ))}
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed border-gray-200 bg-white/60 p-4 text-sm text-gray-400">
                    関連しそうな日記は見つかりませんでした。
                  </p>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
      </div>
    </main>
  );
}

export default function OrganizationsPage() {
  return (
    <Suspense
      fallback={<main className="p-4 text-sm text-gray-500">読み込み中...</main>}
    >
      <OrganizationsInner />
    </Suspense>
  );
}

"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ORG_CATEGORIES, isOrgCategory, type OrgCategory } from "@/lib/categories";

// 団体別攻略：団体を選ぶと「現状 / 課題 / 施策 / 基礎データ / タイムライン」を
// タブで切り替えて確認できるミニCRM的なページ。
//
// 団体の選び方は2段階（2026-07-30 改修。42団体が単一ドロップダウンにベタ並びで
// 探せなかったため）:
//   ① 大ジャンル（正準8分類。lib/categories.ts の ORG_CATEGORIES）をチップで選ぶ
//   ② そのジャンルの団体をドロップダウンで選ぶ（接点の多い順）
// ジャンルは0件のものを出さない。ジャンル判定の根拠と並び順の根拠は
// lib/organizations.ts（resolveOrgCategory / compareOrgByContact）に書いてある。
//
// 各タブの中身は2階建て:
//   ① 吉井さんの手書きメモ（organization_notes）… 上に置く。編集・保存できる。
//   ② 自動導出（週報・会議・成果物から機械的に組み立てたもの）… 手書きメモがあっても消さない。
//
// データ取得:
//   /api/organizations?include=weekly … 団体一覧（会議由来＋週報由来＋ジャンル）
//   /api/organizations/profile        … 現状・課題・施策・基礎データ
//   /api/organizations/notes          … 手書きメモ（GET / PUT / DELETE）
//   /api/organizations/timeline       … タイムライン（タブが選ばれるまで取りに行かない）

type Organization = {
  name: string;
  count: number;
  weeklyCount?: number;
  /** 正準8分類のどれか。古い応答（未設定）は「その他」扱いにする。 */
  category?: string;
};

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

type NoteSection = "現状" | "課題" | "施策" | "基礎データ";

type OrganizationNote = {
  id: string;
  organization: string;
  section: NoteSection;
  content: string;
  created_at: string;
  updated_at: string;
};

type TabKey = "status" | "issues" | "tactics" | "basics" | "timeline";

type TabDef = {
  key: TabKey;
  label: string;
  /** 手書きメモの保存先セクション。タイムラインだけメモを持たない。 */
  section: NoteSection | null;
};

// 並び順：現状 → 課題 → 施策 → 基礎データ → タイムライン
const TABS: TabDef[] = [
  { key: "status", label: "現状", section: "現状" },
  { key: "issues", label: "課題", section: "課題" },
  { key: "tactics", label: "施策", section: "施策" },
  { key: "basics", label: "基礎データ", section: "基礎データ" },
  { key: "timeline", label: "タイムライン", section: null },
];

const DEFAULT_TAB: TabKey = "status";

function toTabKey(value: string | null): TabKey {
  return TABS.some((t) => t.key === value) ? (value as TabKey) : DEFAULT_TAB;
}

// ---------------------------------------------------------------------------
// 大ジャンル（正準8分類）
// ---------------------------------------------------------------------------

/** ジャンルで絞らない状態。URLには `?genre=all` として残す。 */
const ALL_GENRE = "all" as const;

type GenreKey = typeof ALL_GENRE | OrgCategory;

/**
 * 表示するジャンルの並び順は lib/categories.ts の ORG_CATEGORIES そのまま
 * （＝Notion会議DB `種別` の正準順）。ここで独自の並びを作らない。
 * 「その他」は判定できなかった団体の受け皿なので、末尾に来るこの順序で都合がよい。
 */
const GENRE_ORDER: readonly OrgCategory[] = ORG_CATEGORIES;

function toGenreKey(value: string | null): GenreKey | null {
  if (!value) return null;
  if (value === ALL_GENRE) return ALL_GENRE;
  return isOrgCategory(value) ? value : null;
}

/** API が返した category を正準8分類に落とす。未設定・未知の値は「その他」。 */
function orgGenre(o: Organization): OrgCategory {
  return isOrgCategory(o.category) ? o.category : "その他";
}

/**
 * ドロップダウンに出す団体名のラベル。接点件数を必ず添える
 * （これが並び順の根拠でもあるので、順序と表示を食い違わせない）。
 */
function orgOptionLabel(o: Organization): string {
  const weekly = o.weeklyCount ?? 0;
  if (o.count > 0 && weekly > 0) {
    return `${o.name}（会議 ${o.count}件・週報 ${weekly}週）`;
  }
  if (o.count > 0) return `${o.name}（会議 ${o.count}件）`;
  return `${o.name}（週報 ${weekly}週）`;
}

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

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${formatDate(iso)} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
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
          className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${SOURCE_BADGE[note.source]}`}
        >
          {note.source}
        </span>
        {note.latest && (
          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[0.6875rem] font-semibold text-indigo-700">
            最新
          </span>
        )}
        <span className="text-xs text-gray-500">{formatDate(note.date)}</span>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-gray-800">{note.text}</p>
      <p className="mt-1 text-[0.6875rem] text-gray-400">出所：{note.label}</p>
    </li>
  );
}

// ---------------------------------------------------------------------------
// 手書きメモ
// ---------------------------------------------------------------------------

// 自動導出の内容と混ざらないよう、手書きメモは琥珀色の枠で明示的に区別する。
function NoteEditor({
  section,
  note,
  loading,
  onSave,
  onDelete,
}: {
  section: NoteSection;
  note: OrganizationNote | null;
  loading: boolean;
  onSave: (section: NoteSection, content: string) => Promise<boolean>;
  onDelete: (section: NoteSection) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // 団体・セクションを切り替えたときは呼び出し側の key で作り直されるため、
  // ここで編集状態をリセットする必要はない（リセットすると保存直後の
  // 「保存しました」表示まで消えてしまう）。

  useEffect(() => {
    if (savedAt === null) return;
    const timer = setTimeout(() => setSavedAt(null), 3000);
    return () => clearTimeout(timer);
  }, [savedAt]);

  function startEditing() {
    setDraft(note?.content ?? "");
    setError(null);
    setEditing(true);
  }

  async function handleSave() {
    const content = draft.trim();
    if (content === "") {
      setError("メモが空です。削除する場合は「削除」を押してください。");
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await onSave(section, content);
    setBusy(false);
    if (ok) {
      setEditing(false);
      setSavedAt(Date.now());
    } else {
      setError("保存に失敗しました。通信状況を確認してもう一度お試しください。");
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    const ok = await onDelete(section);
    setBusy(false);
    if (ok) {
      setEditing(false);
      setDraft("");
    } else {
      setError("削除に失敗しました。");
    }
  }

  return (
    <section className="rounded-2xl border border-amber-300 bg-amber-50/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[0.6875rem] font-bold text-amber-900">
          手書きメモ
        </span>
        <span className="text-xs text-amber-800">吉井さんが書いた「{section}」</span>
        {savedAt !== null && (
          <span className="ml-auto text-xs font-semibold text-emerald-700">
            保存しました
          </span>
        )}
      </div>

      {loading ? (
        <p className="mt-3 text-sm text-amber-800">読み込み中…</p>
      ) : editing ? (
        <div className="mt-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            maxLength={5000}
            autoFocus
            placeholder={`「${section}」について、自分の言葉で書いておくこと`}
            className="block w-full resize-y rounded-xl border border-amber-300 bg-white px-3 py-2 text-sm leading-relaxed text-gray-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={busy}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white active:opacity-70 disabled:opacity-50"
            >
              {busy ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={busy}
              className="rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-800 active:opacity-70 disabled:opacity-50"
            >
              取消
            </button>
            {note && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={busy}
                className="ml-auto text-sm font-medium text-red-600 active:opacity-70 disabled:opacity-50"
              >
                削除
              </button>
            )}
          </div>
          <p className="mt-1 text-[0.6875rem] text-amber-700">{draft.length} / 5000 文字</p>
        </div>
      ) : note ? (
        <div className="mt-3">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-900">
            {note.content}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={startEditing}
              className="rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-sm font-semibold text-amber-800 active:opacity-70"
            >
              編集
            </button>
            <span className="text-[0.6875rem] text-amber-700">
              最終更新：{formatDateTime(note.updated_at)}
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm text-amber-800">
            手書きメモはまだありません。下の自動集計に足したいことを書けます。
          </p>
          <button
            type="button"
            onClick={startEditing}
            className="mt-2 rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-sm font-semibold text-amber-800 active:opacity-70"
          >
            メモを書く
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 各タブの自動導出パネル
// ---------------------------------------------------------------------------

function AutoLabel({ hint }: { hint: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[0.6875rem] font-bold text-indigo-700">
        自動集計
      </span>
      <span className="text-xs text-gray-500">{hint}</span>
    </div>
  );
}

function StatusPanel({ status }: { status: ProfileResponse["status"] }) {
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
    <BlockCard
      title="現状"
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
            <span className="rounded-full bg-cyan-100 px-2 py-0.5 text-[0.6875rem] font-semibold text-cyan-700">
              {status.headline.weekStart} 週
            </span>
            <span className="text-xs text-gray-500">{status.headline.category}</span>
            {!status.headline.exact && status.headline.organization && (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[0.6875rem] text-gray-600">
                {status.headline.organization}
              </span>
            )}
          </div>
          <p className="mt-2 text-sm leading-relaxed text-gray-800">
            {status.headline.summary}
          </p>
          {olderWeeks.length > 0 && (
            <div className="mt-3 border-t border-gray-100 pt-3">
              <p className="text-xs font-semibold text-gray-500">直近の推移</p>
              <ul className="mt-1.5 space-y-1.5">
                {olderWeeks.map((w) => (
                  <li key={`${w.weekStart}-${w.organization ?? ""}`} className="text-sm">
                    <span className="mr-2 text-xs text-gray-400">{w.weekStart}</span>
                    {!w.exact && w.organization && (
                      <span className="mr-1 text-xs text-gray-400">
                        [{w.organization}]
                      </span>
                    )}
                    <span className="text-gray-700">{truncate(w.summary, 90)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : status.fallback ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[0.6875rem] font-semibold text-blue-700">
              会議メモより
            </span>
            <span className="text-xs text-gray-500">
              {formatDate(status.fallback.date)}
            </span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-gray-800">
            {truncate(status.fallback.text, 300)}
          </p>
          <p className="mt-1 text-[0.6875rem] text-gray-400">
            出所：{status.fallback.label}
          </p>
        </>
      ) : (
        <EmptyLine text="記録なし（現状を示す週報・会議がまだありません）" />
      )}
    </BlockCard>
  );
}

function IssuesPanel({ issues }: { issues: ProfileNote[] }) {
  return (
    <BlockCard title="課題" hint="週報の気づき＋会議メモの課題">
      {issues.length > 0 ? (
        <ul className="space-y-2">
          {issues.map((n) => (
            <NoteRow key={n.id} note={n} />
          ))}
        </ul>
      ) : (
        <EmptyLine text="記録なし（課題として記録された記述は見つかりませんでした）" />
      )}
    </BlockCard>
  );
}

function TacticsPanel({ tactics }: { tactics: ProfileNote[] }) {
  return (
    <BlockCard title="施策（進行中の打ち手）" hint="直近3週の週報＋最新会議のアクション">
      {tactics.length > 0 ? (
        <ul className="space-y-2">
          {tactics.map((n) => (
            <NoteRow key={n.id} note={n} />
          ))}
        </ul>
      ) : (
        <EmptyLine text="記録なし（打ち手として記録された記述は見つかりませんでした）" />
      )}
    </BlockCard>
  );
}

function BasicsPanel({ basics }: { basics: ProfileResponse["basics"] }) {
  return (
    <BlockCard title="基礎データ" hint="登録済みの記録から機械的に集計">
      <div className="flex flex-wrap items-center gap-2">
        {basics.master.registered ? (
          <>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[0.6875rem] font-semibold text-emerald-700">
              マスタ登録あり
            </span>
            {basics.master.category && (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[0.6875rem] text-gray-600">
                {basics.master.category}
              </span>
            )}
          </>
        ) : (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[0.6875rem] font-semibold text-gray-600">
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
      <p className="mt-2 text-xs text-gray-500">
        初回接点：
        {basics.firstContactDate ? formatDate(basics.firstContactDate) : "記録なし"}
      </p>
    </BlockCard>
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

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

function OrganizationsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selected = searchParams.get("org")?.trim() ?? "";
  const activeTab = toTabKey(searchParams.get("tab"));
  const genreParam = toGenreKey(searchParams.get("genre"));

  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [orgsError, setOrgsError] = useState<string | null>(null);

  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [notes, setNotes] = useState<Partial<Record<NoteSection, OrganizationNote>>>({});
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);

  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  // タイムラインはタブが選ばれるまで取りに行かない（重いため）
  const [timelineRequestedFor, setTimelineRequestedFor] = useState<string | null>(null);

  // 団体一覧。週報にしか出てこない団体も選べるよう include=weekly で取る。
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/organizations?include=weekly", {
          cache: "no-store",
        });
        const json: unknown = await res.json().catch(() => null);
        if (!active) return;
        if (!res.ok) {
          setOrgsError(errorMessage(json, "団体一覧の取得に失敗しました"));
          return;
        }
        const list =
          json &&
          typeof json === "object" &&
          Array.isArray((json as { organizations?: unknown }).organizations)
            ? (json as { organizations: Organization[] }).organizations
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

  const loadProfile = useCallback(async (org: string) => {
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
        setProfileError(errorMessage(json, "現状・課題・施策の取得に失敗しました"));
        return;
      }
      setProfile(json as ProfileResponse);
    } catch {
      setProfileError("通信エラーが発生しました。接続を確認してください。");
    } finally {
      setProfileLoading(false);
    }
  }, []);

  const loadNotes = useCallback(async (org: string) => {
    setNotesLoading(true);
    setNotesError(null);
    setNotes({});
    try {
      const res = await fetch(
        `/api/organizations/notes?org=${encodeURIComponent(org)}`,
        { cache: "no-store" }
      );
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setNotesError(errorMessage(json, "手書きメモの取得に失敗しました"));
        return;
      }
      const rows =
        json && typeof json === "object" && Array.isArray((json as { notes?: unknown }).notes)
          ? (json as { notes: OrganizationNote[] }).notes
          : [];
      const map: Partial<Record<NoteSection, OrganizationNote>> = {};
      for (const row of rows) map[row.section] = row;
      setNotes(map);
    } catch {
      setNotesError("手書きメモの取得で通信エラーが発生しました。");
    } finally {
      setNotesLoading(false);
    }
  }, []);

  const loadTimeline = useCallback(async (org: string) => {
    setTimelineLoading(true);
    setTimelineError(null);
    setTimeline(null);
    try {
      const res = await fetch(
        `/api/organizations/timeline?org=${encodeURIComponent(org)}`,
        { cache: "no-store" }
      );
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setTimelineError(errorMessage(json, "タイムラインの取得に失敗しました"));
        return;
      }
      setTimeline(json as TimelineResponse);
    } catch {
      setTimelineError("通信エラーが発生しました。接続を確認してください。");
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  // 団体が変わったら現状・課題・施策・基礎データとメモを取り直し、タイムラインは捨てる
  useEffect(() => {
    setTimeline(null);
    setTimelineError(null);
    setTimelineRequestedFor(null);
    if (!selected) {
      setProfile(null);
      setProfileError(null);
      setNotes({});
      setNotesError(null);
      return;
    }
    loadProfile(selected);
    loadNotes(selected);
  }, [selected, loadProfile, loadNotes]);

  // 遅延ロード：タイムラインタブが選ばれた最初の1回だけ取りに行く
  useEffect(() => {
    if (activeTab !== "timeline" || !selected) return;
    if (timelineRequestedFor === selected) return;
    setTimelineRequestedFor(selected);
    loadTimeline(selected);
  }, [activeTab, selected, timelineRequestedFor, loadTimeline]);

  // ジャンル・団体・タブの3点をURLに保持する（リロード・共有・戻るで復元できる）。
  const pushQuery = useCallback(
    (genre: GenreKey | null, org: string, tab: TabKey) => {
      const params = new URLSearchParams();
      if (genre) params.set("genre", genre);
      if (org) {
        params.set("org", org);
        params.set("tab", tab);
      }
      const qs = params.toString();
      router.push(qs ? `/organizations?${qs}` : "/organizations");
    },
    [router]
  );

  const saveNote = useCallback(
    async (section: NoteSection, content: string): Promise<boolean> => {
      if (!selected) return false;
      try {
        const res = await fetch("/api/organizations/notes", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organization: selected, section, content }),
        });
        if (!res.ok) return false;
        const json: unknown = await res.json().catch(() => null);
        const note =
          json && typeof json === "object"
            ? ((json as { note?: OrganizationNote | null }).note ?? null)
            : null;
        if (!note) return false;
        setNotes((prev) => ({ ...prev, [section]: note }));
        return true;
      } catch {
        return false;
      }
    },
    [selected]
  );

  const deleteNote = useCallback(
    async (section: NoteSection): Promise<boolean> => {
      if (!selected) return false;
      try {
        const res = await fetch(
          `/api/organizations/notes?org=${encodeURIComponent(
            selected
          )}&section=${encodeURIComponent(section)}`,
          { method: "DELETE" }
        );
        if (!res.ok) return false;
        setNotes((prev) => {
          const next = { ...prev };
          delete next[section];
          return next;
        });
        return true;
      } catch {
        return false;
      }
    },
    [selected]
  );

  // 接点の多い順（会議件数＋週報週数の降順）。APIも同じ順で返すが、順序の根拠を
  // 画面側にも残しておく（根拠の詳細は lib/organizations.ts の orgContactScore を参照）。
  const sortedOrgs = useMemo(() => {
    if (!orgs) return [];
    return [...orgs].sort(
      (a, b) =>
        (b.count + (b.weeklyCount ?? 0)) - (a.count + (a.weeklyCount ?? 0)) ||
        b.count - a.count ||
        (b.weeklyCount ?? 0) - (a.weeklyCount ?? 0) ||
        a.name.localeCompare(b.name, "ja")
    );
  }, [orgs]);

  // 団体が1つ以上あるジャンルだけをチップに出す（空振りさせない）。
  const genreCounts = useMemo(() => {
    const counts = new Map<OrgCategory, number>();
    for (const o of sortedOrgs) {
      const g = orgGenre(o);
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return GENRE_ORDER.filter((g) => (counts.get(g) ?? 0) > 0).map((g) => ({
      genre: g,
      count: counts.get(g) as number,
    }));
  }, [sortedOrgs]);

  // URLに genre が無いまま ?org=… で来た場合（他ページからのリンク・古いブックマーク）は、
  // その団体のジャンルを選択済みとして扱い、チップとドロップダウンの表示を揃える。
  const activeGenre: GenreKey | null = useMemo(() => {
    if (genreParam) return genreParam;
    if (!selected) return null;
    const hit = sortedOrgs.find((o) => o.name === selected);
    return hit ? orgGenre(hit) : null;
  }, [genreParam, selected, sortedOrgs]);

  const visibleOrgs = useMemo(() => {
    if (!activeGenre) return [];
    if (activeGenre === ALL_GENRE) return sortedOrgs;
    return sortedOrgs.filter((o) => orgGenre(o) === activeGenre);
  }, [sortedOrgs, activeGenre]);

  // タブの件数バッジ。自動導出の件数を出す（未取得のタイムラインは null＝バッジ無し）。
  const tabCounts: Record<TabKey, number | null> = useMemo(() => {
    if (!profile) {
      return {
        status: null,
        issues: null,
        tactics: null,
        basics: null,
        timeline: timeline ? timeline.timeline.length : null,
      };
    }
    const statusCount = profile.status.headline
      ? Math.max(profile.status.recent.length, 1)
      : profile.status.fallback
        ? 1
        : 0;
    return {
      status: statusCount,
      issues: profile.issues.length,
      tactics: profile.tactics.length,
      basics:
        profile.basics.meetingCount +
        profile.basics.weeklyCount +
        profile.basics.deliverableCount,
      timeline: timeline ? timeline.timeline.length : null,
    };
  }, [profile, timeline]);

  const activeDef = TABS.find((t) => t.key === activeTab) ?? TABS[0];

  function renderAutoPanel() {
    if (profileLoading) return <Spinner label="集計中…" />;
    if (profileError) return <ErrorBox message={profileError} />;
    if (!profile) return null;
    switch (activeTab) {
      case "status":
        return <StatusPanel status={profile.status} />;
      case "issues":
        return <IssuesPanel issues={profile.issues} />;
      case "tactics":
        return <TacticsPanel tactics={profile.tactics} />;
      case "basics":
        return <BasicsPanel basics={profile.basics} />;
      default:
        return null;
    }
  }

  function renderTimelineTab() {
    if (timelineLoading) return <Spinner label="タイムラインを読み込み中…" />;
    if (timelineError) return <ErrorBox message={timelineError} />;
    if (!timeline) return null;
    return (
      <div className="space-y-8">
        <div>
          <AutoLabel hint="会議・週報・成果物を日付降順で" />
          <div className="mt-3">
            {timeline.timeline.length > 0 ? (
              <div className="space-y-3">
                {timeline.timeline.map((entry) => (
                  <TimelineCard key={entry.id} entry={entry} />
                ))}
              </div>
            ) : (
              <EmptyLine text="記録なし（会議・週報・成果物がまだ登録されていません）" />
            )}
          </div>
        </div>

        <div>
          <h3 className="mb-1 text-base font-bold text-gray-900">関連しそうな日記</h3>
          <p className="mb-3 text-xs text-gray-400">
            ※AIが意味的に関連しそうと判断した日記です。時系列本体とは確度が異なる参考情報です。
          </p>
          {timeline.relatedDiaries.length > 0 ? (
            <div className="space-y-3">
              {timeline.relatedDiaries.map((diary) => (
                <DiaryCard key={diary.id} diary={diary} />
              ))}
            </div>
          ) : (
            <EmptyLine text="記録なし（関連しそうな日記は見つかりませんでした）" />
          )}
        </div>
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          団体別攻略
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          団体を選び、現状・課題・施策・基礎データ・タイムラインをタブで切り替えて確認できます。各タブには手書きメモを残せます。
        </p>
      </header>

      {/* 団体セレクタ（① ジャンル → ② 団体 の2段階） */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-medium text-gray-600">
          <span className="mr-1 font-bold text-indigo-600">①</span>ジャンルを選択
        </p>
        {/* チップは PC でもスマホでも押しやすいよう、折り返し・十分な余白で並べる */}
        <div className="mt-2 flex flex-wrap gap-2">
          {!orgs ? (
            <span className="text-sm text-gray-400">読み込み中...</span>
          ) : genreCounts.length === 0 ? (
            <span className="text-sm text-gray-400">団体がまだ登録されていません</span>
          ) : (
            <>
              {genreCounts.map(({ genre, count }) => {
                const isActive = activeGenre === genre;
                return (
                  <button
                    key={genre}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => pushQuery(genre, "", activeTab)}
                    className={`min-h-11 whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold transition active:opacity-70 ${
                      isActive
                        ? "border-indigo-600 bg-indigo-600 text-white"
                        : "border-gray-300 bg-white text-gray-700"
                    }`}
                  >
                    {genre}
                    <span
                      className={`ml-1 text-xs font-bold ${
                        isActive ? "text-indigo-100" : "text-gray-400"
                      }`}
                    >
                      ({count})
                    </span>
                  </button>
                );
              })}
              {/* 逃げ道。ジャンル判定が実データ次第なので、全件から探せる道は残す。 */}
              <button
                type="button"
                aria-pressed={activeGenre === ALL_GENRE}
                onClick={() => pushQuery(ALL_GENRE, "", activeTab)}
                className={`min-h-11 whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold transition active:opacity-70 ${
                  activeGenre === ALL_GENRE
                    ? "border-gray-700 bg-gray-700 text-white"
                    : "border-dashed border-gray-300 bg-white text-gray-500"
                }`}
              >
                すべて
                <span
                  className={`ml-1 text-xs font-bold ${
                    activeGenre === ALL_GENRE ? "text-gray-200" : "text-gray-400"
                  }`}
                >
                  ({sortedOrgs.length})
                </span>
              </button>
            </>
          )}
        </div>

        <label
          htmlFor="org-select"
          className="mt-4 block text-sm font-medium text-gray-600"
        >
          <span className="mr-1 font-bold text-indigo-600">②</span>団体を選択
          {activeGenre && activeGenre !== ALL_GENRE && (
            <span className="ml-1 text-xs font-normal text-gray-400">
              （{activeGenre}・接点の多い順）
            </span>
          )}
        </label>
        <select
          id="org-select"
          value={selected}
          onChange={(e) => pushQuery(activeGenre, e.target.value, activeTab)}
          disabled={!orgs || !activeGenre}
          className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-gray-50 disabled:opacity-60"
        >
          <option value="">
            {!orgs
              ? "読み込み中..."
              : !activeGenre
                ? "先にジャンルを選んでください"
                : "団体を選んでください"}
          </option>
          {visibleOrgs.map((o) => (
            <option key={o.name} value={o.name}>
              {orgOptionLabel(o)}
            </option>
          ))}
        </select>
        {orgsError && <p className="mt-2 text-sm text-red-600">{orgsError}</p>}
      </div>

      {!selected && (
        <div className="mt-6 rounded-xl border border-dashed border-gray-300 bg-white/60 p-6 text-center">
          <p className="text-sm leading-relaxed text-gray-600">
            {activeGenre
              ? "団体を選んでください。"
              : "まずジャンルを選び、その中から団体を選んでください。"}
            <br />
            現状・課題・施策・基礎データ・タイムラインをタブで切り替えて見られます。
          </p>
        </div>
      )}

      {selected && (
        <>
          {/* データの薄さについての注記（タブに関係なく常に出す） */}
          {profile && profile.notes.length > 0 && (
            <div className="mt-6 rounded-xl border border-dashed border-amber-300 bg-amber-50/70 p-3">
              <p className="text-xs font-semibold text-amber-800">
                {profile.sparse ? "情報が少ない団体です" : "データについての注記"}
              </p>
              <ul className="mt-1 space-y-0.5">
                {profile.notes.map((n) => (
                  <li key={n} className="text-xs leading-relaxed text-amber-900">
                    ・{n}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* タブ */}
          <nav
            className="mt-6 -mx-4 overflow-x-auto px-4"
            aria-label="団体別攻略のタブ"
          >
            <div className="flex w-max gap-2" role="tablist">
              {TABS.map((t) => {
                const isActive = t.key === activeTab;
                const count = tabCounts[t.key];
                const hasNote = t.section ? !!notes[t.section] : false;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => pushQuery(activeGenre, selected, t.key)}
                    className={`whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold transition active:opacity-70 ${
                      isActive
                        ? "border-indigo-600 bg-indigo-600 text-white"
                        : "border-gray-300 bg-white text-gray-700"
                    }`}
                  >
                    {t.label}
                    {count !== null && (
                      <span
                        className={`ml-1 text-xs font-bold ${
                          isActive ? "text-indigo-100" : "text-gray-400"
                        }`}
                      >
                        ({count})
                      </span>
                    )}
                    {hasNote && (
                      <span
                        className={`ml-1 text-xs ${
                          isActive ? "text-amber-200" : "text-amber-600"
                        }`}
                        title="手書きメモあり"
                      >
                        ✎
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </nav>

          <section className="mt-4 space-y-4" aria-live="polite">
            {/* 手書きメモ（自動集計より上）。タイムラインタブにはメモを置かない。 */}
            {activeDef.section && (
              <>
                <NoteEditor
                  key={`${selected}:${activeDef.section}`}
                  section={activeDef.section}
                  note={notes[activeDef.section] ?? null}
                  loading={notesLoading}
                  onSave={saveNote}
                  onDelete={deleteNote}
                />
                {notesError && <ErrorBox message={notesError} />}
              </>
            )}

            {/* 自動導出 */}
            {activeTab === "timeline" ? (
              renderTimelineTab()
            ) : (
              <div className="space-y-2">
                <AutoLabel hint="週報・会議・成果物から機械的に集計" />
                {renderAutoPanel()}
              </div>
            )}
          </section>
        </>
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

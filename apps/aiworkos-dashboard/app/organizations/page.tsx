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
//   /api/organizations/influence      … 影響力マップ（同上。抽出・確定・削除もここ）

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

// 影響力マップ（/api/organizations/influence）。人物＝点、関係＝線。
// draft は AI 抽出の下書きで、吉井さんが「確定」を押すまで事実扱いしない。
type InfluenceEdge = {
  id: string;
  org_name: string;
  from_person: string;
  to_person: string;
  relation: string;
  note: string | null;
  source_ref: string | null;
  status: "draft" | "confirmed";
  created_at: string;
  updated_at: string;
};

type InfluencePerson = {
  name: string;
  department: string | null;
  title: string | null;
  flag: string | null;
};

type InfluenceResponse = {
  organization: string;
  edges: InfluenceEdge[];
  people: InfluencePerson[];
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

type TabKey = "status" | "issues" | "tactics" | "basics" | "influence" | "timeline";

type TabDef = {
  key: TabKey;
  label: string;
  /** 手書きメモの保存先セクション。タイムラインだけメモを持たない。 */
  section: NoteSection | null;
};

// 並び順：現状 → 課題 → 施策 → 基礎データ → 影響力 → タイムライン
// 影響力（影響力マップ）は手書きメモを持たない（線の1本1本に根拠と確定操作があるため、
// タブ全体への自由メモは置かない。タイムラインと同じ扱い）。
const TABS: TabDef[] = [
  { key: "status", label: "現状", section: "現状" },
  { key: "issues", label: "課題", section: "課題" },
  { key: "tactics", label: "施策", section: "施策" },
  { key: "basics", label: "基礎データ", section: "基礎データ" },
  { key: "influence", label: "影響力", section: null },
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
  // 保存/削除の成功バッジ（同じ枠に「保存しました」「削除しました」を出す）
  const [flash, setFlash] = useState<string | null>(null);

  // 団体・セクションを切り替えたときは呼び出し側の key で作り直されるため、
  // ここで編集状態をリセットする必要はない（リセットすると保存直後の
  // 「保存しました」表示まで消えてしまう）。

  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), 3000);
    return () => clearTimeout(timer);
  }, [flash]);

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
      setFlash("保存しました");
    } else {
      setError("保存に失敗しました。通信状況を確認してもう一度お試しください。");
    }
  }

  async function handleDelete() {
    // 「取消」の真横にあるボタンなので、誤タップで即消えないよう必ず確認を挟む
    if (
      !window.confirm(
        `「${section}」の手書きメモを削除します。元に戻せません。よろしいですか？`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await onDelete(section);
    setBusy(false);
    if (ok) {
      setEditing(false);
      setDraft("");
      setFlash("削除しました");
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
        {flash !== null && (
          <span className="ml-auto text-xs font-semibold text-emerald-700">
            {flash}
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
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white active:opacity-70 disabled:opacity-50"
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
                className="ml-auto text-sm font-medium text-rose-600 active:opacity-70 disabled:opacity-50"
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

      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
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

// ---------------------------------------------------------------------------
// 影響力マップ（点＝人物カード、線＝関係の行リスト）
// ---------------------------------------------------------------------------

// 人脈DBは「点」の名簿。ここでは点を薄く並べ、主役は下の「線」に譲る。
function InfluencePersonChip({ person }: { person: InfluencePerson }) {
  const sub = [person.department, person.title].filter((s) => !!s).join(" ");
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-bold text-gray-900">{person.name}</span>
        {person.flag && (
          <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-rose-700">
            {person.flag}
          </span>
        )}
      </div>
      {sub && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

// 「A →(後任) B」の矢印。依存パッケージを増やさず、軽いインラインSVGで済ませる。
function RelationArrow({ relation }: { relation: string }) {
  return (
    <span className="flex shrink-0 flex-col items-center px-0.5 text-gray-400">
      <span className="text-xs font-semibold leading-none text-gray-500">
        {relation}
      </span>
      <svg width="44" height="10" viewBox="0 0 44 10" aria-hidden="true" className="mt-0.5">
        <line x1="0" y1="5" x2="35" y2="5" stroke="currentColor" strokeWidth="1.5" />
        <polygon points="35,1 43,5 35,9" fill="currentColor" />
      </svg>
    </span>
  );
}

// 関係1本の行。draft（AI下書き）は琥珀色で「まだ事実ではない」ことを明示し、
// 吉井さんの「確定」で通常表示（confirmed）へ昇格する。
function InfluenceEdgeRow({
  edge,
  busy,
  onConfirm,
  onDelete,
}: {
  edge: InfluenceEdge;
  busy: boolean;
  onConfirm: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const isDraft = edge.status === "draft";
  return (
    <li
      className={`rounded-xl border p-3 ${
        isDraft ? "border-amber-300 bg-amber-50/60" : "border-gray-200 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {isDraft && (
          <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[0.6875rem] font-bold text-amber-900">
            下書き
          </span>
        )}
        <span className="text-sm font-bold text-gray-900">{edge.from_person}</span>
        <RelationArrow relation={edge.relation} />
        <span className="text-sm font-bold text-gray-900">{edge.to_person}</span>
      </div>
      {edge.note && (
        <p className="mt-1.5 text-xs leading-relaxed text-gray-600">根拠：{edge.note}</p>
      )}
      {edge.source_ref && (
        <p className="mt-0.5 text-[0.6875rem] text-gray-400">出所：{edge.source_ref}</p>
      )}
      <div className="mt-2 flex items-center gap-3">
        {isDraft && (
          <button
            type="button"
            onClick={() => onConfirm(edge.id)}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white active:opacity-70 disabled:opacity-50"
          >
            確定
          </button>
        )}
        <button
          type="button"
          onClick={() => onDelete(edge.id)}
          disabled={busy}
          className="ml-auto text-xs font-medium text-rose-600 active:opacity-70 disabled:opacity-50"
        >
          削除
        </button>
      </div>
    </li>
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

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
      {message}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 block rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm font-semibold text-rose-700 active:opacity-70"
        >
          もう一度読み込む
        </button>
      )}
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
  // 取得失敗時に「再試行」で fetch し直すためのキー
  const [orgsReloadKey, setOrgsReloadKey] = useState(0);

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

  // 影響力マップ。タイムラインと同じく、タブが選ばれるまで取りに行かない。
  const [influence, setInfluence] = useState<InfluenceResponse | null>(null);
  const [influenceLoading, setInfluenceLoading] = useState(false);
  const [influenceError, setInfluenceError] = useState<string | null>(null);
  const [influenceRequestedFor, setInfluenceRequestedFor] = useState<string | null>(null);
  // 抽出（Claude呼び出し）と行操作は多重実行させない
  const [extracting, setExtracting] = useState(false);
  const [extractMessage, setExtractMessage] = useState<string | null>(null);
  const [edgeBusyId, setEdgeBusyId] = useState<string | null>(null);

  // 団体一覧。週報にしか出てこない団体も選べるよう include=weekly で取る。
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setOrgsError(null);
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
  }, [orgsReloadKey]);

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

  const loadInfluence = useCallback(async (org: string) => {
    setInfluenceLoading(true);
    setInfluenceError(null);
    setInfluence(null);
    try {
      const res = await fetch(
        `/api/organizations/influence?org=${encodeURIComponent(org)}`,
        { cache: "no-store" }
      );
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setInfluenceError(errorMessage(json, "影響力マップの取得に失敗しました"));
        return;
      }
      setInfluence(json as InfluenceResponse);
    } catch {
      setInfluenceError("通信エラーが発生しました。接続を確認してください。");
    } finally {
      setInfluenceLoading(false);
    }
  }, []);

  // 会議録＋人脈DBメモから関係を抽出（draft 保存）。終わったら一覧を取り直す。
  const runExtract = useCallback(async () => {
    if (!selected || extracting) return;
    setExtracting(true);
    setExtractMessage(null);
    setInfluenceError(null);
    try {
      const res = await fetch("/api/organizations/influence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org: selected, action: "extract" }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setInfluenceError(errorMessage(json, "関係の抽出に失敗しました"));
        return;
      }
      const r = json as { insertedCount?: number; duplicateCount?: number };
      const added = r.insertedCount ?? 0;
      const dup = r.duplicateCount ?? 0;
      setExtractMessage(
        added > 0
          ? `${added}件の関係を下書きとして追加しました${dup > 0 ? `（既存と重複 ${dup}件は除外）` : ""}`
          : dup > 0
            ? `新しい関係はありませんでした（既存と重複 ${dup}件）`
            : "資料から読み取れる新しい関係はありませんでした"
      );
      await loadInfluence(selected);
    } catch {
      setInfluenceError("通信エラーが発生しました。接続を確認してください。");
    } finally {
      setExtracting(false);
    }
  }, [selected, extracting, loadInfluence]);

  // draft → confirmed。楽観更新はせず、APIの返した行で置き換える（状態のズレ防止）。
  const confirmEdge = useCallback(async (id: string) => {
    setEdgeBusyId(id);
    try {
      const res = await fetch("/api/organizations/influence", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: "confirmed" }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setInfluenceError(errorMessage(json, "確定に失敗しました"));
        return;
      }
      const edge =
        json && typeof json === "object"
          ? ((json as { edge?: InfluenceEdge | null }).edge ?? null)
          : null;
      if (!edge) return;
      setInfluence((prev) =>
        prev
          ? { ...prev, edges: prev.edges.map((e) => (e.id === id ? edge : e)) }
          : prev
      );
    } catch {
      setInfluenceError("通信エラーが発生しました。接続を確認してください。");
    } finally {
      setEdgeBusyId(null);
    }
  }, []);

  const deleteEdge = useCallback(async (id: string) => {
    // 目視で確定した営業インテリジェンスが根拠メモごと消えるため、必ず確認を挟む
    if (
      !window.confirm(
        "この関係の線を削除します。根拠メモも一緒に消えます。元に戻せません。よろしいですか？"
      )
    ) {
      return;
    }
    setEdgeBusyId(id);
    try {
      const res = await fetch(
        `/api/organizations/influence?id=${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => null);
        setInfluenceError(errorMessage(json, "削除に失敗しました"));
        return;
      }
      setInfluence((prev) =>
        prev ? { ...prev, edges: prev.edges.filter((e) => e.id !== id) } : prev
      );
    } catch {
      setInfluenceError("通信エラーが発生しました。接続を確認してください。");
    } finally {
      setEdgeBusyId(null);
    }
  }, []);

  // 団体が変わったら現状・課題・施策・基礎データとメモを取り直し、
  // タイムライン・影響力マップは捨てる（次にタブが選ばれたとき取り直す）
  useEffect(() => {
    setTimeline(null);
    setTimelineError(null);
    setTimelineRequestedFor(null);
    setInfluence(null);
    setInfluenceError(null);
    setInfluenceRequestedFor(null);
    setExtractMessage(null);
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

  // 遅延ロード：影響力タブも同じ方式
  useEffect(() => {
    if (activeTab !== "influence" || !selected) return;
    if (influenceRequestedFor === selected) return;
    setInfluenceRequestedFor(selected);
    loadInfluence(selected);
  }, [activeTab, selected, influenceRequestedFor, loadInfluence]);

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
        influence: influence ? influence.edges.length : null,
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
      influence: influence ? influence.edges.length : null,
      timeline: timeline ? timeline.timeline.length : null,
    };
  }, [profile, timeline, influence]);

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

  function renderInfluenceTab() {
    if (influenceLoading) return <Spinner label="影響力マップを読み込み中…" />;
    if (!influence && influenceError)
      return (
        <ErrorBox
          message={influenceError}
          onRetry={() => {
            // 取得済みガードを倒してから effect に再fetchさせる
            setInfluenceError(null);
            setInfluenceRequestedFor(null);
          }}
        />
      );
    if (!influence) return null;

    // 下書き（要確認）を上に出し、確認待ちが埋もれないようにする。
    const drafts = influence.edges.filter((e) => e.status === "draft");
    const confirmed = influence.edges.filter((e) => e.status === "confirmed");

    return (
      <div className="space-y-4">
        {/* 抽出の入り口。draft を増やすだけで、確定は必ず行ごとの目視操作。 */}
        <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold text-gray-900">影響力マップ</h3>
            <span className="text-xs text-gray-400">誰が誰に影響するかの「線」</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-gray-500">
            会議録の同席情報と人脈DBのメモ欄（後任など）から、AIが人物間の関係を下書きとして抽出します。確定するまで事実扱いにはなりません。
          </p>
          <button
            type="button"
            onClick={runExtract}
            disabled={extracting}
            className="mt-3 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white active:opacity-70 disabled:opacity-50"
          >
            {extracting ? "抽出中…（1分ほどかかります）" : "会議録から関係を抽出"}
          </button>
          {extractMessage && (
            <p className="mt-2 text-sm font-medium text-emerald-700">{extractMessage}</p>
          )}
          {influenceError && <p className="mt-2 text-sm text-rose-600">{influenceError}</p>}
        </section>

        <BlockCard title="人物" hint="人脈DB（Notionの写し）から">
          {influence.people.length > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              {influence.people.map((p) => (
                <InfluencePersonChip key={p.name} person={p} />
              ))}
            </div>
          ) : (
            <EmptyLine text="記録なし（この団体の人物はまだ人脈DBに登録されていません）" />
          )}
        </BlockCard>

        <BlockCard
          title="影響の線"
          hint={
            drafts.length > 0
              ? `下書き ${drafts.length}件が確認待ち`
              : "確定済みの関係だけが表示されています"
          }
        >
          {influence.edges.length > 0 ? (
            <ul className="space-y-2">
              {[...drafts, ...confirmed].map((e) => (
                <InfluenceEdgeRow
                  key={e.id}
                  edge={e}
                  busy={edgeBusyId === e.id}
                  onConfirm={confirmEdge}
                  onDelete={deleteEdge}
                />
              ))}
            </ul>
          ) : (
            <EmptyLine text="記録なし（「会議録から関係を抽出」で下書きを作れます）" />
          )}
        </BlockCard>
      </div>
    );
  }

  function renderTimelineTab() {
    if (timelineLoading) return <Spinner label="タイムラインを読み込み中…" />;
    if (timelineError)
      return (
        <ErrorBox
          message={timelineError}
          onRetry={() => {
            // 取得済みガードを倒してから effect に再fetchさせる
            setTimelineError(null);
            setTimelineRequestedFor(null);
          }}
        />
      );
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
        <div className="flex items-center justify-between">
          <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
            ← ホーム
          </Link>
          <Link
            href="/legislators"
            className="text-sm font-medium text-indigo-600 active:opacity-70"
          >
            🏛️ 議員リスト →
          </Link>
        </div>
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
            orgsError ? (
              <span className="text-sm text-rose-600">
                団体一覧を読み込めませんでした
              </span>
            ) : (
              <span className="text-sm text-gray-400">読み込み中...</span>
            )
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
              ? orgsError
                ? "団体一覧を取得できませんでした"
                : "読み込み中..."
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
        {orgsError && (
          <div className="mt-2">
            <ErrorBox
              message={orgsError}
              onRetry={() => setOrgsReloadKey((k) => k + 1)}
            />
          </div>
        )}
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
            {activeTab === "influence" ? (
              renderInfluenceTab()
            ) : activeTab === "timeline" ? (
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

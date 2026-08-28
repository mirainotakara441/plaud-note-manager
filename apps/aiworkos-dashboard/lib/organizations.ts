// 団体別攻略（/organizations）の共通データ層。
//
// 「タイムライン」（/api/organizations/timeline）と「タイムライン以外」
// （/api/organizations/profile）の両方が、同じ取得ロジック・同じ名寄せルールを
// 使えるように切り出したもの。取得元は3つ、いずれも organization 完全一致（eq）:
//   - 会議   : Edge Function org-history（memory_chunks の source_type=会議、organization 完全一致）
//   - 成果物 : memory_chunks 直叩き（source_type=成果物、organization 完全一致）
//   - 週報   : weekly_reports（organization 完全一致。2026-08-19以前はILIKE部分一致で、
//              「横浜市」検索が「尾崎横浜市議会議員」まで拾う誤爆があった）
//
// memory_chunks は RLS で anon の SELECT を許可していないため必ず serviceCreds()。
// weekly_reports / stakeholders は anon に SELECT を許可しているため anonCreds() でよい。
// Edge Function（org-history / search-memory）は anon キーを Bearer で呼ぶ。

import { restHeaders } from "@/lib/supabase";
import { toJstDateString } from "@/lib/date";
import { normalizeOrgCategory, type OrgCategory } from "@/lib/categories";

export type Meeting = {
  id: string;
  source_type: string;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
  organization: string | null;
};

export type DeliverableChunk = {
  id: string;
  title: string;
  content: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type WeeklyReportRow = {
  id: string;
  week_start: string;
  category: string;
  organization: string | null;
  summary: string;
  insight: string | null;
  tactic: string | null;
  created_at: string;
};

export type DiaryResult = {
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

export type TimelineEntry = {
  id: string;
  kind: "会議" | "成果物" | "週報";
  date: string;
  title: string;
  summary: string;
  url?: string;
};

// 会議1件（チャンクをまとめたもの）
export type MeetingDoc = {
  id: string;
  title: string;
  date: string;
  /** 全チャンクを位置順に連結した本文。課題・アクションの抽出はこちらを使う */
  content: string;
};

// 成果物1件（チャンクをまとめたもの）
export type DeliverableDoc = {
  id: string;
  title: string;
  date: string;
  /** 代表チャンク（位置が最小）の本文。タイムラインの要約はこちらを使う */
  leadContent: string;
};

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

// 「{タイトル}｜{n}/{全n}」形式の末尾チャンク番号を取り除く
/**
 * タイトル末尾に積まれたチャンク番号を落として、親（文書）のタイトルに戻す。
 *
 * ■ なぜ書き換えたか（2026-08-28）
 * 以前は `｜1/16` 形式しか落としておらず、実データにある他の形式が残っていた。
 * その結果、1つの文書のチャンクが別々の文書として数えられていた。
 *
 * ■ 実データにある形式（監査で数えたもの。ここに無い形は消さない）
 *   ｜1/16    18件   ｜text1  119件   ｜p1     19件
 *   ｜p10-1   39件   ｜1（裸の数字） 621件（会議・日記・学び・学会・成果物・振り返りの6種別）
 * `｜slide1` `｜img1` も同じ書き手が使う形式なので含める。
 *
 * ■ 接尾辞は積み重なる
 * 「…｜報告書｜slide1｜1」「…｜1/7｜8」のように2段・3段になっている行がある。
 * 1回だけ剥がすと親に戻らないので、既知の形が無くなるまで繰り返す。
 *
 * ■ 広く消さない
 * 「2026-07-06週｜全体」の `｜全体` や `｜報告書` のような、チャンク番号でない
 * 末尾は残す。不明な末尾まで消すと、別の文書どうしを取り違えて潰してしまう。
 */
const CHUNK_SUFFIX = /｜(?:\d+\/\d+|text\d+|slide\d+|img\d+|p\d+(?:-\d+)?|\d+)$/;

/** まだ既知のチャンク接尾辞が残っているか。剥がし切れたかの確認に使う。 */
export function hasChunkSuffix(title: string): boolean {
  return CHUNK_SUFFIX.test(title.trim());
}

export function stripChunkSuffix(title: string): string {
  let t = title.trim();
  // 積み重なった接尾辞を落とし切る。取り違えを防ぐため、全部消えて空になる場合は
  // 元のタイトルを返す（消しすぎるくらいなら、束ねないほうが安全）。
  for (let i = 0; i < 5 && CHUNK_SUFFIX.test(t); i += 1) {
    const next = t.replace(CHUNK_SUFFIX, "").trim();
    if (next === "") return t;
    t = next;
  }
  return t;
}

/**
 * 「これは同じ1つの文書か」を決める鍵。チャンク数と文書数の取り違えを防ぐ唯一の場所。
 *
 * タイトルだけでは足りない。実データで確かめた3つの落とし穴：
 *   ・同じ「無題｜メモ」が同じ日に、戦略合宿と練馬区の2件ある → organization が要る
 *   ・同じ会議名が別の日にもある                             → event_date が要る
 *   ・資料名「法人請求 営業実戦QA」の下に59件のQAがある      → 資料名だけで束ねると潰れる
 * そのため「親タイトル＋日付＋団体」を鍵にする。資料名は粒度が書き手ごとに
 * バラバラ（「無題」が156チャンク・7日付を飲み込む）なので、鍵には使わない。
 */
export function documentKey(row: {
  title: string;
  event_date?: string | null;
  organization?: string | null;
}): string {
  return [
    stripChunkSuffix(row.title),
    row.event_date ?? "(日付なし)",
    row.organization ?? "(団体なし)",
  ].join("␟");
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

export async function fetchMeetings(
  url: string,
  key: string,
  org: string
): Promise<Meeting[]> {
  const res = await fetch(`${url}/functions/v1/org-history`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ organization: org }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`org-history エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  const data: unknown = await res.json();
  if (!isRecord(data) || !Array.isArray(data.meetings)) return [];
  return data.meetings as Meeting[];
}

export async function fetchDeliverables(
  url: string,
  key: string,
  org: string
): Promise<DeliverableChunk[]> {
  const orgParam = encodeURIComponent(org);
  const sourceParam = encodeURIComponent("成果物");
  const res = await fetch(
    `${url}/rest/v1/memory_chunks?select=id,title,content,event_date,metadata,created_at&source_type=eq.${sourceParam}&organization=eq.${orgParam}&order=event_date.desc.nullslast,created_at.desc`,
    { headers: restHeaders(key), cache: "no-store" }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`成果物取得エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as DeliverableChunk[];
}

export async function fetchWeeklyReports(
  url: string,
  key: string,
  org: string
): Promise<WeeklyReportRow[]> {
  // 完全一致（eq）。org は /api/organizations が返す確定済みの団体名がそのまま
  // 渡ってくる（自由入力ではない）ため、ILIKE部分一致にする必要が無い。
  // 以前は ILIKE *org* を使っていたため「横浜市」で「尾崎横浜市議会議員」のような
  // 無関係なレコードまで拾ってしまっていた（2026-08-19 総点検で報告・修正）。
  const orgParam = encodeURIComponent(org);
  const res = await fetch(
    `${url}/rest/v1/weekly_reports?select=id,week_start,category,organization,summary,insight,tactic,created_at&organization=eq.${orgParam}&order=week_start.desc`,
    { headers: restHeaders(key), cache: "no-store" }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`週報取得エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as WeeklyReportRow[];
}

export async function fetchRelatedDiaries(
  url: string,
  key: string,
  org: string
): Promise<DiaryResult[]> {
  try {
    const res = await fetch(`${url}/functions/v1/search-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: org, source_type: "日記", match_count: 5 }),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    if (!isRecord(data) || !Array.isArray(data.results)) return [];
    return data.results as DiaryResult[];
  } catch (error) {
    console.error("関連日記の意味検索エラー（無視して続行）:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 手書きメモ（organization_notes）
// ---------------------------------------------------------------------------
//
// 「現状」「課題」「施策」「基礎データ」は週報・会議からの派生情報なので、
// 元データを書き換えず、上書き／追記用のメモを別テーブルに持たせている。
// 1団体×1セクションにつき1行（organization, section が UNIQUE）。
// anon には SELECT のみ許可しているため、読みは anonCreds()、
// 書きは serviceCreds() を使う。

export const NOTE_SECTIONS = ["現状", "課題", "施策", "基礎データ"] as const;

export type NoteSection = (typeof NOTE_SECTIONS)[number];

export function isNoteSection(v: unknown): v is NoteSection {
  return typeof v === "string" && (NOTE_SECTIONS as readonly string[]).includes(v);
}

export type OrganizationNote = {
  id: string;
  organization: string;
  section: NoteSection;
  content: string;
  created_at: string;
  updated_at: string;
};

export const ORGANIZATION_NOTES_SELECT =
  "id,organization,section,content,created_at,updated_at";

/** 指定団体の手書きメモを全セクション分取得する（完全一致）。 */
export async function fetchOrganizationNotes(
  url: string,
  key: string,
  org: string
): Promise<OrganizationNote[]> {
  const orgParam = encodeURIComponent(org);
  const res = await fetch(
    `${url}/rest/v1/organization_notes?select=${ORGANIZATION_NOTES_SELECT}&organization=eq.${orgParam}`,
    { headers: restHeaders(key), cache: "no-store" }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`手書きメモ取得エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  const rows: unknown = await res.json();
  return Array.isArray(rows) ? (rows as OrganizationNote[]) : [];
}

export type StakeholderRow = { category: string; name: string };

// ステークホルダー・マスタ。取得できなくても致命ではないので失敗時は空配列。
export async function fetchStakeholders(
  url: string,
  key: string
): Promise<StakeholderRow[]> {
  try {
    // 2026-07-30: 団体マスタの正をNotion「顧客CRM」へ移したため、旧 stakeholders から
    // その写し（notion_organizations）へ切り替えた。列名は name / category のまま同じ形。
    // 種別未設定（category is null）の団体は分類の材料にならないので除く。
    const res = await fetch(
      `${url}/rest/v1/notion_organizations?select=category,name&category=not.is.null&limit=2000`,
      { headers: restHeaders(key), cache: "no-store" }
    );
    if (!res.ok) return [];
    const rows: unknown = await res.json();
    return Array.isArray(rows) ? (rows as StakeholderRow[]) : [];
  } catch (error) {
    console.error("ステークホルダー・マスタ取得エラー（無視して続行）:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 団体のジャンル判定（正準8分類へのグルーピング）
// ---------------------------------------------------------------------------
//
// /organizations の団体セレクタを「大ジャンル → 団体」の2段階にするため、
// 42団体それぞれを lib/categories.ts の正準8分類のどれかに割り当てる。
// 分類リストを独自に作ってはいけない（正準は lib/categories.ts の ORG_CATEGORIES）。
//
// 判定材料は3つあり、確度の高い順に採用する（先に当たったもので確定）:
//   1. 会議データ（memory_chunks.source_type=会議）の metadata.種別 / metadata.category
//      … Notion会議DB `種別` 由来。これが正準そのものなので最優先。
//   2. stakeholders.category … 手で整備したマスタ。DBのCHECK制約が正準8分類と一致済み。
//   3. weekly_reports.category … 週報の章立て由来で表記ゆれあり（`委託企業` など）。
//      normalizeOrgCategory で寄せる。`全体`/`支店`/`プロモーション` は
//      「団体の種類」ではないので null になり、採用されない。
//   4. どれにも当たらなければ `その他`。推測で自治体などに入れてはいけない。
//
// 同じ団体に複数の値がぶら下がっている場合（週をまたいで別カテゴリーで書かれた等）は
// 最頻値を採る。同数なら正準8分類の並び順（ORG_CATEGORIES）で先に来るものを採る。

/** 何を根拠にジャンルを決めたか。UI で出所を明かすのに使う。 */
export type OrgCategorySource = "会議" | "マスタ" | "週報" | "未判定";

export type OrgCategoryMap = Map<string, OrgCategory>;

/** (団体名 → カテゴリー → 出現数) の集計を、団体名 → 最頻カテゴリー に畳む。 */
function pickMajority(
  tally: Map<string, Map<OrgCategory, number>>,
  order: readonly OrgCategory[]
): OrgCategoryMap {
  const out: OrgCategoryMap = new Map();
  for (const [name, counts] of tally) {
    let best: OrgCategory | null = null;
    let bestCount = -1;
    for (const cat of order) {
      const n = counts.get(cat) ?? 0;
      if (n > bestCount) {
        best = cat;
        bestCount = n;
      }
    }
    if (best && bestCount > 0) out.set(name, best);
  }
  return out;
}

function addTally(
  tally: Map<string, Map<OrgCategory, number>>,
  name: string,
  raw: unknown
): void {
  const cat = normalizeOrgCategory(raw);
  if (!cat) return;
  const counts = tally.get(name) ?? new Map<OrgCategory, number>();
  counts.set(cat, (counts.get(cat) ?? 0) + 1);
  tally.set(name, counts);
}

/**
 * 会議データの metadata から (団体名 → 正準カテゴリー) を作る。
 *
 * memory_chunks は RLS で anon の SELECT を許可していないため serviceCreds() 必須。
 * `種別` と `category` の2キーが混在している（取込スクリプトの世代差）ため両方見る。
 * 取得に失敗しても致命ではない（マスタ・週報にフォールバックする）ので空Mapを返す。
 */
export async function fetchMeetingOrgCategories(
  url: string,
  key: string,
  order: readonly OrgCategory[]
): Promise<OrgCategoryMap> {
  try {
    const select = encodeURIComponent(
      "organization,shubetsu:metadata->>種別,cat:metadata->>category"
    );
    const sourceParam = encodeURIComponent("会議");
    const res = await fetch(
      `${url}/rest/v1/memory_chunks?select=${select}&source_type=eq.${sourceParam}&organization=not.is.null&limit=2000`,
      { headers: restHeaders(key), cache: "no-store" }
    );
    if (!res.ok) return new Map();
    const rows: unknown = await res.json();
    if (!Array.isArray(rows)) return new Map();

    const tally = new Map<string, Map<OrgCategory, number>>();
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const name = asString(row.organization)?.trim();
      if (!name) continue;
      // 種別を優先。無い世代のチャンクは category を見る。
      addTally(tally, name, row.shubetsu ?? row.cat);
    }
    return pickMajority(tally, order);
  } catch (error) {
    console.error("会議データの種別取得エラー（無視して続行）:", error);
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// 団体一覧の取得（会議・週報から）
// ---------------------------------------------------------------------------
//
// 元は app/api/organizations/route.ts に直書きされていたが、
// app/api/stakeholders/route.ts（相手先ピッカーの候補一覧）でも同じ「接点の多さ」で
// 並べたくなったため、ここへ移して両方から使えるようにした（2026-08-26）。

/** 会議データを持つ団体の一覧（件数付き）。org-history Edge Function の一覧モード。 */
export async function fetchMeetingOrganizations(
  url: string,
  key: string
): Promise<{ name: string; count: number }[]> {
  const res = await fetch(`${url}/functions/v1/org-history`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`org-history 一覧エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data?.organizations) ? data.organizations : [];
}

/**
 * 週報の (organization, category) 行をそのまま返す。呼び出し側で週数の集計と
 * ジャンル判定の両方に使い回す（同じ団体が週をまたいで別カテゴリーで書かれることが
 * あるので、行を潰さずに渡して weeklyCategoryMap 側で最頻値を採らせる）。
 *
 * 落ちても他の一覧は出したいので、失敗時は空配列を返して握りつぶす。
 */
export async function fetchWeeklyRows(
  url: string,
  key: string
): Promise<{ organization: string; category: unknown }[]> {
  try {
    const res = await fetch(
      `${url}/rest/v1/weekly_reports?select=organization,category&organization=not.is.null`,
      { headers: restHeaders(key), cache: "no-store" }
    );
    if (!res.ok) return [];
    const rows: unknown = await res.json();
    if (!Array.isArray(rows)) return [];
    const out: { organization: string; category: unknown }[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const name = (row as { organization?: unknown }).organization;
      if (typeof name !== "string" || name.trim() === "") continue;
      out.push({
        organization: name.trim(),
        category: (row as { category?: unknown }).category,
      });
    }
    return out;
  } catch (error) {
    console.error("週報カテゴリー取得エラー（無視して続行）:", error);
    return [];
  }
}

/** stakeholders マスタから (団体名 → 正準カテゴリー) を作る。 */
export function stakeholderCategoryMap(
  rows: StakeholderRow[],
  order: readonly OrgCategory[]
): OrgCategoryMap {
  const tally = new Map<string, Map<OrgCategory, number>>();
  for (const r of rows) {
    const name = typeof r?.name === "string" ? r.name.trim() : "";
    if (name === "") continue;
    addTally(tally, name, r.category);
  }
  return pickMajority(tally, order);
}

/** weekly_reports の (organization, category) 行から (団体名 → 正準カテゴリー) を作る。 */
export function weeklyCategoryMap(
  rows: { organization: string; category: unknown }[],
  order: readonly OrgCategory[]
): OrgCategoryMap {
  const tally = new Map<string, Map<OrgCategory, number>>();
  for (const r of rows) {
    const name = r.organization.trim();
    if (name === "") continue;
    addTally(tally, name, r.category);
  }
  return pickMajority(tally, order);
}

/**
 * 団体名から所属ジャンルを決める。上記の優先順（会議 → マスタ → 週報 → その他）。
 * 判定できなかった団体は必ず `その他` に落とす（勝手に自治体などへ寄せない）。
 */
export function resolveOrgCategory(
  name: string,
  sources: {
    meeting: OrgCategoryMap;
    master: OrgCategoryMap;
    weekly: OrgCategoryMap;
  }
): { category: OrgCategory; source: OrgCategorySource } {
  const fromMeeting = sources.meeting.get(name);
  if (fromMeeting) return { category: fromMeeting, source: "会議" };
  const fromMaster = sources.master.get(name);
  if (fromMaster) return { category: fromMaster, source: "マスタ" };
  const fromWeekly = sources.weekly.get(name);
  if (fromWeekly) return { category: fromWeekly, source: "週報" };
  return { category: "その他", source: "未判定" };
}

/**
 * 団体の並び順の根拠となる「接点の多さ（アクション数）」。
 *
 * 吉井さんの要望は「アクション数（会議など）が多いものから順に」。会議件数と
 * 週報週数は単位が違うが、どちらも「その団体に1回向き合った記録」なので
 * 1接点=1点として単純合算する（会議16件＋週報2週＝18点）。
 * 会議しか無い団体・週報しか無い団体が同じ尺度で並ぶのが狙い。
 * 同点は「会議件数の多い方」→「週報週数の多い方」→「団体名（日本語順）」で割る。
 */
export function orgContactScore(o: { count: number; weeklyCount?: number }): number {
  return (o.count ?? 0) + (o.weeklyCount ?? 0);
}

/** 接点の多い順（降順）。同点の割り方は orgContactScore のコメント参照。 */
export function compareOrgByContact(
  a: { name: string; count: number; weeklyCount?: number },
  b: { name: string; count: number; weeklyCount?: number }
): number {
  return (
    orgContactScore(b) - orgContactScore(a) ||
    b.count - a.count ||
    (b.weeklyCount ?? 0) - (a.weeklyCount ?? 0) ||
    a.name.localeCompare(b.name, "ja")
  );
}

// ---------------------------------------------------------------------------
// 名寄せ（チャンク → 1件）
// ---------------------------------------------------------------------------

function chunkPosition(metadata: Record<string, unknown> | null): number {
  const meta = isRecord(metadata) ? metadata : null;
  const posStr = meta ? asString(meta["位置"]) : null;
  const n = posStr ? Number(posStr.split("/")[0]) : 1;
  return Number.isFinite(n) ? n : 1;
}

// 会議もチャンク分割されている（1会議が複数のメモに分かれる）ため、
// タイトル（チャンク番号除去）＋日付でグルーピングし、1会議＝1件にまとめる。
// 代表チャンクは位置（n/全n）の n が最小のもの（概要・参加者が入っていることが多い）。
export function groupMeetings(meetings: Meeting[]): MeetingDoc[] {
  const withDate = meetings.filter((m) => !!m.event_date);
  const groups = new Map<string, Meeting[]>();
  for (const m of withDate) {
    const key = `${stripChunkSuffix(m.title)}__${m.event_date}`;
    const arr = groups.get(key) ?? [];
    arr.push(m);
    groups.set(key, arr);
  }

  const docs: MeetingDoc[] = [];
  for (const group of groups.values()) {
    const withPos = group
      .map((m) => ({ meeting: m, n: chunkPosition(m.metadata) }))
      .sort((a, b) => a.n - b.n);
    const rep = withPos[0].meeting;
    docs.push({
      id: rep.id,
      title: stripChunkSuffix(rep.title),
      date: rep.event_date as string,
      content:
        withPos.length > 1
          ? withPos.map((w) => w.meeting.content).join(" ")
          : rep.content,
    });
  }
  return docs;
}

// 成果物はチャンク分割されているため、資料名（無ければタイトルからチャンク番号を
// 除いたもの）＋日付でグルーピングし、1資料＝1件にまとめる。
export function groupDeliverables(chunks: DeliverableChunk[]): DeliverableDoc[] {
  const groups = new Map<string, DeliverableChunk[]>();
  for (const c of chunks) {
    const meta = isRecord(c.metadata) ? c.metadata : null;
    const docName = (meta && asString(meta["資料名"])) ?? stripChunkSuffix(c.title);
    // created_at はUTCタイムスタンプなので、event_dateが無い場合の代替キーは
    // JSTの日付に変換してから使う（さもないとJST 0時台〜8時台の登録が前日扱いになる）。
    const dateKey = c.event_date ?? toJstDateString(c.created_at);
    const key = `${docName}__${dateKey}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  const docs: DeliverableDoc[] = [];
  for (const group of groups.values()) {
    const withPos = group
      .map((c) => ({ chunk: c, n: chunkPosition(c.metadata) }))
      .sort((a, b) => a.n - b.n);
    const rep = withPos[0].chunk;
    const meta = isRecord(rep.metadata) ? rep.metadata : null;
    const docName = (meta && asString(meta["資料名"])) ?? stripChunkSuffix(rep.title);
    docs.push({
      id: rep.id,
      title: docName,
      date: rep.event_date ?? toJstDateString(rep.created_at),
      leadContent: rep.content,
    });
  }
  return docs;
}

// ---------------------------------------------------------------------------
// タイムライン化
// ---------------------------------------------------------------------------

export function meetingsToEntries(meetings: Meeting[]): TimelineEntry[] {
  return groupMeetings(meetings).map((d) => ({
    id: `meeting:${d.id}`,
    kind: "会議" as const,
    date: d.date,
    title: d.title,
    summary: d.content,
  }));
}

export function deliverablesToEntries(chunks: DeliverableChunk[]): TimelineEntry[] {
  return groupDeliverables(chunks).map((d) => ({
    id: `deliverable:${d.id}`,
    kind: "成果物" as const,
    date: d.date,
    title: d.title,
    summary: d.leadContent,
  }));
}

export function weeklyReportsToEntries(rows: WeeklyReportRow[]): TimelineEntry[] {
  return rows.map((r) => ({
    id: `weekly:${r.id}`,
    kind: "週報" as const,
    date: r.week_start,
    title: `${r.category}週報（${r.week_start}週）`,
    summary: [r.summary, r.insight, r.tactic]
      .filter((s): s is string => !!s && s.trim() !== "")
      .join(" / "),
  }));
}

export function sortByDateDesc<T extends { date: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// ---------------------------------------------------------------------------
// 会議本文のセクション抽出
// ---------------------------------------------------------------------------
//
// PLAUD 由来の会議メモは「事実：… 示唆：… 課題：… アクション：…」という
// 定型フォーマットで登録されている（90チャンク中68件に「課題：」がある）。
// metadata 側には課題フィールドが無いため、本文からラベル単位で切り出す。
// ラベルは全角・半角コロン両方、「事実（外部環境）：」のような括弧付きもある。

const SECTION_LABELS = [
  "次のアクション",
  "決定事項",
  "アクション",
  "課題",
  "示唆",
  "事実",
  "背景",
  "論点",
  "リスク",
  "所感",
  "備考",
] as const;

export type SectionLabel = (typeof SECTION_LABELS)[number];

type Segment = { label: string; start: number; bodyStart: number };

function sectionSegments(content: string): Segment[] {
  const re = new RegExp(
    `(${SECTION_LABELS.join("|")})(?:（[^）]{0,20}）)?[：:]`,
    "g"
  );
  const segments: Segment[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    segments.push({
      label: m[1],
      start: m.index,
      bodyStart: m.index + m[0].length,
    });
  }
  return segments;
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 会議本文から指定ラベルの節（次のラベルまで）を取り出す。無ければ null。 */
export function extractSection(content: string, label: SectionLabel): string | null {
  const segments = sectionSegments(content);
  const idx = segments.findIndex((s) => s.label === label);
  if (idx < 0) return null;
  const end = idx + 1 < segments.length ? segments[idx + 1].start : content.length;
  const text = normalizeText(content.slice(segments[idx].bodyStart, end));
  return text === "" ? null : text;
}

/** 会議本文の「アクション」節（「次のアクション」表記も拾う） */
export function extractActionSection(content: string): string | null {
  return extractSection(content, "アクション") ?? extractSection(content, "次のアクション");
}

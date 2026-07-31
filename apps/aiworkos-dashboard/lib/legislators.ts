// 議員リスト（/legislators）の共通データ層。
//
// 目的：ロビー活動の相手（議員）を「会派 × 議会」の階層で辿り、
// 一人ひとりについて「いつアクションを起こしたか（履歴）」と
// 「いつアクションを起こす予定か（予定）」を1画面で確認できるようにする。
//
// データ元（すべて既存テーブル。新規に議員を作るテーブルは持たない）:
//   - 名簿   : notion_contacts … Notion「人脈DB」の写し
//   - 履歴   : weekly_reports（category='議員'）＋ memory_chunks（会議／日記／成果物）
//   - 予定   : strategic_todos（genre='議員'）
//   - 手書き : legislator_notes（このページのために新設）
//
// ★重要★ notion_contacts は app/api/cron/notion-sync が毎時
// 「Notionに無い行は削除」（mark and sweep）で洗い直している。
// このテーブルへサイトから議員を追加しても次の同期で消えるため、
// 名簿の追加・修正はNotion側で行う運用とし、この画面は読み取り専用にしている。
//
// RLS: memory_chunks は anon に SELECT を許可していないため必ず serviceCreds()。
// notion_contacts / weekly_reports / strategic_todos / legislator_notes は
// anon に SELECT を許可しているため anonCreds() でよい。

import { restHeaders } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** 議会の種別。department の文字列から導出する（deriveAssemblyType 参照）。 */
export const ASSEMBLY_TYPES = [
  "衆議院",
  "参議院",
  "都議会",
  "道議会",
  "府議会",
  "県議会",
  "市議会",
  "区議会",
  "町議会",
  "村議会",
  "その他",
] as const;
export type AssemblyType = (typeof ASSEMBLY_TYPES)[number];

/** 議員本人か、議員事務所の秘書などの関係者か。 */
export type LegislatorRole = "議員" | "関係者";

/**
 * 記録の粒度。
 *   person … 本人の名前で紐付いた記録
 *   group  … 所属議連・勉強会の名前で紐付いた記録（本人が主語とは限らない）
 * 画面ではこの2つを分けて出し、混同しないようにする。
 */
export type MatchScope = "person" | "group";

export type HistoryEntry = {
  id: string;
  kind: "週報" | "会議" | "日記" | "成果物";
  /** YYYY-MM-DD。週報は week_start、memory_chunks は event_date（無ければ登録日）。 */
  date: string;
  title: string;
  detail: string;
  /** どのルールで本人に紐付けたか（画面にそのまま出す） */
  matchReason: string;
  scope: MatchScope;
};

export type PlanEntry = {
  id: string;
  task: string;
  status: string | null;
  targetMonth: string | null;
  dueDate: string | null;
  notes: string | null;
  matchReason: string;
  scope: MatchScope;
};

export type LegislatorNote = {
  name_key: string;
  content: string;
  updated_at: string;
};

export type Legislator = {
  id: string;
  name: string;
  /** 会派（notion_contacts.org_name）。未設定は「会派未設定」 */
  faction: string;
  /** 議会（notion_contacts.department）。未設定は「所属議会 未設定」 */
  assembly: string;
  assemblyType: AssemblyType;
  title: string | null;
  status: string | null;
  flag: string | null;
  /** Notion側のメモ（読み取り専用） */
  memo: string | null;
  role: LegislatorRole;
  history: HistoryEntry[];
  plans: PlanEntry[];
};

/** 誰にも紐付かなかった記録。名簿の抜けを見つけるために画面に出す。 */
export type UnmatchedRecord = {
  id: string;
  kind: "週報" | "予定";
  date: string | null;
  label: string;
  detail: string | null;
};

export type LegislatorPayload = {
  legislators: Legislator[];
  unmatched: UnmatchedRecord[];
  notes: LegislatorNote[];
  counts: {
    contacts: number;
    weeklyTotal: number;
    weeklyMatched: number;
    todoTotal: number;
    todoMatched: number;
    chunkMatched: number;
  };
};

// ---------------------------------------------------------------------------
// 議員の判定条件
// ---------------------------------------------------------------------------
//
// notion_contacts 180件のうち「議員（およびその事務所の関係者）」を選ぶ条件。
// 実データを見て決めた条件は次の2つのOR:
//
//   (a) department に「議会」「衆議院」「参議院」のいずれかを含む
//       … 例「札幌市議会」「墨田区議会」「富谷市議会（宮城県）」「衆議院」
//   (b) title に「議員」を含む
//       … department が空でも役職に「◯◯市議会議員」と入っている場合を拾う
//
// (a) は「衆議院 若宮健嗣議員事務所」に所属する秘書も拾う。秘書は議員本人では
// ないので role='関係者' として区別し、件数の数え方も分ける（捨てはしない。
// 会長へのアポは秘書経由になるため、ロビー活動上は同じ画面に居た方がよい）。
export const LEGISLATOR_CONTACT_FILTER =
  "or=(department.ilike.*議会*,department.ilike.*衆議院*,department.ilike.*参議院*,title.ilike.*議員*)";

const ASSEMBLY_IN_DEPARTMENT = /議会|衆議院|参議院/;

function deriveRole(title: string | null, department: string | null): LegislatorRole {
  if (title && title.includes("議員")) return "議員";
  // 役職が空でも、所属が議会なら議員とみなす（Notion側で役職未入力のケース）
  if (!title && department && ASSEMBLY_IN_DEPARTMENT.test(department)) return "議員";
  return "関係者";
}

// ---------------------------------------------------------------------------
// 議会種別の導出ルール
// ---------------------------------------------------------------------------
//
// department の文字列から議会の種別を導く。判定できないものは「その他」に落とし、
// 推測で種別を作らない。
//
//   「衆議院」「衆議院 若宮健嗣議員事務所」        → 衆議院
//   「参議院」                                    → 参議院
//   「墨田区議会」                                → 区議会
//   「札幌市議会」「富谷市議会（宮城県）」        → 市議会
//   「東京都議会」                                → 都議会
//   「北海道議会」                                → 道議会
//   「京都府議会」                                → 府議会
//   「宮城県議会」                                → 県議会
//   それ以外・空                                  → その他
//
// 市区町村を先に判定するのは、「富谷市議会（宮城県）」のように括弧で都道府県名が
// 付く表記があり、「県」で先に引っ掛けると市議会を県議会と誤判定するため。
export function deriveAssemblyType(department: string | null): AssemblyType {
  const d = (department ?? "").trim();
  if (d === "") return "その他";
  if (d.includes("衆議院")) return "衆議院";
  if (d.includes("参議院")) return "参議院";
  if (d.includes("区議会")) return "区議会";
  if (d.includes("市議会")) return "市議会";
  if (d.includes("町議会")) return "町議会";
  if (d.includes("村議会")) return "村議会";
  if (d.includes("都議会")) return "都議会";
  if (d.includes("道議会")) return "道議会";
  if (d.includes("府議会")) return "府議会";
  if (d.includes("県議会")) return "県議会";
  return "その他";
}

/**
 * department から自治体名を取り出す。
 * 「富谷市議会（宮城県）」→「富谷市」／「墨田区議会」→「墨田区」／「衆議院」→ null。
 * 週報の「東村山市渡邊市議」のような略記と突き合わせるために使う。
 */
export function municipalityOf(department: string | null): string | null {
  const base = (department ?? "").replace(/[（(][^）)]*[）)]/g, "").trim();
  const m = base.match(/^(.+?[市区町村])議会/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// 名前の突合ルール
// ---------------------------------------------------------------------------
//
// notion_contacts.name は本名・ひらがな交じり（「くまがい誠一」「佐藤まさたか」）、
// 一方 weekly_reports.organization は「熊谷議員（札幌市議会）」「東村山市渡邊市議」
// のような略記で、完全一致では絶対に繋がらない。
// そこで次の5段階で突き合わせる（上の段ほど強い。最初に当たった理由を採用する）。
//
//   1. 氏名一致        : 記録本文に氏名がそのまま含まれる（「鈴木英敬事務所へ報告」）
//   2. 氏名一致（表記ゆれ）: 下の NAME_ALIASES に登録した別表記が含まれる
//   3. 姓＋敬称の一致  : 「姓＋議員/市議/区議/様/氏…」の形で現れる（「伊藤議員」「熊谷様」）
//   4. 議連・勉強会名の一致: 会派名や役職に含まれる「◯◯議員連盟」等が記録に現れる
//   5. 所属議会（自治体名）の一致: 記録に自治体名が含まれ、かつ**別人の名前が
//      書かれていない**場合のみ（「東村山市渡邊市議」は東村山市が一致しても
//      渡邊さんという別人が明示されているので、佐藤まさたかさんには紐付けない）
//
// memory_chunks（会議・日記・成果物の長文）は母数が大きく誤爆しやすいので、
// 1・2・4 のみを使う（姓だけ・自治体名だけでは紐付けない）。
// どのルールで当たったかは matchReason として画面に出し、吉井さんが誤りを
// 目視で棄却できるようにしている。突合できなかった記録は捨てずに
// 「どの議員にも紐付かなかった記録」として一覧に出す。

type AliasTerm = {
  term: string;
  /** この語も同じ本文に含まれていないと一致とみなさない（同名の別人・地名よけ） */
  context?: string[];
};

// 手で確認した表記ゆれだけを登録する。推測では足さない。
const NAME_ALIASES: Record<string, AliasTerm[]> = {
  // 会議録 plaud:0a0f5b45… の本文に
  // 「PLAUD音声認識で『くまがい誠一』が『熊谷』と誤変換されていた」と明記があり、
  // 週報の「熊谷議員（札幌市議会）」も同一人物。地名の熊谷市と区別するため
  // 「札幌」または議員を示す語との共起を条件にする。
  くまがい誠一: [{ term: "熊谷", context: ["札幌", "議員", "市議", "会派"] }],
  // 本人メモに「漢字表記は『石川祐一』」と記載がある。
  石川ゆういち: [{ term: "石川祐一" }],
};

/** 姓の後ろに付く敬称・肩書き。姓だけの一致を許さず、この形のときだけ拾う。 */
const HONORIFIC =
  "(?:議員|市議|区議|町議|村議|県議|都議|道議|府議|議長|副議長|先生|様|氏|さん)";

/** 議連・勉強会の名前とみなす接尾辞。政党名（自由民主党・公明党）は含めない。 */
const GROUP_NAME_RE =
  /[一-龥ぁ-んァ-ヶー\w]{2,20}?(?:議員連盟|議連|勉強会|懇話会|研究会|連合)/g;

/** 記録本文の中に現れる「〈人名〉＋〈議員/市議/様〉」を拾う（別人検出用）。 */
const PERSON_TOKEN_RE = new RegExp(`([一-龥]{2,4})${HONORIFIC}`, "g");

/** 氏名の先頭にある漢字の連なりから姓を推定する。ひらがな始まりなら null。 */
export function surnameOf(name: string): string | null {
  const run = name.match(/^[一-龥]+/)?.[0] ?? "";
  if (run.length < 2) return null;
  return run.length >= 3 ? run.slice(0, 2) : run;
}

/** 会派名・役職から議連・勉強会の名前を集める。 */
export function groupNamesOf(faction: string | null, title: string | null): string[] {
  const found = new Set<string>();
  const factionText = (faction ?? "").trim();
  if (factionText !== "" && /(議員連盟|議連|勉強会|懇話会|研究会|連合)$/.test(factionText)) {
    found.add(factionText);
  }
  for (const m of (title ?? "").matchAll(GROUP_NAME_RE)) {
    if (m[0].length >= 4) found.add(m[0]);
  }
  return [...found];
}

type MatchKeys = {
  name: string;
  aliases: AliasTerm[];
  surname: string | null;
  groups: string[];
  municipality: string | null;
};

export function buildMatchKeys(leg: {
  name: string;
  faction: string;
  assembly: string;
  title: string | null;
}): MatchKeys {
  return {
    name: leg.name,
    aliases: NAME_ALIASES[leg.name] ?? [],
    surname: surnameOf(leg.name),
    groups: groupNamesOf(leg.faction, leg.title),
    municipality: municipalityOf(leg.assembly),
  };
}

function aliasHit(text: string, alias: AliasTerm): boolean {
  if (!text.includes(alias.term)) return false;
  if (!alias.context || alias.context.length === 0) return true;
  return alias.context.some((c) => text.includes(c));
}

/** 記録に本人以外の人名（〈人名〉＋議員/様 など）が書かれているか。 */
function mentionsOtherPerson(text: string, keys: MatchKeys): boolean {
  // 自治体名は「東村山市議」のように人名らしく見えてしまうので先に落とす
  const stripped = keys.municipality ? text.split(keys.municipality).join("") : text;
  for (const m of stripped.matchAll(PERSON_TOKEN_RE)) {
    const token = m[1];
    if (keys.name.includes(token)) continue;
    if (keys.surname && token.includes(keys.surname)) continue;
    if (keys.aliases.some((a) => a.term.includes(token) || token.includes(a.term))) continue;
    return true;
  }
  return false;
}

export type MatchResult = { reason: string; scope: MatchScope };

/**
 * 週報・ToDo のような略記の短文に対する突合。当たったルール名と粒度を返す。
 * 何にも当たらなければ null。
 */
export function matchShortText(text: string, keys: MatchKeys): MatchResult | null {
  if (text.includes(keys.name)) return { reason: "氏名一致", scope: "person" };
  for (const alias of keys.aliases) {
    if (aliasHit(text, alias)) {
      return { reason: `表記ゆれ一致（${alias.term}）`, scope: "person" };
    }
  }
  if (keys.surname && new RegExp(`${keys.surname}${HONORIFIC}`).test(text)) {
    return { reason: `姓＋敬称の一致（${keys.surname}）`, scope: "person" };
  }
  for (const g of keys.groups) {
    if (text.includes(g)) {
      return { reason: `議連・勉強会名の一致（${g}）`, scope: "group" };
    }
  }
  if (keys.municipality && text.includes(keys.municipality)) {
    if (mentionsOtherPerson(text, keys)) return null;
    return { reason: `所属議会の一致（${keys.municipality}）`, scope: "person" };
  }
  return null;
}

/**
 * memory_chunks のような長文に対する突合。
 * 誤爆を避けるため氏名・表記ゆれ・議連名のみを使い、姓だけ／自治体名だけでは繋がない。
 */
export function matchLongText(text: string, keys: MatchKeys): MatchResult | null {
  if (text.includes(keys.name)) return { reason: "氏名一致", scope: "person" };
  for (const alias of keys.aliases) {
    if (aliasHit(text, alias)) {
      return { reason: `表記ゆれ一致（${alias.term}）`, scope: "person" };
    }
  }
  for (const g of keys.groups) {
    if (text.includes(g)) {
      return { reason: `議連・勉強会名の一致（${g}）`, scope: "group" };
    }
  }
  return null;
}

/** memory_chunks を絞り込むための検索語（ilike に渡す）。 */
export function longTextSearchTerms(keysList: MatchKeys[]): string[] {
  const terms = new Set<string>();
  for (const keys of keysList) {
    terms.add(keys.name);
    for (const a of keys.aliases) terms.add(a.term);
    for (const g of keys.groups) terms.add(g);
  }
  return [...terms].filter((t) => t.length >= 2);
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

export type ContactRow = {
  notion_page_id: string;
  name: string;
  org_name: string | null;
  department: string | null;
  title: string | null;
  status: string | null;
  flag: string | null;
  memo: string | null;
};

export type WeeklyRow = {
  id: string;
  week_start: string;
  organization: string | null;
  summary: string;
  insight: string | null;
  tactic: string | null;
};

export type TodoRow = {
  id: string;
  task_name: string;
  status: string | null;
  target_month: string | null;
  notes: string | null;
  due_date: string | null;
};

export type ChunkRow = {
  id: string;
  source_type: string;
  source_id: string | null;
  organization: string | null;
  title: string | null;
  content: string;
  event_date: string | null;
  created_at: string;
};

async function getJson<T>(url: string, key: string, what: string): Promise<T> {
  const res = await fetch(url, { headers: restHeaders(key), cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${what}の取得エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export function fetchLegislatorContacts(url: string, key: string): Promise<ContactRow[]> {
  const select =
    "select=notion_page_id,name,org_name,department,title,status,flag,memo";
  return getJson<ContactRow[]>(
    `${url}/rest/v1/notion_contacts?${select}&${LEGISLATOR_CONTACT_FILTER}&order=org_name.asc.nullslast,department.asc.nullslast,name.asc`,
    key,
    "議員名簿"
  );
}

export function fetchLegislatorWeeklyReports(url: string, key: string): Promise<WeeklyRow[]> {
  return getJson<WeeklyRow[]>(
    `${url}/rest/v1/weekly_reports?select=id,week_start,organization,summary,insight,tactic&category=eq.${encodeURIComponent(
      "議員"
    )}&order=week_start.desc`,
    key,
    "週報"
  );
}

export function fetchLegislatorTodos(url: string, key: string): Promise<TodoRow[]> {
  return getJson<TodoRow[]>(
    `${url}/rest/v1/strategic_todos?select=id,task_name,status,target_month,notes,due_date&genre=eq.${encodeURIComponent(
      "議員"
    )}&order=due_date.asc.nullslast,target_month.asc.nullslast`,
    key,
    "予定（戦略ToDo）"
  );
}

/** memory_chunks は RLS の都合で必ず serviceCreds() を渡すこと。 */
export async function fetchLegislatorChunks(
  url: string,
  key: string,
  terms: string[]
): Promise<ChunkRow[]> {
  if (terms.length === 0) return [];
  // PostgREST の or= は値にカンマ・括弧が入ると壊れるため、含む語は落としておく
  const safe = terms.filter((t) => !/[(),."']/.test(t));
  if (safe.length === 0) return [];
  const conditions = safe
    .flatMap((t) => [`content.ilike.*${t}*`, `title.ilike.*${t}*`])
    .join(",");
  const select = "select=id,source_type,source_id,organization,title,content,event_date,created_at";
  const sourceFilter = `source_type=in.(${encodeURIComponent("会議")},${encodeURIComponent(
    "日記"
  )},${encodeURIComponent("成果物")})`;
  const orParam = `or=${encodeURIComponent(`(${conditions})`)}`;
  return getJson<ChunkRow[]>(
    `${url}/rest/v1/memory_chunks?${select}&${sourceFilter}&${orParam}&order=event_date.desc.nullslast,created_at.desc&limit=300`,
    key,
    "記憶（会議・日記・成果物）"
  );
}

export function fetchLegislatorNotes(url: string, key: string): Promise<LegislatorNote[]> {
  return getJson<LegislatorNote[]>(
    `${url}/rest/v1/legislator_notes?select=name_key,content,updated_at`,
    key,
    "手書きメモ"
  );
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

function chunkKind(sourceType: string): HistoryEntry["kind"] {
  if (sourceType === "会議") return "会議";
  if (sourceType === "日記") return "日記";
  return "成果物";
}

function trim(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 週報1行を、突合用の1つの文字列にまとめる。 */
function weeklyText(row: WeeklyRow): string {
  return [row.organization, row.summary, row.insight, row.tactic].filter(Boolean).join(" ");
}

/** ToDo1行を、突合用の1つの文字列にまとめる。 */
function todoText(row: TodoRow): string {
  return [row.task_name, row.notes].filter(Boolean).join(" ");
}

export function buildLegislators(
  contacts: ContactRow[],
  weekly: WeeklyRow[],
  todos: TodoRow[],
  chunks: ChunkRow[]
): { legislators: Legislator[]; unmatched: UnmatchedRecord[]; matchedChunkIds: Set<string> } {
  const matchedWeekly = new Set<string>();
  const matchedTodos = new Set<string>();
  const matchedChunkIds = new Set<string>();

  const legislators: Legislator[] = contacts.map((c) => {
    const faction = c.org_name?.trim() || "会派未設定";
    const assembly = c.department?.trim() || "所属議会 未設定";
    const base = { name: c.name, faction, assembly, title: c.title };
    const keys = buildMatchKeys(base);

    const history: HistoryEntry[] = [];

    for (const row of weekly) {
      const hit = matchShortText(weeklyText(row), keys);
      if (!hit) continue;
      matchedWeekly.add(row.id);
      history.push({
        id: `w-${row.id}`,
        kind: "週報",
        date: row.week_start,
        title: row.organization?.trim() || "週報",
        detail: [row.summary, row.insight && `示唆: ${row.insight}`, row.tactic && `打ち手: ${row.tactic}`]
          .filter(Boolean)
          .join(" / "),
        matchReason: hit.reason,
        scope: hit.scope,
      });
    }

    for (const row of chunks) {
      const hit = matchLongText(`${row.title ?? ""} ${row.content}`, keys);
      if (!hit) continue;
      matchedChunkIds.add(row.id);
      history.push({
        id: `c-${row.id}`,
        kind: chunkKind(row.source_type),
        date: row.event_date ?? row.created_at.slice(0, 10),
        title: row.title?.trim() || row.source_type,
        detail: trim(row.content, 220),
        matchReason: hit.reason,
        scope: hit.scope,
      });
    }

    history.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const plans: PlanEntry[] = [];
    for (const row of todos) {
      const hit = matchShortText(todoText(row), keys);
      if (!hit) continue;
      matchedTodos.add(row.id);
      plans.push({
        id: `t-${row.id}`,
        task: row.task_name,
        status: row.status,
        targetMonth: row.target_month,
        dueDate: row.due_date,
        notes: row.notes,
        matchReason: hit.reason,
        scope: hit.scope,
      });
    }
    // 納期の近い順。納期未設定は末尾（その中では対象月の早い順）。
    plans.sort((a, b) => {
      if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return (a.targetMonth ?? "9999").localeCompare(b.targetMonth ?? "9999");
    });

    return {
      id: c.notion_page_id,
      name: c.name,
      faction,
      assembly,
      assemblyType: deriveAssemblyType(c.department),
      title: c.title,
      status: c.status,
      flag: c.flag,
      memo: c.memo,
      role: deriveRole(c.title, c.department),
      history,
      plans,
    };
  });

  const unmatched: UnmatchedRecord[] = [
    ...weekly
      .filter((r) => !matchedWeekly.has(r.id))
      .map((r) => ({
        id: `w-${r.id}`,
        kind: "週報" as const,
        date: r.week_start,
        label: r.organization?.trim() || "（相手先の記載なし）",
        detail: trim(r.summary, 160),
      })),
    ...todos
      .filter((r) => !matchedTodos.has(r.id))
      .map((r) => ({
        id: `t-${r.id}`,
        kind: "予定" as const,
        date: r.due_date,
        label: r.task_name,
        detail: r.target_month ? `対象月 ${r.target_month}` : null,
      })),
  ];

  return { legislators, unmatched, matchedChunkIds };
}

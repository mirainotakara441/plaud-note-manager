// Notion「顧客CRM」「人脈DB」→ Supabase public.notion_organizations / notion_contacts の
// 取り込み用。Notionページ→Supabase行の変換と、Notion REST の読み取り呼び出しをここに集約する。
//
// 方向は一方通行（Notion → Supabase）。Notionが正で、Supabase側は写し。
// strategic_todos のような双方向（ライトスルー）にはしていない。人物・団体データは
// 競合したときに機械では正しく解決できず、間違うと商談履歴が壊れるため。
//
// notionToken / runSequential は lib/notionTodos.ts に既にあるものを使い回す。
// トークン解決（.env.local のプレースホルダ→Supabase app_config へのフォールバック）は
// 二重に持つと片方だけ直して食い違うので複製しない。3つ目の利用箇所ができたら
// lib/notion.ts へ切り出すこと。

import { normalizeOrgCategory, type OrgCategory } from "@/lib/categories";
import { notionToken } from "@/lib/notionTodos";

export { notionToken };

const NOTION_VERSION = "2022-06-28";
const NOTION_API = "https://api.notion.com/v1";
const TIMEOUT_MS = 15000;

// Notionのデータベース ID。Notion上でDBを作り直したら差し替えが必要。
export const NOTION_CRM_DATABASE_ID = "d8a61bcb06ad4d2a9533a45fa05b6a4f"; // 顧客CRM
export const NOTION_CONTACTS_DATABASE_ID = "1c0b7c96bd4e44088f4e99f262894965"; // 人脈DB

// ============ Supabase行の形 ============

export type OrgRow = {
  notion_page_id: string;
  name: string;
  category: OrgCategory | null;
  raw_category: string | null;
  status: string | null;
  priority: string | null;
  counterpart: string | null;
  proposal: string | null;
  issues: string | null;
  next_action: string | null;
  next_action_due: string | null;
  last_contact_on: string | null;
  visit_notes: string | null;
  sources: string[];
  notion_last_edited_at: string | null;
};

export type ContactRow = {
  notion_page_id: string;
  name: string;
  org_page_id: string | null;
  org_name: string | null;
  department: string | null;
  title: string | null;
  status: string | null;
  flag: string | null;
  sources: string[];
  memo: string | null;
  eight_registered_on: string | null;
  last_verified_on: string | null;
  notion_last_edited_at: string | null;
};

// ============ Notionプロパティの読み出し ============

type NotionPage = {
  id?: unknown;
  archived?: unknown;
  in_trash?: unknown;
  last_edited_time?: unknown;
  properties?: Record<string, unknown>;
};

function plainText(prop: unknown, key: "title" | "rich_text"): string {
  const arr = (prop as Record<string, unknown> | undefined)?.[key];
  if (!Array.isArray(arr)) return "";
  return (arr as { plain_text?: unknown }[])
    .map((r) => (typeof r?.plain_text === "string" ? r.plain_text : ""))
    .join("")
    .trim();
}

function text(prop: unknown, key: "title" | "rich_text"): string | null {
  const s = plainText(prop, key);
  return s === "" ? null : s;
}

function selectName(prop: unknown): string | null {
  const v = (prop as Record<string, unknown> | undefined)?.select;
  if (!v || typeof v !== "object") return null;
  const name = (v as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}

function multiSelectNames(prop: unknown): string[] {
  const arr = (prop as Record<string, unknown> | undefined)?.multi_select;
  if (!Array.isArray(arr)) return [];
  return (arr as { name?: unknown }[])
    .map((o) => (typeof o?.name === "string" ? o.name.trim() : ""))
    .filter((s) => s !== "");
}

// 日付プロパティの start を YYYY-MM-DD で返す。
// Notionは日付だけなら "2026-07-30"、時刻付きなら ISO 文字列を返すので先頭10文字を取る。
// Supabase側の列は date 型なので、時刻を残すと投入時に落ちる。
function dateStart(prop: unknown): string | null {
  const v = (prop as Record<string, unknown> | undefined)?.date;
  if (!v || typeof v !== "object") return null;
  const start = (v as Record<string, unknown>).start;
  if (typeof start !== "string" || start.trim() === "") return null;
  return start.slice(0, 10);
}

// リレーションの先頭ページIDだけを取る。人脈DBの「組織名」は運用上1件だけなので、
// 2件目以降は捨てる（複数所属を持たせたくなったら別テーブルに正規化すること）。
function firstRelationId(prop: unknown): string | null {
  const arr = (prop as Record<string, unknown> | undefined)?.relation;
  if (!Array.isArray(arr)) return null;
  const first = (arr as { id?: unknown }[])[0];
  return typeof first?.id === "string" ? first.id : null;
}

function lastEdited(page: NotionPage): string | null {
  return typeof page.last_edited_time === "string" ? page.last_edited_time : null;
}

// ============ ページ → 行 ============
// タイトルが空の行だけ null（＝取り込まない）。それ以外は欠けていても null 列として通す。
// Notionは入力途中の行がそのまま残るので、厳しく弾くと写しが実態から離れる。

export function orgFromPage(page: NotionPage): OrgRow | null {
  const id = typeof page.id === "string" ? page.id : null;
  if (!id) return null;
  const p = page.properties ?? {};

  const name = plainText(p["組織名"], "title");
  if (name === "") return null;

  const raw = selectName(p["種別"]);

  return {
    notion_page_id: id,
    name,
    // 正準8分類へ寄せる。Notionの「種別」には旧分類の`企業`が選択肢として残っており、
    // そのまま入れると読む側の分類軸が9個に増えてしまう（normalizeOrgCategoryが事業者へ寄せる）。
    category: normalizeOrgCategory(raw),
    raw_category: raw,
    status: selectName(p["ステータス"]),
    priority: selectName(p["優先度"]),
    counterpart: text(p["担当者（先方）"], "rich_text"),
    proposal: text(p["提案内容"], "rich_text"),
    issues: text(p["課題"], "rich_text"),
    next_action: text(p["次回アクション"], "rich_text"),
    next_action_due: dateStart(p["次回アクション期日"]),
    last_contact_on: dateStart(p["最終接触日"]),
    visit_notes: text(p["訪問履歴メモ"], "rich_text"),
    sources: multiSelectNames(p["データ源"]),
    notion_last_edited_at: lastEdited(page),
  };
}

// orgNames は「組織ページID → 組織名」。org_name の非正規化コピーに使う。
// 先に顧客CRMを取り込んでから渡すこと。
export function contactFromPage(
  page: NotionPage,
  orgNames: Map<string, string>
): ContactRow | null {
  const id = typeof page.id === "string" ? page.id : null;
  if (!id) return null;
  const p = page.properties ?? {};

  const name = plainText(p["氏名"], "title");
  if (name === "") return null;

  const orgPageId = firstRelationId(p["組織名"]);

  return {
    notion_page_id: id,
    name,
    org_page_id: orgPageId,
    org_name: orgPageId ? (orgNames.get(orgPageId) ?? null) : null,
    department: text(p["部署"], "rich_text"),
    title: text(p["役職"], "rich_text"),
    status: selectName(p["ステータス"]),
    flag: selectName(p["フラグ"]),
    sources: multiSelectNames(p["データ源"]),
    memo: text(p["メモ"], "rich_text"),
    eight_registered_on: dateStart(p["Eight登録日"]),
    last_verified_on: dateStart(p["最終確認日"]),
    notion_last_edited_at: lastEdited(page),
  };
}

// ============ Notion REST（読み取りのみ） ============

async function notionFetch(
  token: string,
  path: string,
  body: unknown,
  method: "POST" | "PATCH" = "POST"
): Promise<unknown> {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    // トークンは本文に載らないが、念のため長さを切って投げる。
    throw new Error(`Notion API ${method} ${path} ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

// ============ 書き込み（ライトスルー） ============
// サイトの団体追加フォームから呼ぶ。Notionを正にしたうえで画面からも足せるようにするため、
// Supabaseの写しにだけ入れて終わりにせず、Notion「顧客CRM」にもページを作る。
// 写しにだけ入れると次の同期（mark and sweep）で消えるので、ここを省いてはいけない。
export async function notionCreateOrgPage(
  token: string,
  fields: { name: string; category: OrgCategory }
): Promise<OrgRow> {
  const data = (await notionFetch(token, "/pages", {
    parent: { database_id: NOTION_CRM_DATABASE_ID },
    properties: {
      組織名: { title: [{ type: "text", text: { content: fields.name.slice(0, 2000) } }] },
      種別: { select: { name: fields.category } },
      // サイトから足したことが後から分かるようにしておく。
      データ源: { multi_select: [{ name: "手入力" }] },
    },
  })) as { id?: unknown; last_edited_time?: unknown };

  const id = typeof data?.id === "string" ? data.id : null;
  if (!id) throw new Error("Notionページ作成のレスポンスにidがありません");

  // 作った直後の姿をそのまま写しへ返す（次の同期を待たずに画面へ出すため）。
  return {
    notion_page_id: id,
    name: fields.name,
    category: fields.category,
    raw_category: fields.category,
    status: null,
    priority: null,
    counterpart: null,
    proposal: null,
    issues: null,
    next_action: null,
    next_action_due: null,
    last_contact_on: null,
    visit_notes: null,
    sources: ["手入力"],
    notion_last_edited_at:
      typeof data.last_edited_time === "string" ? data.last_edited_time : null,
  };
}

// 人脈DBへ人物ページを作る。名刺の写メ取り込み（/legislators）から呼ぶ。
//
// 団体と同じくライトスルー。Notion（正）へ作ってから写しへ入れる。
// 写しにだけ入れると、毎時の同期（mark and sweep）で消える。
//
// ★ステータスとフラグは呼び出し側で決めさせない★
// 「名刺が1年以上前」と「担当を外れた」は別物で、混ぜると過去担当が量産される
// （名刺スキル ROLE.md §3-5）。ここで交換日から機械的に決める。
export async function notionCreateContactPage(
  token: string,
  fields: {
    name: string;
    orgPageId: string;
    department: string | null;
    title: string | null;
    /** 名刺の交換日 YYYY-MM-DD。分からなければ null（その場合フラグは付けない）。 */
    exchangedOn: string | null;
    memo: string;
    /** 今日 YYYY-MM-DD。1年以内かの判定に使う。 */
    today: string;
  },
  orgName: string
): Promise<ContactRow> {
  const recent = isWithinOneYear(fields.exchangedOn, fields.today);
  const status = fields.exchangedOn ? (recent ? "現役" : "要確認") : "要確認";
  const flag = recent ? "現担当" : null;

  const props: Record<string, unknown> = {
    氏名: { title: [{ type: "text", text: { content: fields.name.slice(0, 2000) } }] },
    組織名: { relation: [{ id: fields.orgPageId }] },
    データ源: { multi_select: [{ name: "Eight" }] },
    ステータス: { select: { name: status } },
    メモ: {
      rich_text: [{ type: "text", text: { content: fields.memo.slice(0, 2000) } }],
    },
  };
  if (fields.department) {
    props["部署"] = {
      rich_text: [{ type: "text", text: { content: fields.department.slice(0, 2000) } }],
    };
  }
  if (fields.title) {
    props["役職"] = {
      rich_text: [{ type: "text", text: { content: fields.title.slice(0, 2000) } }],
    };
  }
  if (fields.exchangedOn) props["Eight登録日"] = { date: { start: fields.exchangedOn } };
  // 空欄は「まだ判断していない」を意味する。select に null は送れないので、
  // 付けないときはプロパティごと省く（空文字を送ると選択肢が増える）。
  if (flag) props["フラグ"] = { select: { name: flag } };

  const data = (await notionFetch(token, "/pages", {
    parent: { database_id: NOTION_CONTACTS_DATABASE_ID },
    properties: props,
  })) as { id?: unknown; last_edited_time?: unknown };

  const id = typeof data?.id === "string" ? data.id : null;
  if (!id) throw new Error("Notionページ作成のレスポンスにidがありません");

  return {
    notion_page_id: id,
    name: fields.name,
    org_page_id: fields.orgPageId,
    org_name: orgName,
    department: fields.department,
    title: fields.title,
    status,
    flag,
    sources: ["Eight"],
    memo: fields.memo,
    eight_registered_on: fields.exchangedOn,
    last_verified_on: null,
    notion_last_edited_at:
      typeof data.last_edited_time === "string" ? data.last_edited_time : null,
  };
}

/** 交換日が今日から1年以内か。日付が無ければ false（＝現担当を付けない）。 */
export function isWithinOneYear(day: string | null, today: string): boolean {
  if (!day) return false;
  const d = Date.parse(`${day}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(d) || !Number.isFinite(t)) return false;
  return t - d <= 366 * 24 * 60 * 60 * 1000 && d <= t;
}

// データベースの全ページを取得する。
// archived / in_trash のページはNotionのqueryが返さないため、返ってきたIDの集合が
// 「Notionに生きて存在する行」になる。取り込み側の削除判定はこれを使う。
async function queryAllPages(token: string, databaseId: string): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined = undefined;
  let guard = 0;
  do {
    const data = (await notionFetch(token, `/databases/${databaseId}/query`, {
      page_size: 100,
      start_cursor: cursor,
    })) as { results?: unknown; has_more?: unknown; next_cursor?: unknown };

    const results = Array.isArray(data?.results) ? (data.results as NotionPage[]) : [];
    for (const p of results) {
      if (p?.archived === true || p?.in_trash === true) continue;
      pages.push(p);
    }
    cursor =
      data?.has_more === true && typeof data.next_cursor === "string"
        ? data.next_cursor
        : undefined;
    guard += 1;
  } while (cursor && guard < 50);
  return pages;
}

export type FetchResult = {
  orgs: OrgRow[];
  contacts: ContactRow[];
  orgSkipped: number;
  contactSkipped: number;
};

// 顧客CRM→人脈DBの順に取る（人脈DBの org_name を埋めるのに組織名の対応表が必要なため）。
export async function fetchNotionCrm(token: string): Promise<FetchResult> {
  const orgPages = await queryAllPages(token, NOTION_CRM_DATABASE_ID);
  const orgs: OrgRow[] = [];
  let orgSkipped = 0;
  const orgNames = new Map<string, string>();
  for (const p of orgPages) {
    const row = orgFromPage(p);
    if (row) {
      orgs.push(row);
      orgNames.set(row.notion_page_id, row.name);
    } else {
      orgSkipped += 1;
    }
  }

  const contactPages = await queryAllPages(token, NOTION_CONTACTS_DATABASE_ID);
  const contacts: ContactRow[] = [];
  let contactSkipped = 0;
  for (const p of contactPages) {
    const row = contactFromPage(p, orgNames);
    if (row) contacts.push(row);
    else contactSkipped += 1;
  }

  return { orgs, contacts, orgSkipped, contactSkipped };
}

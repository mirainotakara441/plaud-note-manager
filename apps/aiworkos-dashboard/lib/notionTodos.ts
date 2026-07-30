// Notion「ToDo DB」と Supabase public.strategic_todos の相互変換・Notion REST呼び出しを
// 1箇所に集約する。
//
// なぜ集約するか:
//   Notionのプロパティは型（title / select / status / rich_text）ごとにJSONの形が違う。
//   ライトスルー（app/api/strategic-todos/route.ts）と取り込み（同 sync/route.ts）の
//   両方が同じ変換を必要とするため、片方だけ直して食い違うのを防ぐ。
//
// 「ステータス」は select ではなく status 型プロパティ。
// APIのペイロードが { status: { name } } と { select: { name } } で異なるので注意
// （ここを間違えると 400 validation_error になる）。

export const NOTION_TODO_DATABASE_ID = "95b41654d8d64a1db401173da45102a5";
const NOTION_VERSION = "2022-06-28";
const NOTION_API = "https://api.notion.com/v1";

export const TODO_STATUSES = ["未着手", "進行中", "完了"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
export function isTodoStatus(v: unknown): v is TodoStatus {
  return typeof v === "string" && (TODO_STATUSES as readonly string[]).includes(v);
}

export const TODO_GENRES = ["社内", "自治体", "議員", "事業者", "委託会社"] as const;
export type TodoGenre = (typeof TODO_GENRES)[number];
export function isTodoGenre(v: unknown): v is TodoGenre {
  return typeof v === "string" && (TODO_GENRES as readonly string[]).includes(v);
}

// Supabase strategic_todos の「Notionと同期する分」だけを抜き出した形。
export type TodoFields = {
  task_name: string;
  genre: TodoGenre;
  status: TodoStatus;
  target_month: string | null;
  notes: string | null;
};

export type NotionTodo = TodoFields & { notion_page_id: string };

// ============ トークン取得 ============
// app/api/diary/route.ts の notionToken() と同じ作法。
// .env.local の NOTION_TOKEN はプレースホルダ("ntn_xxxxx")のことがあるため、
// その場合は Supabase app_config の notion_health_sync_token にフォールバックする。
// 取得した値はログにも例外メッセージにも絶対に載せない。

import { serviceCreds, restHeaders } from "@/lib/supabase";

export async function notionToken(): Promise<string | null> {
  const envToken = process.env.NOTION_TOKEN;
  if (envToken && envToken.trim() !== "" && envToken !== "ntn_xxxxx") return envToken.trim();

  const c = serviceCreds();
  if (!c) return null;
  try {
    const res = await fetch(
      `${c.url}/rest/v1/app_config?select=value&key=eq.notion_health_sync_token`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!res.ok) return null;
    const rows: { value: string }[] = await res.json();
    const token = rows[0]?.value?.trim();
    return token && token !== "" ? token : null;
  } catch (err) {
    console.error("notionToken: app_config取得失敗", err);
    return null;
  }
}

function notionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

// ============ Supabase列 → Notionプロパティ ============

function titleProp(v: string) {
  return { title: [{ type: "text", text: { content: v.slice(0, 2000) } }] };
}
function richTextProp(v: string | null) {
  const s = (v ?? "").trim();
  return { rich_text: s === "" ? [] : [{ type: "text", text: { content: s.slice(0, 2000) } }] };
}

// 指定されたキーだけをNotionプロパティへ変換する（undefinedのキーは触らない＝Notion側据え置き）。
export function toNotionProperties(fields: Partial<TodoFields>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (fields.task_name !== undefined) props["タスク名"] = titleProp(fields.task_name);
  if (fields.genre !== undefined) props["ジャンル"] = { select: { name: fields.genre } };
  // status型。select型と形が違う。
  if (fields.status !== undefined) props["ステータス"] = { status: { name: fields.status } };
  if (fields.target_month !== undefined) props["対象月"] = richTextProp(fields.target_month);
  if (fields.notes !== undefined) props["備考"] = richTextProp(fields.notes);
  return props;
}

// ============ Notionページ → Supabase列 ============

type NotionRichText = { plain_text?: unknown };
type NotionPage = {
  id?: unknown;
  archived?: unknown;
  in_trash?: unknown;
  properties?: Record<string, unknown>;
};

function plainText(prop: unknown, key: "title" | "rich_text"): string {
  const arr = (prop as Record<string, unknown> | undefined)?.[key];
  if (!Array.isArray(arr)) return "";
  return (arr as NotionRichText[])
    .map((r) => (typeof r?.plain_text === "string" ? r.plain_text : ""))
    .join("")
    .trim();
}

function namedValue(prop: unknown, key: "select" | "status"): string | null {
  const v = (prop as Record<string, unknown> | undefined)?.[key];
  if (!v || typeof v !== "object") return null;
  const name = (v as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

// 変換できない行（タイトル空／ジャンルやステータスがDBのCHECK制約外）は null を返す。
// 握りつぶさずスキップ件数として呼び出し側で数えられるようにするため、例外は投げない。
export function fromNotionPage(page: NotionPage): NotionTodo | null {
  const id = typeof page?.id === "string" ? page.id : null;
  if (!id) return null;
  const props = page.properties ?? {};

  const task_name = plainText(props["タスク名"], "title");
  if (task_name === "") return null;

  const genre = namedValue(props["ジャンル"], "select");
  if (!isTodoGenre(genre)) return null;

  // Notionでステータス未設定なら未着手扱い（Supabase側はNOT NULL運用のため）。
  const rawStatus = namedValue(props["ステータス"], "status");
  const status: TodoStatus = isTodoStatus(rawStatus) ? rawStatus : "未着手";

  const target_month = plainText(props["対象月"], "rich_text") || null;
  const notes = plainText(props["備考"], "rich_text") || null;

  return { notion_page_id: id, task_name, genre, status, target_month, notes };
}

// ============ Notion REST 呼び出し ============
// 失敗時は Error を投げる。呼び出し側で握って notionSync: "failed" に落とす。

const TIMEOUT_MS = 12000;

async function notionFetch(
  token: string,
  path: string,
  init: { method: string; body?: unknown }
): Promise<unknown> {
  const res = await fetch(`${NOTION_API}${path}`, {
    method: init.method,
    headers: notionHeaders(token),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // トークンが本文に混ざることはないが、念のため長さを切って投げる。
    throw new Error(`Notion API ${init.method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function notionUpdateTodoPage(
  token: string,
  pageId: string,
  fields: Partial<TodoFields>
): Promise<void> {
  const properties = toNotionProperties(fields);
  if (Object.keys(properties).length === 0) return;
  await notionFetch(token, `/pages/${pageId}`, { method: "PATCH", body: { properties } });
}

export async function notionCreateTodoPage(
  token: string,
  fields: TodoFields
): Promise<string> {
  const data = (await notionFetch(token, "/pages", {
    method: "POST",
    body: {
      parent: { database_id: NOTION_TODO_DATABASE_ID },
      properties: toNotionProperties(fields),
    },
  })) as { id?: unknown };
  const id = typeof data?.id === "string" ? data.id : null;
  if (!id) throw new Error("Notionページ作成のレスポンスにidがありません");
  return id;
}

// 完全削除ではなくアーカイブ。誤操作からNotionのゴミ箱で復旧できる余地を残す。
export async function notionArchivePage(token: string, pageId: string): Promise<void> {
  await notionFetch(token, `/pages/${pageId}`, {
    method: "PATCH",
    body: { archived: true },
  });
}

// ToDo DBの全ページを取得する。archived（ゴミ箱）のページはNotion側が返さないため、
// 「Supabaseにあって結果に含まれないもの＝Notionで消された」と判定できる。
//
// 変換できなかったページ（タイトル空／ジャンル・ステータスがDBのCHECK制約外）は
// todos に含めず skipped として数えて返す。黙って落とすと取り込み結果の件数が
// 実態と食い違い、「取り込めている」という誤解を生むため。
//
// livePageIds は「変換できたかどうかに関わらず、Notionに生きて存在するページID」。
// 取り込み側の削除判定には必ずこちらを使うこと。todos から作ってしまうと、
// 変換できなかっただけのページが「Notionで消された」と誤判定され、
// Supabaseの実データが消える。
export async function notionFetchAllTodos(
  token: string
): Promise<{ todos: NotionTodo[]; skipped: number; livePageIds: Set<string> }> {
  const todos: NotionTodo[] = [];
  const livePageIds = new Set<string>();
  let skipped = 0;
  let cursor: string | undefined = undefined;
  let guard = 0;
  do {
    const data = (await notionFetch(
      token,
      `/databases/${NOTION_TODO_DATABASE_ID}/query`,
      { method: "POST", body: { page_size: 100, start_cursor: cursor } }
    )) as { results?: unknown; has_more?: unknown; next_cursor?: unknown };

    const results = Array.isArray(data?.results) ? (data.results as NotionPage[]) : [];
    for (const p of results) {
      if (p?.archived === true || p?.in_trash === true) continue;
      if (typeof p?.id === "string") livePageIds.add(p.id);
      const row = fromNotionPage(p);
      if (row) todos.push(row);
      else skipped += 1;
    }
    cursor =
      data?.has_more === true && typeof data.next_cursor === "string"
        ? data.next_cursor
        : undefined;
    guard += 1;
  } while (cursor && guard < 50);
  return { todos, skipped, livePageIds };
}

// Notionは約3req/秒。逐次＋わずかな間隔で叩く（全件同期・一括更新用）。
export async function runSequential<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  gapMs = 350
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
    out.push(await fn(items[i]));
  }
  return out;
}

import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";
import {
  TODO_STATUSES,
  TODO_GENRES,
  isTodoStatus,
  isTodoGenre,
  notionToken,
  notionCreateTodoPage,
  notionUpdateTodoPage,
  notionArchivePage,
  runSequential,
  type TodoStatus,
  type TodoGenre,
  type TodoFields,
} from "@/lib/notionTodos";

// 「戦略ToDo」= Notion「ToDo DB」とライトスルーで同期する、ジャンル別（社内／自治体／
// 議員／事業者／委託会社）の月次営業ToDo。テーブルは strategic_todos。
//
// daily_actions（日記由来・日付ベース）とは由来もデータ形も違うため、テーブルは
// 分けたまま「日々のToDo」ページ（app/actions/page.tsx）のUIレイヤーで束ねる。
//
// 読み取りは anonキー（RLSで anon にSELECTのみ許可）、書き込みは service role キー。
// 既存の app/api/actions/route.ts と同じ作法。
//
// ── Notion同期の方針（ライトスルー）────────────────────────────────
// PATCH/POST/DELETE は「Supabaseを更新 → 対応するNotionページも更新」の順で行う。
// Notion側が落ちても操作はブロックしない（Supabaseの結果を成功として返す）が、
// 失敗を握りつぶすと画面が「同期済み」と嘘をつくため、必ずレスポンスに
// notionSync を載せて画面側で控えめに示せるようにする。
//   ok      … Notionにも反映済み
//   failed  … Supabaseのみ反映。Notionは未反映
//   skipped … Notion連携対象（notion_page_id）を持たない行で、同期の必要なし
// 逆方向（Notionでの変更をサイトへ）は app/api/strategic-todos/sync/route.ts。

export const dynamic = "force-dynamic";

const TABLE = "strategic_todos";

// Notion側のセレクト値／ステータス値と一致していなければならない。
// 同時に strategic_todos の genre / status CHECK制約とも一致させる必要があるため、
// 定義は lib/notionTodos.ts に集約する（Notionプロパティ変換と必ず同じ集合にするため）。
const STATUSES = TODO_STATUSES;
type Status = TodoStatus;
const isStatus = isTodoStatus;

const GENRES = TODO_GENRES;
type Genre = TodoGenre;
const isGenre = isTodoGenre;

type NotionSync = "ok" | "failed" | "skipped";

function headers(key: string, prefer?: string): Record<string, string> {
  return restHeaders(key, prefer ? { Prefer: prefer } : undefined);
}

// Notion呼び出しの共通ラッパ。例外はここで必ず止めて "failed" に変換する
// （ユーザー操作をブロックしないため）。理由はサーバーログに残す。
async function trySync(label: string, fn: (token: string) => Promise<void>): Promise<NotionSync> {
  try {
    const token = await notionToken();
    if (!token) {
      console.error(`strategic-todos: ${label} Notionトークン未設定のため未同期`);
      return "failed";
    }
    await fn(token);
    return "ok";
  } catch (err) {
    console.error(`strategic-todos: ${label} Notion同期失敗`, err);
    return "failed";
  }
}

const SELECT =
  "id,notion_page_id,task_name,genre,status,target_month,notes,created_at,updated_at";

// 一覧取得（ジャンル順→登録順）。並べ替え・グルーピングは画面側で行う。
export async function GET() {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=${SELECT}&order=genre.asc,created_at.asc`,
    { headers: headers(c.key), cache: "no-store" }
  );
  if (!res.ok) {
    return NextResponse.json({ error: `取得失敗 ${res.status}` }, { status: 502 });
  }
  const items = await res.json();
  return NextResponse.json({ items });
}

// 新規追加。SupabaseへINSERTしたあと、NotionのToDo DBにも同じ内容のページを作り、
// 返ってきたページIDを notion_page_id に書き戻す。
// ここで書き戻さないと、その行は以後どちらの同期経路からも対象外になり、
// サイトでしか見えない孤児行として永久に取り残される。
export async function POST(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const body = await req.json().catch(() => null);

  const task_name: string = (body?.task_name ?? "").trim();
  if (!task_name) {
    return NextResponse.json({ error: "task_nameが空です" }, { status: 400 });
  }

  const genre: unknown = body?.genre;
  if (!isGenre(genre)) {
    return NextResponse.json(
      { error: `genreが不正です（${GENRES.join("/")}のいずれか）` },
      { status: 400 }
    );
  }

  const target_month: unknown = body?.target_month;
  const target_month_value =
    typeof target_month === "string" ? target_month.trim() || null : null;

  const notes: unknown = body?.notes;
  const notes_value = typeof notes === "string" ? notes.trim() || null : null;

  const res = await fetch(`${c.url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: headers(c.key, "return=representation"),
    body: JSON.stringify({
      notion_page_id: null,
      task_name,
      genre,
      status: "未着手",
      target_month: target_month_value,
      notes: notes_value,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    return NextResponse.json({ error: `追加失敗 ${res.status}: ${t}` }, { status: 502 });
  }
  const rows = await res.json();
  const item = rows[0];

  // Supabaseへの登録は済んでいる。ここから先が失敗しても追加そのものは成功扱い。
  let notionSync: NotionSync = "failed";
  let notionPageId: string | null = null;
  const fields: TodoFields = {
    task_name,
    genre,
    status: "未着手",
    target_month: target_month_value,
    notes: notes_value,
  };
  try {
    const token = await notionToken();
    if (!token) {
      console.error("strategic-todos POST: Notionトークン未設定のため未同期");
    } else {
      notionPageId = await notionCreateTodoPage(token, fields);
    }
  } catch (err) {
    console.error("strategic-todos POST: Notionページ作成失敗", err);
  }

  if (notionPageId && item?.id) {
    // 作ったページIDを書き戻す。ここが失敗するとNotion側だけ孤児ページになるため、
    // 失敗時は notionSync を ok にしない（画面に「Notion未反映」を出させる）。
    const back = await fetch(
      `${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(item.id)}`,
      {
        method: "PATCH",
        headers: headers(c.key, "return=representation"),
        body: JSON.stringify({ notion_page_id: notionPageId }),
      }
    );
    if (back.ok) {
      const backRows = await back.json().catch(() => null);
      if (Array.isArray(backRows) && backRows[0]) return NextResponse.json({ item: backRows[0], notionSync: "ok" });
      item.notion_page_id = notionPageId;
      notionSync = "ok";
    } else {
      console.error("strategic-todos POST: notion_page_id書き戻し失敗", back.status);
    }
  }

  return NextResponse.json({ item, notionSync });
}

// ステータス更新。単体 { id, status/task_name/notes/genre } または一括 { ids: string[], status }。
export async function PATCH(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const body = await req.json().catch(() => null);

  // 一括更新
  if (Array.isArray(body?.ids)) {
    const status: unknown = body?.status;
    if (!isStatus(status)) {
      return NextResponse.json(
        { error: `statusが不正です（${STATUSES.join("/")}のいずれか）` },
        { status: 400 }
      );
    }
    const patch = { status, updated_at: new Date().toISOString() };

    const ids: string[] = body.ids.filter(
      (x: unknown): x is string => typeof x === "string" && x.length > 0
    );
    if (ids.length === 0) {
      return NextResponse.json({ error: "idsが必要です" }, { status: 400 });
    }
    const idList = ids.map((id) => encodeURIComponent(id)).join(",");
    const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=in.(${idList})`, {
      method: "PATCH",
      headers: headers(c.key, "return=representation"),
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const t = await res.text();
      return NextResponse.json(
        { error: `一括更新失敗 ${res.status}: ${t}` },
        { status: 502 }
      );
    }
    const rows = await res.json();
    const updated: { notion_page_id: string | null }[] = Array.isArray(rows) ? rows : [];

    // 対象ページを逐次でNotionへ反映（レート制限 約3req/秒に配慮）。
    // 1件でも失敗したら全体を failed 扱いにする（部分成功を「ok」と言わないため）。
    const pageIds = updated
      .map((r) => r.notion_page_id)
      .filter((x): x is string => typeof x === "string" && x !== "");
    let notionSync: NotionSync = pageIds.length === 0 ? "skipped" : "ok";
    if (pageIds.length > 0) {
      const token = await notionToken();
      if (!token) {
        console.error("strategic-todos PATCH(bulk): Notionトークン未設定のため未同期");
        notionSync = "failed";
      } else {
        const results = await runSequential(pageIds, async (pid) => {
          try {
            await notionUpdateTodoPage(token, pid, { status });
            return true;
          } catch (err) {
            console.error("strategic-todos PATCH(bulk): Notion更新失敗", err);
            return false;
          }
        });
        if (results.some((ok) => !ok)) notionSync = "failed";
      }
    }

    return NextResponse.json({ ok: true, count: updated.length, notionSync });
  }

  // 単体更新（status/task_name/notes/genre のうち指定されたものだけを反映）
  const id: unknown = body?.id;
  if (typeof id !== "string" || !id) {
    return NextResponse.json({ error: "idが必要です" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  // Notionへ送る分。指定されたキーだけ入れる（未指定のプロパティはNotion側で据え置き）。
  const notionFields: Partial<TodoFields> = {};
  let hasField = false;

  if (body?.status !== undefined) {
    const status: unknown = body.status;
    if (!isStatus(status)) {
      return NextResponse.json(
        { error: `statusが不正です（${STATUSES.join("/")}のいずれか）` },
        { status: 400 }
      );
    }
    patch.status = status;
    notionFields.status = status;
    hasField = true;
  }

  if (body?.task_name !== undefined) {
    const task_name = typeof body.task_name === "string" ? body.task_name.trim() : "";
    if (!task_name) {
      return NextResponse.json({ error: "task_nameが空です" }, { status: 400 });
    }
    patch.task_name = task_name;
    notionFields.task_name = task_name;
    hasField = true;
  }

  if (body?.genre !== undefined) {
    const genre: unknown = body.genre;
    if (!isGenre(genre)) {
      return NextResponse.json(
        { error: `genreが不正です（${GENRES.join("/")}のいずれか）` },
        { status: 400 }
      );
    }
    patch.genre = genre;
    notionFields.genre = genre;
    hasField = true;
  }

  if (body?.notes !== undefined) {
    if (typeof body.notes === "string") {
      const notes = body.notes.trim();
      patch.notes = notes ? notes : null;
      notionFields.notes = notes ? notes : null;
      hasField = true;
    }
  }

  if (body?.target_month !== undefined) {
    if (typeof body.target_month === "string") {
      const tm = body.target_month.trim();
      patch.target_month = tm ? tm : null;
      notionFields.target_month = tm ? tm : null;
      hasField = true;
    }
  }

  if (!hasField) {
    return NextResponse.json({ error: "更新項目がありません" }, { status: 400 });
  }

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: headers(c.key, "return=representation"),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const t = await res.text();
    return NextResponse.json({ error: `更新失敗 ${res.status}: ${t}` }, { status: 502 });
  }
  const rows = await res.json();
  const item = rows[0] ?? null;

  const pageId: string | null =
    typeof item?.notion_page_id === "string" && item.notion_page_id !== ""
      ? item.notion_page_id
      : null;

  const notionSync: NotionSync = pageId
    ? await trySync("PATCH", (token) => notionUpdateTodoPage(token, pageId, notionFields))
    : "skipped";

  return NextResponse.json({ item, notionSync });
}

// 1件削除。Supabaseからは行を消し、Notion側は archived: true にする（＝ゴミ箱へ）。
// 完全削除にしないのは、誤操作をNotionのゴミ箱から復旧できる余地を残すため。
// return=representation で削除した行を受け取り、notion_page_id を得る
// （先に消してしまうと、どのページを畳めばよいか分からなくなる）。
export async function DELETE(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });
  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(c.key, "return=representation"),
  });
  if (!res.ok) {
    return NextResponse.json({ error: `削除失敗 ${res.status}` }, { status: 502 });
  }
  const rows = await res.json().catch(() => null);
  const pageId: string | null =
    Array.isArray(rows) && typeof rows[0]?.notion_page_id === "string" && rows[0].notion_page_id !== ""
      ? rows[0].notion_page_id
      : null;

  const notionSync: NotionSync = pageId
    ? await trySync("DELETE", (token) => notionArchivePage(token, pageId))
    : "skipped";

  return NextResponse.json({ ok: true, notionSync });
}

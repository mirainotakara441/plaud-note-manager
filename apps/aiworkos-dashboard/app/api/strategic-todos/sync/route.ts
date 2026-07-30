import { NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import {
  notionToken,
  notionFetchAllTodos,
  type NotionTodo,
} from "@/lib/notionTodos";

// Notion「ToDo DB」→ Supabase strategic_todos の取り込み（B方向）。
//
// サイト側の変更は app/api/strategic-todos/route.ts がライトスルーで即Notionへ流すが、
// Notion側で直接編集した分はここを叩くまでサイトに出てこない。
// 「日々のToDo」画面（/actions）の「Notionから取り込み」ボタンから呼ばれる。
//
// 突き合わせは notion_page_id をキーにする:
//   - Notionにあって Supabase に無い          → 追加
//   - 両方にある（値が違う）                  → Notion側の値で更新
//   - Notion側でアーカイブ／削除されたもの     → Supabase からも削除
//
// 削除判定の注意:
//   Notionの database query はアーカイブ済みページを返さない。したがって
//   「notion_page_id を持つのに今回の取得結果に居ない行」＝Notionで消された行、と判断できる。
//   一方 notion_page_id が null の行は、サイトで追加したがNotionページ作成に失敗した行
//   （＝まだNotionに存在したことがない）なので、絶対に削除対象へ入れない。
//   ここを間違えると、同期の失敗が黙ってデータ消失に化ける。

export const dynamic = "force-dynamic";

const TABLE = "strategic_todos";

type Row = {
  id: string;
  notion_page_id: string | null;
  task_name: string;
  genre: string;
  status: string;
  target_month: string | null;
  notes: string | null;
  due_date: string | null;
};

function norm(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
}

// Notion側の値とSupabaseの行が実質同じか。同じなら書きに行かない（無駄なUPDATEを避ける）。
function same(row: Row, n: NotionTodo): boolean {
  return (
    row.task_name === n.task_name &&
    row.genre === n.genre &&
    row.status === n.status &&
    norm(row.target_month) === norm(n.target_month) &&
    norm(row.notes) === norm(n.notes) &&
    // due_date は Supabase から "YYYY-MM-DD" で返り、Notion側も同形に正規化済み。
    norm(row.due_date) === norm(n.due_date)
  );
}

export async function POST() {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const token = await notionToken();
  if (!token) {
    return NextResponse.json(
      { error: "Notionトークンが未設定です。NOTION_TOKEN を確認してください。" },
      { status: 500 }
    );
  }

  // 1) Notion全件（変換できなかったページは skipped として数えられて返る）
  let notionRows: NotionTodo[];
  let skipped: number;
  let livePageIds: Set<string>;
  try {
    const fetched = await notionFetchAllTodos(token);
    notionRows = fetched.todos;
    skipped = fetched.skipped;
    livePageIds = fetched.livePageIds;
  } catch (err) {
    console.error("strategic-todos/sync: Notion取得失敗", err);
    return NextResponse.json({ error: "Notionからの取得に失敗しました" }, { status: 502 });
  }

  // 2) Supabase全件
  const listRes = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=id,notion_page_id,task_name,genre,status,target_month,notes,due_date`,
    { headers: restHeaders(c.key), cache: "no-store" }
  );
  if (!listRes.ok) {
    const t = await listRes.text();
    return NextResponse.json(
      { error: `Supabase取得失敗 ${listRes.status}: ${t}` },
      { status: 502 }
    );
  }
  const rows: Row[] = await listRes.json();

  const byPageId = new Map<string, Row>();
  for (const r of rows) {
    if (typeof r.notion_page_id === "string" && r.notion_page_id !== "") {
      byPageId.set(r.notion_page_id, r);
    }
  }
  // 3) 差分を仕分ける
  const toInsert: NotionTodo[] = [];
  const toUpdate: { row: Row; n: NotionTodo }[] = [];
  for (const n of notionRows) {
    const row = byPageId.get(n.notion_page_id);
    if (!row) toInsert.push(n);
    else if (!same(row, n)) toUpdate.push({ row, n });
  }
  // notion_page_id を持つのにNotion側に生きたページが無い＝アーカイブ／削除された。
  // 判定には livePageIds（変換可否に関わらず生存しているページ）を使う。
  // notionRows から作ると、変換できなかっただけのページを消えたと誤判定してしまう。
  const toDelete = rows.filter(
    (r) =>
      typeof r.notion_page_id === "string" &&
      r.notion_page_id !== "" &&
      !livePageIds.has(r.notion_page_id)
  );

  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  let removed = 0;
  const errors: string[] = [];

  // 4) 追加（1リクエストでまとめてINSERT）
  if (toInsert.length > 0) {
    const res = await fetch(`${c.url}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: restHeaders(c.key, { Prefer: "return=representation" }),
      body: JSON.stringify(
        toInsert.map((n) => ({
          notion_page_id: n.notion_page_id,
          task_name: n.task_name,
          genre: n.genre,
          status: n.status,
          target_month: n.target_month,
          notes: n.notes,
          due_date: n.due_date,
          updated_at: now,
        }))
      ),
    });
    if (res.ok) {
      const ins = await res.json().catch(() => []);
      added = Array.isArray(ins) ? ins.length : toInsert.length;
    } else {
      errors.push(`追加失敗 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  // 5) 更新（差分のある行だけ、1件ずつ）
  for (const { row, n } of toUpdate) {
    const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: restHeaders(c.key),
      body: JSON.stringify({
        task_name: n.task_name,
        genre: n.genre,
        status: n.status,
        target_month: n.target_month,
        notes: n.notes,
        due_date: n.due_date,
        updated_at: now,
      }),
    });
    if (res.ok) updated += 1;
    else errors.push(`更新失敗 ${res.status}: ${(await res.text()).slice(0, 120)}`);
  }

  // 6) 削除（Notionで消えたもの）
  if (toDelete.length > 0) {
    const idList = toDelete.map((r) => encodeURIComponent(r.id)).join(",");
    const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=in.(${idList})`, {
      method: "DELETE",
      headers: restHeaders(c.key, { Prefer: "return=representation" }),
    });
    if (res.ok) {
      const del = await res.json().catch(() => []);
      removed = Array.isArray(del) ? del.length : toDelete.length;
    } else {
      errors.push(`削除失敗 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  // skipped … Notionにはあるが、ジャンル／ステータスがDBのCHECK制約外、または
  // タイトルが空で取り込めなかった件数。0でなければNotion側の値を直す必要がある。
  return NextResponse.json({
    added,
    updated,
    removed,
    skipped,
    notionTotal: notionRows.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}

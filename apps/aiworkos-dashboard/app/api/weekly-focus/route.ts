import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";

// ホーム上部の「今週おこなうこと」。1週あたり最大5件。
//
// 日々のToDo（daily_actions）とは別物。あちらは日記から自動で積み上がる「こなす一覧」で、
// こちらは自分で選んで書く「今週これだけはやる」。5点に絞ることそのものが目的なので、
// 上限はDBのCHECK制約とここの両方で守る（画面だけの約束にしない）。
//
// 週の切り替えは自動。週が変わると新しい週が空で始まり、前の週の行はそのまま残る
// （月次の振り返りで「やると決めたこと」と「実際にやったこと」を突き合わせられるように）。

export const dynamic = "force-dynamic";

const TABLE = "weekly_focus";
const MAX = 5;

export type FocusRow = {
  id: string;
  week_start: string;
  position: number;
  content: string;
  done: boolean;
};

/** JSTの「その週の月曜」。週報・振り返りと同じ切り方にそろえる。 */
function mondayOf(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const dow = jst.getUTCDay(); // 0=日
  const back = dow === 0 ? 6 : dow - 1; // 月曜まで戻る日数
  jst.setUTCDate(jst.getUTCDate() - back);
  return jst.toISOString().slice(0, 10);
}

function shiftWeek(week: string, weeks: number): string {
  const d = new Date(`${week}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

async function rowsOf(
  c: { url: string; key: string },
  week: string
): Promise<FocusRow[]> {
  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?select=id,week_start,position,content,done&week_start=eq.${week}&order=position.asc`,
    { headers: restHeaders(c.key), cache: "no-store" }
  );
  if (!res.ok) throw new Error(`取得失敗 ${res.status}`);
  return res.json();
}

export async function GET() {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const week = mondayOf(new Date());
  try {
    const [items, prev] = await Promise.all([rowsOf(c, week), rowsOf(c, shiftWeek(week, -1))]);
    return NextResponse.json({
      week_start: week,
      items,
      max: MAX,
      // 先週やり残したもの。週が変わると一覧が空になるので、
      // 消えたのか終わったのかが分からなくならないよう件数だけ出す。
      carryover: prev.filter((r) => !r.done).map((r) => r.content),
    });
  } catch (err) {
    console.error("GET /api/weekly-focus:", err);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 502 });
  }
}

// 追加。{ content }（今週の空いている番号に入れる）
export async function POST(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  let body: { content?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return NextResponse.json({ error: "内容を入力してください" }, { status: 400 });

  const week = mondayOf(new Date());
  try {
    const items = await rowsOf(c, week);
    if (items.length >= MAX) {
      return NextResponse.json(
        { error: `今週はすでに${MAX}件あります。どれかを消してから足してください。` },
        { status: 409 }
      );
    }
    // 空いている番号のいちばん小さいものへ入れる（消したあとの穴を埋める）。
    const used = new Set(items.map((r) => r.position));
    let position = 1;
    while (used.has(position)) position += 1;

    const res = await fetch(`${c.url}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: restHeaders(c.key, { Prefer: "return=representation" }),
      body: JSON.stringify({ week_start: week, position, content }),
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("POST /api/weekly-focus:", res.status, detail.slice(0, 300));
      return NextResponse.json({ error: `追加に失敗 ${res.status}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true, item: (await res.json())[0] });
  } catch (err) {
    console.error("POST /api/weekly-focus:", err);
    return NextResponse.json({ error: "追加に失敗しました" }, { status: 502 });
  }
}

// 書き換え・完了の切替。{ id, content?, done? }
export async function PATCH(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  let body: { id?: unknown; content?: unknown; done?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.content === "string") {
    const content = body.content.trim();
    if (!content) return NextResponse.json({ error: "内容が空です" }, { status: 400 });
    patch.content = content;
  }
  if (typeof body.done === "boolean") {
    patch.done = body.done;
    patch.done_at = body.done ? new Date().toISOString() : null;
  }
  if (!("content" in patch) && !("done" in patch)) {
    return NextResponse.json({ error: "変更する項目がありません" }, { status: 400 });
  }

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
    body: JSON.stringify(patch),
    cache: "no-store",
  });
  if (!res.ok) {
    return NextResponse.json({ error: `更新に失敗 ${res.status}` }, { status: 502 });
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "対象が見つかりません" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

// 削除。?id=…
export async function DELETE(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const id = new URL(req.url).searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
    cache: "no-store",
  });
  if (!res.ok) {
    return NextResponse.json({ error: `削除に失敗 ${res.status}` }, { status: 502 });
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "対象が見つかりません" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

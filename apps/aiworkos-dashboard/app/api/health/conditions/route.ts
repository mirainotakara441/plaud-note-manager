import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { isValidCalendarDate } from "@/lib/date";

// 体調の記録（health_conditions）。
//
// なぜ health_metrics に入れないか:
//   health_metrics は「1日に数値が1個」の形。体調は 8/8〜8/10 のように期間を持ち、
//   診断名・受けた検査の結果（コロナもインフルも溶連菌も陰性だった、など）という
//   数値でないものが本体になる。metric を増やして無理に押し込むと、
//   後から「何を疑って何を潰したか」が読めなくなるので別テーブルにしている。
//
// なぜ「違った病気」を残すか:
//   次に同じ症状が出たときに効くのは「何だったか」より「何を先に潰したか」。
//   通院の履歴としても、後から医者に説明するときの材料になる。

export const dynamic = "force-dynamic";

const TABLE = "health_conditions";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TITLE = 60;
const MAX_NOTE = 2000;
const MAX_TAGS = 12;
const MAX_TAG_LEN = 30;
/** 人が耐えられる体温の幅。打ち間違い（3.9 や 390）を弾くためだけの範囲。 */
const TEMP_MIN = 34;
const TEMP_MAX = 43;

const SELECT =
  "select=id,start_day,end_day,title,max_temp_c,symptoms,ruled_out,note,created_at,updated_at";

type Body = {
  id?: unknown;
  start_day?: unknown;
  end_day?: unknown;
  title?: unknown;
  max_temp_c?: unknown;
  symptoms?: unknown;
  ruled_out?: unknown;
  note?: unknown;
};

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== "string") continue;
    const s = t.trim().slice(0, MAX_TAG_LEN);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** 登録・更新の共通チェック。問題があればメッセージを返す。 */
function validate(b: Body): { error: string } | { fields: Record<string, unknown> } {
  const start = b.start_day;
  if (typeof start !== "string" || !DAY_RE.test(start) || !isValidCalendarDate(start)) {
    return { error: "始まりの日を入れてください" };
  }
  // 終わりの日は空でよい（まだ治っていない＝継続中）
  let end: string | null = null;
  if (typeof b.end_day === "string" && b.end_day.trim() !== "") {
    if (!DAY_RE.test(b.end_day) || !isValidCalendarDate(b.end_day)) {
      return { error: "終わりの日の形式が不正です" };
    }
    if (b.end_day < start) return { error: "終わりの日が始まりの日より前になっています" };
    end = b.end_day;
  }

  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) return { error: "病名か症状の呼び名を入れてください" };
  if (title.length > MAX_TITLE) return { error: `呼び名は${MAX_TITLE}文字までです` };

  let temp: number | null = null;
  if (b.max_temp_c != null && String(b.max_temp_c).trim() !== "") {
    const n = Number(b.max_temp_c);
    if (!Number.isFinite(n) || n < TEMP_MIN || n > TEMP_MAX) {
      return { error: `最高体温は${TEMP_MIN}〜${TEMP_MAX}度の範囲で入れてください` };
    }
    temp = n;
  }

  const note = typeof b.note === "string" ? b.note.trim().slice(0, MAX_NOTE) : null;

  return {
    fields: {
      start_day: start,
      end_day: end,
      title,
      max_temp_c: temp,
      symptoms: cleanTags(b.symptoms),
      ruled_out: cleanTags(b.ruled_out),
      note: note || null,
    },
  };
}

/** 一覧。期間で絞れるが、既定は新しい順に全部返す（そう多くならないため）。 */
export async function GET(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const params = [SELECT, "order=start_day.desc", "limit=500"];
  // 期間の重なりで絞る。「8/8〜8/10の記録」は、表示期間が8/9だけでも見えてほしい。
  if (to && DAY_RE.test(to)) params.push(`start_day=lte.${to}`);
  if (from && DAY_RE.test(from)) params.push(`or=(end_day.is.null,end_day.gte.${from})`);

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?${params.join("&")}`, {
    headers: restHeaders(c.key),
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("体調記録の取得に失敗:", res.status, t.slice(0, 200));
    return NextResponse.json({ error: "体調記録の取得に失敗しました" }, { status: 502 });
  }
  return NextResponse.json({ items: await res.json() });
}

/** 新規登録。 */
export async function POST(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = (await req.json().catch(() => null)) as Body | null;
  const v = validate(body ?? {});
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400 });

  const res = await fetch(`${c.url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
    body: JSON.stringify(v.fields),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return NextResponse.json({ error: `登録に失敗 ${res.status}: ${t.slice(0, 200)}` }, { status: 502 });
  }
  const rows = await res.json();
  return NextResponse.json({ ok: true, item: Array.isArray(rows) ? rows[0] : rows });
}

/** 書き換え。 */
export async function PATCH(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = (await req.json().catch(() => null)) as Body | null;
  const id = body?.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "idの指定が不正です" }, { status: 400 });
  }
  const v = validate(body ?? {});
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400 });

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${id}`, {
    method: "PATCH",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
    body: JSON.stringify({ ...v.fields, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return NextResponse.json({ error: `更新に失敗 ${res.status}: ${t.slice(0, 200)}` }, { status: 502 });
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "対象が見つかりません" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, item: rows[0] });
}

/** 削除。 */
export async function DELETE(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "idの指定が不正です" }, { status: 400 });
  }

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${id}`, {
    method: "DELETE",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return NextResponse.json({ error: `削除に失敗 ${res.status}: ${t.slice(0, 200)}` }, { status: 502 });
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "対象が見つかりません" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

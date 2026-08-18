import { NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";

// 用語集（/glossary）の読み書きAPI。
//
// 件数は数十〜数百どまりなので、全件を1回で返して並べ替えと検索は
// ブラウザ側で行う（/bootcamp と同じ流儀）。打つたびに問い合わせんぶん、
// 検索語の出し入れが速い。
//
// GET  … 読み取り。glossary は RLS で anon に SELECT を許可している
// POST … 登録。書き込みは service role でのみ行う

export const dynamic = "force-dynamic";

const COLUMNS = [
  "id",
  "term",
  "reading",
  "aliases",
  "category",
  "short",
  "essence",
  "usage_note",
  "related",
  "source_sprint",
  "source_chapter",
  "created_at",
].join(",");

export async function GET() {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  try {
    const res = await fetch(
      `${c.url}/rest/v1/glossary?select=${COLUMNS}&order=reading.asc`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `用語集の取得に失敗しました（${res.status}）${detail.slice(0, 120)}`
      );
    }
    const terms = await res.json();
    return NextResponse.json({ terms });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "取得に失敗しました" },
      { status: 502 }
    );
  }
}

export async function POST(req: Request) {
  const c = serviceCreds();
  if (!c) {
    return NextResponse.json(
      { error: "書き込み用のキーが未設定です" },
      { status: 500 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "本文が読めません" }, { status: 400 });
  }

  // 読みが無いとあいうえお順に並ばず、行方不明になる。必須にしている。
  const required = ["term", "reading", "short", "essence"];
  const missing = required.filter((k) => !String(body[k] ?? "").trim());
  if (missing.length) {
    return NextResponse.json(
      { error: `未入力の項目があります：${missing.join("・")}` },
      { status: 400 }
    );
  }

  const row = {
    term: String(body.term).trim(),
    reading: String(body.reading).trim(),
    aliases: Array.isArray(body.aliases) ? body.aliases : [],
    category: String(body.category ?? "AI").trim() || "AI",
    short: String(body.short).trim(),
    essence: String(body.essence).trim(),
    usage_note: body.usage_note ? String(body.usage_note).trim() : null,
    related: Array.isArray(body.related) ? body.related : [],
    source_sprint: body.source_sprint ? String(body.source_sprint).trim() : null,
    source_chapter: body.source_chapter
      ? String(body.source_chapter).trim()
      : null,
  };

  try {
    const res = await fetch(`${c.url}/rest/v1/glossary`, {
      method: "POST",
      headers: { ...restHeaders(c.key), Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // 同じ語を二重登録しようとした場合はここに来る
      if (res.status === 409) {
        throw new Error(`「${row.term}」はもう登録されています`);
      }
      throw new Error(`登録に失敗しました（${res.status}）${detail.slice(0, 120)}`);
    }
    const [saved] = await res.json();
    return NextResponse.json({ term: saved });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "登録に失敗しました" },
      { status: 502 }
    );
  }
}

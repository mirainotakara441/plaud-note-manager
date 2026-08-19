import { NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import type { LegislatorNote } from "@/lib/legislators";

// 議員リスト／手書きメモ。
//
// 履歴（週報・記憶）と予定（戦略ToDo）は既存データからの自動導出なので、
// 元データは絶対に書き換えない。また、名簿である notion_contacts は
// 毎時のNotion同期で「Notionに無い行は削除」されるため、そこにも書かない。
// 吉井さん自身のメモは独立した legislator_notes テーブルへ議員1人1件で保存する。
//
//   PUT    { name_key, content } … upsert（空文字は 400。消すなら DELETE）
//   DELETE ?name=くまがい誠一     … 1件削除
//
// 読み取りは /api/legislators がまとめて返すため、ここには GET を置かない。
// legislator_notes は RLS で anon に SELECT のみ許可しているため、
// 書き込み・削除は serviceCreds() を使う。

export const dynamic = "force-dynamic";

const TABLE = "legislator_notes";
const MAX_CONTENT_LENGTH = 5000;

function missingEnv() {
  return NextResponse.json(
    { error: "サーバー設定エラー: 環境変数が設定されていません" },
    { status: 500 }
  );
}

export async function PUT(request: Request) {
  const service = serviceCreds();
  if (!service) return missingEnv();

  const body: unknown = await request.json().catch(() => null);
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const nameKey = typeof raw?.name_key === "string" ? raw.name_key.trim() : "";
  const content = typeof raw?.content === "string" ? raw.content.trim() : "";

  if (nameKey === "") {
    return NextResponse.json({ error: "name_key は必須です" }, { status: 400 });
  }
  if (content === "") {
    return NextResponse.json(
      { error: "メモが空です。削除する場合は DELETE を使ってください" },
      { status: 400 }
    );
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return NextResponse.json(
      { error: `メモは${MAX_CONTENT_LENGTH}文字までです` },
      { status: 400 }
    );
  }

  // name_key の UNIQUE 制約に対する upsert。
  // updated_at はテーブルの BEFORE UPDATE トリガが自動で更新する。
  const res = await fetch(
    `${service.url}/rest/v1/${TABLE}?on_conflict=name_key&select=name_key,content,updated_at`,
    {
      method: "POST",
      headers: restHeaders(service.key, {
        Prefer: "resolution=merge-duplicates,return=representation",
      }),
      body: JSON.stringify([{ name_key: nameKey, content }]),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("議員メモ保存エラー:", res.status, text);
    return NextResponse.json({ error: "手書きメモの保存に失敗しました" }, { status: 502 });
  }
  const rows: unknown = await res.json().catch(() => null);
  const note = Array.isArray(rows) ? (rows[0] as LegislatorNote | undefined) : undefined;
  if (!note) {
    console.error("議員メモ保存エラー: upsertの返り値が空でした", nameKey);
    return NextResponse.json({ error: "手書きメモの保存に失敗しました" }, { status: 502 });
  }
  return NextResponse.json({ note });
}

export async function DELETE(request: Request) {
  const service = serviceCreds();
  if (!service) return missingEnv();

  const { searchParams } = new URL(request.url);
  const nameKey = searchParams.get("name")?.trim();
  if (!nameKey) {
    return NextResponse.json({ error: "name は必須です" }, { status: 400 });
  }

  const res = await fetch(
    `${service.url}/rest/v1/${TABLE}?name_key=eq.${encodeURIComponent(nameKey)}`,
    { method: "DELETE", headers: restHeaders(service.key) }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("議員メモ削除エラー:", res.status, text);
    return NextResponse.json({ error: "手書きメモの削除に失敗しました" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}

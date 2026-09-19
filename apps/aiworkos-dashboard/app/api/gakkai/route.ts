import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";

// 学会書類。毎朝8時にローカルの定期タスクが gakkai_documents へ新着書類
// （要約・納期つき）をINSERTし、ここはその「表示」と「対応状況の更新」を担う。
//
// gakkai_documents はRLS有効・ポリシー無し（= service role のみアクセス可）
// のため、読み取り（SELECT）も anonCreds() ではなく serviceCreds() を使う。
// 学会の書類は信仰にかかわる個人的な内容を含むので、anonにSELECTポリシーを
// 開けて講座アーカイブと同じ方針（読み取りanon）に揃えることはしない。

export const dynamic = "force-dynamic";

const TABLE = "gakkai_documents";
const STATUSES = ["未対応", "対応中", "完了"];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function GET(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  // 並びは「納期が近い順（納期なしは最後）→ 新着順」。このページを開く動機は
  // ほぼ「次に何を出さなあかんか」なので、締切が迫るものを先頭に固定する。
  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", "deadline.asc.nullslast,created_at.desc");

  // status での絞り込み（任意）。許可外の値は黙って無視せず400で返す
  // （タイプミスに気づけないまま全件が返るほうがタチが悪い）。
  const status = str(req.nextUrl.searchParams.get("status"));
  if (status) {
    if (!STATUSES.includes(status)) {
      return NextResponse.json(
        { error: `statusは次から選んでください: ${STATUSES.join(" / ")}` },
        { status: 400 }
      );
    }
    params.set("status", `eq.${status}`);
  }

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?${params.toString()}`, {
    headers: restHeaders(c.key),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `取得失敗 ${res.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  const rows = await res.json();
  return NextResponse.json({ rows });
}

export async function PATCH(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  let body: { id?: unknown; status?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("PATCH /api/gakkai: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const id = str(body.id);
  if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });

  const status = str(body.status);
  if (!STATUSES.includes(status)) {
    return NextResponse.json(
      { error: `statusは次から選んでください: ${STATUSES.join(" / ")}` },
      { status: 400 }
    );
  }

  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { ...restHeaders(c.key), Prefer: "return=representation" },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
      cache: "no-store",
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `更新失敗 ${res.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "更新対象が見つかりません" }, { status: 404 });
  }
  return NextResponse.json({ row: rows[0] });
}

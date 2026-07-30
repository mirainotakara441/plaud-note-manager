import { NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";
import {
  fetchOrganizationNotes,
  isNoteSection,
  ORGANIZATION_NOTES_SELECT,
  type OrganizationNote,
} from "@/lib/organizations";

// 団体別攻略／手書きメモ。
//
// 「現状」「課題」「施策」「基礎データ」は週報・会議から自動導出している派生情報のため、
// 元データ（weekly_reports / memory_chunks）は絶対に書き換えない。
// 代わりに organization_notes テーブルへ、団体×セクション単位で吉井さんの手書きメモを
// 上書き保存する（自動導出の内容は消さず、画面上で並べて表示する）。
//
//   GET    ?org=熊本市                    … その団体の全セクションのメモ
//   PUT    { organization, section, content } … upsert（空文字は 400。消すなら DELETE）
//   DELETE ?org=熊本市&section=課題        … 1セクション分を削除
//
// organization_notes は RLS で anon に SELECT のみ許可しているため、
// 読みは anonCreds()、書き込み・削除は serviceCreds() を使う。

export const dynamic = "force-dynamic";

const TABLE = "organization_notes";
/** 1セクションあたりの上限。UI 側のテキストエリアと合わせた常識的な上限。 */
const MAX_CONTENT_LENGTH = 5000;

function missingEnv() {
  return NextResponse.json(
    { error: "サーバー設定エラー: 環境変数が設定されていません" },
    { status: 500 }
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const org = searchParams.get("org")?.trim();
  if (!org) {
    return NextResponse.json({ error: "org は必須です" }, { status: 400 });
  }

  const anon = anonCreds();
  if (!anon) return missingEnv();

  try {
    const notes = await fetchOrganizationNotes(anon.url, anon.key, org);
    return NextResponse.json({ organization: org, notes });
  } catch (error) {
    console.error("団体メモ取得エラー:", error);
    return NextResponse.json(
      { error: "手書きメモの取得でエラーが発生しました" },
      { status: 502 }
    );
  }
}

export async function PUT(request: Request) {
  const service = serviceCreds();
  if (!service) return missingEnv();

  const body: unknown = await request.json().catch(() => null);
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const org = typeof raw?.organization === "string" ? raw.organization.trim() : "";
  const section = raw?.section;
  const content = typeof raw?.content === "string" ? raw.content.trim() : "";

  if (!org) {
    return NextResponse.json({ error: "organization は必須です" }, { status: 400 });
  }
  if (!isNoteSection(section)) {
    return NextResponse.json(
      { error: "section は 現状／課題／施策／基礎データ のいずれかです" },
      { status: 400 }
    );
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

  // organization, section の UNIQUE 制約に対する upsert。
  // updated_at はテーブルの BEFORE UPDATE トリガが自動で更新する。
  const res = await fetch(
    `${service.url}/rest/v1/${TABLE}?on_conflict=organization,section&select=${ORGANIZATION_NOTES_SELECT}`,
    {
      method: "POST",
      headers: restHeaders(service.key, {
        Prefer: "resolution=merge-duplicates,return=representation",
      }),
      body: JSON.stringify([{ organization: org, section, content }]),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("団体メモ保存エラー:", res.status, text);
    return NextResponse.json(
      { error: "手書きメモの保存に失敗しました" },
      { status: 502 }
    );
  }
  const rows: unknown = await res.json().catch(() => null);
  const note = Array.isArray(rows) ? (rows[0] as OrganizationNote | undefined) : undefined;
  return NextResponse.json({ note: note ?? null });
}

export async function DELETE(request: Request) {
  const service = serviceCreds();
  if (!service) return missingEnv();

  const { searchParams } = new URL(request.url);
  const org = searchParams.get("org")?.trim();
  const section = searchParams.get("section")?.trim();

  if (!org) {
    return NextResponse.json({ error: "org は必須です" }, { status: 400 });
  }
  if (!isNoteSection(section)) {
    return NextResponse.json(
      { error: "section は 現状／課題／施策／基礎データ のいずれかです" },
      { status: 400 }
    );
  }

  const res = await fetch(
    `${service.url}/rest/v1/${TABLE}?organization=eq.${encodeURIComponent(
      org
    )}&section=eq.${encodeURIComponent(section)}`,
    { method: "DELETE", headers: restHeaders(service.key) }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("団体メモ削除エラー:", res.status, text);
    return NextResponse.json(
      { error: "手書きメモの削除に失敗しました" },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true });
}

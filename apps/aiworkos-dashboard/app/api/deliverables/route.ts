import { NextRequest, NextResponse } from "next/server";

// 成果物アップロードUIから、ブラウザ側で抽出済みのテキストチャンクを受け取り、
// store-memory Edge Function 経由で memory_chunks(source_type=成果物) に登録する。
// ファイル本体はブラウザで解析済みなので、ここに届くのはテキストのみ（Vercelの
// リクエストサイズ上限4.5MBを回避）。

export const maxDuration = 60;

const DOC_TYPES = ["提案書", "実習書", "スライド", "報告書", "メモ", "その他"];
// 対象のカテゴリー。自治体だけでなく議員・事業者も提案の対象になるため。
const CATEGORIES = ["自治体", "議員", "事業者", "その他"];
const MAX_CHUNKS = 300;
const MAX_CHUNK_CHARS = 4000;

type InChunk = { pos: string; content: string };

async function storeChunk(
  supabaseUrl: string,
  anonKey: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/store-memory`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.status === "stored";
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }

  let body: {
    organization?: unknown;
    category?: unknown;
    docType?: unknown;
    title?: unknown;
    date?: unknown;
    filename?: unknown;
    chunks?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const organization =
    typeof body.organization === "string" ? body.organization.trim() : "";
  const category =
    typeof body.category === "string" && CATEGORIES.includes(body.category)
      ? body.category
      : "自治体";
  const docType = typeof body.docType === "string" ? body.docType : "";
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : "無題";
  const filename =
    typeof body.filename === "string" && body.filename.trim()
      ? body.filename.trim()
      : "unknown";
  const date =
    typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : new Date().toISOString().slice(0, 10);

  if (!organization) {
    return NextResponse.json({ error: "団体名を入力してください" }, { status: 400 });
  }
  if (!DOC_TYPES.includes(docType)) {
    return NextResponse.json(
      { error: `種別は次から選んでください: ${DOC_TYPES.join(" / ")}` },
      { status: 400 }
    );
  }
  if (!Array.isArray(body.chunks) || body.chunks.length === 0) {
    return NextResponse.json(
      { error: "抽出テキストが空です。ファイルを確認してください。" },
      { status: 400 }
    );
  }

  const chunks: InChunk[] = (body.chunks as unknown[])
    .filter(
      (c): c is InChunk =>
        !!c &&
        typeof c === "object" &&
        typeof (c as InChunk).pos === "string" &&
        typeof (c as InChunk).content === "string" &&
        (c as InChunk).content.trim().length > 0
    )
    .slice(0, MAX_CHUNKS)
    .map((c) => ({ pos: c.pos, content: c.content.slice(0, MAX_CHUNK_CHARS) }));

  if (chunks.length === 0) {
    return NextResponse.json(
      { error: "有効なテキストチャンクがありませんでした" },
      { status: 400 }
    );
  }

  let stored = 0;
  for (const c of chunks) {
    const ok = await storeChunk(supabaseUrl, anonKey, {
      source_type: "成果物",
      source_id: `deliverable:${organization}:${filename}:${c.pos}`,
      organization,
      title: `${title}｜${docType}｜${c.pos}`,
      content: c.content,
      event_date: date,
      metadata: {
        種別: docType,
        カテゴリ: category,
        ファイル名: filename,
        位置: c.pos,
        資料名: title,
      },
    });
    if (ok) stored += 1;
  }

  if (stored === 0) {
    return NextResponse.json(
      { error: "登録に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }

  return NextResponse.json({
    organization,
    category,
    docType,
    title,
    stored,
    total: chunks.length,
  });
}

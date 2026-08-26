import { NextRequest, NextResponse } from "next/server";
import { ORG_CATEGORIES } from "@/lib/categories";
import { correctTranscriptionMany, summarizeCorrections } from "@/lib/transcriptionDictionary";
import { toJstDateString } from "@/lib/date";

// 議事録の手入力登録。app/api/deliverables/route.ts と同じ作りだが、書き込み先が
// 違う（source_type: "会議"）。
//
// ■ なぜ別に作ったか（2026-08-23）
// これまで議事録は「成果物を登録」の種別「メモ」で代用されていた。しかし
// memory_chunks の source_type=成果物 と source_type=会議 は別バケツで、
// 振り返り（/retrospective）の月次「会議◯件」集計、団体別攻略の
// 「会議録から関係を抽出」、団体別攻略の団体セレクタ（org-history由来のみ拾う）
// は、どれも source_type=会議 しか見ない。成果物として登録した議事録は、
// これらのどこにも反映されなかった。
//
// ■ 書式を PLAUD自動連携（plaud-meeting-daily-sync）に合わせている理由
// source_type=会議 の読み取り側（org-history Edge Function、
// lib/organizations.ts の groupMeetings 等）は、自動連携で入った行と
// この手入力の行を区別しない。同じ形で書けば、団体別攻略・振り返り・
// 提案エージェントのどこからも同じように参照される。
//   - title は複数チャンクでも同じ文字列にする（groupMeetings が
//     stripChunkSuffix(title)+event_date でグルーピングするため。実際の
//     PLAUD由来データもチャンクごとにtitleを変えていない）
//   - metadata.位置 は "n/総数" 形式（chunkPosition() が "/" で分割するため。
//     lib/parseDeliverable.ts の windowChunks が返す pos は "text1" 等の別形式
//     なので、そのまま流用せずここで振り直す）
//   - metadata.category は正準8分類（fetchMeetingOrgCategories が
//     metadata.種別 → metadata.category の順で読むフォールバック先）
//
// event_date は必須（groupMeetings が event_date の無い行を捨てるため）。

export const maxDuration = 60;

const CATEGORIES: readonly string[] = ORG_CATEGORIES;
const MAX_CHUNKS = 100;
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
  } catch (err) {
    console.error("storeChunk(meetings): store-memory呼び出し失敗", err);
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
    title?: unknown;
    date?: unknown;
    filename?: unknown;
    chunks?: unknown;
  };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/meetings: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const organization =
    typeof body.organization === "string" ? body.organization.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const filename =
    typeof body.filename === "string" && body.filename.trim()
      ? body.filename.trim()
      : "unknown";
  const date =
    typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : toJstDateString(new Date().toISOString());

  if (!organization) {
    return NextResponse.json({ error: "相手先を選んでください" }, { status: 400 });
  }
  if (typeof body.category !== "string" || !CATEGORIES.includes(body.category)) {
    return NextResponse.json(
      { error: `カテゴリーは次から選んでください: ${CATEGORIES.join(" / ")}` },
      { status: 400 }
    );
  }
  const category = body.category;
  if (!title) {
    return NextResponse.json({ error: "会議のタイトルを入力してください" }, { status: 400 });
  }
  if (!Array.isArray(body.chunks) || body.chunks.length === 0) {
    return NextResponse.json(
      { error: "議事録の本文が空です。テキストを貼り付けるかファイルを選んでください。" },
      { status: 400 }
    );
  }

  const rawChunks: InChunk[] = (body.chunks as unknown[])
    .filter(
      (c): c is InChunk =>
        !!c &&
        typeof c === "object" &&
        typeof (c as InChunk).content === "string" &&
        (c as InChunk).content.trim().length > 0
    )
    .slice(0, MAX_CHUNKS)
    .map((c) => ({ pos: c.pos, content: c.content.slice(0, MAX_CHUNK_CHARS) }));

  if (rawChunks.length === 0) {
    return NextResponse.json(
      { error: "有効なテキストチャンクがありませんでした" },
      { status: 400 }
    );
  }

  // ★音声入力の誤変換を、本文が入ってきたこの1か所で直す（app/api/deliverables/route.ts と同じ理由）。
  const corrected = await correctTranscriptionMany(rawChunks.map((c) => c.content));

  let stored = 0;
  const total = rawChunks.length;
  for (let i = 0; i < rawChunks.length; i += 1) {
    const n = i + 1;
    const pos = `${n}/${total}`;
    const ok = await storeChunk(supabaseUrl, anonKey, {
      source_type: "会議",
      source_id: `meeting:${organization}:${filename}:${n}`,
      organization,
      // タイトルはチャンク間で同じ文字列にする（ファイル冒頭のコメント参照）。
      title,
      content: corrected.texts[i],
      event_date: date,
      metadata: {
        category,
        位置: pos,
        登録方法: "手入力",
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
    title,
    stored,
    total,
    corrections: corrected.replacements,
    correctionTotal: corrected.total,
    correctionMessage: summarizeCorrections(corrected.replacements, corrected.total),
  });
}

import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";
import { isLlmConfigured, structured, llmErrorMessage, llmErrorStatus } from "@/lib/llm";

// 学習ログ1件から、自分専用の4択問題を作る。
//
// 設計メモでは「Sprint1と同じOpen Responses APIを使う」と決めていたが、
// .env.local にはANTHROPIC_API_KEYしか無く、Open Responses API側の鍵が
// 存在しない。存在しない鍵に向けて書いても動かないため、既にAIワークOSの
// 9本のAPIが使っている lib/llm.ts（Anthropic・構造化出力）に乗せる
// （2026-08-04 判断。design memo 内 decisions と同じ理由づけ）。
//
// 材料の優先順位:
//   1. qa_session（あれば）… すでにQ&Aの形なので変換が素直に効く。
//      example（例え話）は誤答選択肢の作りどころ、summary は解説文の下敷きになる。
//   2. source_content + notes（qa_session が無いとき）

export const maxDuration = 60;

type QaPair = { q: string; a: string; example?: string };
type QaChapter = { no: number; title: string; qa: QaPair[]; summary?: string[] };
type QaSession = { theme: string; chapters: QaChapter[] };

type LogRow = {
  id: string;
  topic: string;
  source_content: string | null;
  notes: string | null;
  qa_session: QaSession | null;
};

type QuizQuestion = {
  question: string;
  choices: string[];
  answer_index: number;
  explanation: string;
};

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description: "4択の理解度確認問題。5問。",
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "設問文" },
          choices: {
            type: "array",
            description: "選択肢4つ。正解1つと、もっともらしい誤答3つ",
            items: { type: "string" },
          },
          answer_index: {
            type: "number",
            description: "choices内の正解の位置（0始まり）",
          },
          explanation: {
            type: "string",
            description: "なぜそれが正解か。1〜2文で簡潔に",
          },
        },
        required: ["question", "choices", "answer_index", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
};

// LLMは「正解→もっともらしい誤答3つ」の順で書く癖があり、schema通りに
// そのまま保存すると answer_index が0（先頭）に偏る（2026-08-10 実データで確認、
// 45問中24問が0番目）。選択肢そのものをシャッフルし、正解の新しい位置に
// answer_index を付け替える。
function shuffleChoices(q: QuizQuestion): QuizQuestion {
  const correct = q.choices[q.answer_index];
  const order = q.choices.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const choices = order.map((i) => q.choices[i]);
  return { ...q, choices, answer_index: choices.indexOf(correct) };
}

function materialFromQaSession(qa: QaSession): string {
  return qa.chapters
    .map((c) => {
      const pairs = c.qa
        .map((p) => `Q: ${p.q}\nA: ${p.a}${p.example ? `\n例え: ${p.example}` : ""}`)
        .join("\n\n");
      const summary = c.summary?.length ? `\nまとめ: ${c.summary.join(" / ")}` : "";
      return `【第${c.no}講 ${c.title}】\n${pairs}${summary}`;
    })
    .join("\n\n");
}

export async function POST(req: NextRequest) {
  if (!isLlmConfigured()) {
    return NextResponse.json({ error: "ANTHROPIC_APIキーが未設定です" }, { status: 500 });
  }
  const anon = anonCreds();
  const service = serviceCreds();
  if (!anon || !service) {
    return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  }

  let body: { id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "idを指定してください" }, { status: 400 });

  // 対象の学習ログを読む
  const getRes = await fetch(
    `${anon.url}/rest/v1/bootcamp_logs?id=eq.${encodeURIComponent(id)}&select=id,topic,source_content,notes,qa_session`,
    { headers: restHeaders(anon.key), cache: "no-store" }
  );
  if (!getRes.ok) {
    return NextResponse.json({ error: "学習ログの取得に失敗しました" }, { status: 502 });
  }
  const rows = (await getRes.json()) as LogRow[];
  const log = rows[0];
  if (!log) return NextResponse.json({ error: "該当の学習ログがありません" }, { status: 404 });

  const material = log.qa_session
    ? materialFromQaSession(log.qa_session)
    : [log.source_content, log.notes].filter(Boolean).join("\n\n");

  if (!material.trim()) {
    return NextResponse.json(
      { error: "テストの材料（Q&Aセッションか、本文・メモ）がありません" },
      { status: 400 }
    );
  }

  try {
    const result = await structured<{ questions: QuizQuestion[] }>({
      system:
        "あなたは学習内容から理解度確認クイズを作る先生です。与えられた資料の内容だけをもとに、4択問題を作ってください。" +
        "誤答の選択肢は、本文に出てくる別の概念や、もっともらしい間違いにすること（明らかにおかしい選択肢は作らない）。" +
        "資料に無い知識を問う問題は作らないこと。",
      prompt: `テーマ: ${log.topic}\n\n==== 資料 ====\n${material}\n\n上記の内容から、理解度を確認する4択問題を5問作ってください。`,
      schema: SCHEMA,
      effort: "medium",
      label: "ブートキャンプ クイズ生成",
    });

    if (!result.questions || result.questions.length === 0) {
      return NextResponse.json({ error: "問題を生成できませんでした" }, { status: 502 });
    }

    const quiz = {
      generated_at: new Date().toISOString(),
      questions: result.questions.map(shuffleChoices),
    };

    const patchRes = await fetch(
      `${service.url}/rest/v1/bootcamp_logs?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: restHeaders(service.key, { Prefer: "return=representation" }),
        body: JSON.stringify({ quiz }),
      }
    );
    if (!patchRes.ok) {
      const detail = await patchRes.text().catch(() => "");
      console.error("bootcamp quiz save失敗:", detail);
      return NextResponse.json({ error: "テストの保存に失敗しました" }, { status: 502 });
    }

    return NextResponse.json({ quiz });
  } catch (error) {
    console.error("ブートキャンプ クイズ生成エラー:", error);
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error: llmErrorMessage(
          error,
          `テストの生成に失敗しました: ${detail.slice(0, 200)}`
        ),
      },
      { status: llmErrorStatus(error) }
    );
  }
}

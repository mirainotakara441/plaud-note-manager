import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { structured, isLlmConfigured, llmErrorMessage, llmErrorStatus } from "@/lib/llm";

// 健康週次レポートの総合評価と、来週への助言をAIに下書きさせる。
//
// ■ 下書きであって確定ではない
//   返した★とコメントは画面のフォームに流し込むだけで、DBには書かない。
//   人が直してから「この週を保存」で確定する。機械が付けた★がそのまま
//   確定すると、評価が数字の見た目に引きずられたまま記録に残る。
//
// ■ 壊れた数字の上で評価させない
//   カロミルは定例のプロテイン(222kcal)1件しか届かない日がある。
//   500kcal未満の日を「入力漏れ」としてこちらで判定し、
//   「その日は評価に使うな」と明示して渡す。これをしないと
//   「平均777kcal、素晴らしい節制です」のような嘘の賞賛が出る。
//
// ■ 「今年最良」を言わせるために年初来の最小・最大を渡す
//   見本のコメントは「8/22に28.00%——今年最良」のように比較で書かれている。
//   その週の数字だけ渡すと、モデルは比較できず当たり障りのない文になるか、
//   根拠なく「最良」と書く。事実を渡して、判断だけさせる。

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 1日の摂取がこれ未満なら入力漏れとみなす（画面の判定と同じ値）。 */
const MIN_DAILY_KCAL = 500;

/** 見本の総合評価に合わせた指標。 */
const METRICS = ["体重", "体脂肪率", "筋肉量", "食事", "歩数", "睡眠", "医療"] as const;

type Row = {
  day: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  muscle_kg: number | null;
  steps: number | null;
  kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  salt_g: number | null;
};

async function rpcRange(url: string, key: string, from: string, to: string): Promise<Row[]> {
  const res = await fetch(`${url}/rest/v1/rpc/health_range_summary`, {
    method: "POST",
    headers: restHeaders(key),
    body: JSON.stringify({ from_day: from, to_day: to }),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`日次データの取得に失敗しました（${res.status}）${detail.slice(0, 120)}`);
  }
  return res.json();
}

const num = (rows: Row[], k: keyof Row) =>
  rows.map((r) => r[k]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));

function extremes(rows: Row[], k: keyof Row) {
  const list = num(rows, k);
  if (list.length === 0) return null;
  return { min: Math.min(...list), max: Math.max(...list), days: list.length };
}

const SCHEMA = {
  type: "object",
  properties: {
    ratings: {
      type: "array",
      description: "指標ごとの評価。データが無い指標も、★を付けずにコメントだけ返すこと。",
      items: {
        type: "object",
        properties: {
          metric: { type: "string", enum: [...METRICS] },
          stars: {
            type: ["integer", "null"],
            description:
              "1〜5。判断材料が無い、または数字が信用できない指標は null にする。推測で付けない。",
          },
          comment: {
            type: "string",
            description:
              "40〜70字程度。必ず具体的な数字を1つ以上入れる。「良い調子です」のような中身の無い文にしない。",
          },
        },
        required: ["metric", "stars", "comment"],
        additionalProperties: false,
      },
    },
    advice: {
      type: "array",
      description: "来週どうするか。2〜4件。",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "10〜20字の見出し。何をするかを動詞で。" },
          detail: {
            type: "string",
            description:
              "60〜100字。今週の数字を根拠にする。一般論を書かない。数値目標を置けるなら置く。",
          },
        },
        required: ["title", "detail"],
        additionalProperties: false,
      },
    },
  },
  required: ["ratings", "advice"],
  additionalProperties: false,
} as const;

type Advised = {
  ratings: { metric: string; stars: number | null; comment: string }[];
  advice: { title: string; detail: string }[];
};

export async function POST(req: NextRequest) {
  if (!isLlmConfigured()) {
    return NextResponse.json({ error: "AIの設定がありません" }, { status: 500 });
  }
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const start = typeof body?.week_start === "string" ? body.week_start : "";
  const end = typeof body?.week_end === "string" ? body.week_end : "";
  if (!DAY_RE.test(start) || !DAY_RE.test(end) || end < start) {
    return NextResponse.json({ error: "週の範囲が不正です" }, { status: 400 });
  }

  try {
    // 今週・前週・年初来をまとめて取る。比較材料が無いと、
    // 「今年最良」のような見本どおりのコメントが書けない。
    const prevStart = new Date(`${start}T00:00:00Z`);
    prevStart.setUTCDate(prevStart.getUTCDate() - 7);
    const prevEnd = new Date(`${start}T00:00:00Z`);
    prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
    const yearStart = `${start.slice(0, 4)}-01-01`;

    const [week, prev, year] = await Promise.all([
      rpcRange(c.url, c.key, start, end),
      rpcRange(c.url, c.key, prevStart.toISOString().slice(0, 10), prevEnd.toISOString().slice(0, 10)),
      rpcRange(c.url, c.key, yearStart, end),
    ]);

    // 目標値（本人が設定したぶんだけ）。無ければ渡さない。
    const goalsRes = await fetch(`${c.url}/rest/v1/health_goals?select=metric,target`, {
      headers: restHeaders(c.key),
      cache: "no-store",
    });
    const goals = goalsRes.ok ? await goalsRes.json() : [];

    const lowDays = week.filter((r) => r.kcal != null && r.kcal < MIN_DAILY_KCAL).map((r) => r.day);
    const noMealDays = week.filter((r) => r.kcal == null).map((r) => r.day);
    const usableMeal = week.filter((r) => r.kcal != null && r.kcal >= MIN_DAILY_KCAL);

    const avg = (list: number[]) =>
      list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : null;

    const facts = {
      週: { 開始: start, 終了: end },
      今週の日次: week,
      今週の要約: {
        体重平均: avg(num(week, "weight_kg")),
        体脂肪率平均: avg(num(week, "body_fat_pct")),
        筋肉量平均: avg(num(week, "muscle_kg")),
        歩数合計: num(week, "steps").reduce((a, b) => a + b, 0),
        歩数平均: avg(num(week, "steps")),
        歩数の記録日数: num(week, "steps").length,
        食事_評価に使える日のカロリー平均: avg(usableMeal.map((r) => r.kcal as number)),
        食事_評価に使える日数: usableMeal.length,
        食事_塩分平均: avg(usableMeal.map((r) => r.salt_g).filter((v): v is number => v != null)),
      },
      前週の要約: {
        体重平均: avg(num(prev, "weight_kg")),
        体脂肪率平均: avg(num(prev, "body_fat_pct")),
        歩数平均: avg(num(prev, "steps")),
      },
      年初来: {
        体重: extremes(year, "weight_kg"),
        体脂肪率: extremes(year, "body_fat_pct"),
        筋肉量: extremes(year, "muscle_kg"),
        歩数: extremes(year, "steps"),
      },
      目標値: goals,
      // ★ここが肝。壊れた日を明示して、評価から外させる。
      信用できない日: {
        カロリーが500kcal未満の日: lowDays,
        食事の記録が無い日: noMealDays,
        説明:
          "500kcal未満の日は、毎日の定例であるプロテイン(222kcal)1件しかカロミルから届いていない日で、実際の摂取量ではない。これらの日は食事の評価・平均から必ず除外すること。",
      },
    };

    const advised = await structured<Advised>({
      system: `あなたは吉井さんの健康データを見て、1週間の総合評価と来週への助言を書きます。

## 評価の付け方
- ★は1〜5。判断材料が無い指標、または数字が信用できない指標は stars を null にして、その理由をコメントに書く。推測で★を付けない。
- 「医療」は健康データに現れない。受診の記録が渡されていなければ stars は null にし、コメントは「受診の記録なし」とだけ書く。
- 「睡眠」もデータが無ければ null。
- コメントには必ず具体的な数字を1つ以上入れる。「順調です」「良い調子」のような中身の無い文は書かない。
- 年初来の最小・最大が渡してあるので、その週の値が年初来で最良／最悪なら、そう書いてよい。渡されていない比較は書かない。
- 記録日数が少ない指標は、平均値だけで高く評価しない。何日ぶんかを必ずコメントに書く。

## 絶対に守ること
- 「信用できない日」に挙がっている日は、食事の評価にも平均にも使わない。
  その日を含めて「摂取が少なく理想的」のような評価をするのは、事実に反する賞賛になる。
- 食事の評価に使える日が2日以下なら、食事の stars は null にして「◯日ぶんしか評価できない」と書く。
- 渡されていない事実を作らない。体調・通院・出張・食べた物の内容は、渡されていなければ触れない。

## 来週への助言
- 2〜4件。今週の数字を根拠にする。一般論（「バランスの良い食事を」等）は書かない。
- 数値目標を置けるなら置く。ただし渡された目標値と矛盾させない。
- いちばん効くことを1件目に置く。

## 文体
常体でも敬体でもよいが、励ましすぎない。事実と、次にやることだけ書く。`,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text" as const,
              text:
                `次の週の総合評価と、来週への助言を書いてください。\n\n` +
                `${JSON.stringify(facts, null, 1)}`,
            },
          ],
        },
      ],
      schema: SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 4000,
      label: "健康週次レポートの評価",
    });

    return NextResponse.json({
      ratings: Array.isArray(advised.ratings) ? advised.ratings : [],
      advice: Array.isArray(advised.advice) ? advised.advice : [],
      // 画面で「どの日を外して評価したか」を出すために返す
      excluded: { low: lowDays, none: noMealDays },
    });
  } catch (e) {
    console.error("健康週次レポートの評価に失敗:", e);
    return NextResponse.json(
      { error: llmErrorMessage(e, e instanceof Error ? e.message : "評価を書けませんでした") },
      { status: llmErrorStatus(e) }
    );
  }
}

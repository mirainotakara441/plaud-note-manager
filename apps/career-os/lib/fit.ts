// 適合スコア（このアプリの中核）。
//
// doda X が「年収と知名度」で並べるのに対して、ここは吉井さん自身の判断軸で並べ替える。
// 判断軸は career_criteria テーブルにあり、UIから重みを変えられる。
//
// 使い分け:
//   - scoreJob(): 取込時の一次採点。Sonnet 5。新着求人ぶん自動で走る。
//   - scoreJob({ deep: true }): /fit からの深掘り再採点。Opus 5。判断軸ごとの内訳つき。

import { structured, EXTRACT_MODEL, FIT_MODEL } from "./anthropic";
import { CANDIDATE_PROFILE } from "./profile";
import { select } from "./db";
import type { CareerCriterion, CareerJob, FitResult } from "./types";

const SYSTEM = `
あなたは、候補者本人の価値観を熟知したキャリアアドバイザーです。
求人票を、候補者本人が定めた判断軸に照らして採点します。

守ること:
- 年収や企業の知名度だけで高得点をつけないこと。判断軸の重みに従うこと。
- 求人票に書いていないことを、あるかのように書かないこと。
  情報が無い項目は「求人票からは読み取れない」と明記し、その分は減点も加点もしない。
- 懸念(cons)は遠慮なく書くこと。良いことしか書かない診断は役に立たない。
- 日本語で、簡潔に。褒め言葉や励ましは不要。事実と判断だけ書く。
`.trim();

const BASE_SCHEMA = {
  type: "object",
  properties: {
    score: {
      type: "integer",
      description: "総合適合度 0〜100。判断軸の重みで加重平均した値",
    },
    summary: {
      type: "string",
      description: "この求人が候補者にとって何なのかを1〜2文で。当たり障りのない要約にしないこと",
    },
    pros: {
      type: "array",
      items: { type: "string" },
      description: "候補者の判断軸に照らして良い点。最大4個",
    },
    cons: {
      type: "array",
      items: { type: "string" },
      description: "懸念・引っかかる点・確認すべき点。最大4個",
    },
  },
  required: ["score", "summary", "pros", "cons"],
  additionalProperties: false,
} as const;

const DEEP_SCHEMA = {
  type: "object",
  properties: {
    ...BASE_SCHEMA.properties,
    breakdown: {
      type: "array",
      description: "判断軸ごとの内訳。渡された判断軸すべてについて必ず1件ずつ返すこと",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "判断軸の名前。渡されたものと完全一致させること" },
          score: { type: "integer", description: "その軸での評価 0〜100" },
          comment: { type: "string", description: "その評価にした理由。1〜2文" },
        },
        required: ["label", "score", "comment"],
        additionalProperties: false,
      },
    },
  },
  required: ["score", "summary", "pros", "cons", "breakdown"],
  additionalProperties: false,
} as const;

/** 有効な判断軸を重み順に取得する。 */
export async function activeCriteria(): Promise<CareerCriterion[]> {
  return select<CareerCriterion>(
    "career_criteria",
    "select=*&active=eq.true&order=sort_order.asc"
  );
}

function criteriaBlock(criteria: CareerCriterion[]): string {
  return criteria
    .map(
      (c, i) =>
        `${i + 1}. 【${c.label}】(重み ${c.weight}/5)\n   ${c.description ?? ""}`
    )
    .join("\n");
}

function jobBlock(job: Pick<CareerJob,
  "company" | "title" | "salary_text" | "salary_min" | "salary_max" |
  "location" | "employment_type" | "industry" | "description" | "source">
): string {
  const salary =
    job.salary_text ??
    (job.salary_min || job.salary_max
      ? `${job.salary_min ?? "?"}万円〜${job.salary_max ?? "?"}万円`
      : "記載なし");
  return [
    `企業名: ${job.company}`,
    `ポジション: ${job.title}`,
    `想定年収: ${salary}`,
    `勤務地: ${job.location ?? "記載なし"}`,
    `雇用形態: ${job.employment_type ?? "記載なし"}`,
    `業種: ${job.industry ?? "記載なし"}`,
    `出典: ${job.source ?? "不明"}`,
    "",
    "求人の内容:",
    job.description ?? "（詳細の記載なし）",
  ].join("\n");
}

/**
 * 求人1件を判断軸に照らして採点する。
 *
 * deep=true で Opus 5 + 判断軸ごとの内訳つき。既定は Sonnet 5 の一次採点。
 */
export async function scoreJob(
  job: Parameters<typeof jobBlock>[0],
  opts: { deep?: boolean; criteria?: CareerCriterion[] } = {}
): Promise<FitResult & { model: string }> {
  const criteria = opts.criteria ?? (await activeCriteria());
  const deep = opts.deep === true;
  const model = deep ? FIT_MODEL : EXTRACT_MODEL;

  const prompt = `
==== 候補者 ====
${CANDIDATE_PROFILE}

==== 判断軸（この順・この重みで採点すること）====
${criteriaBlock(criteria)}

==== 採点対象の求人 ====
${jobBlock(job)}

この求人を上の判断軸で採点してください。
重みの大きい軸（5）で引っかかる求人は、他がどれだけ良くても総合スコアを大きく下げること。
${deep ? "判断軸すべてについて内訳(breakdown)も返すこと。" : ""}
指定のJSONスキーマで返してください。
`.trim();

  const result = await structured<FitResult>({
    model,
    system: SYSTEM,
    prompt,
    schema: (deep ? DEEP_SCHEMA : BASE_SCHEMA) as unknown as Record<string, unknown>,
  });

  // スコアは 0〜100 に丸めておく（UIの棒グラフ計算が壊れないように）。
  const score = Math.max(0, Math.min(100, Math.round(result.score)));
  return { ...result, score, model };
}

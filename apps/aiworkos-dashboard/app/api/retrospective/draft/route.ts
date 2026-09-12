import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { structured, isLlmConfigured, llmErrorMessage, llmErrorStatus } from "@/lib/llm";
import { CATEGORIES } from "@/lib/retrospective";

// 週次振り返りの下書きを、一行日記から起こす。
//
// ■ なぜ要るか
//   既存の振り返りは「Claudeが整形したMarkdownを手で貼る」運用で、
//   生成の口が無かったため7件・8/31で止まっていた。材料（一行日記）は
//   毎日溜まっているのに、それを束ねる手間が続かなかった。
//
// ■ 下書きであって確定ではない
//   返すだけでDBには書かない。★もコメントも画面で直してから保存する。
//
// ■ 日記に書かれていないことを書かせない
//   一行日記は「印象的だったこと／そうか／やってみよう」の3段で、
//   その週に本人が何を見て何を考えたかが入っている。ここに無い出来事を
//   足されると、振り返りが本人の記憶と食い違う。カテゴリーに材料が無ければ
//   「今週は記録なし」と書かせる。埋めるために作らせない。
//
// ■ 健康だけは数字を渡す
//   日記に体重や歩数は書かれない。health_range_summary の実測を渡し、
//   記録が欠けている週は「欠けている」と書かせる。

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type Diary = { event_date: string; title: string | null; content: string };

async function rest<T>(url: string, key: string, path: string, label: string): Promise<T> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: restHeaders(key),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${label}の取得に失敗しました（${res.status}）${detail.slice(0, 120)}`);
  }
  return res.json();
}

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "「9月7日〜9月12日 週次振り返り」の形。" },
    one_liner: {
      type: "string",
      description: "【今週を一言で】25字以内。その週が何の週だったかを言い切る。",
    },
    sections: {
      type: "array",
      description: "カテゴリーごとの振り返り。材料が無いカテゴリーも必ず1件返す。",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: [...CATEGORIES] },
          rating: {
            type: ["integer", "null"],
            description: "1〜5。材料が無いカテゴリーは null。推測で付けない。",
          },
          body: {
            type: "string",
            description:
              "150〜300字。固有名詞（人名・自治体名・会社名）と数字をそのまま残す。材料が無ければ「今週は記録なし」とだけ書く。",
          },
          assessment: {
            type: "string",
            description: "【評価】1文。その週をどう見るか。材料が無ければ空文字。",
          },
          impact: {
            type: "string",
            description: "【将来への影響】1〜2文。先々どう効くか。材料が無ければ空文字。",
          },
        },
        required: ["category", "rating", "body", "assessment", "impact"],
        additionalProperties: false,
      },
    },
    insights: {
      type: "array",
      description: "【今週の示唆】2〜3件。その週から言い切れることを、言い切りの形で。",
      items: { type: "string" },
    },
    next_plans: {
      type: "array",
      description: "【来週の最重要3点】最大3件。日付が日記から分かるものだけ date に入れる。",
      items: {
        type: "object",
        properties: {
          date: { type: "string", description: "「9/14」の形。分からなければ空文字。" },
          label: { type: "string", description: "何をやるか。60字以内。" },
        },
        required: ["date", "label"],
        additionalProperties: false,
      },
    },
    action_guideline: {
      type: "string",
      description: "【来週の行動指針】どういう週にするかの1〜2文。個別の予定ではなく構えを書く。",
    },
  },
  required: ["title", "one_liner", "sections", "insights", "next_plans", "action_guideline"],
  additionalProperties: false,
} as const;

export async function POST(req: NextRequest) {
  if (!isLlmConfigured()) {
    return NextResponse.json({ error: "AIの設定がありません" }, { status: 500 });
  }
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const start = typeof body?.period_start === "string" ? body.period_start : "";
  const end = typeof body?.period_end === "string" ? body.period_end : "";
  if (!DAY_RE.test(start) || !DAY_RE.test(end) || end < start) {
    return NextResponse.json({ error: "期間が不正です" }, { status: 400 });
  }

  try {
    const enc = encodeURIComponent;
    const [diaries, weekly, health] = await Promise.all([
      rest<Diary[]>(
        c.url,
        c.key,
        `memory_chunks?select=event_date,title,content&source_type=eq.${enc("日記")}` +
          `&event_date=gte.${start}&event_date=lte.${end}&order=event_date.asc`,
        "一行日記"
      ),
      // 週報は団体ごとの事実のログ。日記に書かれなかった商談を補える。
      rest<Record<string, unknown>[]>(
        c.url,
        c.key,
        `weekly_reports?select=*&week_start=gte.${start}&week_start=lte.${end}`,
        "週報"
      ).catch(() => []),
      fetch(`${c.url}/rest/v1/rpc/health_range_summary`, {
        method: "POST",
        headers: restHeaders(c.key),
        body: JSON.stringify({ from_day: start, to_day: end }),
        cache: "no-store",
      })
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []),
    ]);

    if (diaries.length === 0) {
      return NextResponse.json(
        {
          error: `${start}〜${end} の一行日記が1件もありません。日記を登録してから下書きしてください。`,
        },
        { status: 400 }
      );
    }

    const draft = await structured<Record<string, unknown>>({
      system: `あなたは吉井さんの一行日記を読んで、その週の振り返りを書きます。

## 材料
一行日記は「印象的だったこと／そうか／やってみよう」の3段で書かれています。
- 印象的だったこと … その日に起きた事実
- そうか … 本人がそこから掴んだこと
- やってみよう … 次の行動

## 書き方
- **固有名詞と数字をそのまま残す。** 「ある議員」「複数の自治体」に丸めない。
  犬山市・柴山議員・オンライン化率10%・川邊さん——こう書かれていたらこう書く。
  これを抽象化すると、あとで読んだときに何のことか分からなくなる。
- 各カテゴリーの body は、その週の事実を2〜3文でつないでから、意味づけを書く。
- 【評価】は「活動量ではなく診断の精度が上がった週」のように、何がどう良かった／
  足りなかったかを一言で言い切る。
- 【将来への影響】は、その週の出来事が先々どこに効くかを書く。

## 絶対に守ること
- **日記に書かれていないことを書かない。** 材料が無いカテゴリーは rating を null にし、
  body に「今週は記録なし」とだけ書く。欄を埋めるために出来事を作らない。
- 同じ話を複数のカテゴリーに重複して書かない。いちばん当てはまる1つに寄せる。
- 健康は渡された数値だけで書く。記録が欠けていれば「欠けている」と書く。
  日記に体調の記述があればそれは添えてよい。
- ★は、その週の中身で付ける。材料が薄いカテゴリーを高く評価しない。

## 【今週の示唆】
その週から言い切れることを、言い切りの形で2〜3件。
「〜が必要かもしれない」ではなく「〜である。だから〜をやめる」と書く。

## 文体
常体。励ましすぎない。事実と、そこから言えることだけ。`,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text" as const,
              text:
                `${start} 〜 ${end} の週次振り返りを書いてください。\n\n` +
                `## 一行日記（${diaries.length}件）\n` +
                diaries
                  .map((d) => `### ${d.event_date} ${d.title ?? ""}\n${d.content}`)
                  .join("\n\n") +
                `\n\n## 週報（団体ごとの事実のログ。日記に無い商談があればここから拾う）\n` +
                (weekly.length > 0 ? JSON.stringify(weekly).slice(0, 12000) : "この週の登録なし") +
                `\n\n## 健康の実測（健康カテゴリーはこの数字だけで書く）\n` +
                JSON.stringify(health),
            },
          ],
        },
      ],
      schema: SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 12000,
      label: "週次振り返りの下書き",
    });

    return NextResponse.json({
      draft: { ...draft, period_type: "週次", period_start: start, period_end: end },
      sources: { 日記: diaries.length, 週報: weekly.length, 健康: health.length },
    });
  } catch (e) {
    console.error("週次振り返りの下書きに失敗:", e);
    return NextResponse.json(
      { error: llmErrorMessage(e, e instanceof Error ? e.message : "下書きできませんでした") },
      { status: llmErrorStatus(e) }
    );
  }
}

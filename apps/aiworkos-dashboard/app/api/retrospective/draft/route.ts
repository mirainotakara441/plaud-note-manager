import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { structured, isLlmConfigured, llmErrorMessage, llmErrorStatus } from "@/lib/llm";
import { CATEGORIES } from "@/lib/retrospective";

// 週次振り返りの下書きを、その週に残っている記録から起こす。
//
// ■ なぜ要るか
//   既存の振り返りは「Claudeが整形したMarkdownを手で貼る」運用で、
//   生成の口が無かったため7件・8/31で止まっていた。材料（一行日記）は
//   毎日溜まっているのに、それを束ねる手間が続かなかった。
//
// ■ 下書きであって確定ではない
//   返すだけでDBには書かない。★もコメントも画面で直してから保存する。
//
// ■ 材料は日記だけではない（2026-09-12に拡張）
//   最初は一行日記だけを渡していたが、それでは吉井さんが実際に書いている
//   振り返りに届かなかった。見本に出てくる「石田本部長の指示」「辻リーダーの報告」
//   「幾野さん・市本さん」は会議録に、「先週の尾崎議員」「先週の御書講義」は
//   前週の振り返りにしか無い。実測では対象週の会議録が13件あり、日記3件の
//   4倍以上の材料を捨てていた。日記・会議録・週報・前週の振り返り・健康の5つを渡す。
//
// ■ 分からないことは聞き返させる
//   見本の末尾には「※GROWTH祭の実参加状況を教えてください」という但し書きがある。
//   材料に無いものを埋めるのでも黙って落とすのでもなく、本人に聞く。
//   questions がその欄。
//
// ■ 記録に無いことを書かせない
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

type Chunk = { event_date: string; title: string | null; content: string };

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
    questions: {
      type: "array",
      description:
        "材料からは確認できず、本人に聞かないと書けなかったこと。0〜3件。「※GROWTH祭の実参加状況を教えてください」のような形。無ければ空配列。",
      items: { type: "string" },
    },
  },
  required: [
    "title",
    "one_liner",
    "sections",
    "insights",
    "next_plans",
    "action_guideline",
    "questions",
  ],
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
    // 前週の範囲。「先週の◯◯に続いて」と書くために、前回の振り返りを渡す。
    const prevEnd = new Date(`${start}T00:00:00Z`);
    prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
    const prevEndIso = prevEnd.toISOString().slice(0, 10);

    const [diaries, meetings, weekly, prevRetro, health] = await Promise.all([
      rest<Chunk[]>(
        c.url,
        c.key,
        `memory_chunks?select=event_date,title,content&source_type=eq.${enc("日記")}` +
          `&event_date=gte.${start}&event_date=lte.${end}&order=event_date.asc`,
        "一行日記"
      ),
      // ★会議録。日記に書かれない社内の指示・他人の報告はここにしか無い。
      rest<Chunk[]>(
        c.url,
        c.key,
        `memory_chunks?select=event_date,title,content&source_type=eq.${enc("会議")}` +
          `&event_date=gte.${start}&event_date=lte.${end}&order=event_date.asc`,
        "会議録"
      ).catch(() => []),
      // 週報は団体ごとの事実のログ。日記に書かれなかった商談を補える。
      rest<Record<string, unknown>[]>(
        c.url,
        c.key,
        `weekly_reports?select=*&week_start=gte.${start}&week_start=lte.${end}`,
        "週報"
      ).catch(() => []),
      // 直前の振り返り1件。「先週の◯◯」と書くための土台。
      rest<Record<string, unknown>[]>(
        c.url,
        c.key,
        `retrospectives?select=period_start,period_end,one_liner,insights,next_plans,action_guideline` +
          `&period_end=lte.${prevEndIso}&order=period_start.desc&limit=1`,
        "前週の振り返り"
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

    // 会議録は全文だと長すぎる。実測で13件・4万字を渡したら3分かかって
    // ソケットが切れた（lib/llm は非ストリーミング）。欲しいのは「誰が何と
    // 言ったか」なので、1件あたりを切って総量も抑える。
    const MEETING_CHARS = 2000;
    const MEETING_TOTAL = 16000;
    let used = 0;
    const meetingText = meetings
      .map((m) => {
        if (used >= MEETING_TOTAL) return "";
        const head = `### ${m.event_date} ${m.title ?? ""}\n`;
        const body = (m.content ?? "").slice(0, MEETING_CHARS);
        used += head.length + body.length;
        return head + body;
      })
      .filter(Boolean)
      .join("\n\n");

    const draft = await structured<Record<string, unknown>>({
      system: `あなたは吉井さんのその週の記録を読んで、週次振り返りを書きます。

## 材料
1. **一行日記** … 「印象的だったこと／そうか／やってみよう」の3段。本人が何を見て何を考えたか
2. **会議録** … その週の会議。★社内の指示・他人の報告・数字はここにしかない。
   「誰が何と言ったか」を拾う（例：本部長の指示、リーダーからの進捗報告、メンバーの動き）
3. **週報** … 団体ごとの事実のログ。商談の進捗はここから拾う
4. **前週の振り返り** … 「先週の◯◯に続いて」「先週挙げた3点のうち」と書くための土台
5. **健康の実測** … 体重・食事・歩数の数字

日記と会議録で同じ出来事が出てきたら、会議録の方が固有名詞と数字が細かい。両方使って1つにまとめる。

## 書き方
- **固有名詞と数字をそのまま残す。** 「ある議員」「複数の自治体」に丸めない。
  犬山市・柴山議員・オンライン化率10%・川邊さん——こう書かれていたらこう書く。
  これを抽象化すると、あとで読んだときに何のことか分からなくなる。
- 各カテゴリーの body は **150〜300字**。その週の事実を2〜3文でつないでから、意味づけを書く。
  事実を1つだけ書いて終わらせない。複数の出来事を関連づけると振り返りになる。
- **人の名前を出す。** 「本部長から指示」ではなく「石田本部長から『事業者自身の言葉で
  コミットメントを取れ』という指示」。誰が何と言ったかまで書く。
- 前週の振り返りが渡されていれば「先週の◯◯に続いて」と繋げてよい。渡されていなければ書かない。
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
- **分からないことは questions に書いて本人に聞く。** 記録に予定だけあって実施の結果が
  無い、参加したか不明、といった場合は、想像で書かずに「※◯◯の実施状況を教えてください」
  と質問に回す。埋めるのでも黙って落とすのでもなく、聞く。

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
                `\n\n## 会議録（${meetings.length}件。社内の指示・他人の報告はここから拾う）\n` +
                (meetings.length > 0 ? meetingText : "この週の登録なし") +
                `\n\n## 週報（団体ごとの事実のログ。日記に無い商談があればここから拾う）\n` +
                (weekly.length > 0 ? JSON.stringify(weekly).slice(0, 12000) : "この週の登録なし") +
                `\n\n## 前週の振り返り（「先週の◯◯」と書くための土台。無ければ触れない）\n` +
                (prevRetro.length > 0 ? JSON.stringify(prevRetro[0]) : "登録なし") +
                `\n\n## 健康の実測（健康カテゴリーはこの数字だけで書く）\n` +
                JSON.stringify(health),
            },
          ],
        },
      ],
      schema: SCHEMA as unknown as Record<string, unknown>,
      // 9カテゴリー×300字＋示唆＋来週の3点＋質問で、本文だけでも相当長い。
      // そこへ thinking のぶんも同じ上限を食うので、余裕を持たせる。
      // 9000では実測で足りず「上限に達して途中で切れました」で落ちた。
      maxTokens: 20000,
      label: "週次振り返りの下書き",
    });

    return NextResponse.json({
      draft: { ...draft, period_type: "週次", period_start: start, period_end: end },
      sources: {
        日記: diaries.length,
        会議録: meetings.length,
        週報: weekly.length,
        前週の振り返り: prevRetro.length,
        健康: health.length,
      },
    });
  } catch (e) {
    console.error("週次振り返りの下書きに失敗:", e);
    return NextResponse.json(
      { error: llmErrorMessage(e, e instanceof Error ? e.message : "下書きできませんでした") },
      { status: llmErrorStatus(e) }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { structured, isLlmConfigured, llmErrorMessage, llmErrorStatus } from "@/lib/llm";

// 薬・サプリの効能を調べて台帳へ保存する。
//
// ■ 一般情報であって、本人への指示ではない
//   書かせるのは「その薬が一般にどういう薬か」。添付文書やお薬手帳の説明文に
//   あたる内容で、吉井さんの検査値や体調は一切渡さない。渡すと
//   「あなたの場合は」という形の文が出てしまい、それは医者の仕事になる。
//   増減・中止の判断を書かせないのも同じ理由。
//
// ■ 一度作ったら保存する
//   薬の一般的な効能は毎回変わらない。開くたびに生成すると待たされるし、
//   同じ質問に毎回違う文が返るのも落ち着かない。
//
//   POST { name } … その薬の効能を調べ、health_medications に保存して返す

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SCHEMA = {
  type: "object",
  properties: {
    kind_label: {
      type: "string",
      description: "薬効分類を短く（例：GLP-1/GIP受容体作動薬、ビグアナイド系、プロスタグランジン関連点眼薬）。サプリなら「サプリメント」と素材の分類。",
    },
    what: {
      type: "string",
      description: "何のための薬・サプリか。80〜150字。専門用語には短い言い換えを添える。",
    },
    how: {
      type: "string",
      description: "どう効くか（作用のしくみ）。80〜150字。難しければ比喩を使ってよい。",
    },
    notes: {
      type: "array",
      description:
        "一般に知られている注意点。副作用の傾向、飲み合わせ、飲み方の一般的な注意など。0〜4件。各40〜80字。",
      items: { type: "string" },
    },
    uncertain: {
      type: "boolean",
      description:
        "商品名が特定できない、複数の製品が該当するなどで、確かなことが言えない場合は true。",
    },
  },
  required: ["kind_label", "what", "how", "notes", "uncertain"],
  additionalProperties: false,
} as const;

type Efficacy = {
  kind_label: string;
  what: string;
  how: string;
  notes: string[];
  uncertain: boolean;
};

/** 保存する1本の文章に畳む。画面ではこれをそのまま出す。 */
function toText(e: Efficacy): string {
  const lines = [`【分類】${e.kind_label}`, "", `【何のための薬か】\n${e.what}`, "", `【どう効くか】\n${e.how}`];
  if (e.notes.length > 0) {
    lines.push("", "【一般に知られている注意点】", ...e.notes.map((n) => `・${n}`));
  }
  if (e.uncertain) {
    lines.push("", "※ 商品名だけでは特定しきれない部分があります。お薬手帳の説明書を確認してください。");
  }
  lines.push("", "※ 一般的な情報です。処方・中止・増減の判断は主治医にご相談ください。");
  return lines.join("\n");
}

export async function POST(req: NextRequest) {
  if (!isLlmConfigured()) {
    return NextResponse.json({ error: "AIの設定がありません" }, { status: 500 });
  }
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (name === "" || name.length > 120) {
    return NextResponse.json({ error: "薬剤名が不正です" }, { status: 400 });
  }
  const dose = typeof body?.dose === "string" ? body.dose.slice(0, 120) : "";
  const category = typeof body?.category === "string" ? body.category.slice(0, 60) : "";

  try {
    // 既に調べてあれば、それを返す（生成し直さない）。
    const cached = await fetch(
      `${c.url}/rest/v1/health_medications?select=name,efficacy&name=eq.${encodeURIComponent(name)}&efficacy=not.is.null&limit=1`,
      { headers: restHeaders(c.key), cache: "no-store" }
    ).then((r) => (r.ok ? r.json() : []));
    if (Array.isArray(cached) && cached[0]?.efficacy) {
      return NextResponse.json({ efficacy: cached[0].efficacy, cached: true });
    }

    const e = await structured<Efficacy>({
      system: `あなたは薬・サプリメントの一般的な説明を書く係です。お薬手帳に添えられる説明書や、薬局でもらう説明文にあたるものを書きます。

## 絶対に守ること
- **一般的な説明だけを書く。** 特定の人に向けた指示・評価・提案は書かない。
  「あなたの場合は」「続けたほうがよい」「やめても大丈夫」は禁止。
- **増減・中止・変更の判断を書かない。** それは主治医の仕事。
- **診断をしない。** 「この薬を飲んでいるということは◯◯である」と書かない。
- 分からない・特定できないときは uncertain を true にする。もっともらしく埋めない。
- 商品名から一般名が分かる場合は一般名も書く。分からなければ書かない。

## 書き方
- 医学の素人が読んで分かる言葉で書く。専門用語を使うときは短い言い換えを添える
  （例：「GLP-1受容体作動薬（食欲と血糖の調節に関わるホルモンに似た働きをする薬）」）。
- 「どう効くか」は、しくみを具体的に。比喩を使ってよい。
- 注意点は「一般に知られていること」に限る。頻度の低い重篤な副作用を並べ立てて
  不安を煽らない。日常的に気をつけることを中心に。
- サプリメントの場合は、医薬品のような効能効果の断定をしない。
  「〜が期待されるとされる」のように、確立の度合いが分かる書き方にする。`,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text" as const,
              text:
                `次の薬・サプリの一般的な説明を書いてください。\n\n` +
                `名称：${name}\n` +
                (dose ? `用量・頻度：${dose}\n` : "") +
                (category ? `台帳上の分類：${category}\n` : ""),
            },
          ],
        },
      ],
      schema: SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 3000,
      label: `薬の効能(${name})`,
    });

    const text = toText(e);

    // 同名の行すべてに保存する（同じ薬が複数行にはならない想定だが、念のため）。
    await fetch(
      `${c.url}/rest/v1/health_medications?name=eq.${encodeURIComponent(name)}`,
      {
        method: "PATCH",
        headers: restHeaders(c.key, { Prefer: "return=minimal" }),
        body: JSON.stringify({ efficacy: text, efficacy_updated_at: new Date().toISOString() }),
      }
    ).catch(() => {
      /* 保存に失敗しても、いま調べた内容は返す（次回また調べ直すだけ） */
    });

    return NextResponse.json({ efficacy: text, cached: false });
  } catch (e) {
    console.error("薬の効能の取得に失敗:", e);
    return NextResponse.json(
      { error: llmErrorMessage(e, e instanceof Error ? e.message : "調べられませんでした") },
      { status: llmErrorStatus(e) }
    );
  }
}

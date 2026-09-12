import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { structured, isLlmConfigured, llmErrorMessage, llmErrorStatus } from "@/lib/llm";

// 健康の基礎データ。薬・検査値・方針・医療機関をまとめて返し、質問にも答える。
//
// ■ 日々の数値とは別物
//   health_metrics は毎日増える時系列。こちらは「いま何を飲んでいるか」
//   「前回の検査値はいくつか」「次の受診はいつか」という、変わったときだけ
//   書き換える台帳。
//
// ■ 薬と検査値はAIを通さない
//   「薬は？」「HbA1cは？」がいちばん聞かれる。ここをAIに要約させると
//   用量や数値が丸まる余地が残る。GETはDBの行をそのまま返し、画面も表で出す。
//   AIを使うのは、表に無いことを聞かれたとき（POST）だけ。
//
// ■ 健康データなので service role
//   3つのテーブルとも RLS 有効・ポリシー0本。health_metrics と同じ扱いで、
//   anon には開けない。
//
//   GET  … 薬・検査値・節をまとめて返す
//   POST … { question } に、上の材料だけを根拠にして答える

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

type Med = {
  kind: string;
  category: string | null;
  name: string;
  dose: string | null;
  purpose: string | null;
  note: string | null;
  started_on: string | null;
  ended_on: string | null;
  /** その薬が一般にどういうものか。クリックで開いたときに出す。未取得なら null。 */
  efficacy: string | null;
};
type Lab = {
  measured_on: string;
  item: string;
  value: number | null;
  value_text: string | null;
  unit: string | null;
  category: string | null;
  flag: string | null;
  note: string | null;
};
type Section = { key: string; title: string; body: string };

async function loadAll(url: string, key: string) {
  const [medications, labs, sections] = await Promise.all([
    rest<Med[]>(
      url,
      key,
      "health_medications?select=kind,category,name,dose,purpose,note,started_on,ended_on,efficacy&order=sort_order.asc",
      "薬剤"
    ),
    rest<Lab[]>(
      url,
      key,
      "health_labs?select=measured_on,item,value,value_text,unit,category,flag,note&order=measured_on.desc",
      "検査値"
    ),
    rest<Section[]>(
      url,
      key,
      "health_profile_sections?select=key,title,body&order=sort_order.asc",
      "基礎データ"
    ),
  ]);
  return { medications, labs, sections };
}

export async function GET() {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  try {
    return NextResponse.json(await loadAll(c.url, c.key));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "取得に失敗しました" },
      { status: 502 }
    );
  }
}

const SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "質問への答え。数値・薬剤名・用量・日付は材料のとおり一字一句変えない。分からなければ「基礎データには入っていません」と書く。",
    },
    found: {
      type: "boolean",
      description: "材料の中に答えがあったか。無かった場合は false。",
    },
    sources: {
      type: "array",
      description: "根拠にした箇所。「薬剤台帳」「検査値 2026-07-17」「医療機関・次回予定」など。",
      items: { type: "string" },
    },
  },
  required: ["answer", "found", "sources"],
  additionalProperties: false,
} as const;

export async function POST(req: NextRequest) {
  if (!isLlmConfigured()) {
    return NextResponse.json({ error: "AIの設定がありません" }, { status: 500 });
  }
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (question === "") {
    return NextResponse.json({ error: "聞きたいことを入れてください" }, { status: 400 });
  }
  if (question.length > 300) {
    return NextResponse.json({ error: "質問が長すぎます（300字まで）" }, { status: 400 });
  }

  try {
    const data = await loadAll(c.url, c.key);

    const answer = await structured<{ answer: string; found: boolean; sources: string[] }>({
      system: `あなたは吉井さんの健康の基礎データに答える係です。

## 絶対に守ること
- **渡された材料の中にあることだけを答える。** 材料に無いことは推測でも一般論でも書かない。
  無ければ found を false にして「基礎データには入っていません」と答え、
  どこを見れば分かるか（お薬手帳、主治医の診療記録など）を添える。
- **数値・薬剤名・用量・日付は一字一句変えない。** 「5mg」を「約5mg」にしない。
  「週1回」を「定期的に」にしない。丸めた瞬間に台帳の意味が無くなる。
- **診断や治療方針を述べない。** あなたは記録を引く係であって、医者ではない。
  「〜したほうがよい」「問題ありません」と書かない。記録に医師の判断が
  書かれている場合は、それを医師の言葉として引用する形にする。
- 経過を聞かれたら、日付つきで古い順に並べる。

## 答え方
- 短く。表で並んでいるものは表のまま箇条書きにする。
- 「★要確認」と書かれている項目を答えに含めるときは、その但し書きも必ず一緒に出す。
  用法が未確認の薬を、確定しているかのように答えない。`,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text" as const,
              text:
                `質問：${question}\n\n` +
                `## 薬剤・サプリ台帳\n${JSON.stringify(data.medications)}\n\n` +
                `## 検査値の履歴\n${JSON.stringify(data.labs)}\n\n` +
                `## 基礎データの各節\n` +
                data.sections.map((s) => `### ${s.title}\n${s.body}`).join("\n\n"),
            },
          ],
        },
      ],
      schema: SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 4000,
      label: "健康基礎データへの質問",
    });

    return NextResponse.json(answer);
  } catch (e) {
    console.error("健康基礎データへの質問に失敗:", e);
    return NextResponse.json(
      { error: llmErrorMessage(e, e instanceof Error ? e.message : "答えられませんでした") },
      { status: llmErrorStatus(e) }
    );
  }
}

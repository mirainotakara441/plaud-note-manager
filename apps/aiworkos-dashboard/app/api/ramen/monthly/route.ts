import { NextRequest, NextResponse } from "next/server";
// text は下のローカル変数と名前がぶつかるので別名で取り込む。
import { text as generateText, isLlmConfigured, llmErrorMessage, llmErrorStatus } from "@/lib/llm";
import { anonCreds, restHeaders } from "@/lib/supabase";
import { captureAuthorized, type RamenRow } from "@/lib/ramen";

// 月次振り返りの下書き。吉井さんが毎月アタマにXへ出している4本立てを、
// その月の ramen_logs から候補を並べたうえで生成する。
//   summary  【◯月ラーメンまとめ】 その月の全杯を①②③…で羅列（店名・メニュー・★5段階）
//   feature  【◯月の特徴】         その月を貫いたテーマを2〜3本立てで
//   awards   【◯月金賞・殿堂入り】 殿堂1店 ＋ 金賞4店
//   memories 【◯月 思い出の4枚】   ラーメン以外の4件
//
// 文体は説明より実物。ramen_monthly_posts に入れてある過去の実投稿を種類ごとに
// 手本として渡す（2026-06分を投入済み）。
// 殿堂を誰にするかは最後は本人の感覚なので、候補も一緒に返して画面で差し替えられるようにする。

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const MONTH_RE = /^\d{4}-\d{2}$/;

const SELECT =
  "id,eaten_on,bowl_no,bowl_label,shop,area,genre,visit_count,menu,price,score,score_time,stars,title,excerpt,memo,status,draft_tabelog,draft_x,is_ramen";

const KINDS = ["summary", "feature", "awards", "memories"] as const;
type Kind = (typeof KINDS)[number];

// 「点数が高い」だけだと毎月同じ常連店が並ぶので、再訪の重みも少しだけ足す。
// あくまで並べ替えの目安であって、選ぶのは人。
function rank(r: RamenRow & { stars?: number | null }): number {
  const score = r.score ?? 0;
  const revisit = Math.min(r.visit_count ?? 1, 20) / 100;
  return score + revisit;
}

function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

export async function POST(req: NextRequest) {
  if (!(await captureAuthorized(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  if (!isLlmConfigured()) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY が未設定です" }, { status: 500 });
  }
  const anon = anonCreds();
  if (!anon) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  let month = "";
  try {
    const body = await req.json();
    month = String(body?.month ?? "");
  } catch {
    /* 下で弾く */
  }
  if (!MONTH_RE.test(month)) {
    return NextResponse.json({ error: "month は YYYY-MM 形式で指定してください" }, { status: 400 });
  }

  const [logsRes, sampleRes] = await Promise.all([
    fetch(
      `${anon.url}/rest/v1/ramen_logs?select=${SELECT}&eaten_on=gte.${month}-01&eaten_on=lte.${monthEnd(
        month
      )}&order=eaten_on.asc,bowl_no.asc`,
      { headers: restHeaders(anon.key), cache: "no-store" }
    ),
    // 手本は対象月そのものを避ける（自分の答えを見て書くことになるため）。
    fetch(
      `${anon.url}/rest/v1/ramen_monthly_posts?select=month,kind,body&month=neq.${month}&order=month.desc`,
      { headers: restHeaders(anon.key), cache: "no-store" }
    ),
  ]);

  if (!logsRes.ok) {
    return NextResponse.json({ error: `取得に失敗（${logsRes.status}）` }, { status: 502 });
  }
  const rows = (await logsRes.json()) as (RamenRow & { stars: number | null })[];
  if (rows.length === 0) {
    return NextResponse.json({ error: `${month} の記録がありません` }, { status: 404 });
  }
  const samples: { month: string; kind: string; body: string }[] = sampleRes.ok
    ? await sampleRes.json()
    : [];

  const ramenByDate = rows.filter((r) => r.is_ramen);
  const ramenByRank = [...ramenByDate].sort((a, b) => rank(b) - rank(a));
  const others = rows.filter((r) => !r.is_ramen).sort((a, b) => rank(b) - rank(a));
  const bowls = ramenByDate.map((r) => r.bowl_no).filter((n): n is number => n != null);

  const line = (r: RamenRow & { stars: number | null }) =>
    [
      `${r.eaten_on.slice(5)} ${r.shop}（${r.area ?? "—"}）`,
      r.bowl_label ? `[${r.bowl_label}]` : null,
      r.menu ? `注文:${r.menu}` : null,
      r.score != null ? `食べログ点:${r.score}` : null,
      r.stars != null ? `★${r.stars}` : null,
      r.visit_count != null ? `${r.visit_count}回目` : null,
      r.excerpt ? `本文:${r.excerpt}` : null,
    ]
      .filter(Boolean)
      .join(" / ");

  const [, mm] = month.split("-");
  const label = `${Number(mm)}月`;

  const examples = KINDS.map((k) => {
    const s = samples.find((x) => x.kind === k);
    return s ? `## ${k} の実物（${s.month}）\n\n${s.body}` : "";
  })
    .filter(Boolean)
    .join("\n\n---\n\n");

  const prompt = `あなたは吉井嗣和さん（X: @0kara1_man）のラーメン投稿の代筆をします。
毎月アタマにXへ出している「月次振り返り」4本の下書きを作ってください。

# ${label}の実績

ラーメン ${ramenByDate.length}杯${
    bowls.length ? `（${Math.min(...bowls)}杯目〜${Math.max(...bowls)}杯目）` : ""
  }／ラーメン以外 ${others.length}件

## ラーメン（食べた順。まとめの①②③はこの順に並べる）
${ramenByDate.map(line).join("\n")}

## ラーメン（評価の高い順。殿堂・金賞の候補順）
${ramenByRank.slice(0, 10).map(line).join("\n")}

## ラーメン以外（思い出の4枚の候補）
${others.map(line).join("\n")}

# 手本（この文体・構成をそのまま踏襲する）

${examples || "（手本なし。型は以下の指示に従うこと）"}

# 4本の構成

1. summary  「【${label}ラーメンまとめ】」で始める。「${label}は${ramenByDate.length}杯完食」を2行目に置き、
   食べた順に①②③…で「店名 / メニュー / ★5段階」を3行1組で並べる。★は食べログ点を
   そのまま5段階に置き換えるのではなく、本文の熱量と点数の両方から決める。
   最も評価の高い1杯には「★★★★★（殿堂）」と添える。最後に締めを2行。
2. feature  「【${label}の特徴】」で始める。その月を貫いたテーマを2〜3本立てて、
   該当する店を箇条書きで挙げる。締めのあと店名のハッシュタグを並べる。
3. awards   「【${label}金賞・殿堂入り】」で始める。総括1〜2文 → 「殿堂」1店 → 「金賞」4店。
   各店は「店名（エリア）」「メニュー」の2行。締めは二段構え。最後に店名ハッシュタグ。
4. memories 「【${label} 思い出の4枚】」で始める。「ラーメンだけではありません。」を置き、
   ラーメン以外4件を「店名」＋情景2〜3行で。締めは食と記憶を結ぶ2文。

# 禁則
- 上のデータに無い店・メニュー・エピソードを作らない。
- 「絶品」「至福」のような紋切り型の食レポ語を使わない。
- 本文にURLを入れない。
- 殿堂は1店だけ。迷ったら再訪回数と点数の両方が高い店を選ぶ。

次の形式ちょうどで返してください。区切り行はそのまま、前後に説明文を付けないこと。
JSONにはしないこと（本文が複数行なので改行で壊れる）。

===SUMMARY===
1本目の全文
===FEATURE===
2本目の全文
===AWARDS===
3本目の全文
===MEMORIES===
4本目の全文
===END===`;

  // system プロンプトは渡さない。役割指示は上の prompt（user 側）に入っているため、
  // ここで別に書き起こすと送る内容が変わる。
  let text = "";
  try {
    // effort を指定しないと、このモデルは推論だけで max_tokens を使い切り、
    // 本文が1文字も返らないことがある（2026-08-01: stop=max_tokens / blocks=thinking / chars=0）。
    // 4本ぶんの長文を出す枠を確保するため、思考は控えめにして上限も広げておく。
    text = await generateText({
      prompt,
      maxTokens: 16000,
      thinking: false,
      effort: "medium",
      label: "月次生成",
    });
    console.log("月次生成 chars=", text.length);
  } catch (e) {
    console.error("月次振り返り生成エラー:", e);
    return NextResponse.json(
      { error: llmErrorMessage(e, "月次振り返りの生成に失敗しました") },
      { status: llmErrorStatus(e) }
    );
  }

  // JSONにしない理由は上の指示文と同じ。4本とも複数行の日本語なので、
  // JSONだと改行のエスケープが崩れて全部読めなくなる（2026-08-01に実際に踏んだ）。
  const pick = (from: string, to: string): string | undefined => {
    const i = text.indexOf(from);
    if (i === -1) return undefined;
    const j = text.indexOf(to, i + from.length);
    const v = text.slice(i + from.length, j === -1 ? undefined : j).trim();
    return v === "" ? undefined : v;
  };
  const drafts: Partial<Record<Kind, string>> = {
    summary: pick("===SUMMARY===", "===FEATURE==="),
    feature: pick("===FEATURE===", "===AWARDS==="),
    awards: pick("===AWARDS===", "===MEMORIES==="),
    memories: pick("===MEMORIES===", "===END==="),
  };
  const missing = KINDS.filter((k) => !drafts[k]);
  if (missing.length > 0) {
    console.error("月次の読み取り失敗。生成文の長さ:", text.length, "末尾:", text.slice(-200));
    return NextResponse.json(
      { error: `生成結果が揃いませんでした（${missing.join("・")}）`, drafts },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    month,
    summary: {
      ramen: ramenByDate.length,
      others: others.length,
      bowl_from: bowls.length ? Math.min(...bowls) : null,
      bowl_to: bowls.length ? Math.max(...bowls) : null,
    },
    candidates: ramenByRank.slice(0, 8).map((r) => ({
      id: r.id,
      shop: r.shop,
      area: r.area,
      menu: r.menu,
      score: r.score,
      visit_count: r.visit_count,
    })),
    drafts,
  });
}

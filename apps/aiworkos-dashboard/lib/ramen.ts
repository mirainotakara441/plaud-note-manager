import { NextRequest } from "next/server";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";

// ラーメン記録（ライフOS側）の共通部品。
// 「一杯を記録 → 文章を2本生成 → 食べログは半自動・Xは自動投稿」までを支える。

const COOKIE_NAME = "aiworkos_auth";

export type RamenRow = {
  id: number;
  eaten_on: string;
  bowl_no: number | null;
  bowl_label: string | null;
  shop: string;
  area: string | null;
  genre: string | null;
  visit_count: number | null;
  menu: string | null;
  price: number | null;
  score: number | null;
  score_time: string | null;
  title: string | null;
  excerpt: string | null;
  memo: string | null;
  status: string;
  draft_tabelog: string | null;
  draft_x: string | null;
  is_ramen: boolean;
};

// iPhoneショートカットからの起票は合言葉cookieを持てないため、
// cronルートと同じ二本立てにする（Bearerトークン or 合言葉cookie）。
// RAMEN_CAPTURE_SECRET 未設定なら、ショートカット経路は閉じたまま（フェイルクローズ）。
export async function captureAuthorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.RAMEN_CAPTURE_SECRET?.trim();
  if (secret && req.headers.get("authorization") === `Bearer ${secret}`) {
    return true;
  }
  const passphrase = process.env.APP_PASSPHRASE;
  if (passphrase && passphrase.trim() !== "") {
    const cookie = req.cookies.get(COOKIE_NAME)?.value ?? "";
    if (constantTimeEqual(cookie, await cookieValueFor(passphrase))) return true;
  }
  return false;
}

// 吉井さんの実際の投稿から抽出した型。ここを緩めると「AIが書いた文」になるので、
// 具体的な癖（✨の位置、「↓」の区切り、締めの言い回し）まで明文化してある。
export const STYLE_GUIDE = `# 吉井さんのラーメン投稿の型

## 食べログ用（長文・記録重視）
- タイトルは「【◯◯杯目】ひとこと」の形。ひとことは感嘆や問いかけを含む短い一句
  （例：「10年ぶり？？ラーメンも最高！」「チェーン店でも、うまいものはうまい！最高！」）。
- 本文の1文目は「◯時頃、仕事帰りに一人で「店名」へ訪問」の形で、時刻・状況・同行者・店名を必ず入れる。
- 次に注文を「・メニュー名 1,200円」の中黒リストで書き、行末に✨を置く。
- 味の描写は 麺 → スープ → 具 → 味変 の順。専門用語より食感と温度で書く。
- 途中に必ず「その日ならではの出来事」を1つ入れる（店員の気配り、行列の有無、同行者の反応、
  帰宅後の家族の反応など）。ここが吉井さんの文章の芯。
- 締めは「ご馳走さまでした！！」または「良いお店との出会いに感謝！」。
- 絵文字は✨だけを使う。多用しない。段落間は1行空ける。

## X用（短文・リズム重視）
- 1行目は必ずフック。事実ではなく引きで始める
  （例：「今年No.1の麺に出会ったかもしれない。」「暑すぎて、今日は冷やし一択。」
  「”経営”としてのラーメン屋」「◯◯杯目」）。
- 「↓」だけの行で場面を区切り、畳みかける。1ブロックは1〜3行。
- 体言止めと短文を多用。説明しすぎない。価格の羅列はしない。
- 最後の1行で効かせる（例：「「辛い」じゃなく「また食べたい」が勝つ一杯。」）。
- ハッシュタグは付けない（月次まとめの投稿でだけ使う）。
- 本文にURLは入れない。
- 全体で280文字前後に収める。長くても400文字。

## 両方に共通する禁則
- 食べていないもの、聞いていない値段、確認していない店の由来を創作しない。
- 「絶品」「至福」のような紋切り型の食レポ語を使わない。
- 過度な断定や煽りをしない。点数の話は本文に書かない。`;

// 直近の投稿済みを数件そのまま見せる。文体は言葉で説明するより実物を見せたほうが写る。
export function fewShot(samples: RamenRow[]): string {
  const usable = samples.filter((s) => s.excerpt || s.draft_tabelog);
  if (usable.length === 0) return "";
  const blocks = usable.slice(0, 3).map((s) => {
    const tabelog = s.draft_tabelog ?? s.excerpt ?? "";
    return [
      `### ${s.shop}（${s.bowl_label ?? "—"}）`,
      `[食べログのタイトル] ${s.title ?? ""}`,
      `[食べログ本文]\n${tabelog}`,
      s.draft_x ? `[X投稿]\n${s.draft_x}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return `\n\n# 実際の過去投稿（この文体に寄せる）\n\n${blocks.join("\n\n")}`;
}

export function draftPrompt(row: RamenRow, samples: RamenRow[]): string {
  const facts = [
    `店名: ${row.shop}`,
    row.area ? `エリア: ${row.area}` : null,
    row.genre ? `ジャンル: ${row.genre}` : null,
    row.visit_count != null ? `その店に通算${row.visit_count}回目` : null,
    row.bowl_label ? `通算杯数ラベル: ${row.bowl_label}` : null,
    row.menu ? `注文: ${row.menu}` : null,
    row.price != null ? `価格: ${row.price}円` : null,
    `食べた日: ${row.eaten_on}`,
    row.memo ? `その場のメモ（一次情報・最重要）:\n${row.memo}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `${STYLE_GUIDE}${fewShot(samples)}

# 今回の一杯

${facts}

# 指示

上の「その場のメモ」を一次情報として、食べログ用とX用の文章を1本ずつ書いてください。
メモに書かれていない事実（同行者・時刻・値段・店の由来）は創作せず、書かずに済ませてください。

次のJSONだけを返してください。前後に説明文を付けないこと。

{"title":"食べログのタイトル","tabelog":"食べログ本文","x":"X投稿本文"}`;
}

// JSONだけ返せと言っても前後に文が付くことがあるので、最初の { 〜 最後の } を拾う。
export function parseDraft(text: string): { title: string; tabelog: string; x: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (typeof obj.tabelog !== "string" || typeof obj.x !== "string") return null;
    return {
      title: typeof obj.title === "string" ? obj.title : "",
      tabelog: obj.tabelog,
      x: obj.x,
    };
  } catch {
    return null;
  }
}

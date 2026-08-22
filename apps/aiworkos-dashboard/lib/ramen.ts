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
- 1行目は、食べログ本文に既にある一文か、そこから素直に引ける事実で始める。
  **本文に無い驚き（「〜とは思わなかった」「ハマるとは」等）を創作して
  フックにしない**（2026-08-01 吉井さん指摘）。本文自体が強い一文で始まっているなら
  それをそのまま1行目に使う。
- **問いかけで締めない。**「どちら派ですか？」のような読者への質問は食べログ側の作法で、
  X用には入れない（同上）。
- **読者に行動を促さない。**「ぜひ」「提供終了前に」「〜する価値あり」のような
  呼びかけ・宣伝調の締めを書かない。締めは吉井さん自身の感想で終える
  （2026-08-01 吉井さん指摘）。
- **会社の同僚が読んでも違和感のない文章にする。** これが文体の最終判定基準。
  インフルエンサー的な煽り、大げさな断定、内輪ノリの語尾は入れない。
  仕事仲間に見られて困る書き方になっていないか、書いたあとに一度読み返すこと。
- 「↓」だけの行で場面を区切り、畳みかける。1ブロックは1〜3行。
- 体言止めと短文を多用。説明しすぎない。価格の羅列はしない。
- 最後の1行で効かせる（例：「「辛い」じゃなく「また食べたい」が勝つ一杯。」）。
- ハッシュタグは本文に書かない。店名のタグ（#店名）は投稿の直前に機械で付けるので、
  ここで書くと二重になる。
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
  // 既に書いてある食べログ本文があるなら、それが一次情報。
  // これを渡さずに店名と注文だけで書かせると、モデルが隙間を埋めようとして
  // 事実と逆のことを書く（2026-08-01に「じんわり系煮干し」を「ガツン系」と
  // 真逆に書かせてしまった）。
  const source = row.draft_tabelog ?? row.excerpt ?? null;

  const facts = [
    `店名: ${row.shop}`,
    row.area ? `エリア: ${row.area}` : null,
    row.genre ? `ジャンル: ${row.genre}` : null,
    row.visit_count != null ? `その店に通算${row.visit_count}回目` : null,
    row.bowl_label ? `通算杯数ラベル: ${row.bowl_label}` : null,
    row.menu ? `注文: ${row.menu}` : null,
    row.price != null ? `価格: ${row.price}円` : null,
    `食べた日: ${row.eaten_on}`,
    row.memo ? `その場のメモ（一次情報）:\n${row.memo}` : null,
    source ? `すでに書いた食べログ本文（一次情報・最重要）:\n${source}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `${STYLE_GUIDE}${fewShot(samples)}

# 今回の一杯

${facts}

# 指示

上の一次情報から、食べログ用とX用の文章を1本ずつ書いてください。

**すでに食べログ本文がある場合、それが事実の唯一の出典です。**
X用はその内容を短く組み直すだけで、味の評価・感想・回数・同行者を変えないこと。
たとえば「じんわり広がるバランス型」と書いてあるものを「ガツンと来る」に
言い換えるのは、文体の調整ではなく事実の改変です。絶対にしないこと。
本文に書かれていない出来事（過去に避けていた、初めて頼んだ等）も足さないこと。
食べログ本文が既にあるときは ===TABELOG=== の中身は空のままでかまいません。

次の形式ちょうどで返してください。区切り行はそのまま、前後に説明文を付けないこと。

===TITLE===
食べログのタイトル
===TABELOG===
食べログ本文
===X===
X投稿本文
===END===`;
}

// 出力はJSONにしない。本文が複数行の日本語なので、JSONだと改行のエスケープが崩れて
// 丸ごと読み取れなくなる（2026-08-01に実際に踏んだ）。区切り行で切り出す。
//
// 食べログ本文が既にある一杯（取り込み済みのもの）では、モデルがX用だけを返すことがある。
// 必須はX用だけにして、食べログ用が無ければ既存を残す。
// ---------------------------------------------------------------------------
// 店名ハッシュタグ
// ---------------------------------------------------------------------------
//
// X投稿には必ず「#店名」を付ける（例: #田坂屋 / #べんてん）。
// 本文の生成をAIに任せると付け忘れる日が出るので、投稿の直前に機械で足す。
//
// Xのハッシュタグは英数字・アンダースコア・各国語の文字しか拾わない。
// 空白や記号が入るとそこでタグが切れるため、店名から落としてから付ける
// （「中華そば つけ麺 湊」→「#中華そばつけ麺湊」）。

// 店名の頭に付く業態の前置き。「味噌麺処 田坂屋」を「#味噌麺処田坂屋」にすると
// タグとして長く、同じ店を指す別のタグと混ざる。吉井さんの求めは「#田坂屋」なので、
// 空白で区切られた前置きを落として固有名だけを残す。
// 長い順に並べる（「中華そば」を「そば」より先に当てるため）。
const SHOP_PREFIXES = [
  "自家製手もみ麺", "チャーシュー麺専門", "塩そば専門店", "煮干しつけ麺",
  "家系総本山", "中華そばの店", "横浜家系らーめん", "自家製中華そば",
  "生姜焼き定食専門店", "青竹手打佐野らーめん",
  "味噌麺処", "中華そば", "らぁめん", "らーめん", "ラーメン", "自家製麺",
  "中華料理", "中華処", "麺処", "麺屋", "麺家", "麺や", "麺舗", "麺壱", "麺創",
  "拉麺", "支那ソバ", "だしと麺", "とんこつ", "豚骨", "油そば", "つけ麺",
  "スープカレー", "洋食キッチン", "創作料理", "元気カフェ", "大衆ビストロ",
] as const;

// 末尾の支店名。「#らーめん信玄南６条店」ではなく「#信玄」にしたい。
const BRANCH_SUFFIX = /\s*\S*?(?:本店|本館|本邸|本丸店|総本店|総本山|支店|[^\s]*?店)$/;

/**
 * 店名をXのハッシュタグに使える形にする。使えない店名なら null。
 *
 * 業態の前置き（味噌麺処・中華そば等）と末尾の支店名を落として固有名だけ残す。
 * 落とした結果が空になる店（「ラーメン 雷 東京本丸店」の「雷」のように
 * 固有名が中間にある場合を含む）は、落とす前の形に戻して取りこぼさない。
 */
export function shopHashtag(shop: string | null | undefined): string | null {
  if (!shop) return null;

  // 全角・半角の括弧書き（支店名など）は落とす。「#べんてん(早稲田)」は不自然。
  let s = shop.trim().replace(/[（(][^）)]*[）)]/g, "").trim();

  // 末尾の支店名を落とす。ただし店名がそれだけになるなら落とさない。
  const withoutBranch = s.replace(BRANCH_SUFFIX, "").trim();
  if (withoutBranch !== "") s = withoutBranch;

  // 先頭の業態の前置きを落とす。空白区切りでも続けて書かれていても拾う。
  for (const p of SHOP_PREFIXES) {
    if (s.startsWith(p) && s.length > p.length) {
      const rest = s.slice(p.length).trim();
      if (rest !== "") {
        s = rest;
        break;
      }
    }
  }

  const cleaned = s
    // 記号・空白はタグを途中で切るので取り除く
    .replace(/[\s　]/g, "")
    .replace(/[!-/:-@[-`{-~！-／：-＠［-｀｛-～、。・「」『』…〜ー―–—]/g, (m) =>
      // 長音符（ー）だけは店名の一部なので残す。他の記号はタグを切るため落とす。
      m === "ー" ? m : ""
    );
  return cleaned === "" ? null : `#${cleaned}`;
}

/**
 * X本文に店名タグを足す。既に同じタグが入っていれば足さない（二重防止）。
 * 本文とタグの間は1行空ける。
 */
export function withShopHashtag(body: string, shop: string | null | undefined): string {
  const tag = shopHashtag(shop);
  if (!tag) return body;
  if (body.includes(tag)) return body;
  return `${body.trimEnd()}\n\n${tag}`;
}

export function parseDraft(
  text: string
): { title: string; tabelog: string | null; x: string } | null {
  const pick = (from: string, to: string): string | null => {
    const i = text.indexOf(from);
    if (i === -1) return null;
    const j = text.indexOf(to, i + from.length);
    const v = text.slice(i + from.length, j === -1 ? undefined : j).trim();
    return v === "" ? null : v;
  };
  const x = pick("===X===", "===END===");
  if (!x) return null;
  return {
    title: pick("===TITLE===", "===TABELOG===") ?? "",
    tabelog: pick("===TABELOG===", "===X==="),
    x,
  };
}

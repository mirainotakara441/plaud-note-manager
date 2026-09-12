// 一行日記の「原文」を、そう名乗ってよいかを判定する純粋ロジック。**実装はここ1本だけ。**
//
// ■ なぜ検証が要るか
// 1日ぶんの原文は、貼り付けた塊をClaudeに日ごとへ分解させて得ている。
// Claudeは「そのまま返せ」と言っても整形しがちなので、**返ってきたものが
// 本当に貼り付け原文の一部かをコードで確かめる**。確かめずに保存すると、
// 「原文」と名乗る別物が残り、後から何を書いたか追えなくなる——
// それは原文を残さないより悪い。
//
// ■ 判定の方針
// 完全一致は求めない。改行・全半角スペース・連続空白の揺れは、貼り付けや
// Claudeの往復で普通に起きる。だから**空白を畳んでから部分文字列か**を見る。
// それ以外（文字の差し替え・語順の変更・要約）は通さない。
//
// ■ 通らなかったらどうするか
// その日の原文は**保存しない**。要約は従来どおり保存されるので、失うものは無い。
// 「検証に落ちた」という事実だけ呼び出し側へ返す。

/** 空白の揺れだけを畳む。文字そのものは変えない。 */
export function normalizeForCompare(s) {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")      // 改行コードの違い
    .replace(/[ \t　]+/g, " ") // 半角/全角スペース・タブの連続
    .replace(/\n{2,}/g, "\n")      // 空行の数
    .replace(/[ ]*\n[ ]*/g, "\n")  // 行頭行末の空白
    .trim();
}

/**
 * Claudeが返した「その日の原文」を保存してよいか。
 *
 * @param {string} pasted 吉井さんが貼り付けた全文（誤字辞書を通した後）
 * @param {string|null|undefined} candidate Claudeが「その日の原文」として返したもの
 * @returns {{ok: boolean, reason: string|null, raw: string|null}}
 */
export function verifyRawSpan(pasted, candidate) {
  const raw = typeof candidate === "string" ? candidate.trim() : "";
  if (!raw) return { ok: false, reason: "原文が返ってこなかった", raw: null };

  // 短すぎるものは「原文」と呼べない。要約が紛れ込むのを防ぐ最低線。
  if (raw.length < 20) return { ok: false, reason: `短すぎる（${raw.length}字）`, raw: null };

  const hay = normalizeForCompare(pasted);
  const needle = normalizeForCompare(raw);
  if (!hay.includes(needle)) {
    return { ok: false, reason: "貼り付け原文の中に見つからない（改変された可能性）", raw: null };
  }
  // 貼り付け全体より長いことはありえない
  if (needle.length > hay.length) {
    return { ok: false, reason: "貼り付け原文より長い", raw: null };
  }
  return { ok: true, reason: null, raw };
}

/**
 * Notion の1ブロックは2000字まで。原文をブロックに収まる単位へ割る。
 * 改行の切れ目を優先し、無ければ字数で切る。
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string[]}
 */
export function splitForNotionBlocks(text, limit = 1900) {
  const s = String(text ?? "");
  if (s.length <= limit) return s ? [s] : [];
  const out = [];
  let rest = s;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;   // 改行が近くに無ければ字数で切る
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

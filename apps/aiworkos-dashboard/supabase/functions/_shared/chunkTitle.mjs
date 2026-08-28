// タイトル末尾のチャンク接尾辞を落とす規則。**実装はここ1本だけ。**
//
// ■ なぜ supabase/functions/_shared に置くか
//   identity.mjs と同じ理由。同じ規則を Edge Function（Deno）とアプリ・テスト
//   （Node）の両方から使うので、二重実装にすると片方だけ育って食い違う。
//   実際に食い違った：2026-08-26 に org-history 側で「｜n/m を落とす」修正を入れ、
//   2026-08-28 にアプリ側だけが他形式まで落とすよう育った。本番の会議287行には
//   ｜n/m が0行しか無く、org-history は実データを1行も剥がせていなかった。
//   その結果 /organizations の団体セレクタだけが膨らんでいた
//   （札幌市 6→実際2、アグレックス 3→実際1、横浜市 11→実際7）。
//   Deno / Node のAPIは一切使わない。素のJSだけで書く。
//
// ■ なぜ接尾辞を落とすのか
//   1つの文書が複数チャンクに分かれているとき、これを外さないと同じ文書が
//   チャンクの数だけ別文書として数えられる。
//
// ■ 実データにある形式（監査で数えたもの。ここに無い形は消さない）
//   ｜1/16    18件   ｜text1  119件   ｜p1     19件
//   ｜p10-1   39件   ｜1（裸の数字） 621件（会議・日記・学び・学会・成果物・振り返りの6種別）
//   `｜slide1` `｜img1` も同じ書き手が使う形式なので含める。
//
// ■ 接尾辞は積み重なる
//   「…｜報告書｜slide1｜1」「…｜1/7｜8」のように2段・3段になっている行がある。
//   1回だけ剥がすと親に戻らないので、既知の形が無くなるまで繰り返す。
//
// ■ 広く消さない
//   「2026-07-06週｜全体」の `｜全体` や `｜報告書` のような、チャンク番号でない
//   末尾は残す。不明な末尾まで消すと、別の文書どうしを取り違えて潰してしまう。

const CHUNK_SUFFIX = /｜(?:\d+\/\d+|text\d+|slide\d+|img\d+|p\d+(?:-\d+)?|\d+)$/;

/**
 * まだ既知のチャンク接尾辞が残っているか。剥がし切れたかの確認に使う。
 * @param {string} title
 * @returns {boolean}
 */
export function hasChunkSuffix(title) {
  return CHUNK_SUFFIX.test(title.trim());
}

/**
 * 既知のチャンク接尾辞を落とし切る。
 *
 * 取り違えを防ぐため、全部消えて空になる場合は元のタイトルを返す
 * （消しすぎるくらいなら、束ねないほうが安全）。
 *
 * @param {string} title
 * @returns {string}
 */
export function stripChunkSuffix(title) {
  let t = title.trim();
  for (let i = 0; i < 5 && CHUNK_SUFFIX.test(t); i += 1) {
    const next = t.replace(CHUNK_SUFFIX, "").trim();
    if (next === "") return t;
    t = next;
  }
  return t;
}

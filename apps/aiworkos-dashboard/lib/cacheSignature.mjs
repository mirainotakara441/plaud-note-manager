// AIキャッシュの署名。**実装はここ1本だけ。**
//
// ■ なぜ共有モジュールにするか
// 以前は agent/route.ts と monthly-report/route.ts に別々の computeSignature が
// あり、どちらも同じ弱点（件数と content.length の合計しか見ない）を持っていた。
// identity.mjs / chunkTitle.mjs と同じ理由で、実装は1本にする。
// .mjs にしてあるのは、Next のルート（TS）からも純粋ロジックのテスト（Node）からも
// 同じものを読むため。Next や Anthropic の依存を持ち込まない。
//
// ■ v2（2026-08-29）で id・並び順・本文を入れた理由
// 旧版は `${件数}:${最新日}:${content長の合計}` だけだった。**和は順序に依らない**ので、
// 検索結果を並べ替えただけでは署名が変わらず、古いAI回答が返り続ける。
// 本番データで確認した実害の経路が2つある。
//
//   ① 並び順が変わっても署名が同じ
//      agent 成果物 北九州市（成果物4文書）で再現。集合は同じ・順序だけ違うのに
//      署名は完全一致した。RAGの並べ替え改善を入れると、その効果測定ごと壊れる。
//
//   ② 誤字修正で文字数が変わらないと署名が同じ
//      transcription_dictionary 140語のうち **40語が同じ文字数の置換**
//      （精霊市→政令市 / 富士フィルム→富士フイルム / 東洋資料→東洋紙業 など）。
//      直しても content.length が動かないので、誤字入りの提案が残り続ける。
//      月報側はさらに深刻で、weekly_reports に updated_at 列が無いため、
//      既存週報を書き直しても検知する手がかりが本文ハッシュしか無い。
//
// だから「**どの行が・どの順で・どんな中身だったか**」を署名に入れる。
//
// ■ 読める部分を残す
// 全部ハッシュにすると障害調査で何も分からない。先頭に版・件数・最新日を平文で置き、
// 末尾にハッシュを付ける。
//
// ■ 版を上げるときは SIGNATURE_VERSION を上げる
// 接頭辞が違えば旧署名と決して一致しない。形式を変えたのに古いキャッシュが
// 生き残る事故を、規約でなく形で防ぐ。

import { createHash } from "node:crypto";

export const SIGNATURE_VERSION = "v2";

/** 区切り。本文に出てこない制御文字を使う（NULバイトはgitがバイナリ扱いするので使わない）。 */
const SEP = "␟";

/** @param {string} text @returns {string} */
export function hashText(text) {
  return createHash("sha256").update(text ?? "").digest("hex");
}

/**
 * 1行ぶんの指紋。id と本文と（あれば）類似度を効かせる。
 *
 * **本文のハッシュを必ず入れる。** id と similarity だけでは、
 * 「同じ行の中身だけが変わる」誤字修正を確実には拾えない
 * （再エンベディングで similarity は動くが、丸めると一致しうるので当てにしない）。
 *
 * @param {{id?: string|null, similarity?: number|null, content?: string|null}} row
 * @returns {string}
 */
export function rowFingerprint(row) {
  const id = row?.id ?? "-";
  const sim = typeof row?.similarity === "number" && Number.isFinite(row.similarity)
    ? row.similarity.toFixed(6)
    : "-";
  return `${id}#${sim}#${hashText(row?.content ?? "").slice(0, 16)}`;
}

/** 最新の日付。空や null は無視する。 */
function latestOf(rows, key) {
  let max = "";
  for (const r of rows ?? []) {
    const v = r?.[key];
    if (v && (!max || v > max)) max = v;
  }
  return max;
}

/**
 * 提案エージェントのキャッシュ署名（app/api/agent）。
 * 会議・団体別成果物・共通資料の3つが材料。**順序を変えれば署名も変わる。**
 *
 * @param {Array<{id?:string,content?:string,event_date?:string|null}>} meetings
 * @param {Array<{id?:string,content?:string,similarity?:number}>} deliverables
 * @param {Array<{id?:string,content?:string,similarity?:number}>} commonDocs
 * @returns {string}
 */
export function proposalSignature(meetings, deliverables, commonDocs) {
  const m = meetings ?? [];
  const d = deliverables ?? [];
  const c = commonDocs ?? [];
  const latest = latestOf(m, "event_date");
  // join で並べるので、順序が変われば必ず文字列が変わる
  const body = [
    SIGNATURE_VERSION,
    `m${m.length}`, latest, m.map(rowFingerprint).join(","),
    `d${d.length}`, d.map(rowFingerprint).join(","),
    `c${c.length}`, c.map(rowFingerprint).join(","),
  ].join(SEP);
  return `${SIGNATURE_VERSION}:m${m.length}:d${d.length}:c${c.length}:${latest}:${hashText(body)}`;
}

/**
 * 月報のキャッシュ署名（app/api/monthly-report）。
 *
 * weekly_reports に updated_at 列が無いため、既存の週報を書き直しても
 * created_at は動かない。**本文のハッシュだけが唯一の検知手段**なので、
 * ここを外すと書き直しが永久に反映されなくなる。
 *
 * @param {Array<{id?:string,summary?:string,insight?:string|null,tactic?:string|null,created_at?:string}>} rows
 * @returns {string}
 */
export function monthlyReportSignature(rows) {
  const r = rows ?? [];
  const latest = latestOf(r, "created_at");
  const body = [
    SIGNATURE_VERSION,
    `w${r.length}`,
    latest,
    r.map((x) =>
      `${x?.id ?? "-"}#${hashText([x?.summary ?? "", x?.insight ?? "", x?.tactic ?? ""].join(SEP)).slice(0, 16)}`
    ).join(","),
  ].join(SEP);
  return `${SIGNATURE_VERSION}:w${r.length}:${latest}:${hashText(body)}`;
}

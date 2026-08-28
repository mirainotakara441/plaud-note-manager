// Memory 2.0（同一性の4列）の異常を「今朝の気づき」の形に落とす純粋ロジック。
//
// I/Oを持たないので、合成データでそのまま試せる。検知器
// （lib/advisor/detectors/memory.ts）はここを呼ぶだけにしてある。
// 判定そのものは lib/memoryShadow.mjs の auditShadowColumns が唯一の正で、
// ここに条件を書き写さない。
//
// ■ 同じ異常で毎朝鳴らさない／直ったあと再発したらまた鳴る
// id に「その異常に関わる行のうち、いちばん古い created_at」を混ぜている。
//   ・同じ異常が続いている間 … いちばん古い行は変わらない → id が同じ → 既読が効く
//   ・直って、あとで再発     … 別の行なので id が変わる   → もう一度鳴る
// 件数を id に入れてはいけない。1行増えるたびに別の気づきとして鳴り直す。
//
// ■ 鳴らさないもの
// 実体で見たときの同番（別version）は異常ではない。同じ録音から作られた
// 別々の要約が同じ番号で並ぶのは設計どおりの姿（第4.1弾で実データ確認済み）。

import { auditShadowColumns } from "./memoryShadow.mjs";

/**
 * @typedef {Object} IdentityRow
 * @property {string|null} canonical_document_id
 * @property {string|null} source_document_id
 * @property {number|null} chunk_index
 * @property {string|null} ingest_scheme
 * @property {string} source_type
 * @property {string} created_at
 */

const HREF = "/status";
const HREF_LABEL = "記憶の健康診断で見る";

/** いちばん古い created_at（分まで）。idの素にする。 */
function oldest(rows) {
  let min = null;
  for (const r of rows) if (!min || r.created_at < min) min = r.created_at;
  return (min ?? "unknown").slice(0, 16);
}

function isBlank(v) {
  return v === null || v === undefined || v === "";
}

/**
 * @param {IdentityRow[]} rows      memory_chunks の全行（4列＋source_type＋created_at）
 * @param {boolean} truncated       取り切れていないか
 * @returns {{id:string, area:string, severity:string, title:string, facts:string[], href?:string, hrefLabel?:string}[]}
 */
export function buildMemoryFindings(rows, truncated = false) {
  const findings = [];
  if (!Array.isArray(rows) || rows.length === 0) return findings;

  const h = auditShadowColumns(rows);
  const suffix = truncated ? "（取得上限に達しているため、これ以上ある可能性があります）" : "";

  // --- A. 4列のどれかが未設定 -------------------------------------
  const nullRows = rows.filter(
    (r) =>
      isBlank(r.canonical_document_id) ||
      isBlank(r.source_document_id) ||
      r.chunk_index === null ||
      r.chunk_index === undefined ||
      isBlank(r.ingest_scheme)
  );
  if (nullRows.length > 0) {
    const parts = [
      h.canonicalNull > 0 ? `実体ID ${h.canonicalNull}行` : null,
      h.sourceDocumentNull > 0 ? `取り込み文書ID ${h.sourceDocumentNull}行` : null,
      h.chunkIndexNull > 0 ? `chunk_index ${h.chunkIndexNull}行` : null,
      h.ingestSchemeNull > 0 ? `ingest_scheme ${h.ingestSchemeNull}行` : null,
    ].filter((s) => s !== null);
    const types = [...new Set(nullRows.map((r) => r.source_type))].slice(0, 5).join("、");
    findings.push({
      id: `memory2:null:${oldest(nullRows)}`,
      area: "取り込み",
      severity: "alert",
      title: `Memory 2.0 の同一性が入っていない記憶が${nullRows.length}行あります${suffix}`,
      facts: [
        `未設定の内訳：${parts.join(" / ")}`,
        `いちばん古いものは ${oldest(nullRows)}（種別：${types}）`,
        "書き込み口（store-memory）を通っていないか、通る前に入った行です。取り込み経路を確かめてください",
      ],
      href: HREF,
      hrefLabel: HREF_LABEL,
    });
  }

  // --- B. 同じ取り込み文書の中で番号が衝突 --------------------------
  if (h.collisions.length > 0) {
    const keys = new Set(h.collisions.map((c) => `${c.sourceDocumentId}␟${c.chunkIndex}`));
    const hit = rows.filter(
      (r) => !isBlank(r.source_document_id) && keys.has(`${r.source_document_id}␟${r.chunk_index}`)
    );
    const rowCount = h.collisions.reduce((n, c) => n + c.rows, 0);
    findings.push({
      id: `memory2:collision:${oldest(hit)}`,
      area: "取り込み",
      severity: "alert",
      title: `同じ取り込み文書の中で番号が重なっている箇所が${h.collisions.length}組あります${suffix}`,
      facts: [
        `対象は${rowCount}行。1つの文書の中に同じ chunk_index が複数あります`,
        `例：${h.collisions
          .slice(0, 2)
          .map((c) => `${String(c.sourceDocumentId).slice(0, 44)} の ${c.chunkIndex}番が${c.rows}行`)
          .join(" / ")}`,
        "チャンクの切り方を変えて入れ直したときに、古い行が消えずに残ると起きます",
      ],
      href: HREF,
      hrefLabel: HREF_LABEL,
    });
  }

  // --- C. 1つの取り込み文書が複数の実体にまたがる --------------------
  if (h.variantsSpanningCanonicals.length > 0) {
    const ids = new Set(h.variantsSpanningCanonicals.map((v) => v.sourceDocumentId));
    const hit = rows.filter((r) => !isBlank(r.source_document_id) && ids.has(r.source_document_id));
    findings.push({
      id: `memory2:spanning:${oldest(hit)}`,
      area: "取り込み",
      severity: "alert",
      title: `1つの取り込み文書が複数の実体にまたがっています（${h.variantsSpanningCanonicals.length}件）${suffix}`,
      facts: [
        "取り込み文書は必ず1つの実体にぶら下がります。またいでいるのは親子関係が壊れた合図です",
        `例：${h.variantsSpanningCanonicals
          .slice(0, 2)
          .map((v) => `${String(v.sourceDocumentId).slice(0, 40)} → ${v.canonicalDocumentIds.length}実体`)
          .join(" / ")}`,
        "同一性の導出規則を変えたときに、既存行と新規行で別の答えが出ると起きます",
      ],
      href: HREF,
      hrefLabel: HREF_LABEL,
    });
  }

  // --- D. 総合。A〜Cで説明できない不健全が残っていたら念のため出す ----
  // 判定の定義（auditShadowColumns の healthy）が将来変わっても取りこぼさない保険。
  if (!h.healthy && findings.length === 0) {
    findings.push({
      id: `memory2:unhealthy:${oldest(rows)}`,
      area: "取り込み",
      severity: "alert",
      title: `Memory 2.0 の健全性チェックが異常を返しています${suffix}`,
      facts: [
        "個別の内訳（未設定・番号の衝突・実体またぎ）では説明が付きませんでした",
        "判定は lib/memoryShadow.mjs の auditShadowColumns にあります",
      ],
      href: HREF,
      hrefLabel: HREF_LABEL,
    });
  }

  return findings;
}

// Memory 2.0 Shadow Mode の純粋ロジック。
//
// 目的:
//   本番の束ね方（lib/organizations.ts の documentKey 系）には一切触れず、
//   2026-08-28 の migration で入った新しい3列だけで数え直して、横に並べる。
//
//   canonical_document_id … 実体（1本の録音・1つのファイル）
//     └ source_document_id … 取り込み文書＝版（1回の取り込みが作った文書）
//         └ chunk_index    … その版の中での並び（0起点）
//             └ source_id  … 実際の行
//
// なぜ .mjs なのか:
//   このリポジトリには tsx / vitest / jest が無く、テストは node が直接動かす
//   .mjs だけ。純粋ロジックを素の JS に置いておけば、ビルド無しで
//   tests/shadow.mjs から呼べる。TS 側は allowJs で型を推論して読む。
//
// ここに本番の検索・RAG・AI回答のロジックは持ち込まない。Shadow Mode は
// いずれ捨てる可能性があるため、本番と共通化しない。

/**
 * @typedef {Object} ShadowRow
 * @property {string} source_type
 * @property {string|null} [canonical_document_id]
 * @property {string|null} [source_document_id]
 * @property {number|null} [chunk_index]
 * @property {string|null} [ingest_scheme]
 * @property {string|null} [title]
 * @property {string|null} [organization]
 * @property {string|null} [event_date]
 */

/**
 * 複合キーの区切り。lib/organizations.ts の documentKey() と同じ記号を使う。
 * ID に現れない文字であることが条件（source_document_id には URL も入る）。
 */
const KEY_SEP = "␟";

/** 値が空（null / undefined / 空文字）か。0 は空ではない。 */
function isBlank(v) {
  return v === null || v === undefined || v === "";
}

/**
 * source_type ごとに chunk 数・canonical 数・取り込み文書数を数える。
 * null の鍵は「数えない」（欠損は countNulls 側で別に報告する）。
 *
 * @param {ShadowRow[]} rows
 * @returns {{chunks:number, canonicalDocuments:number, sourceDocuments:number,
 *            bySourceType:{sourceType:string, chunks:number,
 *                          canonicalDocuments:number, sourceDocuments:number}[]}}
 */
export function summarizeShadow(rows) {
  const allCanonical = new Set();
  const allSource = new Set();
  /** @type {Map<string, {chunks:number, canonical:Set<string>, source:Set<string>}>} */
  const byType = new Map();

  for (const r of rows) {
    const t = r.source_type ?? "(不明)";
    let bucket = byType.get(t);
    if (!bucket) {
      bucket = { chunks: 0, canonical: new Set(), source: new Set() };
      byType.set(t, bucket);
    }
    bucket.chunks += 1;
    if (!isBlank(r.canonical_document_id)) {
      bucket.canonical.add(r.canonical_document_id);
      allCanonical.add(r.canonical_document_id);
    }
    if (!isBlank(r.source_document_id)) {
      bucket.source.add(r.source_document_id);
      allSource.add(r.source_document_id);
    }
  }

  const bySourceType = [...byType.entries()]
    .map(([sourceType, b]) => ({
      sourceType,
      chunks: b.chunks,
      canonicalDocuments: b.canonical.size,
      sourceDocuments: b.source.size,
    }))
    .sort((a, b) => b.chunks - a.chunks);

  return {
    chunks: rows.length,
    canonicalDocuments: allCanonical.size,
    sourceDocuments: allSource.size,
    bySourceType,
  };
}

/**
 * 1つの実体に複数の取り込み文書がぶら下がっているものを拾う。
 * これは「重複」でも「削除対象」でもない。**別version**として見せるためのもの。
 *
 * @param {ShadowRow[]} rows
 * @returns {{canonicalDocumentId:string, variantCount:number, chunks:number,
 *            variants:{sourceDocumentId:string, sourceType:string, title:string|null,
 *                      organization:string|null, eventDate:string|null, chunks:number}[]}[]}
 */
export function findMultiVariantCanonicals(rows) {
  /** @type {Map<string, Map<string, {sourceType:string, title:string|null, organization:string|null, eventDate:string|null, chunks:number}>>} */
  const byCanonical = new Map();

  for (const r of rows) {
    if (isBlank(r.canonical_document_id) || isBlank(r.source_document_id)) continue;
    let variants = byCanonical.get(r.canonical_document_id);
    if (!variants) {
      variants = new Map();
      byCanonical.set(r.canonical_document_id, variants);
    }
    const seen = variants.get(r.source_document_id);
    if (seen) {
      seen.chunks += 1;
    } else {
      variants.set(r.source_document_id, {
        sourceType: r.source_type ?? "(不明)",
        title: r.title ?? null,
        organization: r.organization ?? null,
        eventDate: r.event_date ?? null,
        chunks: 1,
      });
    }
  }

  const out = [];
  for (const [canonicalDocumentId, variants] of byCanonical) {
    if (variants.size < 2) continue;
    const list = [...variants.entries()]
      .map(([sourceDocumentId, v]) => ({ sourceDocumentId, ...v }))
      .sort((a, b) => a.sourceDocumentId.localeCompare(b.sourceDocumentId));
    out.push({
      canonicalDocumentId,
      variantCount: list.length,
      chunks: list.reduce((n, v) => n + v.chunks, 0),
      variants: list,
    });
  }
  return out.sort((a, b) => b.variantCount - a.variantCount ||
    a.canonicalDocumentId.localeCompare(b.canonicalDocumentId));
}

/**
 * 新4列の健康チェック。期待値をハードコードせず、渡された行から実際に数える。
 *
 * collisions … 同じ取り込み文書の中で chunk_index が重複している（あってはならない）
 * variantsSpanningCanonicals … 1つの取り込み文書が複数の実体にまたがっている
 *                              （親子関係が壊れている合図。あってはならない）
 *
 * canonical 側の衝突は**異常ではない**ので、ここでは数えるだけで警告にしない。
 * 別versionが同じ番号で並ぶのが設計どおりの姿。
 *
 * @param {ShadowRow[]} rows
 */
export function auditShadowColumns(rows) {
  let canonicalNull = 0;
  let sourceDocumentNull = 0;
  let chunkIndexNull = 0;
  let ingestSchemeNull = 0;

  /** @type {Map<string, number>} */
  const perSourceIndex = new Map();
  /** @type {Map<string, Set<string>>} */
  const canonicalsPerSource = new Map();
  /** @type {Map<string, number>} */
  const perCanonicalIndex = new Map();

  for (const r of rows) {
    if (isBlank(r.canonical_document_id)) canonicalNull += 1;
    if (isBlank(r.source_document_id)) sourceDocumentNull += 1;
    if (r.chunk_index === null || r.chunk_index === undefined) chunkIndexNull += 1;
    if (isBlank(r.ingest_scheme)) ingestSchemeNull += 1;

    if (!isBlank(r.source_document_id) && r.chunk_index !== null && r.chunk_index !== undefined) {
      const k = `${r.source_document_id}${KEY_SEP}${r.chunk_index}`;
      perSourceIndex.set(k, (perSourceIndex.get(k) ?? 0) + 1);
    }
    if (!isBlank(r.canonical_document_id) && r.chunk_index !== null && r.chunk_index !== undefined) {
      const k = `${r.canonical_document_id}${KEY_SEP}${r.chunk_index}`;
      perCanonicalIndex.set(k, (perCanonicalIndex.get(k) ?? 0) + 1);
    }
    if (!isBlank(r.source_document_id) && !isBlank(r.canonical_document_id)) {
      let set = canonicalsPerSource.get(r.source_document_id);
      if (!set) {
        set = new Set();
        canonicalsPerSource.set(r.source_document_id, set);
      }
      set.add(r.canonical_document_id);
    }
  }

  const collisions = [];
  for (const [k, n] of perSourceIndex) {
    if (n > 1) {
      const [sourceDocumentId, idx] = k.split(KEY_SEP);
      collisions.push({ sourceDocumentId, chunkIndex: Number(idx), rows: n });
    }
  }
  collisions.sort((a, b) => b.rows - a.rows || a.sourceDocumentId.localeCompare(b.sourceDocumentId));

  const spanning = [];
  for (const [sourceDocumentId, set] of canonicalsPerSource) {
    if (set.size > 1) {
      spanning.push({ sourceDocumentId, canonicalDocumentIds: [...set].sort() });
    }
  }
  spanning.sort((a, b) => a.sourceDocumentId.localeCompare(b.sourceDocumentId));

  let canonicalIndexCollisions = 0;
  for (const n of perCanonicalIndex.values()) if (n > 1) canonicalIndexCollisions += 1;

  return {
    canonicalNull,
    sourceDocumentNull,
    chunkIndexNull,
    ingestSchemeNull,
    collisions,
    variantsSpanningCanonicals: spanning,
    // 参考値。異常ではない（別versionが同じ番号で並ぶのは設計どおり）
    canonicalIndexCollisions,
    healthy:
      canonicalNull === 0 &&
      sourceDocumentNull === 0 &&
      chunkIndexNull === 0 &&
      ingestSchemeNull === 0 &&
      collisions.length === 0 &&
      spanning.length === 0,
  };
}

/**
 * 旧方式の文書数（呼び出し側が本番ロジックで数えたもの）と、新方式を突き合わせる。
 * 差分は「エラー」ではない。数字だけ並べ、意味づけは呼び出し側に任せる。
 *
 * @param {{sourceType:string, chunks:number, canonicalDocuments:number, sourceDocuments:number}[]} shadowRows
 * @param {Record<string, number>} oldCounts  source_type -> 旧方式の文書数
 */
export function compareWithOld(shadowRows, oldCounts) {
  return shadowRows.map((r) => {
    const old = oldCounts[r.sourceType];
    const known = typeof old === "number";
    return {
      ...r,
      oldDocuments: known ? old : null,
      diff: known ? r.canonicalDocuments - old : null,
    };
  });
}

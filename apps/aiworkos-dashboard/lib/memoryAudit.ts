// 記憶（memory_chunks）の健康診断。読むだけで、直さない。
//
// ■ なぜ要るか
// この記憶層は「1件の文書が複数のチャンク行に分かれて入る」形だが、
// **chunk_index に相当する列が無い**。何番目のチャンクかは
//   ・title の末尾（｜1/16 や ｜text1）
//   ・metadata.位置（"1/16" や "text1" や "slide3"）
//   ・source_id の末尾
// のどれかに、書き込む側ごとにバラバラな書式で入っている。
// そのため「チャンク数」と「文書数」を取り違える事故が起きやすい
// （実際 org-history が1会議26チャンクを26会議と数えていた）。
// ここはその取り違えが今どれだけ起きているかを、事実として並べる。
//
// ■ やらないこと
// 修正・名寄せ・削除・再Embedding・migration はしない。
// 表記揺れも「候補」として出すだけで、機械的に統合しない
// （「横浜市」と「横浜市・相模原市」は別物かもしれない）。

import { documentKey, hasChunkSuffix, stripChunkSuffix } from "./organizations";
import {
  summarizeShadow,
  findMultiVariantCanonicals,
  auditShadowColumns,
  compareWithOld,
} from "./memoryShadow.mjs";

/**
 * 監査が metadata から読むキー。**ここに無いキーは取得していない。**
 *
 * 型が union なので、これ以外のキーを meta() に渡すと tsc が落ちる
 * （`npm run test:all` の1段目）。キーを増やすときは、この配列と
 * AUDIT_SELECT の両方を直さないとコンパイルが通らない作りにしてある。
 */
const AUDIT_META_KEYS = ["位置", "資料名", "PLAUD_ID", "plaud_id"] as const;
type AuditMetaKey = (typeof AUDIT_META_KEYS)[number];

/** metadata のキー → PostgREST で付ける別名（ASCIIでないと別名に使えない）。 */
const META_FIELD = {
  位置: "meta_pos",
  資料名: "meta_shiryo",
  // ★録音IDは大文字と小文字の2表記が実在する（両方を持つ行は無い）。
  //   2026-08-28時点で PLAUD_ID が50行、plaud_id が70行。片方しか見ないと
  //   70行が検査対象から丸ごと外れる。
  PLAUD_ID: "meta_plaud_id",
  plaud_id: "meta_plaud_id_lower",
} as const satisfies Record<AuditMetaKey, string>;

/**
 * 監査に使う列。content と embedding は重いので取らない。
 *
 * ■ metadata を丸ごと取らない理由（2026-08-28）
 * 1458行の取得のうち **metadata だけで1.7MB＝全体の75%** を占めていた
 * （content の457KBより3.8倍重い）。しかし監査が実際に読むのは
 * 位置 / 資料名 / PLAUD_ID の3キーだけ。DB側で必要な値だけ取り出すと
 * 2,218KB→604KB、11.1秒→1.3秒になる（実測）。機能は1つも削っていない。
 * この経路はスモークの8秒判定に常時ぶつかっており、行が増えるほど悪化する。
 *
 * ■ 2026-08-28の migration で入った同一性の4列も取る
 * Shadow Mode（新方式の数え方を旧方式の横に並べるだけの機能）がこれを読む。
 * **本番の検索・RAG・AI回答はこの4列をまだ一切使っていない。**
 */
export const AUDIT_SELECT =
  "source_type,source_id,organization,title,event_date," +
  "canonical_document_id,source_document_id,chunk_index,ingest_scheme," +
  `${META_FIELD.位置}:metadata->>位置,` +
  `${META_FIELD.資料名}:metadata->>資料名,` +
  `${META_FIELD.PLAUD_ID}:metadata->>PLAUD_ID,` +
  `${META_FIELD.plaud_id}:metadata->>plaud_id`;

export type AuditRow = {
  source_type: string;
  source_id: string | null;
  organization: string | null;
  title: string;
  event_date: string | null;
  /** ↓ 2026-08-28 の migration で入った4列。旧データを読む経路もあるので任意扱い。 */
  canonical_document_id?: string | null;
  source_document_id?: string | null;
  chunk_index?: number | null;
  ingest_scheme?: string | null;
  /** ↓ metadata から必要な3キーだけを取り出したもの。丸ごとは運ばない。 */
  meta_pos?: string | null;
  meta_shiryo?: string | null;
  meta_plaud_id?: string | null;
  meta_plaud_id_lower?: string | null;
};

/** 事実として確定している不整合。 */
export type Confirmed = {
  key: string;
  label: string;
  count: number;
  detail: string;
  /** 代表例。何が起きているか目で見て分かるように。 */
  samples: string[];
};

/** 人の判断が要る「候補」。ここから先は勝手に決めない。 */
export type Candidate = {
  key: string;
  label: string;
  count: number;
  detail: string;
  samples: string[];
};

/**
 * Memory 2.0 Shadow。新方式（canonical / source_document / chunk_index）で
 * 数え直した結果を、旧方式の横に並べるだけのもの。**置き換えではない。**
 *
 * 差分は「エラー」ではない。旧方式が過剰に統合していた分も、新方式が
 * 実体として束ねた分も、どちらも差として出る。意味づけは人がする。
 */
export type ShadowSummary = {
  chunks: number;
  canonicalDocuments: number;
  sourceDocuments: number;
  bySourceType: Array<{
    sourceType: string;
    chunks: number;
    canonicalDocuments: number;
    sourceDocuments: number;
    /** 旧方式（documentKey＝親タイトル＋日付＋団体）の文書数 */
    oldDocuments: number | null;
    diff: number | null;
  }>;
  /** 1つの実体に複数の取り込み文書がある組。「重複」ではなく別version。 */
  multiVariant: Array<{
    canonicalDocumentId: string;
    variantCount: number;
    chunks: number;
    variants: Array<{
      sourceDocumentId: string;
      sourceType: string;
      title: string | null;
      organization: string | null;
      eventDate: string | null;
      chunks: number;
    }>;
  }>;
  health: {
    canonicalNull: number;
    sourceDocumentNull: number;
    chunkIndexNull: number;
    ingestSchemeNull: number;
    collisions: Array<{ sourceDocumentId: string; chunkIndex: number; rows: number }>;
    variantsSpanningCanonicals: Array<{
      sourceDocumentId: string;
      canonicalDocumentIds: string[];
    }>;
    /** 実体で見たときの同番。設計どおりなので異常ではない（参考値）。 */
    canonicalIndexCollisions: number;
    healthy: boolean;
  };
};

export type AuditResult = {
  total: number;
  /** 取得上限に当たったか。当たっていたら数字は「以上」の意味になる。 */
  truncated: boolean;
  bySourceType: Array<{
    source_type: string;
    chunks: number;
    docs: number;
    org_null: number;
    pos_missing: number;
  }>;
  confirmed: Confirmed[];
  candidates: Candidate[];
  heavyDocs: Array<{ doc: string; source_type: string; date: string | null; chunks: number }>;
  shadow: ShadowSummary;
};

/**
 * metadata の値を読む。**AUDIT_SELECT が取っているキーしか読めない。**
 *
 * ■ 静かに null で通ることを防ぐ二重の仕掛け
 * ① 型：`AuditMetaKey` 以外を渡すと tsc が落ちる（キーの打ち間違い・新キーの追加漏れ）
 * ② 実行時：AUDIT_SELECT に足し忘れて列そのものが返っていない場合、
 *    その項目は `undefined` になる（キーが無いだけなら PostgREST は null を返すので、
 *    「取得していない」と「値が無い」を区別できる）。開発とテストでは例外にして
 *    気づかせ、本番では画面を落とさずログに出して null を返す。
 *
 * 監査が「0件」と出したとき、それが本当に0件なのか取り忘れなのかを
 * 分からなくしないための作り。
 */
function meta(r: AuditRow, key: AuditMetaKey): string | null {
  const v = r[META_FIELD[key]];
  if (v === undefined) {
    const msg = `AUDIT_SELECT が metadata.${key} を取得していません（${META_FIELD[key]} が応答に無い）`;
    if (process.env.NODE_ENV !== "production") throw new Error(msg);
    console.error(msg);
    return null;
  }
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * 文書としての識別子。
 *
 * 2026-08-28に本番の集計側（lib/organizations.ts の documentKey）を直したので、
 * 監査もそこを読む。監査だけ別の束ね方を持つと、画面に出す「文書数」と
 * 実際の集計がずれ、どちらが本当か分からなくなる。
 */
function docKey(r: AuditRow): string {
  return documentKey(r);
}

/**
 * source_id を「取り込み経路の系統」に落とす。
 *
 * ■ なぜ末尾のチャンク番号を剥がす方式をやめたか（2026-08-28）
 * 以前は source_id からチャンク番号を削って「同じ文書を指す素性」を作り、
 * それが複数あれば二重登録として挙げていた。しかしチャンク番号の書式は
 * 経路ごとに違い（下表）、1つでも剥がし漏れると正常なデータが二重登録に化ける。
 * 実際 `#N` の漏れで109件、`p2-1` の漏れで1件の誤検知を出した。
 * 剥がし忘れを増やし続ける作りなので、発想を変えて「系統」だけを見る。
 *
 * ■ 実データとコードの両方で確認した、チャンク番号の書式
 *   text{n}      lib/parseDeliverable.ts windowChunks の既定接頭辞
 *   slide{n}     同 parsePptx
 *   p{i}         同 parsePdf（短いページ）
 *   p{i}-{n}     同 parsePdf（800字超のページをさらに窓分割）★これの漏れが今回の誤検知
 *   img{n}       app/api/deliverables/image/route.ts
 *   {n}          weekly_report / meeting / weapon / refine / qa などの連番
 *   #{n}         2026-08-17の復元スクリプト（doc_key に #2 を足す形）
 *
 * ■ 系統で見ると何が良いか
 * 「同じ経路の中で鍵が違う」のは別レコード（週報が同じ週に複数行あるのは正常）。
 * 「経路をまたいで同じ文書がある」のだけが二重登録の疑い。チャンク番号を
 * 剥がす必要が無くなるので、書式が増えても壊れない。
 */
function ingestScheme(sid: string): string {
  if (/^https?:\/\//.test(sid)) return "Notion URL";
  // 復元スクリプトが持ち込んだPLAUDの生ハッシュ（接頭辞なし32桁）。
  if (/^[0-9a-f]{32}$/.test(sid)) return "PLAUDハッシュ";
  const i = sid.indexOf(":");
  return i > 0 ? sid.slice(0, i) : "その他";
}

function count<T>(rows: T[], f: (r: T) => boolean): number {
  return rows.filter(f).length;
}

export function auditMemory(rows: AuditRow[], limit: number): AuditResult {
  const truncated = rows.length >= limit;

  // ── source_type 別 ────────────────────────────────────
  const types = [...new Set(rows.map((r) => r.source_type))];
  const bySourceType = types
    .map((t) => {
      const rs = rows.filter((r) => r.source_type === t);
      return {
        source_type: t,
        chunks: rs.length,
        docs: new Set(rs.map(docKey)).size,
        org_null: count(rs, (r) => !r.organization || r.organization.trim() === ""),
        pos_missing: count(rs, (r) => meta(r, "位置") === null),
      };
    })
    .sort((a, b) => b.chunks - a.chunks);

  const confirmed: Confirmed[] = [];
  const candidates: Candidate[] = [];

  // ── 確定①：source_id が無い ──────────────────────────
  const noSid = rows.filter((r) => !r.source_id || r.source_id.trim() === "");
  if (noSid.length > 0) {
    confirmed.push({
      key: "source_id_missing",
      label: "source_id が空",
      count: noSid.length,
      detail: "source_id はupsertの鍵。空だと同じものを入れ直すたびに増える",
      samples: noSid.slice(0, 3).map((r) => `${r.source_type}｜${r.title.slice(0, 40)}`),
    });
  }

  // ── 確定②：同じ source_id が複数行 ───────────────────
  const sidCount = new Map<string, number>();
  for (const r of rows) {
    if (!r.source_id) continue;
    sidCount.set(r.source_id, (sidCount.get(r.source_id) ?? 0) + 1);
  }
  const dupSid = [...sidCount.entries()].filter(([, n]) => n > 1);
  if (dupSid.length > 0) {
    confirmed.push({
      key: "source_id_duplicated",
      label: "同じ source_id が複数行ある",
      count: dupSid.length,
      detail: "upsertの鍵が重複している。片方だけ更新され、もう片方が古いまま残る",
      samples: dupSid.slice(0, 3).map(([sid, n]) => `${sid.slice(0, 50)}（${n}行）`),
    });
  }

  // ── 確定③：チャンク接尾辞を落とし切れなかったタイトル ──
  //
  // stripChunkSuffix は既知の形式を繰り返し落とすが、積み過ぎ（5段以上）や
  // 全部消えて空になる場合は途中で止めて元を返す。その取りこぼしだけを拾う。
  //
  // ★「数字で終わるタイトル」を疑ってはいけない。日付で終わる正当なタイトル
  //   （…｜武器｜想定ストーリー｜2026-07-17）まで拾ってしまい、実際121件の
  //   誤検知を出した（2026-08-28、実装中に発覚）。落とし切れたかどうかだけを見る。
  const stillChunked = rows.filter((r) => hasChunkSuffix(stripChunkSuffix(r.title)));
  if (stillChunked.length > 0) {
    confirmed.push({
      key: "title_suffix_unstrippable",
      label: "チャンク接尾辞を落とし切れていない",
      count: stillChunked.length,
      detail:
        "接尾辞が想定より深く積まれている可能性がある。実データを見て確認すること" +
        "（推測で広く消す正規表現にはしない）",
      samples: stillChunked.slice(0, 3).map((r) => r.title.slice(0, 50)),
    });
  }

  // ── 確定④：同じ文書が複数の取り込み経路から入っている ────
  //
  // 同じ経路の中で鍵が違うのは別レコードなので挙げない。実データで確かめた例：
  //   ・週報は同じ週の「全体」に内容の違う行が複数ある（weekly_report:UUID が別々）
  //   ・学びは同じ催しを別のNotionページに2回記録することがある（URLが別々）
  // どちらも正常なデータで、以前はこれを二重登録として誤って挙げていた。
  const schemes = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.source_id) continue;
    const k = docKey(r);
    if (!schemes.has(k)) schemes.set(k, new Set());
    schemes.get(k)!.add(ingestScheme(r.source_id));
  }
  const split = [...schemes.entries()].filter(([, s]) => s.size > 1);
  if (split.length > 0) {
    confirmed.push({
      key: "doc_split_across_sources",
      label: "同じ文書が複数の取り込み経路から入っている",
      count: split.length,
      detail: "同じものを別経路で入れた疑い。どちらが正かは中身を見ないと決められない",
      samples: split.slice(0, 3).map(([k, s]) => `${k.split("␟")[0].slice(0, 30)}（${[...s].join(" + ")}）`),
    });
  }

  // ── 確定⑤：録音IDが別の行の source_id を指している ────
  //
  // タイトルの一致に頼らない、いちばん強い証拠。Notion経由で入った会議は
  // metadata に元の録音IDを持っているので、その録音が別の行としても
  // 存在するなら、同じ録音を2回登録したことがデータ自身から言い切れる。
  //
  // ★大文字 PLAUD_ID と小文字 plaud_id の両方を見る。2026-08-28時点で
  //   大文字50行・小文字70行・両方持つ行は0。大文字だけ見ていた頃は
  //   小文字の70行が検査対象から丸ごと外れていた（当時の実データでは
  //   たまたま検出結果は同じだったが、見ていないこと自体が穴だった）。
  const recordingId = (r: AuditRow): string | null =>
    meta(r, "PLAUD_ID") ?? meta(r, "plaud_id");
  const byId = new Set(rows.map((r) => r.source_id).filter((x): x is string => !!x));
  const plaudDup = rows.filter((r) => {
    const pid = recordingId(r);
    return pid !== null && pid !== r.source_id && byId.has(pid);
  });
  if (plaudDup.length > 0) {
    const recordings = new Set(plaudDup.map(recordingId)).size;
    confirmed.push({
      key: "plaud_id_duplicated",
      label: "同じ録音が複数の行として入っている（PLAUD_IDが一致）",
      count: plaudDup.length,
      detail:
        `${recordings}本の録音について、metadata.PLAUD_ID が別の行の source_id と一致している。` +
        "タイトルの類似ではなくデータ自身が同じ録音だと示すので、上の経路またぎでは" +
        "見つからない組（題も団体も違うのに同じ録音）もここで出る",
      // 団体も出す。同じ録音が別団体で登録されている組があるため。
      samples: plaudDup
        .slice(0, 4)
        .map((r) => `${stripChunkSuffix(r.title).slice(0, 26)}（${r.organization ?? "団体なし"}）`),
    });
  }

  // ── 候補①：organization が空 ─────────────────────────
  const orgNull = count(rows, (r) => !r.organization || r.organization.trim() === "");
  if (orgNull > 0) {
    candidates.push({
      key: "organization_null",
      label: "organization が空",
      count: orgNull,
      detail:
        "団体別の画面は organization の完全一致で引くため、空の行はどの団体からも見えない。" +
        "日記・振り返りのように元々団体に紐づかないものも含むので、全部が異常ではない",
      samples: [...new Set(rows.filter((r) => !r.organization).map((r) => r.source_type))].slice(0, 6),
    });
  }

  // ── 候補②：1つの organization 欄に複数団体が入っている ──
  const multiOrg = [
    ...new Set(
      rows
        .map((r) => r.organization)
        .filter((o): o is string => !!o && /[・,、/／]/.test(o))
    ),
  ];
  if (multiOrg.length > 0) {
    candidates.push({
      key: "organization_multi",
      label: "1つの organization 欄に複数の団体名が入っている",
      count: multiOrg.length,
      detail:
        "団体別の画面は完全一致で引くので、この行はどの団体を選んでも出てこない。" +
        "分割すべきか、そもそも1件の会議だったのかは中身を見ないと決められない",
      samples: multiOrg.slice(0, 5),
    });
  }

  // ── 候補③：表記揺れ（前方一致するペア）──────────────
  // 機械的に統合しない。「横浜市」と「横浜市・相模原市」は別物かもしれない。
  const orgCount = new Map<string, number>();
  for (const r of rows) {
    const o = r.organization?.trim();
    if (!o) continue;
    orgCount.set(o, (orgCount.get(o) ?? 0) + 1);
  }
  const names = [...orgCount.keys()];
  const pairs: string[] = [];
  for (const a of names) {
    for (const b of names) {
      if (a === b || b.length <= a.length) continue;
      if (b.startsWith(a)) pairs.push(`${a}（${orgCount.get(a)}）⊂ ${b}（${orgCount.get(b)}）`);
    }
  }
  if (pairs.length > 0) {
    candidates.push({
      key: "organization_variants",
      label: "表記揺れの候補（片方がもう片方で始まる）",
      count: pairs.length,
      detail: "同じ団体かどうかは人が見て決める。ここでは統合していない",
      samples: pairs.slice(0, 5),
    });
  }

  // ── 候補④：資料名の粒度がバラバラ ────────────────────
  // 「無題」のように、別々の文書が1つの資料名に潰れているもの。
  const byShiryo = new Map<string, { chunks: number; dates: Set<string>; titles: Set<string> }>();
  for (const r of rows) {
    const name = meta(r, "資料名");
    if (!name) continue;
    if (!byShiryo.has(name)) {
      byShiryo.set(name, { chunks: 0, dates: new Set(), titles: new Set() });
    }
    const e = byShiryo.get(name)!;
    e.chunks += 1;
    if (r.event_date) e.dates.add(r.event_date);
    e.titles.add(stripChunkSuffix(r.title));
  }
  const coarse = [...byShiryo.entries()].filter(([, v]) => v.dates.size > 1);
  if (coarse.length > 0) {
    candidates.push({
      key: "shiryo_too_coarse",
      label: "1つの資料名が複数の日付にまたがっている",
      count: coarse.length,
      detail:
        "資料名を文書の識別に使う処理（groupDeliverables）では、別の日の別資料が" +
        "1つにまとまってしまう。「無題」で登録されたものが主な原因",
      samples: coarse
        .sort((a, b) => b[1].chunks - a[1].chunks)
        .slice(0, 4)
        .map(([n, v]) => `${n}（${v.chunks}chunk・${v.dates.size}日付）`),
    });
  }

  // ── チャンクが極端に多い文書 ─────────────────────────
  const docChunks = new Map<string, { source_type: string; date: string | null; n: number }>();
  for (const r of rows) {
    const k = docKey(r);
    const e = docChunks.get(k);
    if (e) e.n += 1;
    else docChunks.set(k, { source_type: r.source_type, date: r.event_date, n: 1 });
  }
  const heavyDocs = [...docChunks.entries()]
    .map(([doc, v]) => ({ doc, source_type: v.source_type, date: v.date, chunks: v.n }))
    .sort((a, b) => b.chunks - a.chunks)
    .slice(0, 8);

  // ── Memory 2.0 Shadow ────────────────────────────────
  //
  // 新方式で数え直して、上で出した旧方式の docs の横に並べる。
  // ここで本番の束ね方（docKey）は一切書き換えない。読むだけ。
  const summary = summarizeShadow(rows);
  const oldCounts: Record<string, number> = {};
  for (const b of bySourceType) oldCounts[b.source_type] = b.docs;
  const shadow: ShadowSummary = {
    chunks: summary.chunks,
    canonicalDocuments: summary.canonicalDocuments,
    sourceDocuments: summary.sourceDocuments,
    bySourceType: compareWithOld(summary.bySourceType, oldCounts),
    multiVariant: findMultiVariantCanonicals(rows),
    health: auditShadowColumns(rows),
  };

  // 新4列が欠けている／版の中で番号がぶつかっている／親子関係が壊れているのは
  // 事実として確定した不整合。0をハードコードせず、実データから数えた結果で判定する。
  if (!shadow.health.healthy) {
    const h = shadow.health;
    const parts = [
      h.canonicalNull > 0 ? `canonical未設定 ${h.canonicalNull}行` : null,
      h.sourceDocumentNull > 0 ? `取り込み文書未設定 ${h.sourceDocumentNull}行` : null,
      h.chunkIndexNull > 0 ? `chunk_index未設定 ${h.chunkIndexNull}行` : null,
      h.ingestSchemeNull > 0 ? `ingest_scheme未設定 ${h.ingestSchemeNull}行` : null,
      h.collisions.length > 0 ? `版の中でchunk_indexが衝突 ${h.collisions.length}組` : null,
      h.variantsSpanningCanonicals.length > 0
        ? `実体をまたぐ取り込み文書 ${h.variantsSpanningCanonicals.length}件`
        : null,
    ].filter((s): s is string => s !== null);
    confirmed.push({
      key: "shadow_columns_unhealthy",
      label: "Memory 2.0 の同一性の列が壊れている",
      count: parts.length,
      detail:
        "2026-08-28のmigrationで入れた4列に欠損か衝突がある。" +
        "取り込み処理が新しい列を埋めずに書いた可能性がある（現時点では埋める実装は未着手）",
      samples: parts.slice(0, 4),
    });
  }

  return {
    total: rows.length,
    truncated,
    bySourceType,
    confirmed,
    candidates,
    heavyDocs,
    shadow,
  };
}

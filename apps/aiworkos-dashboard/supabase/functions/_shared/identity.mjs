// memory_chunks の同一性（Identity）を決める純粋関数。**実装はここ1本だけ。**
//
// ■ なぜ supabase/functions/_shared に置くか
//   同じ規則を Edge Function（Deno）とアプリ・テスト（Node）の両方から使う。
//   二重実装にすると、片方だけ直したときに既存データと新規データで
//   別の同一性が生まれる——この案件でいちばん避けたい事故がそれ。
//   `_shared/` は Supabase Edge Functions が関数と一緒に配る標準の置き場なので、
//   Deno からは `../_shared/identity.mjs`、Node からは lib/memoryIdentity.mjs
//   （このファイルを再輸出するだけの薄い層）経由で、同じ1本を読む。
//   Deno / Node のAPIは一切使わない。素のJSだけで書く。
//
// ■ これが与えるもの
//   2026-08-28 の migration（scripts/memory_chunks_canonical_v2.sql）が
//   既存1458行に与えたのと同じ4列を、1行ぶんの入力から計算する。
//   本番1458行との突き合わせで完全一致（差分ゼロ）を確認済み。
//
// ■ 決めるのは Gateway 側
//   canonical / source_document / ingest_scheme は caller に決めさせない。
//   caller から受け取るのは「Gateway 単独では原理的に決められないもの」だけ——
//   いまのところ deliverable の chunk_index ただ1つ。
//
// ■ 同一性に使わないもの
//   title / event_date / organization は入力に取らない。
//   団体名を鍵に入れると、団体名を直しただけで別物になる（第4.1弾で実害を確認）。
//   title も第7.2弾の実測で「有無による結果差 0/1458」だったので引数から外した。
//   使わないことを規約でなく**関数の形**で保証する。

/**
 * @typedef {Object} IdentityInput
 * @property {string} [source_type]        監査・分類の参考。**同一性には使わない**
 * @property {string|null} [source_id]     行の識別子。同一性の主な材料
 * @property {Record<string, unknown>|null} [metadata]
 * @property {number|null} [chunkIndex]    caller が持っている0起点の番号（任意）
 */

/**
 * @typedef {Object} Identity
 * @property {string|null} canonical_document_id
 * @property {string|null} source_document_id
 * @property {number|null} chunk_index
 * @property {string|null} ingest_scheme
 * @property {boolean} needsCallerChunkIndex  caller の番号が無いと確定できないか
 * @property {string|null} reason             決められなかった理由（呼び出し側のエラー文言用）
 */

const HEX32 = /^[0-9a-f]{32}$/;
const INTERNAL_PREFIX = /^(weekly_report|retrospective|refine|slide-refine|procedure-refine):/;
const CATALOG_PREFIX = /^(qa|weapon|gakkai|metrics):/;
const MONTHLY_PREFIX = "monthly_briefing:";

/** 末尾の `:N` を落とす経路。ここに無い経路では落とさない（ファイル名末尾の誤爆防止）。 */
const STRIPS_TRAILING_NUMBER = new Set(["meeting", "internal", "catalog", "monthly"]);

/** metadata から文字列を取り出す。空文字は無いものとして扱う。 */
function metaStr(metadata, key) {
  const v = metadata?.[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * 録音ID。**大文字と小文字の2表記が実在する**（2026-08-28時点で PLAUD_ID 50行 /
 * plaud_id 70行 / 両方持つ行は0）。片方だけ見ると70行が丸ごと素通りする。
 * 小文字 plaud_id は plaud-meeting-daily-sync スキルが書いている。
 */
function recordingId(metadata) {
  const v = metaStr(metadata, "PLAUD_ID") ?? metaStr(metadata, "plaud_id");
  return v ? v.toLowerCase() : null;
}

/** どの規則で canonical を決めるか。経路を7つに畳んだもの。 */
function schemeOf(sid, hasRecordingId) {
  if (hasRecordingId || sid.startsWith("plaud:") || HEX32.test(sid)) return "plaud";
  if (/^https?:\/\//.test(sid)) return "notion";
  if (sid.startsWith("meeting:")) return "meeting";
  if (sid.startsWith("deliverable:")) return "deliverable";
  if (INTERNAL_PREFIX.test(sid)) return "internal";
  if (CATALOG_PREFIX.test(sid)) return "catalog";
  if (sid.startsWith(MONTHLY_PREFIX)) return "monthly";
  return null;
}

/**
 * 取り込み文書＝版のID。source_id から「チャンクを指す部分」だけを落とす。
 *
 * deliverable だけ正規表現を使わない。ファイル名にコロンや数字が入る実データが
 * あり（`deliverable:ソフトバンク:text:無題:2026-08-26:text10`）、正規表現だと
 * 削り過ぎる。metadata.位置 の値そのものと突き合わせて外す。
 */
function sourceDocumentOf(scheme, sid, pos) {
  if (scheme === "deliverable") {
    if (pos !== null && sid.endsWith(`:${pos}`)) return sid.slice(0, sid.length - pos.length - 1);
    return sid;
  }
  if (STRIPS_TRAILING_NUMBER.has(scheme)) return sid.replace(/:[0-9]+$/, "");
  return sid;
}

/** 実体ID。版のキーに、録音ID / Notionページ ID による束ね方だけを重ねる。 */
function canonicalOf(scheme, sid, rec, sdid) {
  if (scheme === "plaud") {
    const fromSid = sid.startsWith("plaud:") ? sid.split(":")[1] || "" : "";
    const bare = HEX32.test(sid) ? sid : "";
    const id = rec ?? (fromSid ? fromSid.toLowerCase() : null) ?? (bare ? bare.toLowerCase() : null);
    return id ? `plaud:${id}` : null;
  }
  if (scheme === "notion") {
    const m = sid.match(/([0-9a-f]{32})$/);
    return m ? `notion:${m[1].toLowerCase()}` : null;
  }
  return sdid;
}

/** 1起点で書かれている番号を拾う。見つからなければ null。 */
function explicitNumber(sourceId, sid, pos, scheme) {
  // ① 2026-08-17の復元スクリプトが付けた #N
  const hash = sourceId.match(/#([0-9]+)$/);
  if (hash) return Number(hash[1]);

  // ② metadata.位置 が `i/n` 形式（会議147行ほか計232行）。分子が番号。
  if (pos) {
    const p = pos.match(/^([0-9]+)\/[0-9]+$/);
    if (p) return Number(p[1]);
  }

  // ③ source_id 末尾の :N。ファイル名末尾を誤って拾わないよう経路を限定する。
  if (STRIPS_TRAILING_NUMBER.has(scheme)) {
    const s = sid.match(/:([0-9]+)$/);
    if (s) return Number(s[1]);
  }
  return null;
}

/** 決められなかったときの戻り値。**null のまま成功にしないための土台。** */
function undecided(reason) {
  return {
    canonical_document_id: null,
    source_document_id: null,
    chunk_index: null,
    ingest_scheme: null,
    needsCallerChunkIndex: false,
    reason,
  };
}

/**
 * 1行ぶんの Identity を決める。
 *
 * chunk_index の決め方には順序がある。**明示的に書かれている番号を最優先**にし、
 * caller の値はそれが1つも無いときだけ使う。Gateway が自分で決められることを
 * caller に上書きさせないため。
 *
 * どれも無ければ 0 に固定する。**通し番号で埋めない。** 別版どうしが 0,1 と
 * 並んで衝突が消えて見えるため（第4.1弾で踏んだ罠）。
 *
 * @param {IdentityInput} input
 * @returns {Identity}
 */
export function deriveIdentity(input) {
  const sourceId = typeof input?.source_id === "string" ? input.source_id.trim() : "";
  const metadata = input?.metadata ?? null;
  const pos = metaStr(metadata, "位置");
  const rec = recordingId(metadata);

  if (sourceId === "") return undecided("source_id が空です");

  const sid = sourceId.replace(/#[0-9]+$/, "");
  const scheme = schemeOf(sid, rec !== null);

  // 7分類のどれにも当たらない形。ここを黙って埋めない——埋めると
  // 「知らない書式の writer が増えた」ことに気づけなくなる。
  if (scheme === null) return undecided(`source_id の書式が未知です: ${sourceId.slice(0, 80)}`);

  const sdid = sourceDocumentOf(scheme, sid, pos);
  const canonical = canonicalOf(scheme, sid, rec, sdid);
  if (!canonical || !sdid) return undecided(`実体IDを組み立てられません: ${sourceId.slice(0, 80)}`);

  const n = explicitNumber(sourceId, sid, pos, scheme);
  const caller =
    typeof input?.chunkIndex === "number" &&
    Number.isInteger(input.chunkIndex) &&
    input.chunkIndex >= 0
      ? input.chunkIndex
      : null;

  let chunkIndex;
  if (n !== null) chunkIndex = n - 1;
  else if (caller !== null) chunkIndex = caller;
  else chunkIndex = 0;

  return {
    canonical_document_id: canonical,
    source_document_id: sdid,
    chunk_index: chunkIndex,
    ingest_scheme: scheme,
    // deliverable の位置は `text1` `p2-1` のような札で、順番はその行だけでは決まらない。
    // 兄弟行を数えるのは同時挿入で競合するので、caller のループ index をもらう。
    needsCallerChunkIndex: scheme === "deliverable" && n === null && caller === null,
    reason: null,
  };
}

/**
 * DB へ書く4列だけを取り出す。INSERT と UPDATE の**両方**でこれを展開する。
 * UPDATE 側に入れ忘れると、入れ直しのたびに古い同一性が残り続ける。
 *
 * @param {Identity} identity
 */
export function identityColumns(identity) {
  return {
    canonical_document_id: identity.canonical_document_id,
    source_document_id: identity.source_document_id,
    chunk_index: identity.chunk_index,
    ingest_scheme: identity.ingest_scheme,
  };
}

/** caller が指定してはいけないキー。Gateway が決めるものを外から上書きさせない。 */
export const CALLER_FORBIDDEN_KEYS = [
  "canonical_document_id",
  "source_document_id",
  "ingest_scheme",
  "embedding",
];

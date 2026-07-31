// PLAUD NotePin の音声文字起こし由来の誤変換を、取り込み時に自動修正するための
// 共通ライブラリ。
//
// 辞書の実体は Supabase の public.transcription_dictionary（2026-07-31時点で118件）。
// 元はGoogle Driveの「_PLAUD誤変換辞書_500語」だったが、全入口から使うには
// Drive APIが重いためSupabaseへ移した。Drive側はもう読まない。
//
// このモジュールの利用者は、各取り込みAPIの「利用者が貼り付けた本文が最初に
// 入ってくる場所」で correctTranscription() を1回だけ呼ぶ。Claudeに渡す前・
// Notionに書く前・Supabaseに書く前のすべてに効かせるため、入口で1回が正解。
//
// 設計方針（重要な順）:
//   1. 辞書が取れなくても取り込み自体は絶対に失敗させない（素通し）。辞書は補助機能。
//   2. 長い語を必ず優先する。「よしいつぐかず→吉井嗣和」と「つぐかず→嗣和」の
//      両方がある状態で短い方が先に当たると「よしい嗣和」という存在しない表記が
//      生まれる。DB側に (length(wrong) DESC) WHERE enabled のインデックスがあるので
//      その順で取得し、マッチングでも各位置で長い候補から試す。
//   3. URL・メールアドレスは置換前に退避する。「LG1→LGWAN」のような短い語が
//      URLやIDに紛れ込むと壊れるため。
//   4. 実際に置換したものだけを件数付きで返す。黙って書き換えない。

import { anonCreds, restHeaders } from "@/lib/supabase";

export type DictRule = { wrong: string; correct: string };

/** 実際に置換が発生した語と、その回数。 */
export type Replacement = { wrong: string; correct: string; count: number };

export type CorrectionResult = {
  /** 置換後のテキスト。辞書が取れなかった場合は入力そのまま。 */
  text: string;
  /** 実際に置換が発生したものだけ。1件も無ければ空配列。 */
  replacements: Replacement[];
  /** 置換の延べ件数（同じ語が2回出たら2）。 */
  total: number;
};

export const EMPTY_CORRECTION: Omit<CorrectionResult, "text"> = {
  replacements: [],
  total: 0,
};

// ============ マッチング候補の構築 ============

type Candidate = {
  /** テキスト中で照合する文字列。 */
  match: string;
  /** 置換後の文字列。null なら「素通し（ガード）」。 */
  replacement: string | null;
};

// 3文字以下のひらがなを辞書から除外する理由:
//   運用方針として「3文字以下のひらがなは辞書に入れない」ことになっているが、
//   2026-07-31 時点の実データには10件（ここみ/まさき/おがわ 等）が残っている。
//   これらは日本語の普通の文の一部に平気で出現する。例えば
//     「ここみたいな話」→「心美たいな話」
//     「いまさきほど」  →「い正木ほど」
//   のように、利用者が書いていない表記を作ってしまう。誤変換を直すはずの機能が
//   本文を壊すのは本末転倒なので、コード側でも保険として弾く。
//   使いたい場合は辞書側で「ここみさん→心美さん」のように語を伸ばせば有効になる。
const HIRAGANA_ONLY = /^[ぁ-ゖゝ-ゟー]+$/;
const MIN_HIRAGANA_LEN = 4;

function isTooShortHiragana(wrong: string): boolean {
  return wrong.length < MIN_HIRAGANA_LEN && HIRAGANA_ONLY.test(wrong);
}

/**
 * 辞書ルールから、単一走査マッチャ用の候補表（先頭文字→候補配列）を作る。
 *
 * ガード候補について:
 *   「法人請求オンライン→法人請求オンラインサービス」のようなルールがあると、
 *   すでに正しい「法人請求オンラインサービス」という入力に対して前方一致で
 *   当たってしまい「法人請求オンラインサービスサービス」になる（冪等性が壊れる）。
 *   そこで、他のルールの wrong を内部に含む correct 値を「素通し候補」として
 *   長い順の先頭側に混ぜ、正しい表記が来たらそこを飛ばす。
 */
export function buildCandidates(rules: DictRule[]): Map<string, Candidate[]> {
  const usable = rules.filter(
    (r) => r.wrong !== "" && r.wrong !== r.correct && !isTooShortHiragana(r.wrong)
  );

  const wrongSet = new Set(usable.map((r) => r.wrong));
  const guards = new Set<string>();
  for (const r of usable) {
    for (const w of wrongSet) {
      // 「correct が w より長く、かつ w を含む」ときだけガードにする。
      // correct 自体が別ルールの wrong と完全一致する場合はガードにしない
      // （そのルールを丸ごと無効化してしまうため。2026-07-31時点では該当なし）。
      if (r.correct.length > w.length && r.correct.includes(w) && !wrongSet.has(r.correct)) {
        guards.add(r.correct);
      }
    }
  }

  const candidates: Candidate[] = [
    ...usable.map((r) => ({ match: r.wrong, replacement: r.correct })),
    ...Array.from(guards).map((g) => ({ match: g, replacement: null })),
  ];

  const index = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const head = c.match[0];
    const bucket = index.get(head);
    if (bucket) bucket.push(c);
    else index.set(head, [c]);
  }
  // ★長い語優先★ 各位置で長い候補から試すため、バケットを長さ降順に並べる。
  // 長さが同じならガードを後ろに回して決定的にする。
  for (const bucket of index.values()) {
    bucket.sort((a, b) => {
      if (b.match.length !== a.match.length) return b.match.length - a.match.length;
      if ((a.replacement === null) !== (b.replacement === null)) {
        return a.replacement === null ? 1 : -1;
      }
      return a.match < b.match ? -1 : 1;
    });
  }
  return index;
}

// ============ URL・メールアドレスの保護 ============
//
// 「LG1→LGWAN」のような短い語がURLのパスやIDに紛れると事故る。日付(2026-07-31)や
// UUIDは辞書に数字だけの語が無いため直接の危険は無いが、URLに含まれる形で
// 巻き込まれうるので、URL・メールアドレスごと退避する。
//
// 退避先の目印には私用領域(U+E000/U+E001)を使う。辞書の語も日本語本文も
// この領域の文字を含まないため、目印自体が置換対象になることはない。
const SENTINEL_OPEN = "\uE000";
const SENTINEL_CLOSE = "\uE001";
const PROTECT_RE =
  /(?:https?:\/\/|www\.)[^\s、。」』）】＞>"'`]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function protect(text: string): { masked: string; slots: string[] } {
  const slots: string[] = [];
  const masked = text.replace(PROTECT_RE, (hit) => {
    const i = slots.push(hit) - 1;
    return `${SENTINEL_OPEN}${i}${SENTINEL_CLOSE}`;
  });
  return { masked, slots };
}

function restore(text: string, slots: string[]): string {
  if (slots.length === 0) return text;
  let out = text;
  for (let i = 0; i < slots.length; i += 1) {
    out = out.split(`${SENTINEL_OPEN}${i}${SENTINEL_CLOSE}`).join(slots[i]);
  }
  return out;
}

// ============ 置換本体（純粋関数・単体テスト対象） ============

/**
 * 辞書を適用する。正規表現は使わない（辞書の語に含まれる記号でパターンが壊れるため）。
 *
 * 実装は左から右への単一走査。各位置で「その位置から始まる最長の候補」に当てて、
 * 置換結果は出力バッファへ書き出し、入力側のカーソルをマッチ長ぶん進める。
 * こうすると
 *   - 長い語が短い語より必ず先に当たる（★最重要要件★）
 *   - この走査の中では置換後の文字列を読み返さないので、1語の置換がその場で
 *     連鎖して暴走することはない
 * の両方が同時に満たせる。
 */
function applyOnce(
  masked: string,
  index: Map<string, Candidate[]>,
  counts: Map<string, Replacement>
): { text: string; changed: number } {
  let out = "";
  let changed = 0;
  let i = 0;
  while (i < masked.length) {
    const bucket = index.get(masked[i]);
    let hit: Candidate | null = null;
    if (bucket) {
      for (const c of bucket) {
        if (masked.startsWith(c.match, i)) {
          hit = c;
          break;
        }
      }
    }
    if (!hit) {
      out += masked[i];
      i += 1;
      continue;
    }
    if (hit.replacement === null) {
      // ガード（すでに正しい表記）はそのまま通す
      out += hit.match;
    } else {
      out += hit.replacement;
      changed += 1;
      const key = `${hit.match} ${hit.replacement}`;
      const prev = counts.get(key);
      if (prev) prev.count += 1;
      else counts.set(key, { wrong: hit.match, correct: hit.replacement, count: 1 });
    }
    i += hit.match.length;
  }
  return { text: out, changed };
}

// 走査を繰り返す上限。実データで必要なのは2回まで
// （「ほうじんせいきゅうオンライン」が1回目で「法人請求オンライン」、
//   2回目で「法人請求オンラインサービス」。3回目はガードが効いて必ず0件）。
// 万一辞書がループするルールを持っても止まるよう、上限を保険として置く。
const MAX_PASSES = 3;

/**
 * 辞書を適用する。走査結果が安定するまで最大3回まわす。
 *
 * 1回で止めるとルールの連鎖が途中で切れ、「同じ本文をもう一度取り込むと結果が
 * 変わる」状態になってしまう。ガード候補があるので、正しい表記に到達したところで
 * 必ず止まる（＝冪等になる）。
 */
export function applyDictionary(text: string, rules: DictRule[]): CorrectionResult {
  if (!text || rules.length === 0) return { text, ...EMPTY_CORRECTION };

  const index = buildCandidates(rules);
  if (index.size === 0) return { text, ...EMPTY_CORRECTION };

  const { masked, slots } = protect(text);

  const counts = new Map<string, Replacement>();
  let current = masked;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const r = applyOnce(current, index, counts);
    current = r.text;
    if (r.changed === 0) break;
  }

  const replacements = Array.from(counts.values()).sort((a, b) => b.count - a.count);
  return {
    text: restore(current, slots),
    replacements,
    total: replacements.reduce((s, r) => s + r.count, 0),
  };
}

// ============ 辞書の取得とプロセス内キャッシュ ============
//
// 取り込みのたびに116件を全件取得すると遅いので、プロセス内で60秒だけ持つ。
// 同時に複数リクエストが来たときに全部がSupabaseを叩かないよう、進行中の
// fetch を共有する（in-flight dedupe）。
// 辞書を直したあと最大60秒は古い辞書が使われるが、辞書更新は日常操作ではないので許容。

const CACHE_TTL_MS = 60_000;

type Cache = { rules: DictRule[]; expiresAt: number };

let cache: Cache | null = null;
let inflight: Promise<DictRule[] | null> | null = null;

async function fetchRules(): Promise<DictRule[] | null> {
  const c = anonCreds();
  if (!c) {
    console.warn("transcriptionDictionary: Supabase未設定のため辞書を適用しません");
    return null;
  }
  try {
    // ★長い語優先★ DBの (length(wrong) DESC) WHERE enabled インデックスの順で取る。
    const res = await fetch(
      `${c.url}/rest/v1/transcription_dictionary` +
        `?select=wrong,correct&enabled=is.true&order=wrong.desc`,
      { headers: restHeaders(c.key), cache: "no-store", signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) {
      console.warn("transcriptionDictionary: 辞書取得失敗", res.status);
      return null;
    }
    const rows: unknown = await res.json();
    if (!Array.isArray(rows)) return null;
    const rules = rows
      .filter(
        (r): r is DictRule =>
          !!r &&
          typeof r === "object" &&
          typeof (r as DictRule).wrong === "string" &&
          typeof (r as DictRule).correct === "string" &&
          (r as DictRule).wrong.trim() !== ""
      )
      .map((r) => ({ wrong: r.wrong, correct: r.correct }))
      // PostgRESTのorderは文字列順なので、長さ降順はここで確定させる。
      .sort((a, b) => b.wrong.length - a.wrong.length);
    return rules;
  } catch (err) {
    console.warn("transcriptionDictionary: 辞書取得でエラー", err);
    return null;
  }
}

/** 辞書を取得する。取得できなければ null（＝置換せず素通し）。 */
export async function loadDictionary(): Promise<DictRule[] | null> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.rules;
  if (inflight) return inflight;

  inflight = fetchRules()
    .then((rules) => {
      if (rules) cache = { rules, expiresAt: Date.now() + CACHE_TTL_MS };
      return rules;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** テスト用。キャッシュを捨てる。 */
export function resetDictionaryCache(): void {
  cache = null;
  inflight = null;
}

/**
 * 取り込み入口用のメインAPI。辞書を読んで置換した結果を返す。
 * 辞書が取れなかった場合は入力をそのまま返す（取り込みを失敗させない）。
 */
export async function correctTranscription(text: string): Promise<CorrectionResult> {
  if (!text) return { text, ...EMPTY_CORRECTION };
  const rules = await loadDictionary();
  if (!rules) return { text, ...EMPTY_CORRECTION };
  return applyDictionary(text, rules);
}

/**
 * 複数の文字列をまとめて置換し、内訳を1つに合算する。
 * 成果物のチャンク配列や、週報の複数フィールドのように「1回の取り込みで
 * 複数の本文がある」ケース用。辞書の取得は1回だけ。
 */
export async function correctTranscriptionMany(
  texts: string[]
): Promise<{ texts: string[]; replacements: Replacement[]; total: number }> {
  const rules = await loadDictionary();
  if (!rules) return { texts, ...EMPTY_CORRECTION };

  const merged = new Map<string, Replacement>();
  const out = texts.map((t) => {
    const r = applyDictionary(t, rules);
    for (const rep of r.replacements) {
      const key = `${rep.wrong} ${rep.correct}`;
      const prev = merged.get(key);
      if (prev) prev.count += rep.count;
      else merged.set(key, { ...rep });
    }
    return r.text;
  });

  const replacements = Array.from(merged.values()).sort((a, b) => b.count - a.count);
  return {
    texts: out,
    replacements,
    total: replacements.reduce((s, r) => s + r.count, 0),
  };
}

/**
 * 画面に出す控えめな一文を作る。実際に置換したものしか載せない。
 * 例: 「3件の表記を自動修正しました（AJEC→エイジェック ほか）」
 */
export function summarizeCorrections(replacements: Replacement[], total: number): string | null {
  if (replacements.length === 0 || total === 0) return null;
  const head = replacements
    .slice(0, 2)
    .map((r) => `${r.wrong}→${r.correct}`)
    .join("、");
  const rest = replacements.length > 2 ? " ほか" : "";
  return `${total}件の表記を自動修正しました（${head}${rest}）`;
}

// 原文(documents)から検索用チャンクを組み立てる。lib/chunks.ts の文字数固定分割の後継。
//
// なぜ作り直したか（2026-08-17の実測にもとづく）:
//   旧方式は400字で機械的に切っていたため、(a)文や単語の途中で切れる、(b)割り切れずに
//   数文字の断片が残る、(c)中扉スライド(「費用」「現状と課題」等)がそのまま1チャンクになる、
//   という3つの問題があった。
//   短いチャンクは埋め込みの座標が定まらず、互いに固まってしまう。実測では2字の「費用」と
//   5字の「現状と課題」の類似度が 0.9894 ＝ ほぼ同義と判定されていた。意味が全く違うのに。
//   その結果、検索のたびに短い断片が上位を占め、本当に読むべき本文を押し出していた。
//   （対照として489字の本文チャンク同士は 0.94〜0.95 で健全にばらけている）
//
// 方針:
//   1. 見出し・段落・文の境界を優先して切る。文の途中では切らない
//   2. MIN_CHARS 未満の断片は前後に合流させ、単独では残さない
//   3. 境界で切るので重なり(overlap)は付けない。原文は documents 側が持つため復元も不要

export const MAX_CHARS = 400; // gte-smallは日本語およそ500字で頭打ち。その内側に収める
export const MIN_CHARS = 80; // これ未満は意味の座標が定まらず、検索のノイズになる

export type Section = { pos?: string | null; text: string };
export type BuiltChunk = { pos: string; content: string };

const HEADING_RE = /^\s{0,3}#{1,6}\s+\S/;

/** 段落（空行区切り）に割る。 */
function toParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** 日本語の文末（。！？）と改行で文に割る。閉じ括弧は文末側に含める。 */
function toSentences(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of text) {
    buf += ch;
    if (/[。！？!?]/.test(ch)) {
      out.push(buf);
      buf = "";
    } else if (ch === "\n" && buf.trim()) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf);
  // 先頭の空白だけ落とし、末尾の改行は残す。s.trim()で両端を削ると、改行を
  // 区切りに使った文からその改行自体が消え、joiner=""で連結する際に2文が
  // くっついてしまう（2026-08-17判明。「本質\n\n【仕事」の空行が消えていた）。
  return out.map((s) => s.replace(/^\s+/, "")).filter((s) => s.trim());
}

/** 見出し行で塊に割る。見出しは直後の本文とセットで1塊にする。 */
function toHeadingBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (HEADING_RE.test(line) && cur.some((l) => l.trim())) {
      blocks.push(cur.join("\n").trim());
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.some((l) => l.trim())) blocks.push(cur.join("\n").trim());
  return blocks.filter(Boolean);
}

/**
 * 単位の配列を塊に詰め直す。
 * MAX_CHARSまで貪欲に詰めると最後に数十字の余りが出て、それが合流もできず
 * （直前が満杯なので）孤立する。そこで先に「何塊に分けるか」を決め、
 * 均等な目安サイズまでで詰めることで、余りが痩せないようにする。
 */
function packUnits(units: string[], joiner: string): string[] {
  if (units.length <= 1) return units.slice();
  const jl = joiner.length;
  const total = units.reduce((a, u) => a + u.length, 0) + jl * (units.length - 1);
  if (total <= MAX_CHARS) return [units.join(joiner)];

  const groups = Math.ceil(total / MAX_CHARS);
  const target = Math.min(MAX_CHARS, Math.ceil(total / groups));

  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    if (!cur) {
      cur = u;
      continue;
    }
    const merged = cur + joiner + u;
    if (merged.length <= MAX_CHARS && cur.length < target) cur = merged;
    else {
      out.push(cur);
      cur = u;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** どうしても長い1文を、読点や空白を狙って強制的に割る（最後の手段）。 */
function hardSplit(text: string): string[] {
  // ここも均等割りにする。MAX_CHARSずつ削ると最後に短い余りが出るため。
  const groups = Math.ceil(text.length / MAX_CHARS);
  const target = Math.ceil(text.length / groups);
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHARS) {
    const window = rest.slice(0, target);
    // 後ろ寄りの読点・空白で切れれば、そこで切る
    const at = Math.max(window.lastIndexOf("、"), window.lastIndexOf("　"), window.lastIndexOf(" "));
    const cut = at > target * 0.6 ? at + 1 : target;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/** 1つのセクション本文を、境界を優先してMAX_CHARS以内の塊に割る。 */
export function splitSection(text: string): string[] {
  const body = text.trim();
  if (!body) return [];
  if (body.length <= MAX_CHARS) return [body];

  const out: string[] = [];
  for (const block of packUnits(toHeadingBlocks(body), "\n\n")) {
    if (block.length <= MAX_CHARS) {
      out.push(block);
      continue;
    }
    for (const para of packUnits(toParagraphs(block), "\n\n")) {
      if (para.length <= MAX_CHARS) {
        out.push(para);
        continue;
      }
      for (const sent of packUnits(toSentences(para), "")) {
        if (sent.length <= MAX_CHARS) out.push(sent);
        else out.push(...hardSplit(sent));
      }
    }
  }
  return out.filter(Boolean);
}

type Piece = { pos: string; content: string; isTail: boolean };

/**
 * 短すぎる塊を前後へ合流させる。
 * - セクションの末尾に出た余り  → 直前へ寄せる（「げ続ける」のような分割の余り）
 * - それ以外（中扉など丸ごと短いセクション） → 直後へ寄せる（「費用」→次の本文と一体化）
 */
function mergeSmall(pieces: Piece[]): Piece[] {
  const out = pieces.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const p = out[i];
      if (p.content.length >= MIN_CHARS || out.length === 1) continue;
      const prev = out[i - 1];
      const next = out[i + 1];
      const canPrev = prev && prev.content.length + p.content.length + 1 <= MAX_CHARS;
      const canNext = next && next.content.length + p.content.length + 1 <= MAX_CHARS;
      const order = p.isTail ? [canPrev && "prev", canNext && "next"] : [canNext && "next", canPrev && "prev"];
      const pick = order.find(Boolean);
      if (pick === "prev") {
        prev.content = `${prev.content}\n${p.content}`;
        prev.isTail = p.isTail;
        out.splice(i, 1);
      } else if (pick === "next") {
        next.content = `${p.content}\n${next.content}`;
        out.splice(i, 1);
      } else continue;
      changed = true;
      break;
    }
  }
  return out;
}

/**
 * 文書（セクションの並び）からチャンクを組み立てる。
 * セクション境界＝スライドや章の切れ目を最優先の切れ目として扱う。
 */
export function buildChunks(sections: Section[]): BuiltChunk[] {
  const pieces: Piece[] = [];
  for (const [si, sec] of sections.entries()) {
    const parts = splitSection(sec.text || "");
    const base = sec.pos || `s${si + 1}`;
    parts.forEach((content, i) => {
      pieces.push({
        pos: parts.length === 1 ? base : `${base}-${i + 1}`,
        content,
        isTail: i === parts.length - 1,
      });
    });
  }
  return mergeSmall(pieces).map((p) => ({ pos: p.pos, content: p.content }));
}

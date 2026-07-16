// 成果物ファイル(pptx/docx)をブラウザ側で解析し、テキストチャンクを抽出する。
// pptx/docx は OOXML = zip なので JSZip で解凍し、テキストラン(<a:t>/<w:t>)を取り出す。
// ブラウザでもNode でも同じ JSZip で動くため、抽出ロジックは手元でも検証できる。
import JSZip from "jszip";

export type Chunk = { pos: string; content: string };

// フッター(社名・ページ番号)や空行を除いてノイズを減らす（ingest.py と同じ方針）。
const FOOTER_RE = /^(FUJIFILM System Services Corp\.?|[0-9]{1,3})$/;

function cleanLines(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !FOOTER_RE.test(l))
    .join("\n");
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function matchAll(xml: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(decodeXml(m[1]));
  return out;
}

// 長文を文字数ウィンドウで分割(日本語想定・gte-small ~512tok に収める)。
export function windowChunks(
  text: string,
  prefix: string,
  size = 800,
  overlap = 100
): Chunk[] {
  const t = text.trim();
  if (!t) return [];
  const chunks: Chunk[] = [];
  let i = 0;
  let n = 0;
  while (i < t.length) {
    n += 1;
    chunks.push({ pos: `${prefix}${n}`, content: t.slice(i, i + size) });
    i += size - overlap;
  }
  return chunks;
}

async function parsePptx(buf: ArrayBuffer): Promise<Chunk[]> {
  const zip = await JSZip.loadAsync(buf);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)![1]);
      const nb = Number(b.match(/slide(\d+)\.xml$/)![1]);
      return na - nb;
    });
  const chunks: Chunk[] = [];
  for (const name of slideNames) {
    const xml = await zip.files[name].async("string");
    const texts = matchAll(xml, /<a:t>([\s\S]*?)<\/a:t>/g);
    const body = cleanLines(texts.join("\n"));
    if (body) {
      const n = name.match(/slide(\d+)\.xml$/)![1];
      chunks.push({ pos: `slide${n}`, content: body });
    }
  }
  return chunks;
}

async function parseDocx(buf: ArrayBuffer): Promise<Chunk[]> {
  const zip = await JSZip.loadAsync(buf);
  const docFile = zip.files["word/document.xml"];
  if (!docFile) return [];
  const xml = await docFile.async("string");
  // 段落(<w:p>)ごとに <w:t> を連結して1行にする。
  const paras = xml.split(/<w:p[ >]/).map((p) => {
    const runs = matchAll(p, /<w:t[^>]*>([\s\S]*?)<\/w:t>/g);
    return runs.join("");
  });
  const text = cleanLines(paras.join("\n"));
  return windowChunks(text, "p");
}

export const SUPPORTED_EXT = [".pptx", ".docx"] as const;

// ファイルの拡張子で解析器を選び、チャンク配列を返す。
export async function extractChunks(
  buf: ArrayBuffer,
  filename: string
): Promise<Chunk[]> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pptx")) return parsePptx(buf);
  if (lower.endsWith(".docx")) return parseDocx(buf);
  throw new Error(`未対応の拡張子です（対応: ${SUPPORTED_EXT.join(", ")}）`);
}

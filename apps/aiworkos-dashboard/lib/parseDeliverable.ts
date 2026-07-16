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

// PDFはページ単位で抽出する。※PDFによっては文字を取り出せないことがある
// （スキャン画像PDF、またはToUnicodeマップ無しでフォントが埋め込まれた書き出しPDF）。
// その場合は無言で0件にせず、原因が分かるエラーを投げる。
async function parsePdf(buf: ArrayBuffer): Promise<Chunk[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).toString();

  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const chunks: Chunk[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const raw = tc.items
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const body = cleanLines(raw);
    if (!body) continue;
    // 長いページはさらに窓分割して埋め込みの上限に収める
    if (body.length > 800) {
      chunks.push(...windowChunks(body, `p${i}-`));
    } else {
      chunks.push({ pos: `p${i}`, content: body });
    }
  }

  if (chunks.length === 0) {
    throw new Error(
      "このPDFからはテキストを抽出できませんでした。スキャン画像のPDFか、フォントの埋め込み方によって文字を取り出せない場合があります。PowerPoint/Wordの元ファイルがあれば、そちらを選んでください。"
    );
  }
  return chunks;
}

export const SUPPORTED_EXT = [".pptx", ".docx", ".pdf"] as const;

// ファイルの拡張子で解析器を選び、チャンク配列を返す。
export async function extractChunks(
  buf: ArrayBuffer,
  filename: string
): Promise<Chunk[]> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pptx")) return parsePptx(buf);
  if (lower.endsWith(".docx")) return parseDocx(buf);
  if (lower.endsWith(".pdf")) return parsePdf(buf);
  // 未対応の時は「何が起きたか」を具体的に返す（無言でチャンク0にしない）
  if (lower.endsWith(".ppt") || lower.endsWith(".doc")) {
    throw new Error(
      "旧形式(.ppt / .doc)は未対応です。PowerPoint・Wordで .pptx / .docx として保存し直してください。"
    );
  }
  throw new Error(
    `このファイル形式は未対応です（対応: ${SUPPORTED_EXT.join(", ")}）`
  );
}

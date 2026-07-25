// 長文をClaudeへの埋め込み・検索用に一定サイズへ分割するチャンク化ヘルパー。
// refine / weapons など複数のAPIルートで同じロジックが重複していたため一本化
// （2026-07-25 アーキテクチャレビュー P2対応）。

export const CHUNK_SIZE = 400;
export const CHUNK_OVERLAP = 60;

export function windowChunks(
  text: string,
  size: number = CHUNK_SIZE,
  overlap: number = CHUNK_OVERLAP
): string[] {
  const body = text.trim();
  if (!body) return [];
  if (body.length <= size) return [body];
  const chunks: string[] = [];
  for (let i = 0; i < body.length; i += size - overlap) {
    chunks.push(body.slice(i, i + size));
  }
  return chunks;
}

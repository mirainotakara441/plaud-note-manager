import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // lib/systemPrompt.ts は content/*.md を実行時に readFileSync で読む。
  // Next.js の自動トレースは動的なパスを追えないため、明示的に同梱を指示する。
  // これが無いと、ローカルでは動くのに Vercel 上だけ
  // 「ENOENT: content/instruction.md が無い」で落ちる。
  outputFileTracingIncludes: {
    "/api/chat": ["./content/**"],
  },
};

export default nextConfig;

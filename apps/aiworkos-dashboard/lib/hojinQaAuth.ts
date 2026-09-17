// 法人請求QA検索（/hojin-qa）専用の合言葉ゲート。
//
// 2026-08-23 時点ではQA検索サイトが AIワークOS の外（chatgpt.site、Codex製の暫定
// サイト）にあり、こちらは /qa-gate で合言葉を照合してから外部へ送り出すだけだった。
// 実URLを知っている人には効かない穴があった。
//
// 2026-09-17 にQAの実体を本体の /hojin-qa へ取り込み、この合言葉で実体ごと守る形に
// 替えた（データは lib/hojinQa/data.json、作り直しは scripts/build-hojin-qa.mjs）。
//
// この合言葉はAIワークOS本体の合言葉（APP_PASSPHRASE）とは別物。法人請求チームの
// 同僚に配る前提のQAなので、本体へのログインは要求しない。逆に、この合言葉で
// 入れるのは /hojin-qa だけで、本体の他ページには入れない（proxy.ts 参照）。
//
// フェイルクローズ: 本番（NODE_ENV=production）で HOJIN_QA_PASSPHRASE が未設定なら
// 扉を閉じる（proxy.ts の APP_PASSPHRASE と同じ方針）。以前はコードに "houjin" を
// 直書きしたデフォルトで動いていたが、メンバー展開にあたり Vercel 側で別の合言葉を
// 設定する運用へ切り替えた（2026-09-17）。開発環境だけは "houjin" にフォールバック
// して、.env.local を触らずにローカルで開けるようにしている。

export const HOJIN_QA_COOKIE_NAME = "hojin_qa_auth";

const DEV_FALLBACK = "houjin";

/**
 * 有効な合言葉を返す。本番で未設定なら null（＝閉じる）。
 */
export function hojinQaPassphrase(): string | null {
  const v = process.env.HOJIN_QA_PASSPHRASE?.trim();
  if (v) return v;
  if (process.env.NODE_ENV !== "production") return DEV_FALLBACK;
  return null;
}

/** /hojin-qa 配下かどうか（proxy.ts と page.tsx で同じ判定を使う）。 */
export function isHojinQaPath(pathname: string): boolean {
  return pathname === "/hojin-qa" || pathname.startsWith("/hojin-qa/");
}

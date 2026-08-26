// 法人請求QA検索（外部・chatgpt.site）専用の合言葉ゲート。
//
// QA検索サイト自体はAIワークOSの外（chatgpt.site、Codexで作った暫定サイト）に
// あり、こちらのコードから直接手を入れることはできない。代わりにAIワークOSの
// 中に「入り口」（/qa-gate）を作り、合言葉を照合してから外部サイトへ送り出す。
//
// この合言葉はAIワークOS本体の合言葉（APP_PASSPHRASE）とは別物。法人請求チームの
// 同僚に共有する前提のQAなので、AIワークOS本体へのログインは要求しない
// （proxy.ts の PUBLIC_PATHS に /qa-gate と /api/qa-gate を加えている）。
//
// ★注意: これは「入り口」を守るだけで、chatgpt.site の実URLを直接知っている人
// には効かない（そちらのホスティングには手が入れられないため）。QA検索サイトを
// Claude Code側へ作り直したとき（project_qa_site_claude_code_rebuild 参照）は、
// この合言葉ゲートも本体の実装に置き換えること。

export const HOJIN_QA_COOKIE_NAME = "hojin_qa_auth";

// 環境変数 HOJIN_QA_PASSPHRASE で上書きできる。未設定時は "houjin"
// （2026-08-23、吉井さん指定）。
export const HOJIN_QA_PASSPHRASE = process.env.HOJIN_QA_PASSPHRASE?.trim() || "houjin";

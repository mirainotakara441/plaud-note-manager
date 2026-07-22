// Supabase PostgREST 呼び出し用の共通クレデンシャル・ヘッダーヘルパー。
//
// 使い分け:
//   - 読み取り（SELECT）: anonCreds() … RLSがanonにSELECTを許可している経路のみ
//   - 書き込み・RPC呼び出し（INSERT/UPDATE/DELETE/rpc）: serviceCreds()
//
// service role キーはRLSを完全にバイパスするため、ブラウザに絶対出さない
// （NEXT_PUBLIC_ を付けない。サーバー側 route.ts からのみ使う）。
// serviceCreds() は SUPABASE_SERVICE_ROLE_KEY が未設定なら null を返す。
// anon キーへのフォールバックはしない（フォールバックすると、anonの書き込み
// ポリシーを落とした後にサイレントに壊れるか、あるいは無自覚にanon書き込みへ
// 戻ってしまうため）。
//
// 2026-07-25 アーキテクチャレビュー Task 2 対応。

export type Creds = { url: string; key: string };

function baseUrl(): string | null {
  const url = process.env.SUPABASE_URL?.trim();
  return url && url !== "" ? url : null;
}

// Vercel/ダッシュボードUIでのコピペ時に末尾改行・空白が混入することがあり、
// それを含んだ値を Authorization ヘッダーへ渡すと fetch() が
// "Invalid character in header content" 相当の例外を投げて空の500応答になる
// （2026-07-25 動作確認で実際に踏んだ不具合）。必ずtrimしてから使う。
function cleanKey(raw: string | undefined): string | null {
  const key = raw?.trim();
  return key && key !== "" ? key : null;
}

export function anonCreds(): Creds | null {
  const url = baseUrl();
  const key = cleanKey(process.env.SUPABASE_ANON_KEY);
  if (!url || !key) return null;
  return { url, key };
}

export function serviceCreds(): Creds | null {
  const url = baseUrl();
  const key = cleanKey(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) return null;
  return { url, key };
}

export function restHeaders(
  key: string,
  extra?: Record<string, string>
): Record<string, string> {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

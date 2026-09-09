// 相談ログの読み書き（Supabase PostgREST 直叩き）。
//
// テーブル: bunshin_logs
//   id          bigserial primary key
//   member_name text        誰が相談したか（ログイン時に入力した名前）
//   question    text        メンバーが打った相談
//   answer      text        分身AIが返した答え
//   created_at  timestamptz default now()
//
// 書き込みは service role キーで行う（RLS をバイパスするのでブラウザに出さない）。
// 記録に失敗しても会話は止めない（ログのために相談が使えなくなる方が損なので、
// 失敗はサーバーログに残して握りつぶす）。

import { serviceCreds } from "@/lib/supabase";

export type LogRow = {
  id: number;
  member_name: string;
  question: string;
  answer: string;
  created_at: string;
};

export async function saveLog(
  memberName: string,
  question: string,
  answer: string
): Promise<void> {
  const creds = serviceCreds();
  if (!creds) {
    console.error("saveLog: SUPABASE_SERVICE_ROLE_KEY 未設定のため記録をスキップ");
    return;
  }
  try {
    const r = await fetch(`${creds.url}/rest/v1/bunshin_logs`, {
      method: "POST",
      headers: {
        apikey: creds.key,
        Authorization: `Bearer ${creds.key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        member_name: memberName,
        question,
        answer,
      }),
    });
    if (!r.ok) console.error("saveLog: 失敗", r.status, await r.text());
  } catch (err) {
    console.error("saveLog: 例外", err);
  }
}

export async function listLogs(limit = 200): Promise<LogRow[]> {
  const creds = serviceCreds();
  if (!creds) return [];
  const url =
    `${creds.url}/rest/v1/bunshin_logs` +
    `?select=id,member_name,question,answer,created_at&order=created_at.desc&limit=${limit}`;
  const r = await fetch(url, {
    headers: { apikey: creds.key, Authorization: `Bearer ${creds.key}` },
    cache: "no-store",
  });
  if (!r.ok) {
    console.error("listLogs: 失敗", r.status, await r.text());
    return [];
  }
  return (await r.json()) as LogRow[];
}

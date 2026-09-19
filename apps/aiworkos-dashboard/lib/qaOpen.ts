import { serviceCreds, restHeaders } from "@/lib/supabase";

// 法人請求QA 外部公開サイト（/qa-open）のサーバー側ヘルパー。
//
// /hojin-qa（社内向け・合言葉）とは別物。こちらは合言葉を要求せず、
// 代わりに「名前とメールアドレスの登録」を入口にする。登録した人は
// qa_open_visitors に残り、開くたびに qa_open_access_log に1行増える。
// QAへの修正案・質問は qa_open_feedback に入り、プッシュ通知で吉井さんへ飛ぶ。
//
// テーブル（2026-09-19 migration qa_open_visitors_feedback）:
//   qa_open_visitors   … id, name, email(unique), org, first_seen, last_seen, visits
//   qa_open_access_log … visitor_id, at, path, user_agent
//   qa_open_feedback   … visitor_id, item_id, kind, message, status, created_at
// いずれも RLS 有効・anon ポリシー無し。読み書きは service role のみ。

export const QA_OPEN_COOKIE = "qa_open_visitor";
export const QA_OPEN_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type QaOpenVisitor = {
  id: string;
  name: string;
  email: string;
  org: string | null;
  first_seen: string;
  last_seen: string;
  visits: number;
};

export type QaOpenFeedback = {
  id: number;
  visitor_id: string;
  item_id: string | null;
  kind: string;
  message: string;
  status: string;
  created_at: string;
  qa_open_visitors?: { name: string; email: string; org: string | null } | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string | undefined | null): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  if (e.length < 5 || e.length > 200) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

export function normalizeName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const n = v.trim().replace(/\s+/g, " ");
  if (n.length < 1 || n.length > 80) return null;
  return n;
}

export function normalizeOrg(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const o = v.trim().replace(/\s+/g, " ");
  return o ? o.slice(0, 120) : null;
}

/** 来訪者を id で引く。無ければ null（cookie が古い・消された等） */
export async function findVisitor(id: string): Promise<QaOpenVisitor | null> {
  const c = serviceCreds();
  if (!c || !isUuid(id)) return null;
  const r = await fetch(
    `${c.url}/rest/v1/qa_open_visitors?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    { headers: restHeaders(c.key), cache: "no-store" }
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as QaOpenVisitor[];
  return rows[0] ?? null;
}

/** 名前・メールで登録（同じメールなら名前・所属を上書きして同じ id を返す） */
export async function upsertVisitor(input: {
  name: string;
  email: string;
  org: string | null;
}): Promise<QaOpenVisitor | null> {
  const c = serviceCreds();
  if (!c) return null;
  const r = await fetch(`${c.url}/rest/v1/qa_open_visitors?on_conflict=email&select=*`, {
    method: "POST",
    headers: restHeaders(c.key, { Prefer: "resolution=merge-duplicates,return=representation" }),
    body: JSON.stringify({ name: input.name, email: input.email, org: input.org }),
  });
  if (!r.ok) {
    console.error("qa_open_visitors upsert 失敗", r.status, await r.text().catch(() => ""));
    return null;
  }
  const rows = (await r.json()) as QaOpenVisitor[];
  return rows[0] ?? null;
}

/** 1回のアクセスを記録し、visits と last_seen を進める */
export async function logAccess(visitorId: string, path: string, userAgent: string | null) {
  const c = serviceCreds();
  if (!c || !isUuid(visitorId)) return;
  await fetch(`${c.url}/rest/v1/qa_open_access_log`, {
    method: "POST",
    headers: restHeaders(c.key, { Prefer: "return=minimal" }),
    body: JSON.stringify({ visitor_id: visitorId, path, user_agent: userAgent?.slice(0, 300) ?? null }),
  }).catch((e) => console.error("qa_open_access_log 失敗", e));
  // visits は RPC を作らず、読んで+1で書く（同時アクセスの厳密さは要らない）
  const cur = await findVisitor(visitorId);
  if (!cur) return;
  await fetch(`${c.url}/rest/v1/qa_open_visitors?id=eq.${encodeURIComponent(visitorId)}`, {
    method: "PATCH",
    headers: restHeaders(c.key, { Prefer: "return=minimal" }),
    body: JSON.stringify({ visits: cur.visits + 1, last_seen: new Date().toISOString() }),
  }).catch((e) => console.error("qa_open_visitors visits 更新失敗", e));
}

export async function insertFeedback(input: {
  visitorId: string;
  itemId: string | null;
  kind: string;
  message: string;
}): Promise<QaOpenFeedback | null> {
  const c = serviceCreds();
  if (!c) return null;
  const r = await fetch(`${c.url}/rest/v1/qa_open_feedback?select=*`, {
    method: "POST",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
    body: JSON.stringify({
      visitor_id: input.visitorId,
      item_id: input.itemId,
      kind: input.kind,
      message: input.message,
    }),
  });
  if (!r.ok) {
    console.error("qa_open_feedback insert 失敗", r.status, await r.text().catch(() => ""));
    return null;
  }
  const rows = (await r.json()) as QaOpenFeedback[];
  return rows[0] ?? null;
}

/** 社内の受信箱（/hojin-qa/inbox）用。新しい順 */
export async function listFeedback(limit = 200): Promise<QaOpenFeedback[]> {
  const c = serviceCreds();
  if (!c) return [];
  const r = await fetch(
    `${c.url}/rest/v1/qa_open_feedback?select=*,qa_open_visitors(name,email,org)&order=created_at.desc&limit=${limit}`,
    { headers: restHeaders(c.key), cache: "no-store" }
  );
  if (!r.ok) return [];
  return (await r.json()) as QaOpenFeedback[];
}

export async function listVisitors(limit = 500): Promise<QaOpenVisitor[]> {
  const c = serviceCreds();
  if (!c) return [];
  const r = await fetch(
    `${c.url}/rest/v1/qa_open_visitors?select=*&order=last_seen.desc&limit=${limit}`,
    { headers: restHeaders(c.key), cache: "no-store" }
  );
  if (!r.ok) return [];
  return (await r.json()) as QaOpenVisitor[];
}

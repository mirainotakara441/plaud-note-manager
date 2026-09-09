// Supabase PostgREST への薄いラッパ。
//
// AIワークOS と同じく supabase-js は使わず fetch で直接叩く（バンドルを軽く保つため）。
// 読み書きとも service role キーを使う: career_* テーブルは RLS 有効・anon ポリシー無しで、
// アクセス経路をサーバー側 route.ts に一本化している。
// service role キーは絶対にブラウザへ出さない（NEXT_PUBLIC_ を付けない）。

import { serviceCreds, restHeaders } from "./supabase";

export class DbNotConfiguredError extends Error {
  constructor() {
    super("Supabase の接続情報が設定されていません（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）");
    this.name = "DbNotConfiguredError";
  }
}

function creds() {
  const c = serviceCreds();
  if (!c) throw new DbNotConfiguredError();
  return c;
}

async function request(
  path: string,
  init: RequestInit & { prefer?: string } = {}
): Promise<Response> {
  const { url, key } = creds();
  const { prefer, ...rest } = init;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...rest,
    headers: restHeaders(key, prefer ? { Prefer: prefer } : undefined),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase ${init.method ?? "GET"} ${path} が ${res.status}: ${body.slice(0, 400)}`);
  }
  return res;
}

/** SELECT。query は PostgREST のクエリ文字列（例: "select=*&order=created_at.desc"）。 */
export async function select<T>(table: string, query = "select=*"): Promise<T[]> {
  const res = await request(`${table}?${query}`);
  return (await res.json()) as T[];
}

/** SELECT で1件だけ取る。無ければ null。 */
export async function selectOne<T>(table: string, query: string): Promise<T | null> {
  const rows = await select<T>(table, `${query}&limit=1`);
  return rows[0] ?? null;
}

/** count のみ取得（Prefer: count=exact + Content-Range ヘッダを読む）。 */
export async function count(table: string, query = ""): Promise<number> {
  const { url, key } = creds();
  const res = await fetch(`${url}/rest/v1/${table}?select=id&limit=1${query ? `&${query}` : ""}`, {
    headers: restHeaders(key, { Prefer: "count=exact" }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase count ${table} が ${res.status}: ${body.slice(0, 200)}`);
  }
  // Content-Range は "0-0/123" の形。分母が総件数。
  const range = res.headers.get("content-range") ?? "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

/** INSERT。返り値は挿入された行。 */
export async function insert<T>(table: string, rows: unknown[] | unknown): Promise<T[]> {
  const res = await request(table, {
    method: "POST",
    body: JSON.stringify(rows),
    prefer: "return=representation",
  });
  return (await res.json()) as T[];
}

/**
 * UPSERT。conflictColumn に一意制約が必要。
 * ignoreDuplicates=true なら既存行はそのまま（重複メールの取込などで使う）。
 */
export async function upsert<T>(
  table: string,
  rows: unknown[] | unknown,
  conflictColumn: string,
  ignoreDuplicates = false
): Promise<T[]> {
  const resolution = ignoreDuplicates ? "ignore-duplicates" : "merge-duplicates";
  const res = await request(`${table}?on_conflict=${conflictColumn}`, {
    method: "POST",
    body: JSON.stringify(rows),
    prefer: `resolution=${resolution},return=representation`,
  });
  return (await res.json()) as T[];
}

/** UPDATE。filter は PostgREST のフィルタ（例: "id=eq.xxx"）。 */
export async function update<T>(
  table: string,
  filter: string,
  patch: Record<string, unknown>
): Promise<T[]> {
  const res = await request(`${table}?${filter}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    prefer: "return=representation",
  });
  return (await res.json()) as T[];
}

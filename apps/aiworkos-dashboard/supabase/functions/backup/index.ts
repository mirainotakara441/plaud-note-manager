// AIワークOS 全テーブルバックアップ。service_role で全行を読み、JSON で返す。
// 目的: 日記など再生不能データのコピーを定期的にローカルに落とす（Supabase無料プランは自動バックアップなし）。
//
// ⚠保護: verify_jwt=true なので呼ぶには有効な JWT（anon key）が必要。
//   anon key はこのアプリでは NEXT_PUBLIC 不使用でサーバ側のみに置いてあり、
//   フロントに露出していない。**この関数は全データを返すので、anon key を
//   フロントに露出させないことを前提に保護されている**。
//
// ── 2026-08-11 改修（v4）─────────────────────────────────────────
// 【障害】2026-08-03 / 08-10 の週次バックアップが http=500 で失敗。
//   原因は「対象テーブルのハードコード一覧が陳腐化したこと」。
//   stakeholders が 2026-07-30 に stakeholders_retired_20260730 へリネームされ、
//   PostgREST が "Could not find the table 'public.stakeholders'" を返し、
//   旧実装はその時点で即 500 を返して全体が落ちていた（データ肥大ではない）。
//   加えて旧一覧は10テーブルしか含まず、ramen_logs / health_metrics / family_logs /
//   salt2_members / weekly_reports などは**そもそもバックアップ対象外**だった。
//
// 【対策】
//   1. 対象テーブルを PostgREST の OpenAPI(/rest/v1/) から毎回動的に取得する。
//      → テーブルを増やしても消してもこのファイルを触らなくて済む＝同じ壊れ方を再発させない。
//      取得に失敗したときだけ FALLBACK_TABLES を使う。
//   2. 1テーブルの失敗で全体を落とさない。errors に記録して残りを続行する。
//   3. テーブル単位・ページ単位で返すモードを追加（データが増えても
//      メモリ/実行時間の上限に当たらない）。backup.sh 側はこちらを使って
//      1本の JSON に組み立てる。
//
// ── リクエスト body ─────────────────────────────────────────────
//   {"mode":"list"}
//       → {"tables":[...], "source":"openapi"|"fallback"}  対象テーブル名の一覧
//   {"table":"memory_chunks","offset":0,"limit":500,"include_embedding":true}
//       → {"table":..,"offset":..,"limit":..,"rows":[...],"count":n,"done":bool}
//   {"include_embedding":true}   （従来どおりの一括モード。互換のため残す）
//       → {"generated_at","project","include_embedding","counts","tables","errors"}
//
//   include_embedding:false で memory_chunks の embedding 列を除外（軽量版）。
//   既定は embedding 込みの完全バックアップ。embedding は store-memory で再生成も可能。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// 動的取得が失敗したときだけ使う保険。ここが「正」ではない。
const FALLBACK_TABLES = [
  "memory_chunks",
  "dx_news",
  "refine_messages",
  "news_themes",
  "integration_jobs",
  "service_health",
  "learning_logs",
  "refine_sessions",
  "proposal_cache",
];

const MAX_PAGE = 1000;

/** PostgREST の OpenAPI から public スキーマの実テーブル名を拾う。 */
async function discoverTables(): Promise<{ tables: string[]; source: string }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!res.ok) throw new Error(`openapi http ${res.status}`);
    const spec = await res.json();
    const paths = Object.keys(spec?.paths ?? {});
    const tables = paths
      .filter((p) => p !== "/" && !p.startsWith("/rpc/"))
      .map((p) => p.replace(/^\//, ""))
      .filter((t) => t.length > 0)
      .sort();
    if (tables.length === 0) throw new Error("openapi returned no tables");
    return { tables, source: "openapi" };
  } catch (_e) {
    return { tables: [...FALLBACK_TABLES], source: "fallback" };
  }
}

/** 1テーブルの1ページを取る。 */
async function fetchPage(
  table: string,
  offset: number,
  limit: number,
  includeEmbedding: boolean,
) {
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  if (!includeEmbedding) {
    for (const row of rows) delete (row as Record<string, unknown>).embedding;
  }
  return rows;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const body = await req.json().catch(() => ({}));
    const includeEmbedding = body.include_embedding !== false; // 既定 true

    // ── モード1: 対象テーブル一覧 ──────────────────────────────
    if (body.mode === "list") {
      const { tables, source } = await discoverTables();
      return json({ tables, source });
    }

    // ── モード2: テーブル単位・ページ単位 ─────────────────────
    if (typeof body.table === "string" && body.table.length > 0) {
      const offset = Number.isFinite(body.offset) ? Math.max(0, Number(body.offset)) : 0;
      const limit = Number.isFinite(body.limit)
        ? Math.min(MAX_PAGE, Math.max(1, Number(body.limit)))
        : 500;
      try {
        const rows = await fetchPage(body.table, offset, limit, includeEmbedding);
        return json({
          table: body.table,
          offset,
          limit,
          count: rows.length,
          done: rows.length < limit,
          rows,
        });
      } catch (e) {
        return json({ error: `table ${body.table}: ${String(e)}` }, 500);
      }
    }

    // ── モード3: 一括（従来互換）──────────────────────────────
    // 1テーブルこけても全体は落とさない。errors に残して続行する。
    const { tables: TABLES, source } = await discoverTables();
    const counts: Record<string, number> = {};
    const tablesOut: Record<string, unknown[]> = {};
    const errors: Record<string, string> = {};

    for (const t of TABLES) {
      const rows: unknown[] = [];
      try {
        for (let from = 0; ; from += MAX_PAGE) {
          const page = await fetchPage(t, from, MAX_PAGE, includeEmbedding);
          for (const row of page) rows.push(row);
          if (page.length < MAX_PAGE) break;
        }
        tablesOut[t] = rows;
        counts[t] = rows.length;
      } catch (e) {
        errors[t] = String(e);
      }
    }

    return json({
      generated_at: new Date().toISOString(),
      project: "zuadqnarsoykplkafyxv",
      include_embedding: includeEmbedding,
      table_source: source,
      counts,
      tables: tablesOut,
      errors,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

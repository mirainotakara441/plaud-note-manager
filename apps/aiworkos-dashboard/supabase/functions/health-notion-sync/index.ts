// AIワークOS 健康ログDB 日次同期
// Supabase health_metrics(ロング型) → health_daily_summary() で1日1行に集約 → Notion「健康ログDB」へ冪等upsert。
// verify_jwt=false: pg_cronからnet.http_postで無認証呼び出しされるため(fetch-news-multiと同じ運用パターン)。
//   代わりにNotion側はapp_config.notion_health_sync_tokenを使って認証する。
//
// 認証: Notion側は内部インテグレーションのシークレット(app_config.notion_health_sync_token)を使用。
//   まだ未設定の場合は 500 で明示的にエラーを返す（cronは失敗するが害はない）。
// 冪等性: Notionの「日付」プロパティで既存ページをquery→あれば update、なければ create。
// 実行: POST { day?: "YYYY-MM-DD" }。dayを省略した場合はJSTの「前日」を対象にする
//   （Health Auto Exportの同期は日をまたいで行われるため、前日分は確定しているとみなせる）。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 健康ログDB (Notion database, single data source)。2026-07-20作成。
const NOTION_HEALTH_DB_ID = "c24ce2db-f939-4787-a5b3-1ea3b5085588";
const NOTION_VERSION = "2022-06-28";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function jstYesterday(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() - 1);
  return jst.toISOString().slice(0, 10);
}

function isValidDay(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

async function getNotionToken(): Promise<string> {
  const { data, error } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "notion_health_sync_token")
    .maybeSingle();
  if (error) throw new Error(`app_config lookup failed: ${error.message}`);
  if (!data?.value) {
    throw new Error(
      "notion_health_sync_token が app_config に未設定です。Notionで内部インテグレーションを作成し、" +
        "健康ログDBに接続を許可した上でシークレットを登録してください。",
    );
  }
  return data.value;
}

type Summary = {
  day: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  bmi: number | null;
  steps: number | null;
  kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  walking_speed_kmh: number | null;
};

function numberProp(v: number | null) {
  return { number: v === null || v === undefined ? null : v };
}

function buildProperties(s: Summary) {
  return {
    "Name": { title: [{ text: { content: s.day } }] },
    "日付": { date: { start: s.day } },
    "体重(kg)": numberProp(s.weight_kg),
    "体脂肪率(%)": numberProp(s.body_fat_pct),
    "BMI": numberProp(s.bmi),
    "歩数": numberProp(s.steps),
    "摂取カロリー(kcal)": numberProp(s.kcal),
    "タンパク質(g)": numberProp(s.protein_g),
    "脂質(g)": numberProp(s.fat_g),
    "炭水化物(g)": numberProp(s.carbs_g),
    "歩行速度(km/h)": numberProp(s.walking_speed_kmh),
    // メモは手動記入欄なので同期のたびに上書きしない（キー自体を送らない）
  };
}

async function notionFetch(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Notion API ${path} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function findExistingPageId(day: string, token: string): Promise<string | null> {
  const result = await notionFetch(
    `/databases/${NOTION_HEALTH_DB_ID}/query`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        filter: { property: "日付", date: { equals: day } },
        page_size: 2,
      }),
    },
  );
  const results = (result as any).results ?? [];
  return results.length > 0 ? results[0].id : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return json({ ok: true, service: "health-notion-sync" });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const day = isValidDay(body?.day) ? body.day : jstYesterday();

    const { data: rows, error: rpcError } = await supabase.rpc(
      "health_daily_summary",
      { target_day: day },
    );
    if (rpcError) return json({ error: rpcError.message }, 500);
    const summary: Summary = { day, ...(rows?.[0] ?? {}) };

    const token = await getNotionToken();
    const properties = buildProperties(summary);

    const existingId = await findExistingPageId(day, token);
    if (existingId) {
      await notionFetch(`/pages/${existingId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ properties }),
      });
      return json({ ok: true, mode: "updated", day, page_id: existingId, summary });
    } else {
      const created = await notionFetch(`/pages`, token, {
        method: "POST",
        body: JSON.stringify({
          parent: { database_id: NOTION_HEALTH_DB_ID },
          properties,
        }),
      });
      return json({ ok: true, mode: "created", day, page_id: (created as any).id, summary });
    }
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});

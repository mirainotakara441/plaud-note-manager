// Health Auto Export → Supabase 受け口
// 認証: 独自トークン(x-ingest-token ヘッダ / Bearer / ?token=)を
//   (a) app_config.health_ingest_token_sha256 の SHA-256ハッシュ または
//   (b) 環境変数 HEALTH_INGEST_TOKEN と照合。
// 受信: Health Auto Export の REST API(JSON) ペイロードを health_metrics へ冪等upsert。
//
// 重要: 同一(metric,day,source)の行が1回のupsertバッチ内に複数あると
// PostgresのON CONFLICTがエラーになるため、送信前に必ず1件へ畳んでから送る。
//
// 畳み方は指標によって違う。ここを間違えると値は入るが中身が別物になる:
//   歩数・距離・消費エネルギー・栄養 … 1日の中で積み上がる量 → 合計
//   心拍・体重・歩行速度・各種％      … その瞬間の水準        → 平均
// 2026-08-03まで全指標を平均で畳んでいたため、歩数は「1サンプルあたりの平均歩数」
// （実測4,874歩の日が42.4）になっていた。合計/平均を指標ごとに選ぶよう修正。
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ENV_TOKEN = Deno.env.get("HEALTH_INGEST_TOKEN");

// --- 畳み方の判定 ---------------------------------------------------------
// 「その瞬間の水準」を表す指標。1日に何点来ても平均が正しい。
// Health Auto Export が出しうる離散(discrete)系をここに列挙する。
const AVG_METRICS = new Set([
  "heart_rate",
  "resting_heart_rate",
  "walking_heart_rate_average",
  "heart_rate_variability",
  "respiratory_rate",
  "blood_oxygen_saturation",
  "oxygen_saturation",
  "body_temperature",
  "basal_body_temperature",
  "blood_pressure_systolic",
  "blood_pressure_diastolic",
  "blood_glucose",
  "vo2_max",
  "body_mass",
  "weight_body_mass",
  "lean_body_mass",
  "body_fat_percentage",
  "body_mass_index",
  "waist_circumference",
  "height",
  "walking_speed",
  "walking_step_length",
  "walking_asymmetry_percentage",
  "walking_double_support_percentage",
  "stair_ascent_speed",
  "stair_descent_speed",
  "six_minute_walking_test_distance",
  "environmental_audio_exposure",
  "headphone_audio_exposure",
]);

// 単位からも水準系を拾う。新しい指標が増えたときに、
// 名前を登録し忘れて合計されてしまう事故を防ぐための二段目。
// 「量あたり」でなく「毎分」「率」「長さ・重さそのもの」を表す単位を平均扱いにする。
const AVG_UNIT_RE = /^\s*(%|bpm|[a-z]+\/min|km\/hr|mi\/hr|m\/s|cm|in|kg|lb|mmHg|ms|°?[CF]|deg[CF])\s*$/i;

function aggFor(metric: string, unit: string | null): "sum" | "avg" {
  if (AVG_METRICS.has(metric)) return "avg";
  if (unit && AVG_UNIT_RE.test(unit)) return "avg";
  return "sum";
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toDay(d: unknown): string | null {
  if (typeof d !== "string" || d.length < 10) return null;
  return d.slice(0, 10);
}
function toTimestamp(d: unknown): string | null {
  if (typeof d !== "string") return null;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" && !Number.isNaN(n) ? n : null;
}
function pickValue(name: string, p: Record<string, unknown>): number | null {
  if (p == null || typeof p !== "object") return null;
  if ((p as any).qty != null) return num((p as any).qty);
  if (name === "sleep_analysis") {
    return num((p as any).asleep) ?? num((p as any).totalSleep) ?? num((p as any).inBed) ?? num((p as any).value);
  }
  return num((p as any).Avg) ?? num((p as any).avg) ?? num((p as any).value);
}

type Row = { day: string; metric: string; value: number | null; unit: string | null; source: string; extra: Record<string, unknown>; measured_at: string | null };

Deno.serve(async (req) => {
  if (req.method === "GET") return json({ ok: true, service: "ingest-health" });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let rawBody = "";
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // --- 認証 ---
    const url = new URL(req.url);
    const hdrToken = req.headers.get("x-ingest-token");
    const authHeader = req.headers.get("authorization");
    const qsToken = url.searchParams.get("token");
    const supplied = hdrToken ?? authHeader?.replace(/^Bearer\s+/i, "") ?? qsToken ?? "";
    if (!supplied) return json({ error: "unauthorized", debug: "no token supplied" }, 401);

    let ok = false;
    if (ENV_TOKEN && supplied === ENV_TOKEN) ok = true;
    if (!ok) {
      const { data: cfg } = await supabase
        .from("app_config")
        .select("value")
        .eq("key", "health_ingest_token_sha256")
        .maybeSingle();
      if (cfg?.value) ok = (await sha256Hex(supplied)) === cfg.value;
    }
    if (!ok) return json({ error: "unauthorized" }, 401);

    rawBody = await req.text();

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      return json({ error: "invalid json", parse_error: String(e), body_head: rawBody.slice(0, 300) }, 400);
    }

    const metrics = payload?.data?.metrics ?? payload?.metrics ?? [];
    if (!Array.isArray(metrics)) {
      return json({ error: "no metrics array", payload_keys: Object.keys(payload ?? {}), body_head: rawBody.slice(0, 300) }, 400);
    }

    // (metric,day,source) ごとに1件へ畳んでからupsert。
    // 畳み方(sum/avg)は指標ごとに決め、何点をどう畳んだかを extra に残す。
    // 後から「値がおかしい」となったとき、点数と方式が分かれば原因を辿れる。
    const merged = new Map<string, Row & { _sum: number; _cnt: number; _agg: "sum" | "avg" }>();
    for (const m of metrics) {
      const name = String(m?.name ?? "").trim();
      const unit = m?.units ?? null;
      const points = Array.isArray(m?.data) ? m.data : [];
      if (!name) continue;
      const agg = aggFor(name, unit);
      for (const p of points as Record<string, unknown>[]) {
        if (p == null || typeof p !== "object") continue;
        const day = toDay((p as any).date) ?? toDay((p as any).sleepStart);
        if (!day) continue;
        const source = ((p as any).source ? String((p as any).source) : "unknown").trim() || "unknown";
        const key = `${name}|${day}|${source}`;
        const v = pickValue(name, p as any);
        const measured = toTimestamp((p as any).date) ?? toTimestamp((p as any).sleepStart);
        const rest = { ...(p as any) };
        delete rest.date; delete rest.qty; delete rest.source;

        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, {
            day, metric: name, unit, source, extra: rest, measured_at: measured,
            value: v, _sum: v ?? 0, _cnt: v != null ? 1 : 0, _agg: agg,
          });
        } else {
          if (v != null) {
            existing._sum += v;
            existing._cnt += 1;
            existing.value = agg === "sum" ? existing._sum : existing._sum / existing._cnt;
          }
          existing.extra = { ...existing.extra, ...rest };
          if (measured && (!existing.measured_at || measured > existing.measured_at)) existing.measured_at = measured;
        }
      }
    }

    const rows: Row[] = [...merged.values()].map(({ _sum, _cnt, _agg, ...r }) => ({
      ...r,
      extra: { ...r.extra, agg: _agg, n_points: _cnt },
    }));

    if (rows.length === 0) return json({ ok: true, upserted: 0, note: "no data points", metrics_seen: metrics.length });

    const { error, count } = await supabase
      .from("health_metrics")
      .upsert(rows, { onConflict: "metric,day,source", count: "exact" });

    if (error) return json({ error: error.message, received: rows.length }, 500);
    return json({ ok: true, upserted: count ?? rows.length, points_received: metrics.reduce((s: number, m: any) => s + (Array.isArray(m?.data) ? m.data.length : 0), 0) });
  } catch (e) {
    console.log(`FATAL_ERROR ${String(e)} body_head=${rawBody.slice(0, 500)}`);
    return json({ error: "internal error", message: String(e), body_head: rawBody.slice(0, 500) }, 500);
  }
});

#!/usr/bin/env node
// AIワークOS 全APIの通し点検（スモークテスト）。
//
// なぜ要るか:
//   作り足しでAPIが66本まで増えたが、テストが1本も無く、
//   壊れたことに気づくのはいつも「画面を開いて数字が変だった」時だった。
//   ここでやるのは深い検証ではなく「全部が生きているか」の一括確認。
//   落ちている1本を、探さずに見つけられる状態を作るのが目的。
//
// 方針:
//   ・読み取り(GET)は実際に叩いて 5xx・例外・error列の有無・応答時間を見る
//   ・書き込み(POST等)は叩かない。副作用があるため（Xへの投稿・Notion書き込み等）。
//     代わりに「認証なしで弾かれるか」だけ確かめる。これは proxy が
//     ハンドラより前で止めるので、何も起きない。
//   ・合言葉は .env.local の APP_PASSPHRASE から cookie を作る（値は表示しない）
//
// 使い方:
//   npm run test:smoke            … http://localhost:3023 に対して
//   BASE=https://... npm run test:smoke  … 本番に対して
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE || "http://localhost:3023";
/** 応答がこれより遅い読み取りは、遅いというだけで報告する（壊れかけの兆候） */
const SLOW_MS = 8000;

function loadEnv() {
  try {
    const out = {};
    for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}
const env = loadEnv();
const passphrase = process.env.APP_PASSPHRASE || env.APP_PASSPHRASE;
if (!passphrase) {
  console.error("APP_PASSPHRASE が読めません（.env.local か環境変数に必要）");
  process.exit(2);
}
const COOKIE = `aiworkos_auth=${createHash("sha256").update(passphrase).digest("hex")}`;

/** app/api を歩いて route.ts を集め、exportしているメソッドを読む */
function collectRoutes(dir = join(ROOT, "app/api"), prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectRoutes(p, `${prefix}/${name}`));
    else if (name === "route.ts") {
      const src = readFileSync(p, "utf8");
      const methods = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)/g)].map(m => m[1]);
      out.push({ path: prefix || "/", methods });
    }
  }
  return out;
}

// 読み取りに引数が要るAPIの既定値。
// ここに無いものは引数なしで叩く（引数なしで壊れるなら、それ自体が報告に値する）。
const QUERY = {
  "/health": "from=2026-08-01&to=2026-08-07",
  "/health/manual": "from=2026-08-01&to=2026-08-07",
  "/health/ramen": "from=2026-08-01&to=2026-08-07",
  "/health/conditions": "from=2026-08-01&to=2026-08-31",
  "/monthly-report": "month=2026-07",
  "/monthly-report/briefings": "month=2026-08",
  "/weekly-report": "week_start=2026-08-10",
  "/news": "",
  "/search": "",
  // 団体を1つ指定しないと成立しないAPI。実在する団体名を使う。
  "/organizations/influence": "org=" + encodeURIComponent("北九州市"),
  "/organizations/notes": "org=" + encodeURIComponent("北九州市"),
  "/organizations/profile": "org=" + encodeURIComponent("北九州市"),
  "/organizations/timeline": "org=" + encodeURIComponent("北九州市"),
  "/retrospective/month": "month=2026-07",
  // 写真はバケット内のパスを渡す。実在しないパスだと400が正しい挙動。
  "/family/photo": "path=" + encodeURIComponent("unassigned/20260806035946-e5nv32.jpg"),
};

// JSONを返さないのが正しいAPI（画像プロキシなど）。
const NOT_JSON_OK = new Set(["/family/photo"]);

// ローカルでは環境変数が無くて当然のもの。落ちても点検の失敗とはみなさない。
const LOCAL_SKIP = new Set(["/cron/daily-todo", "/cron/notion-sync"]);

const results = [];
function record(r) { results.push(r); }

async function checkGet(path) {
  const qs = QUERY[path] ?? "";
  const url = `${BASE}/api${path}${qs ? `?${qs}` : ""}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { Cookie: COOKIE } });
    const ms = Date.now() - t0;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* JSONでない応答も記録する */ }
    const problems = [];
    if (res.status >= 500) problems.push(`HTTP ${res.status}`);
    else if (res.status >= 400) problems.push(`HTTP ${res.status}`);
    if (json === null && !NOT_JSON_OK.has(path)) problems.push("JSONで返っていない");
    if (json && typeof json === "object" && json.error) problems.push(`error: ${String(json.error).slice(0, 120)}`);
    if (ms > SLOW_MS) problems.push(`遅い ${(ms / 1000).toFixed(1)}秒`);
    record({ kind: "GET", path, status: res.status, ms, problems });
  } catch (e) {
    record({ kind: "GET", path, status: 0, ms: Date.now() - t0, problems: [`通信できない: ${e.message}`] });
  }
}

/** 認証が効いているか。proxy がハンドラより前で止めるので副作用は無い。 */
async function checkAuthGate(path, method) {
  const url = `${BASE}/api${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : "{}",
    });
    const problems = res.status === 401 ? [] : [`認証なしで ${res.status} が返る（401であるべき）`];
    record({ kind: `認証 ${method}`, path, status: res.status, ms: 0, problems });
  } catch (e) {
    record({ kind: `認証 ${method}`, path, status: 0, ms: 0, problems: [`通信できない: ${e.message}`] });
  }
}

const PUBLIC_PATHS = [/^\/login$/, /^\/cron\//, /^\/push\//];
const isPublic = (p) => PUBLIC_PATHS.some((re) => re.test(p));

const routes = collectRoutes().sort((a, b) => a.path.localeCompare(b.path));
console.log(`対象: ${routes.length}本のAPI（BASE=${BASE}）\n`);

for (const r of routes) {
  if (r.methods.includes("GET") && !(BASE.includes("localhost") && LOCAL_SKIP.has(r.path))) {
    await checkGet(r.path);
  }
  if (!isPublic(r.path)) {
    const m = r.methods.includes("GET") ? "GET" : r.methods[0];
    if (m) await checkAuthGate(r.path, m);
  }
}

const bad = results.filter((r) => r.problems.length > 0);
const okCount = results.length - bad.length;
console.log(`合格 ${okCount} / ${results.length}\n`);
if (bad.length) {
  console.log("― 引っかかったもの ―");
  for (const b of bad) {
    console.log(`  [${b.kind}] ${b.path}  → ${b.problems.join(" / ")}`);
  }
}
process.exit(bad.length ? 1 : 0);

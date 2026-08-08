// SALT2受講生名簿（salt2_members）の取込。何度流しても同じ結果になる（upsert）。
//
//   node scripts/import-salt2-members.mjs /Users/YOSHII/Desktop/AI/SALT2/salt2_members_normalized.json
//
// JSONの形は { meta: {...}, members: [ {name, kana, slack_display, ...}, ... ] }。
// 生JSONの配列（membersだけ）を渡してもよい。
//
// 渡すのは normalized 版（Notionの「SALT2人脈DB」の写し）。
// タグの正はNotionで、industry_tags / stance_tags / hobby_tags の3系統が
// 正準セット（22種・22種・19種）。Notion・一覧表・SPAで見え方を揃えるため、
// ここでもその語彙のまま入れる。生タグ（tags・109種）と趣味の原文（hobbies）も
// フリーワード検索用に一緒に持たせる。
// 正規化列が無い旧JSON（salt2_members.json）を渡しても動く（3系統は空配列になる）。
//
// team はSlackのチームチャンネル20本から起こしたチーム配属（例「8月ビジネスチーム6」）。
// SALT2側の配属が未完のため空文字の人がいる（空文字はnullで入る）。
// track は team から補正済みなので、この2つは必ずセットで流すこと。
//
// linkedin / x_url / note_url / facebook / sns_other / sns_confidence は
// 本人のSNSプロフィールを開くためだけの導線。大多数（68名中58名）が空で正常。
// sns_confidence は '確実' / 'たぶん' / 空。'たぶん' は本人特定に確証が無い印で、
// 画面側で「本人確認は未確定」と出すために使うので、勝手に '確実' へ寄せないこと。
// URLは search_text（DB側のトリガー）には入れていない。検索語として打たれないため。
//
// キーは slack_display。同じ人をもう一度流せば上書き、新しい人は追加される。
// 氏名の修正（「矢幡」→「矢幡 康祐」など）も slack_display が変わらない限り上書きで通る。
// 名簿全体は136名で、いま入っているのは自己紹介を投稿した68名。
// 未投稿の人ぶんを後から取れたら、同じ形のJSONにしてこのスクリプトを流せば足せる。
//
// RLSをまたぐので service role キーを使う（.env.local の SUPABASE_SERVICE_ROLE_KEY）。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("使い方: node scripts/import-salt2-members.mjs <salt2_members.json>");
  process.exit(1);
}

// .env.local を読む（このスクリプトはNext.jsの外で走るため）
const env = {};
try {
  const text = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
} catch {
  // 環境変数が直接渡されている場合はそれでよい
}

const url = (process.env.SUPABASE_URL ?? env.SUPABASE_URL ?? "").trim();
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
if (!url || !key) {
  console.error("SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です（.env.local か環境変数）");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(file, "utf8"));
const members = Array.isArray(raw) ? raw : (raw.members ?? []);
if (members.length === 0) {
  console.error("membersが空です");
  process.exit(1);
}

// 空文字はnullに寄せる（DB側は「未記入」をnullで持つ）
const s = (v) => {
  const t = (v ?? "").toString().trim();
  return t === "" ? null : t;
};
const list = (v) => (Array.isArray(v) ? v.map((x) => `${x}`.trim()).filter(Boolean) : []);

const rows = members.map((m) => ({
  name: s(m.name),
  kana: s(m.kana),
  slack_display: s(m.slack_display),
  email: s(m.email),
  company: s(m.company),
  role: s(m.role),
  career: s(m.career),
  ai_usage: s(m.ai_usage),
  goal: s(m.goal),
  hobbies: list(m.hobbies),
  personal: s(m.personal),
  note: s(m.note),
  track: s(m.track),
  team: s(m.team),
  tags: list(m.tags),
  industry_tags: list(m.industry_tags),
  stance_tags: list(m.stance_tags),
  hobby_tags: list(m.hobby_tags),
  raw_intro: s(m.raw_intro),
  posted_at: s(m.posted_at),
  // SNSプロフィールへの導線。無い人は空文字で来るので s() で null に落ちる。
  // 68名中10名しか埋まっていない（確実9・たぶん1）のが正常な状態。
  linkedin: s(m.linkedin),
  x_url: s(m.x_url),
  note_url: s(m.note_url),
  facebook: s(m.facebook),
  sns_other: s(m.sns_other),
  sns_confidence: s(m.sns_confidence),
}));

const missing = rows.filter((r) => !r.name || !r.slack_display);
if (missing.length > 0) {
  console.error(`name と slack_display は必須です（${missing.length}件が欠けています）`);
  process.exit(1);
}

const res = await fetch(`${url}/rest/v1/salt2_members?on_conflict=slack_display`, {
  method: "POST",
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=minimal",
  },
  body: JSON.stringify(rows),
});

if (!res.ok) {
  console.error(`取込に失敗しました（${res.status}）`, await res.text().catch(() => ""));
  process.exit(1);
}
console.log(`salt2_members に ${rows.length}件をupsertしました`);

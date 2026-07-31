import { NextResponse } from "next/server";
import { anonCreds, restHeaders, serviceCreds } from "@/lib/supabase";
import { normalizeOrgCategory, type OrgCategory } from "@/lib/categories";

// 監視ダッシュボード用エンドポイント。
// Supabase側は集計RPC(dashboard_stats)を service role キーで叩き、件数・最終時刻のみ受け取る
// （RPC呼び出しのため2026-07-25レビュー対応でservice roleに切替）。
// Notion側は NOTION_TOKEN が設定されていれば各DBの「最新の更新」を読み、未設定なら休眠のまま返す。
//
// org_status（「次に攻める団体」）には RPC 側に種別が無いので、ここで
// stakeholders / weekly_reports から団体名→正準8分類を引いて付け足す
// （分類の正は lib/categories.ts。どれにも当たらない団体は「その他」にする）。

export const dynamic = "force-dynamic";

type NotionDbConfig = { key: string; label: string; dbId: string };

// 環境変数で連携するNotion DBを列挙する（未設定のものは無視）。
function notionDbs(): NotionDbConfig[] {
  const defs: Array<{ key: string; label: string; env: string }> = [
    { key: "diary", label: "一行日記", env: "NOTION_DB_DIARY" },
    { key: "learning", label: "学び・ナレッジ", env: "NOTION_DB_LEARNING" },
    { key: "meeting", label: "会議", env: "NOTION_DB_MEETING" },
  ];
  return defs
    .map((d) => ({ key: d.key, label: d.label, dbId: process.env[d.env] ?? "" }))
    .filter((d) => d.dbId);
}

async function fetchNotion() {
  const token = process.env.NOTION_TOKEN;
  const dbs = notionDbs();
  if (!token || dbs.length === 0) {
    return { connected: false as const, dbs: [] };
  }

  const results = await Promise.all(
    dbs.map(async (db) => {
      try {
        const res = await fetch(
          `https://api.notion.com/v1/databases/${db.dbId}/query`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              page_size: 3,
              sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
            }),
            cache: "no-store",
            // Notionが固まってもSupabase表示を道連れにしないよう5秒で打ち切る
            signal: AbortSignal.timeout(5000),
          }
        );
        if (!res.ok) {
          return { key: db.key, label: db.label, ok: false, error: `HTTP ${res.status}` };
        }
        const data = await res.json();
        const rows = Array.isArray(data?.results) ? data.results : [];
        const recent = rows.map((p: Record<string, unknown>) => ({
          last_edited: p.last_edited_time as string | undefined,
          title: extractNotionTitle(p),
        }));
        return {
          key: db.key,
          label: db.label,
          ok: true,
          last_edited: recent[0]?.last_edited ?? null,
          recent,
        };
      } catch (err) {
        console.error(`GET /api/status: Notion DB(${db.key})取得失敗`, err);
        return { key: db.key, label: db.label, ok: false, error: "通信エラー" };
      }
    })
  );

  return { connected: true as const, dbs: results };
}

// Notionページのタイトルプロパティ（型がtitleのもの）から表示名を取り出す。
function extractNotionTitle(page: Record<string, unknown>): string {
  const props = (page.properties ?? {}) as Record<string, { type?: string; title?: Array<{ plain_text?: string }> }>;
  for (const value of Object.values(props)) {
    if (value?.type === "title" && Array.isArray(value.title)) {
      const text = value.title.map((t) => t.plain_text ?? "").join("").trim();
      if (text) return text;
    }
  }
  return "(無題)";
}

// 団体名の表記ゆれを吸収する突合キー。
// 例: 会議記憶は「アトラス情報サービス」、stakeholders マスタは「アトラス情報サービス株式会社」。
// 法人格・空白の有無だけの違いは同じ団体として扱う（それ以上の推測はしない。
// 語順違い（例:「パーソルプロセスビジネスデザイン」と「パーソルビジネスプロセスデザイン」）は
// 別物のまま出す。どちらが正しい社名かはデータを見ないと決められないため）。
function orgKey(name: string): string {
  return name
    .replace(/(株式会社|有限会社|合同会社|一般社団法人|一般財団法人|公益財団法人|公益社団法人)/g, "")
    .replace(/（株）|\(株\)|（有）|\(有\)/g, "")
    .replace(/[\s　]/g, "")
    .toLowerCase();
}

// 団体名 → 正準8分類の対応表を作る。
// 優先度は stakeholders（団体マスタ）> weekly_reports（週報の章立て）。
// weekly_reports の `全体`/`支店`/`プロモーション` は団体の種類ではないため
// normalizeOrgCategory が null を返す → 採用しない。
// 分類は滅多に変わらないので直近の成功結果を10分だけ持つ。
// 取得に失敗したときも古い結果を使い回す（空マップを返すと全団体が「その他」に
// 落ちて「種別未登録」だと誤解させてしまうため）。
const CATEGORY_TTL_MS = 10 * 60 * 1000;

// 突合キー → 分類、および突合キー → 団体マスタ上の正式名。
// 正式名は名寄せ後の表示名を決めるときの最後の拠り所に使う（mergeDuplicateOrgs 参照）。
type OrgLookup = { category: Map<string, OrgCategory>; masterName: Map<string, string> };

let categoryCache: { at: number; lookup: OrgLookup } | null = null;

async function fetchOrgLookup(): Promise<OrgLookup> {
  if (categoryCache && Date.now() - categoryCache.at < CATEGORY_TTL_MS) {
    return categoryCache.lookup;
  }
  const lookup: OrgLookup = { category: new Map(), masterName: new Map() };
  const map = lookup.category;
  const c = anonCreds(); // stakeholders / weekly_reports は anon に SELECT 許可済み
  if (!c) return categoryCache?.lookup ?? lookup;

  // 失敗は null で返す（空配列＝「0件だった」と区別する。片方だけ取れた
  // 中途半端なマップをキャッシュに焼き付けると、銀行や議員が丸ごと「その他」に
  // 落ちた状態が10分固定される）。
  async function rows(path: string): Promise<Array<Record<string, unknown>> | null> {
    try {
      const res = await fetch(`${c!.url}/rest/v1/${path}`, {
        headers: restHeaders(c!.key),
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const json = await res.json();
      return Array.isArray(json) ? json : null;
    } catch (err) {
      console.error(`GET /api/status: 分類の取得失敗 (${path})`, err);
      return null;
    }
  }

  const [weekly, stakeholders] = await Promise.all([
    rows("weekly_reports?select=organization,category&organization=not.is.null&limit=2000"),
    rows("stakeholders?select=name,category&limit=2000"),
  ]);

  // 弱い方（週報）から入れて、強い方（団体マスタ）で上書きする
  for (const r of weekly ?? []) {
    const name = typeof r.organization === "string" ? r.organization.trim() : "";
    const cat = normalizeOrgCategory(r.category);
    if (name && cat) map.set(orgKey(name), cat);
  }
  for (const r of stakeholders ?? []) {
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const cat = normalizeOrgCategory(r.category);
    if (name && cat) map.set(orgKey(name), cat);
    if (name) lookup.masterName.set(orgKey(name), name);
  }

  // 2本とも取れたときだけ「正しい表」としてキャッシュする。
  if (weekly !== null && stakeholders !== null) {
    categoryCache = { at: Date.now(), lookup };
    return lookup;
  }
  // 取り逃しあり。古くても前回の完全な表を使い、無ければ取れた分で妥協する。
  return categoryCache?.lookup ?? lookup;
}

// RPC の org_status は「会議記憶の organization」と「stakeholders.name」を
// 素の文字列でUNIONしているため、法人格の有無だけが違う同じ団体が2行に割れる
// （例:「エイジェック」会議5 と「株式会社エイジェック」会議0）。ここで畳む。
//
// ★表示名の決め方が肝★
// 「提案→」「壁打ち→」のリンクは ?org=<団体名> を下流へ渡し、下流は
// memory_chunks.organization の *完全一致* で記憶を引く（lib/organizations.ts）。
// そのため会議記録を持っている方の表記を残さないと、提案エージェントが
// 「記憶0件」で空振りする。会議数が多い表記を正とし、全て0件のときだけ
// 団体マスタの正式名を使う（どれも空振りしないので、見栄えの良い方を選ぶ）。
type OrgStatusRow = Record<string, unknown> & { name?: unknown; meetings?: unknown };

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mergeDuplicateOrgs(list: OrgStatusRow[], masterName: Map<string, string>): OrgStatusRow[] {
  const groups = new Map<string, OrgStatusRow[]>();
  for (const row of list) {
    const name = typeof row.name === "string" ? row.name : "";
    const key = orgKey(name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const merged: OrgStatusRow[] = [];
  for (const [key, rows] of groups) {
    if (rows.length === 1) {
      merged.push(rows[0]);
      continue;
    }
    // 会議数が最多の表記を代表にする（同数なら先に出てきた方＝RPCの並び順）
    const lead = rows.reduce((a, b) => (num(b.meetings) > num(a.meetings) ? b : a));
    const meetings = rows.reduce((sum, r) => sum + num(r.meetings), 0);
    // 全部0件なら下流が空振りしないので、マスタの正式名を優先して見せる
    const name =
      meetings === 0 ? masterName.get(key) ?? (lead.name as string) : (lead.name as string);
    // 最終接点は 'YYYY-MM-DD' 文字列。null を除いて辞書順の最大＝最新。
    const lastMeeting = rows
      .map((r) => (typeof r.last_meeting === "string" ? r.last_meeting : null))
      .filter((d): d is string => !!d)
      .sort()
      .pop() ?? null;

    merged.push({
      ...lead,
      name,
      meetings,
      last_meeting: lastMeeting,
      has_proposal: rows.some((r) => r.has_proposal === true),
      has_refine: rows.some((r) => r.has_refine === true),
    });
  }

  // 畳んだ結果で会議数が変わるので、RPCと同じ「提案がまだ→会議が多い順」に並べ直す。
  return merged.sort(
    (a, b) =>
      Number(a.has_proposal === true) - Number(b.has_proposal === true) ||
      num(b.meetings) - num(a.meetings)
  );
}

export async function GET() {
  const c = serviceCreds();
  if (!c) {
    return NextResponse.json(
      { ok: false, error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }

  try {
    const [supaRes, notion, orgLookup] = await Promise.all([
      fetch(`${c.url}/rest/v1/rpc/dashboard_stats`, {
        method: "POST",
        headers: {
          apikey: c.key,
          Authorization: `Bearer ${c.key}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        cache: "no-store",
      }),
      fetchNotion(),
      fetchOrgLookup(),
    ]);

    if (!supaRes.ok) {
      const text = await supaRes.text().catch(() => "");
      return NextResponse.json(
        { ok: false, error: `Supabase接続エラー (${supaRes.status})`, detail: text.slice(0, 300) },
        { status: 502 }
      );
    }

    const stats = await supaRes.json();

    // 「次に攻める団体」を整える。順番に意味がある:
    //   1. 法人格違いで割れた同一団体を畳む（mergeDuplicateOrgs）
    //   2. そのうえで種別を付ける。突合できない団体は「その他」。
    //      自治体らしい名前だからといって自治体に寄せる推測はしない（捏造防止）。
    // 1→2 の順にするのは、畳んだ後の代表名で分類を引き直すため（同じ突合キーなので
    // 結果は変わらないが、名前と分類が必ず同じ行の情報で揃う）。
    if (stats && Array.isArray(stats.org_status)) {
      stats.org_status = mergeDuplicateOrgs(stats.org_status, orgLookup.masterName).map((o) => {
        const name = typeof o.name === "string" ? o.name : "";
        return { ...o, category: orgLookup.category.get(orgKey(name)) ?? "その他" };
      });
    }

    return NextResponse.json({ ok: true, stats, notion });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "Supabaseへの接続に失敗しました", detail: String(e).slice(0, 200) },
      { status: 502 }
    );
  }
}

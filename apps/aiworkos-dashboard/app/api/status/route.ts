import { NextResponse } from "next/server";

// 監視ダッシュボード用エンドポイント。
// Supabase側は集計RPC(dashboard_stats)を anonキーで叩き、件数・最終時刻のみ受け取る。
// Notion側は NOTION_TOKEN が設定されていれば各DBの「最新の更新」を読み、未設定なら休眠のまま返す。

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
      } catch {
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

export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { ok: false, error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }

  try {
    const [supaRes, notion] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/rpc/dashboard_stats`, {
        method: "POST",
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        cache: "no-store",
      }),
      fetchNotion(),
    ]);

    if (!supaRes.ok) {
      const text = await supaRes.text().catch(() => "");
      return NextResponse.json(
        { ok: false, error: `Supabase接続エラー (${supaRes.status})`, detail: text.slice(0, 300) },
        { status: 502 }
      );
    }

    const stats = await supaRes.json();
    return NextResponse.json({ ok: true, stats, notion });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "Supabaseへの接続に失敗しました", detail: String(e).slice(0, 200) },
      { status: 502 }
    );
  }
}

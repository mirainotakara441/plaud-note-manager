import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";
import { notionToken } from "@/lib/notionContacts";

// 「次に攻める団体」から団体を外す／戻す。
//
// ★これは削除ではない★
//   Notion「顧客CRM」の`ステータス`を「対象外」にするだけ。ページも名刺（人脈DB）も
//   会議記録も消えない。ステータスを空に戻せば一覧に復活する。
//   団体ページを消してしまうと、そこに紐づいた名刺の「この人はどこの会社の人か」が
//   失われるため、あえて除外方式にしている。
//
// 正はNotion:
//   Supabaseの写し（notion_organizations）は /api/cron/notion-sync が毎時
//   Notionから全件洗い直す。写しにだけ書いても次の同期で上書きされるので、
//   必ずNotion側を先に更新すること。
//   そのうえで写しも即座に書き換える（ライトスルー）。次の同期を待たずに
//   画面と実態を合わせるため。写しへの反映に失敗してもNotion側は正しいので、
//   その場合は warning を付けて返す（成功を装わない）。
//
// トークンは lib/notionTodos.ts / lib/notionContacts.ts と同じ notionToken() を使う
// （.env.local の NOTION_TOKEN → 無ければ Supabase app_config へフォールバック）。
// 値はログにも例外メッセージにも絶対に載せない。

export const dynamic = "force-dynamic";

const TABLE = "notion_organizations";
const EXCLUDED = "対象外";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const TIMEOUT_MS = 12000;

// Notionのページ ID（ハイフン有無どちらの表記も来うる）。
// 任意の文字列をそのままURLに載せてPATCHしないための入口チェック。
const PAGE_ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

type OrgRow = { notion_page_id: string; name: string; category: string | null; status: string | null };

// ── GET: 対象外にした団体の一覧 ──────────────────────────
// 画面の「対象外にした団体（N）」に出して、そこから「戻す」を押せるようにする。
export async function GET() {
  const c = anonCreds();
  if (!c) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }
  try {
    const res = await fetch(
      `${c.url}/rest/v1/${TABLE}?select=notion_page_id,name,category,status` +
        `&status=eq.${encodeURIComponent(EXCLUDED)}&order=name.asc&limit=2000`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("GET /api/status/exclude: 取得失敗", res.status, t.slice(0, 300));
      return NextResponse.json({ error: "対象外の一覧を取得できませんでした" }, { status: 502 });
    }
    const rows: OrgRow[] = await res.json();
    return NextResponse.json({
      ok: true,
      orgs: (Array.isArray(rows) ? rows : []).map((r) => ({
        notion_page_id: r.notion_page_id,
        name: r.name,
        category: r.category,
      })),
    });
  } catch (err) {
    console.error("GET /api/status/exclude: 取得失敗", err);
    return NextResponse.json({ error: "通信エラーが発生しました" }, { status: 502 });
  }
}

// ── POST: 対象外にする / 戻す ────────────────────────────
// body: { notion_page_id: string, exclude: boolean }
export async function POST(req: NextRequest) {
  const c = serviceCreds();
  if (!c) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }

  let body: { notion_page_id?: unknown; exclude?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/status/exclude: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const pageId = typeof body.notion_page_id === "string" ? body.notion_page_id.trim() : "";
  const exclude = body.exclude === true;
  if (!PAGE_ID_RE.test(pageId)) {
    return NextResponse.json(
      { error: "Notion顧客CRMのページIDが必要です" },
      { status: 400 }
    );
  }

  try {
    // ①写しで実在確認。顧客CRMに載っていないIDを更新しに行かせない
    //   （画面から渡ってくる値でNotionの任意ページを書き換えられるのを防ぐ）。
    const look = await fetch(
      `${c.url}/rest/v1/${TABLE}?select=notion_page_id,name,category,status` +
        `&notion_page_id=eq.${encodeURIComponent(pageId)}&limit=1`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!look.ok) {
      const t = await look.text().catch(() => "");
      console.error("POST /api/status/exclude: 団体照会失敗", look.status, t.slice(0, 300));
      return NextResponse.json({ error: "団体の照会に失敗しました" }, { status: 502 });
    }
    const rows: OrgRow[] = await look.json();
    const org = Array.isArray(rows) ? rows[0] : undefined;
    if (!org) {
      return NextResponse.json(
        { error: "Notion顧客CRMに未登録のため、ここからは操作できません" },
        { status: 404 }
      );
    }

    const token = await notionToken();
    if (!token) {
      return NextResponse.json(
        { error: "Notionトークンが取得できないため更新できません（NOTION_TOKEN / app_config）" },
        { status: 500 }
      );
    }

    // ②Notion（正）を更新する。`ステータス`は select 型なので { select: ... }。
    //   戻すときは { select: null } で空欄にする（{} や空文字は 400 になる）。
    const nextStatus = exclude ? EXCLUDED : null;
    const nres = await fetch(`${NOTION_API}/pages/${pageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: { ステータス: exclude ? { select: { name: EXCLUDED } } : { select: null } },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!nres.ok) {
      // 応答本文にトークンは載らないが、念のため長さを切る。
      const t = await nres.text().catch(() => "");
      console.error("POST /api/status/exclude: Notion更新失敗", nres.status, t.slice(0, 300));
      return NextResponse.json(
        { error: `Notionの更新に失敗しました (${nres.status})。画面の表示は変えていません` },
        { status: 502 }
      );
    }

    // ③写しにも同じ値を入れる（ライトスルー）。次の毎時同期を待たずに
    //   dashboard_stats の結果と画面を合わせるため。Notionは既に正しいので、
    //   ここが落ちても操作自体は成立している（warningで正直に伝える）。
    const up = await fetch(
      `${c.url}/rest/v1/${TABLE}?notion_page_id=eq.${encodeURIComponent(pageId)}`,
      {
        method: "PATCH",
        headers: restHeaders(c.key, { Prefer: "return=minimal" }),
        body: JSON.stringify({ status: nextStatus }),
        cache: "no-store",
      }
    );
    if (!up.ok) {
      const t = await up.text().catch(() => "");
      console.error("POST /api/status/exclude: 写しへの反映失敗", up.status, t.slice(0, 300));
      return NextResponse.json({
        ok: true,
        name: org.name,
        excluded: exclude,
        warning:
          "Notionは更新しましたが、画面への反映は次の同期（毎時）までかかることがあります",
      });
    }

    return NextResponse.json({ ok: true, name: org.name, excluded: exclude });
  } catch (err) {
    console.error("POST /api/status/exclude: 更新失敗", err);
    return NextResponse.json({ error: "更新に失敗しました" }, { status: 502 });
  }
}

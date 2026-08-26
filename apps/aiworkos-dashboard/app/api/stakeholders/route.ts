import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";
import { STAKEHOLDER_CATEGORIES, isOrgCategory } from "@/lib/categories";
import { notionToken, notionCreateOrgPage } from "@/lib/notionContacts";
import {
  compareOrgByContact,
  fetchMeetingOrganizations,
  fetchWeeklyRows,
} from "@/lib/organizations";

// 団体マスタ。カテゴリー→具体名の2段階選択に使う。
//
// 2026-07-30に「Notionを正」へ切り替えた。
//   読み取り: Supabase notion_organizations（Notion「顧客CRM」の写し）
//   書き込み: Notion「顧客CRM」へページを作り（ライトスルー）、同時に写しへも入れる
//
// 旧 public.stakeholders はもう読まないし書かない。写しは /api/cron/notion-sync が
// 毎時まるごと洗い直すため、Supabase側にだけ書いた行は次の同期で消える。
// だからここでNotionへの書き込みを省いてはいけない（省くと「追加したのに勝手に消える」
// という一番タチの悪い壊れ方になる）。
//
// 値は正準8分類（lib/categories.ts）。Notion「顧客CRM」の`種別`セレクトには旧分類の
// `企業` も選択肢として残っているが、ここから新規に書くことはしない。

export const CATEGORIES = STAKEHOLDER_CATEGORIES;

const TABLE = "notion_organizations";

type Row = { category: string | null; name: string };

export async function GET() {
  const c = anonCreds();
  if (!c) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }
  try {
    // category が null の団体（Notionで種別未設定）は選択肢に出しようがないので除く。
    // 並び順は取らず、下で接点の多さ順に振り直す（2026-08-26）。
    const res = await fetch(
      `${c.url}/rest/v1/${TABLE}?select=category,name&category=not.is.null&limit=2000`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!res.ok) return NextResponse.json({ byCategory: {} });
    const rows: Row[] = await res.json();

    const byCategory: Record<string, string[]> = {};
    for (const cat of CATEGORIES) byCategory[cat] = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r.category) continue;
      if (!byCategory[r.category]) byCategory[r.category] = [];
      byCategory[r.category].push(r.name);
    }

    // 議事録・成果物を登録する画面のプルダウンは、自治体だけで20件超あり、
    // 五十音順（データ上は文字コード順で、実際の読みとは一致しない——地名の
    // ふりがなを持っていないため）で並べても目当ての相手を探しにくいという
    // 指摘を受けた（2026-08-26）。/organizations の団体セレクタと同じ
    // 「接点の多さ順」（会議件数＋週報週数、同数はja比較）に揃える。
    // 落ちても名前一覧自体は出したいので、失敗時は元の並びのまま返す。
    try {
      const [meetingOrgs, weeklyRows] = await Promise.all([
        fetchMeetingOrganizations(c.url, c.key),
        fetchWeeklyRows(c.url, c.key),
      ]);
      const score = new Map<string, { count: number; weeklyCount: number }>();
      for (const o of meetingOrgs) {
        if (!o?.name) continue;
        score.set(o.name, { count: o.count ?? 0, weeklyCount: 0 });
      }
      for (const r of weeklyRows) {
        const cur = score.get(r.organization) ?? { count: 0, weeklyCount: 0 };
        cur.weeklyCount += 1;
        score.set(r.organization, cur);
      }
      for (const cat of Object.keys(byCategory)) {
        byCategory[cat].sort((a, b) =>
          compareOrgByContact(
            { name: a, ...(score.get(a) ?? { count: 0, weeklyCount: 0 }) },
            { name: b, ...(score.get(b) ?? { count: 0, weeklyCount: 0 }) }
          )
        );
      }
    } catch (err) {
      console.error("GET /api/stakeholders: 接点順の並び替えに失敗（元の並びのまま返す）", err);
    }

    return NextResponse.json({ byCategory });
  } catch (err) {
    console.error("GET /api/stakeholders: 取得失敗", err);
    return NextResponse.json({ byCategory: {} });
  }
}

export async function POST(req: NextRequest) {
  const c = serviceCreds();
  if (!c) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }

  let body: { category?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch (err) {
    console.error("POST /api/stakeholders: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const category = typeof body.category === "string" ? body.category : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!isOrgCategory(category) || !name) {
    return NextResponse.json({ error: "カテゴリーと名前が必要です" }, { status: 400 });
  }

  try {
    // 同名の団体が既にあればNotionページを作らない。
    // ここを省くと、追加ボタンを2回押すたびにNotion側に重複ページが増える。
    const dup = await fetch(
      `${c.url}/rest/v1/${TABLE}?select=name,category&name=eq.${encodeURIComponent(name)}&limit=1`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (dup.ok) {
      const rows: Row[] = await dup.json();
      if (Array.isArray(rows) && rows.length > 0) {
        // 種別が違っていてもNotion側の値を正とし、ここでは上書きしない。
        return NextResponse.json({
          added: false,
          already: true,
          category: rows[0].category ?? category,
          name,
        });
      }
    }

    const token = await notionToken();
    if (!token) {
      return NextResponse.json(
        { error: "Notionトークンが取得できないため追加できません" },
        { status: 500 }
      );
    }

    // ①Notion（正）へ作る
    const row = await notionCreateOrgPage(token, { name, category });

    // ②写しへも入れる。次の同期を待たずに選択肢へ出すため。
    // ここが失敗してもNotion側には作れているので、次の同期で写しに追いつく。
    const up = await fetch(`${c.url}/rest/v1/${TABLE}?on_conflict=notion_page_id`, {
      method: "POST",
      headers: restHeaders(c.key, {
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify([{ ...row, synced_at: new Date().toISOString() }]),
      cache: "no-store",
    });
    if (!up.ok) {
      const t = await up.text().catch(() => "");
      console.error("POST /api/stakeholders: 写しへの反映に失敗", up.status, t.slice(0, 300));
      return NextResponse.json({
        added: true,
        category,
        name,
        warning: "Notionには追加しましたが、画面への反映は次の同期までかかります",
      });
    }

    return NextResponse.json({ added: true, category, name });
  } catch (err) {
    console.error("POST /api/stakeholders: 追加失敗", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "追加に失敗しました" },
      { status: 502 }
    );
  }
}

import { NextResponse } from "next/server";
import { anonCreds, serviceCreds } from "@/lib/supabase";
import {
  fetchDeliverables,
  fetchMeetings,
  fetchRelatedDiaries,
  fetchWeeklyReports,
  meetingsToEntries,
  deliverablesToEntries,
  weeklyReportsToEntries,
  sortByDateDesc,
} from "@/lib/organizations";

// 団体別攻略／タイムライン：会議（org-history）・成果物（memory_chunks 直叩き）・
// 週報（weekly_reports、organization ILIKE 部分一致）を統合し、日付降順の
// タイムラインとして返す。日記は search-memory の意味検索で「関連しそうな日記」
// として別枠を返す（失敗しても他セクションに影響しないよう握りつぶす）。
//
// 取得・名寄せロジックの実体は lib/organizations.ts にあり、
// 「タイムライン以外」を返す /api/organizations/profile と共有している。
//
// memory_chunks は RLS で anon の SELECT を許可していないため、必ず
// serviceCreds() を使う。weekly_reports は anon に SELECT を許可しているため
// anonCreds() でよい。Edge Function（org-history / search-memory）は
// これまで通り anon キーを Bearer トークンとして呼ぶ。

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const org = searchParams.get("org")?.trim();
  if (!org) {
    return NextResponse.json({ error: "org は必須です" }, { status: 400 });
  }

  const anon = anonCreds();
  const service = serviceCreds();
  if (!anon || !service) {
    return NextResponse.json(
      { error: "サーバー設定エラー: 環境変数が設定されていません" },
      { status: 500 }
    );
  }

  try {
    const [meetings, deliverables, weeklyReports] = await Promise.all([
      fetchMeetings(anon.url, anon.key, org),
      fetchDeliverables(service.url, service.key, org),
      fetchWeeklyReports(anon.url, anon.key, org),
    ]);

    const timeline = sortByDateDesc([
      ...meetingsToEntries(meetings),
      ...deliverablesToEntries(deliverables),
      ...weeklyReportsToEntries(weeklyReports),
    ]);

    // 意味検索は失敗しても他が壊れないよう独立して呼ぶ
    const relatedDiaries = await fetchRelatedDiaries(anon.url, anon.key, org);

    return NextResponse.json({ organization: org, timeline, relatedDiaries });
  } catch (error) {
    console.error("団体別タイムライン取得エラー:", error);
    return NextResponse.json(
      { error: "団体別タイムラインの取得でエラーが発生しました" },
      { status: 502 }
    );
  }
}

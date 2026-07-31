import { NextResponse } from "next/server";
import { anonCreds, serviceCreds } from "@/lib/supabase";
import {
  buildLegislators,
  buildMatchKeys,
  fetchLegislatorChunks,
  fetchLegislatorContacts,
  fetchLegislatorNotes,
  fetchLegislatorTodos,
  fetchLegislatorWeeklyReports,
  longTextSearchTerms,
  type LegislatorPayload,
} from "@/lib/legislators";

// 議員リスト（/legislators）の読み取りAPI。
//
// 名簿（notion_contacts）・履歴（weekly_reports / memory_chunks）・
// 予定（strategic_todos）・手書きメモ（legislator_notes）を1回で返す。
// 議員は8名前後、記録も数十件と小さいので、突合はここでまとめて済ませ、
// 画面側は絞り込みと表示だけを行う（iPhoneでの切り替えを速くするため）。
//
// 突合ルールと議会種別の導出ルールは lib/legislators.ts のコメント参照。
//
// memory_chunks は RLS で anon の SELECT を許可していないため serviceCreds()。
// それ以外は anon に SELECT を許可しているため anonCreds()。
//
// ★このAPIは読み取り専用★ notion_contacts は毎時のNotion同期で
// 「Notionに無い行は削除」されるため、議員の追加はNotion側で行う運用。

export const dynamic = "force-dynamic";

export async function GET() {
  const anon = anonCreds();
  const service = serviceCreds();
  if (!anon || !service) {
    return NextResponse.json(
      { error: "サーバー設定エラー: 環境変数が設定されていません" },
      { status: 500 }
    );
  }

  try {
    const [contacts, weekly, todos, notes] = await Promise.all([
      fetchLegislatorContacts(anon.url, anon.key),
      fetchLegislatorWeeklyReports(anon.url, anon.key),
      fetchLegislatorTodos(anon.url, anon.key),
      fetchLegislatorNotes(anon.url, anon.key),
    ]);

    // memory_chunks は氏名・表記ゆれ・議連名で先に絞ってから取る（全件は取らない）
    const keysList = contacts.map((c) =>
      buildMatchKeys({
        name: c.name,
        faction: c.org_name?.trim() || "会派未設定",
        assembly: c.department?.trim() || "",
        title: c.title,
      })
    );
    const chunks = await fetchLegislatorChunks(
      service.url,
      service.key,
      longTextSearchTerms(keysList)
    ).catch((error) => {
      // 記憶の検索が落ちても、名簿・週報・予定は出せるようにする
      console.error("議員リスト: memory_chunks 取得エラー:", error);
      return [];
    });

    const { legislators, unmatched, matchedChunkIds } = buildLegislators(
      contacts,
      weekly,
      todos,
      chunks
    );

    const payload: LegislatorPayload = {
      legislators,
      unmatched,
      notes,
      counts: {
        contacts: contacts.length,
        weeklyTotal: weekly.length,
        weeklyMatched: weekly.length - unmatched.filter((u) => u.kind === "週報").length,
        todoTotal: todos.length,
        todoMatched: todos.length - unmatched.filter((u) => u.kind === "予定").length,
        chunkMatched: matchedChunkIds.size,
      },
    };
    return NextResponse.json(payload);
  } catch (error) {
    console.error("議員リスト取得エラー:", error);
    return NextResponse.json(
      { error: "議員リストの取得でエラーが発生しました" },
      { status: 502 }
    );
  }
}

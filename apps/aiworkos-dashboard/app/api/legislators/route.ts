import { NextResponse } from "next/server";
import { anonCreds, serviceCreds } from "@/lib/supabase";
import {
  buildLegislators,
  buildMatchKeys,
  fetchCandidates,
  fetchLegislatorChunks,
  fetchLegislatorContacts,
  fetchLegislatorNotes,
  fetchLegislatorTodos,
  fetchLegislatorWeeklyReports,
  longTextSearchTerms,
  mergeCandidates,
  type LegislatorPayload,
} from "@/lib/legislators";

// 議員リスト（/legislators）の読み取りAPI。
//
// 接点あり名簿（notion_contacts）・候補名簿（legislators）・
// 履歴（weekly_reports / memory_chunks）・予定（strategic_todos）・
// 手書きメモ（legislator_notes）を1回で返す。
// 議員は接点あり8名＋候補34名、記録も数十件と小さいので、突合はここで
// まとめて済ませ、画面側は絞り込みと表示だけを行う
// （iPhoneでのタブ・軸の切り替えを速くするため）。
//
// 突合ルール・議会種別の導出・名寄せは lib/legislators.ts のコメント参照。
//
// memory_chunks は RLS で anon の SELECT を許可していないため serviceCreds()。
// それ以外（legislators を含む）は anon に SELECT を許可しているため anonCreds()。
//
// ★このAPIは読み取り専用★ notion_contacts は毎時のNotion同期で
// 「Notionに無い行は削除」されるため、接点ありの議員の追加はNotion側で行う運用。
// 候補リスト（legislators）はこの画面からは書き換えない（表示のみ）。

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
    const [contacts, weekly, todos, notes, candidateRows] = await Promise.all([
      fetchLegislatorContacts(anon.url, anon.key),
      fetchLegislatorWeeklyReports(anon.url, anon.key),
      fetchLegislatorTodos(anon.url, anon.key),
      fetchLegislatorNotes(anon.url, anon.key),
      fetchCandidates(anon.url, anon.key),
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

    const built = buildLegislators(contacts, weekly, todos, chunks);
    const { unmatched, matchedChunkIds } = built;

    // 候補リストのうち contact_page_id で人脈DBに紐付く人は接点あり側へ畳む。
    // 同じ人が「接点あり」と「候補」の両方に出ないようにするため。
    const { legislators, candidates, linked } = mergeCandidates(
      built.legislators,
      candidateRows
    );

    const payload: LegislatorPayload = {
      legislators,
      candidates,
      unmatched,
      notes,
      counts: {
        contacts: contacts.length,
        weeklyTotal: weekly.length,
        weeklyMatched: weekly.length - unmatched.filter((u) => u.kind === "週報").length,
        todoTotal: todos.length,
        todoMatched: todos.length - unmatched.filter((u) => u.kind === "予定").length,
        chunkMatched: matchedChunkIds.size,
        candidateTotal: candidateRows.length,
        candidateLinked: linked,
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

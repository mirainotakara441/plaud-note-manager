import { NextResponse } from "next/server";
import { anonCreds, restHeaders } from "@/lib/supabase";

// SALT2人脈DB（/salt2）の読み取りAPI。
//
// 56行（名簿全体136名のうち自己紹介を投稿した人）と小さいので、全件を1回で返し、
// 横断検索・タグ・会社・トラックの絞り込みはブラウザ側で行う（家庭訪問と同じ流儀）。
// 打つたびにサーバーへ問い合わせないぶん、検索語を消したり足したりが速い。
//
// salt2_members は RLS で anon に SELECT を許可しているため anonCreds()。
// ★このAPIは読み取り専用★ 名簿の追加投入（未投稿者80名ぶん）は
// Slackからの取込側で service role を使って upsert する運用。

export const dynamic = "force-dynamic";

const COLUMNS = [
  "id",
  "name",
  "kana",
  "slack_display",
  "email",
  "company",
  "role",
  "career",
  "ai_usage",
  "goal",
  "hobbies",
  "personal",
  "note",
  "track",
  // 絞り込みに使う正準タグ3系統（Notionと同じ語彙）
  "industry_tags",
  "stance_tags",
  "hobby_tags",
  // 生タグ・生の趣味・自己紹介の原文はフリーワード検索と詳細表示のため
  "tags",
  "raw_intro",
  "posted_at",
].join(",");

export async function GET() {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  try {
    const res = await fetch(
      `${c.url}/rest/v1/salt2_members?select=${COLUMNS}&order=name.asc,id.asc`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`名簿の取得に失敗しました（${res.status}）${detail.slice(0, 120)}`);
    }
    const members = await res.json();
    return NextResponse.json({ members });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "取得に失敗しました" },
      { status: 502 }
    );
  }
}

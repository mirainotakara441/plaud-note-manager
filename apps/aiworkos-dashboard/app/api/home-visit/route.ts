import { NextResponse } from "next/server";
import { anonCreds, restHeaders } from "@/lib/supabase";

// 家庭訪問（ライフOS）：メンバーと訪問履歴をまとめて返す。
// 人ベースで見るページなので、両方を1回で渡して結合はクライアント側で行う
// （メンバー百人規模・履歴も年数百件のオーダーなので、分割取得の必要が無い）。

export const dynamic = "force-dynamic";

const MEMBER_COLUMNS = [
  "id",
  "name",
  "division",
  "district",
  "block",
  "role",
  "birth_date",
  "age_manual",
  "note",
  "active",
  "sort_order",
].join(",");

const LOG_COLUMNS = ["id", "member_id", "visit_date", "met", "topics", "next_action"].join(",");

async function fetchTable(url: string, key: string, label: string) {
  const res = await fetch(url, { headers: restHeaders(key), cache: "no-store" });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${label}の取得に失敗しました（${res.status}）${detail.slice(0, 120)}`);
  }
  return res.json();
}

export async function GET() {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  try {
    const [members, logs] = await Promise.all([
      fetchTable(
        `${c.url}/rest/v1/home_visit_members?select=${MEMBER_COLUMNS}&order=sort_order.asc,id.asc`,
        c.key,
        "メンバー"
      ),
      fetchTable(
        `${c.url}/rest/v1/home_visit_logs?select=${LOG_COLUMNS}&order=visit_date.desc,id.desc`,
        c.key,
        "訪問履歴"
      ),
    ]);
    return NextResponse.json({ members, logs });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "取得に失敗しました" },
      { status: 502 }
    );
  }
}

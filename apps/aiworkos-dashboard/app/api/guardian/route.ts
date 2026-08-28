import { NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { buildGuardianRows, summarize, GUARDIAN_SELECT, type HeartbeatRow } from "@/lib/guardian";

// OS Guardian（第1弾・可視化のみ）のデータ。
//
// job_heartbeats を読むだけ。書き込みも、ジョブの起動も、リトライもしない。
// 判定は lib/guardian.ts に置いてある（閾値の正は lib/advisor/watchlist.ts）。
//
// service role が要る: job_heartbeats は RLS 有効・ポリシー無しで、anon では
// 空配列が返る（＝「ジョブが1本も無い」に見えてしまう。監視としては最悪の壊れ方）。
// /api/advisor が同じ理由で serviceCreds を使っているのと同じ。
//
// ★取得に失敗したら必ずエラーで返す。空配列にフォールバックしない。
//   「ジョブが0本」と「読めなかった」を同じ見た目にすると、監視が沈黙したことに
//   気づけなくなる（このアプリで何度も踏んでいる型のバグ）。

export const dynamic = "force-dynamic";

export async function GET() {
  const c = serviceCreds();
  if (!c) {
    return NextResponse.json(
      { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }

  try {
    const res = await fetch(
      `${c.url}/rest/v1/job_heartbeats?select=${GUARDIAN_SELECT}&limit=200`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("job_heartbeats取得エラー:", res.status, detail.slice(0, 300));
      return NextResponse.json({ error: `取得失敗 ${res.status}` }, { status: 502 });
    }

    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) {
      console.error("job_heartbeats: 配列ではない応答", String(raw).slice(0, 200));
      return NextResponse.json({ error: "取得失敗（応答の形が不正）" }, { status: 502 });
    }

    const now = new Date();
    const rows = buildGuardianRows(raw as HeartbeatRow[], now);

    return NextResponse.json({
      checked_at: now.toISOString(),
      rows,
      summary: summarize(rows),
    });
  } catch (err) {
    console.error("GET /api/guardian: 取得失敗", err);
    return NextResponse.json({ error: "ジョブの状態を取得できませんでした" }, { status: 502 });
  }
}

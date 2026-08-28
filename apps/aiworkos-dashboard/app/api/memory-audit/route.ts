import { NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { auditMemory, AUDIT_SELECT, type AuditRow } from "@/lib/memoryAudit";

// 記憶（memory_chunks）の健康診断。読むだけ。
//
// 直さない・消さない・名寄せしない・再Embeddingしない。判定は lib/memoryAudit.ts。
//
// service role が要る: memory_chunks は RLS で anon の SELECT を許可していない
// （anon では空配列が返り、「記憶が0件」に見えてしまう）。
//
// ★取得に失敗したら必ずエラーで返す。空配列にフォールバックしない。
//   「不整合ゼロ」と「読めなかった」が同じ見た目になるのが、監査として最悪の壊れ方。

export const dynamic = "force-dynamic";

// ★PostgREST にはサーバ側の最大行数（このプロジェクトでは1000）があり、
//   limit を大きくしても黙って切られる。実際 limit=5000 で 1458件中1000件しか
//   返らないのに「全部見た」と誤報した（2026-08-28、実装中に発覚）。
//   件数を過少に見せるのは監査として最悪なので、Range ヘッダで明示的に
//   ページングし、Content-Range の総数と突き合わせて取り切れたかを確認する。
const PAGE = 1000;
/** 安全弁。これを超える規模になったら、その旨を画面に出して打ち切る。 */
const MAX_ROWS = 20000;

export async function GET() {
  const c = serviceCreds();
  if (!c) {
    return NextResponse.json(
      { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
      { status: 500 }
    );
  }

  try {
    const rows: AuditRow[] = [];
    let expected: number | null = null;

    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const res = await fetch(
        // order を固定しないとページ間で行が重複・欠落しうる（PostgRESTの既定は不定順）。
        `${c.url}/rest/v1/memory_chunks?select=${AUDIT_SELECT}&order=created_at.asc,id.asc`,
        {
          headers: {
            ...restHeaders(c.key),
            Range: `${from}-${from + PAGE - 1}`,
            "Range-Unit": "items",
            Prefer: "count=exact",
          },
          cache: "no-store",
        }
      );
      if (!res.ok && res.status !== 206) {
        const detail = await res.text().catch(() => "");
        console.error("memory_chunks取得エラー:", res.status, detail.slice(0, 300));
        return NextResponse.json({ error: `取得失敗 ${res.status}` }, { status: 502 });
      }

      // Content-Range: "0-999/1458" の形で総数が返る。
      const cr = res.headers.get("content-range");
      const totalStr = cr?.split("/")[1];
      if (expected === null && totalStr && totalStr !== "*") {
        expected = Number(totalStr);
      }

      const page: unknown = await res.json();
      if (!Array.isArray(page)) {
        console.error("memory_chunks: 配列ではない応答");
        return NextResponse.json({ error: "取得失敗（応答の形が不正）" }, { status: 502 });
      }
      rows.push(...(page as AuditRow[]));
      if (page.length < PAGE) break;
    }

    // ★取り切れていないなら黙って続けない。数字が嘘になる。
    const truncated = expected !== null && rows.length < expected;
    if (truncated) {
      console.error(`memory-audit: 取り切れていません（${rows.length}/${expected}）`);
    }

    const result = auditMemory(rows, MAX_ROWS);
    return NextResponse.json({
      checked_at: new Date().toISOString(),
      ...result,
      // auditMemory 側の判定より、実際の総数との突合を優先する。
      truncated: truncated || result.truncated,
      expected_total: expected,
    });
  } catch (err) {
    console.error("GET /api/memory-audit: 取得失敗", err);
    return NextResponse.json({ error: "記憶の監査データを取得できませんでした" }, { status: 502 });
  }
}

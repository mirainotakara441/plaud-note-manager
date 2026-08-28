// 検知器：Memory 2.0（同一性の4列）が壊れていないか。
//
// ■ なぜ Guardian ではなくここに置くか
// lib/guardian.ts が見ているのは「ジョブが走ったか・落ちたか」（job_heartbeats）で、
// これはデータそのものの整合性なので種類が違う。通知の出口は既存のものを使う——
// ここが返した Finding は、ホームの「今朝の気づき」（/api/advisor）と
// 朝のPush通知（/api/cron/daily-todo）の両方が拾う。新しい通知の仕組みは作らない。
//
// ■ 判定はここに書かない
// 何を異常とみなすかは lib/memoryHealthFindings.mjs（さらにその中身は
// lib/memoryShadow.mjs の auditShadowColumns）が唯一の正。ここは取ってきて渡すだけ。
// I/Oと判定を分けてあるので、判定は合成データでテストできる（tests/memory-health.mjs）。

import { restHeaders } from "@/lib/supabase";
import { buildMemoryFindings } from "../../memoryHealthFindings.mjs";
import type { Ctx, Detector, Finding } from "../types";

/** PostgREST のサーバ側上限。これを超える分はページを送らないと黙って切られる。 */
const PAGE = 1000;
const MAX_ROWS = 20000;

/** 判定に要る列だけ。content と embedding は重いので取らない。 */
const SELECT =
  "canonical_document_id,source_document_id,chunk_index,ingest_scheme,source_type,created_at";

export type IdentityRow = {
  canonical_document_id: string | null;
  source_document_id: string | null;
  chunk_index: number | null;
  ingest_scheme: string | null;
  source_type: string;
  created_at: string;
};

/**
 * 行を全部取る。**ページングを省かないこと。**
 * memory_chunks は2026-08時点で1458行あり、PostgREST の既定上限1000で
 * 黙って切られる。切られたまま数えると「異常なし」と嘘をつく
 * （lib/advisor/client.ts の getRows はページングしないので使わない）。
 */
async function fetchAll(ctx: Ctx): Promise<{ rows: IdentityRow[]; expected: number | null }> {
  const rows: IdentityRow[] = [];
  let expected: number | null = null;

  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const res = await fetch(
      `${ctx.creds.url}/rest/v1/memory_chunks?select=${SELECT}&order=created_at.asc,id.asc`,
      {
        headers: {
          ...restHeaders(ctx.creds.key),
          Range: `${from}-${from + PAGE - 1}`,
          "Range-Unit": "items",
          Prefer: "count=exact",
        },
        cache: "no-store",
      }
    );
    if (!res.ok && res.status !== 206) {
      const detail = await res.text().catch(() => "");
      throw new Error(`memory_chunks の取得に失敗 (${res.status}) ${detail.slice(0, 120)}`);
    }
    const total = res.headers.get("content-range")?.split("/")[1];
    if (expected === null && total && total !== "*") expected = Number(total);

    const page = (await res.json()) as IdentityRow[];
    if (!Array.isArray(page)) throw new Error("memory_chunks: 配列ではない応答");
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return { rows, expected };
}

async function run(ctx: Ctx): Promise<Finding[]> {
  const { rows, expected } = await fetchAll(ctx);
  const truncated = expected !== null && rows.length < expected;
  if (truncated) {
    console.error(`memory検知器: 取り切れていません（${rows.length}/${expected}）`);
  }
  return buildMemoryFindings(rows, truncated) as Finding[];
}

export const memoryDetector: Detector = { name: "Memory 2.0 の同一性", run };

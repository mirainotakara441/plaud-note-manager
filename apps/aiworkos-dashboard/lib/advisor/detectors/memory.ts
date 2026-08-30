// 検知器：Memory 2.0（同一性の4列）が壊れていないか。
//
// ■ なぜ Guardian ではなくここに置くか
// lib/guardian.ts が見ているのは「ジョブが走ったか・落ちたか」（job_heartbeats）で、
// これはデータそのものの整合性なので種類が違う。通知の出口は既存のものを使う——
// ここが返した Finding は、ホームの「今朝の気づき」（/api/advisor）と
// 朝のPush通知（/api/cron/daily-todo）の両方が拾う。新しい通知の仕組みは作らない。
//
// ■ 全行を運ばない（2026-08-30に直した）
// 最初は memory_chunks の同一性4列を全行取ってきて数えていた。1469行で364KB、
// 取得だけで3.0〜3.6秒かかり、/advisor が11秒を超えてスモークの8秒判定に落ちた。
// 参謀は毎朝の通知にも使うので、ここが重いと通知そのものが遅れる。
//
// いまは DB 側の memory_identity_problems() が**壊れている行だけ**を返す。
// 正常なら0行なので、通信量はほぼゼロ。判定そのもの（何を壊れているとみなすか）は
// アプリ側の auditShadowColumns に残してある——DBとアプリの2か所に判定を持つと、
// 片方だけ直したときに画面と通知で言い分が食い違う。
//
// ■ 判定はここに書かない
// lib/memoryHealthFindings.mjs（→ lib/memoryShadow.mjs の auditShadowColumns）が
// 唯一の正。ここは取ってきて渡すだけ。合成データでのテストは tests/memory-health.mjs。

import { callRpc } from "../client";
import { buildMemoryFindings } from "../../memoryHealthFindings.mjs";
import type { Ctx, Detector, Finding } from "../types";

export type IdentityRow = {
  canonical_document_id: string | null;
  source_document_id: string | null;
  chunk_index: number | null;
  ingest_scheme: string | null;
  source_type: string;
  created_at: string;
};

async function run(ctx: Ctx): Promise<Finding[]> {
  // 正常なら0行。異常があるときだけ、その組に属する行がまとめて返る
  // （衝突なら同じ番号の行を全部、実体またぎならその取り込み文書の行を全部）。
  const rows = await callRpc<IdentityRow>(ctx, "memory_identity_problems", {});
  // 取り切れないことが無い（絞り込み済みなので）ため truncated は常に false。
  return buildMemoryFindings(rows, false) as Finding[];
}

export const memoryDetector: Detector = { name: "Memory 2.0 の同一性", run };

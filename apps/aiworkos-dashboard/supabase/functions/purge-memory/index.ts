// AIワークOS: source_id の前方一致で memory_chunks を削除するエンドポイント。
// memory_chunks は RLS 有効・ポリシー0（anon から直接触れない）ため、削除も
// service role を持つ Edge Function 経由で行う。
//
// 用途: 同じ元データを「チャンクの切り方を変えて」入れ直すとき、古いチャンクが
// source_id のズレで孤児として残るのを防ぐ。入れ直しの直前に呼ぶ。
//   例) 壁打ちの再保存: prefix="refine:{sessionId}" で前回分を一掃してから再登録
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }
  try {
    const { source_id_prefix } = await req.json();

    // 前方一致の削除は取り消せないので、空・非文字列・短すぎる prefix は弾く。
    // うっかり "" や "refine:" で全件消すのを防ぐ最低限のガード。
    if (typeof source_id_prefix !== "string" || source_id_prefix.trim().length < 8) {
      return new Response(
        JSON.stringify({ error: "source_id_prefix (8文字以上の文字列) is required" }),
        { status: 400 },
      );
    }

    // LIKE のワイルドカードを無害化してから前方一致にする
    const escaped = source_id_prefix.replace(/([\\%_])/g, "\\$1");

    const { data, error } = await supabase
      .from("memory_chunks")
      .delete()
      .like("source_id", `${escaped}%`)
      .select("id");

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    return new Response(
      JSON.stringify({ status: "purged", deleted: data?.length ?? 0 }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

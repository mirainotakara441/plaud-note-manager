// memory_chunks の embedding を貼り直すだけの保守用エンドポイント。
// 本文を後から直したとき（音声誤字の一括置換など）にベクトルが古い文言のまま残るのを解消する。
// 行の追加・削除は一切しない。embedding 列だけを更新する。
//
// POST { ids: string[] }        … 指定した id の行だけ貼り直す
// POST { since: "2026-08-04" }  … 指定日以降に作られたバックアップ表と本文が食い違う行を貼り直す（未使用）
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const model = new Supabase.ai.Session("gte-small");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }
  try {
    const { ids } = await req.json();
    if (!Array.isArray(ids) || ids.length === 0) {
      return new Response(JSON.stringify({ error: "ids (string[]) is required" }), { status: 400 });
    }

    const { data: rows, error } = await supabase
      .from("memory_chunks")
      .select("id, title, content")
      .in("id", ids);

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    const updated: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const row of rows ?? []) {
      try {
        // store-memory と同じ埋め込み対象の作り方に揃える
        const textToEmbed = `${row.title}\n\n${row.content}`;
        const embedding = await model.run(textToEmbed, { mean_pool: true, normalize: true });

        const { error: upErr } = await supabase
          .from("memory_chunks")
          .update({ embedding })
          .eq("id", row.id);

        if (upErr) failed.push({ id: row.id, error: upErr.message });
        else updated.push(row.id);
      } catch (e) {
        failed.push({ id: row.id, error: String(e) });
      }
    }

    return new Response(
      JSON.stringify({ requested: ids.length, found: rows?.length ?? 0, updated: updated.length, failed }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

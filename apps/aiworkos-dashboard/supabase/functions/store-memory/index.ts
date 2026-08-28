// AIワークOS Phase 3: テキストを埋め込み化して memory_chunks に保存するエンドポイント
// source_id が既に存在すれば upsert（重複登録を避ける）
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
    const body = await req.json();
    const { source_type, source_id, organization, title, content, event_date, metadata } = body;

    if (!source_type || !title || !content) {
      return new Response(
        JSON.stringify({ error: "source_type, title, content are required" }),
        { status: 400 },
      );
    }

    const textToEmbed = `${title}\n\n${content}`;
    const embedding = await model.run(textToEmbed, { mean_pool: true, normalize: true });

    let query = supabase.from("memory_chunks");
    let result;
    if (source_id) {
      // 同じsource_idがあれば更新、なければ新規作成
      const { data: existing } = await supabase
        .from("memory_chunks")
        .select("id")
        .eq("source_id", source_id)
        .maybeSingle();

      if (existing) {
        result = await supabase
          .from("memory_chunks")
          .update({ source_type, organization, title, content, event_date, metadata, embedding })
          .eq("id", existing.id)
          .select()
          .single();
      } else {
        result = await supabase
          .from("memory_chunks")
          .insert({ source_type, source_id, organization, title, content, event_date, metadata, embedding })
          .select()
          .single();
      }
    } else {
      result = await supabase
        .from("memory_chunks")
        .insert({ source_type, organization, title, content, event_date, metadata, embedding })
        .select()
        .single();
    }

    if (result.error) {
      return new Response(JSON.stringify({ error: result.error.message }), { status: 500 });
    }

    return new Response(JSON.stringify({ id: result.data.id, status: "stored" }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

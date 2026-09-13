// AIワークOS Phase 3: テキストをベクトル化するだけのシンプルなエンドポイント
// Supabase内蔵のgte-small（384次元、無料・ローカル推論）を使う
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const model = new Supabase.ai.Session("gte-small");

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }
  try {
    const { text } = await req.json();
    if (!text || typeof text !== "string") {
      return new Response(JSON.stringify({ error: "text (string) is required" }), { status: 400 });
    }
    const embedding = await model.run(text, { mean_pool: true, normalize: true });
    return new Response(JSON.stringify({ embedding }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

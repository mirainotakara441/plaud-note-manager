// AIワークOS Phase 3: テキストを埋め込み化して memory_chunks に保存するエンドポイント
// source_id が既に存在すれば upsert（重複登録を避ける）
//
// ■ Memory 2.0 の同一性（2026-08-28〜）
// memory_chunks は RLS 有効・ポリシー0で、書き込みはこの関数だけを通る。
// だから同一性の4列（canonical_document_id / source_document_id /
// chunk_index / ingest_scheme）もここで決める。画面の各APIも、
// Claude Code のスキルも、この1か所を通るので個別に直さなくてよい。
//
// 決めるのはこちら側で、caller には決めさせない。caller から受け取るのは
// 「ここでは原理的に決められないもの」だけ——いまのところ deliverable の
// chunk_index ただ1つ。位置の札（text1 / p2-1）は順番がその行だけでは
// 決まらず、兄弟行を数える方式は同時挿入で競合するため。
//
// 導出できない source_id は 422 で落とす。null のまま成功にすると、
// 知らない書式の writer が増えたことに気づけなくなる。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  CALLER_FORBIDDEN_KEYS,
  deriveIdentity,
  identityColumns,
} from "../_shared/identity.mjs";

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
    const chunk_index = body?.chunk_index;

    if (!source_type || !title || !content) {
      return new Response(
        JSON.stringify({ error: "source_type, title, content are required" }),
        { status: 400 },
      );
    }

    // 同一性は Gateway が決める。外から渡された分は受け付けない。
    const forbidden = CALLER_FORBIDDEN_KEYS.filter((k) => k in (body ?? {}));
    if (forbidden.length > 0) {
      return new Response(
        JSON.stringify({
          error: `${forbidden.join(", ")} は指定できません（store-memory が決めます）`,
        }),
        { status: 400 },
      );
    }

    const identity = deriveIdentity({ source_type, source_id, metadata, chunkIndex: chunk_index });
    if (!identity.ingest_scheme) {
      // ★ここを素通りさせない。未知の writer を検知する唯一の場所。
      return new Response(
        JSON.stringify({ error: `同一性を決められません: ${identity.reason}` }),
        { status: 422 },
      );
    }
    if (identity.needsCallerChunkIndex) {
      // ★0 を入れて成功させない。deliverable の位置（text1 / p2-1）は
      //   「何ページ目か」の札であって並び順ではなく、ここでは決められない。
      //   黙って0を入れると、1文書の全チャンクが0番になって版の中で衝突する。
      //   caller が持っているループ index を chunk_index として送ること。
      return new Response(
        JSON.stringify({
          error:
            "chunk_index が必要です（deliverable は 0起点のループindexを送ってください）: " +
            String(source_id).slice(0, 80),
        }),
        { status: 422 },
      );
    }
    const ident = identityColumns(identity);

    const textToEmbed = `${title}\n\n${content}`;
    const embedding = await model.run(textToEmbed, { mean_pool: true, normalize: true });

    let result;
    // 同じsource_idがあれば更新、なければ新規作成
    const { data: existing } = await supabase
      .from("memory_chunks")
      .select("id")
      .eq("source_id", source_id)
      .maybeSingle();

    if (existing) {
      result = await supabase
        .from("memory_chunks")
        // ★UPDATE 側にも4列を入れる。入れ忘れると入れ直しのたびに古い同一性が残る。
        .update({
          source_type,
          organization,
          title,
          content,
          event_date,
          metadata,
          embedding,
          ...ident,
        })
        .eq("id", existing.id)
        .select()
        .single();
    } else {
      result = await supabase
        .from("memory_chunks")
        .insert({
          source_type,
          source_id,
          organization,
          title,
          content,
          event_date,
          metadata,
          embedding,
          ...ident,
        })
        .select()
        .single();
    }

    if (result.error) {
      return new Response(JSON.stringify({ error: result.error.message }), { status: 500 });
    }

    return new Response(
      JSON.stringify({ id: result.data.id, status: "stored", identity: ident }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

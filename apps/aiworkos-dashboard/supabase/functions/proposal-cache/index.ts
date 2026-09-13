// AIワークOS ②提案エージェント: 提案キャッシュのget/set。service_roleでproposal_cacheを読み書きする。
// edited=true は吉井さんが手直しした版。signature が変わって再生成するときも、この版を
// プロンプトに渡して訂正を引き継がせる（手直しが黙って消えないように）。
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
    const body = await req.json().catch(() => ({}));
    const action = typeof body.action === "string" ? body.action : "";
    const organization =
      typeof body.organization === "string" ? body.organization.trim() : "";

    if (!organization) {
      return new Response(JSON.stringify({ error: "organization required" }), {
        status: 400,
      });
    }

    if (action === "get") {
      const { data, error } = await supabase
        .from("proposal_cache")
        .select(
          "organization, signature, proposal, meetings, model, edited, edited_at, updated_at",
        )
        .eq("organization", organization)
        .maybeSingle();
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }
      return new Response(JSON.stringify({ cache: data ?? null }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "set") {
      const signature = typeof body.signature === "string" ? body.signature : "";
      if (!signature || body.proposal === undefined || body.meetings === undefined) {
        return new Response(
          JSON.stringify({ error: "signature, proposal, meetings required" }),
          { status: 400 },
        );
      }
      const edited = body.edited === true;
      const { error } = await supabase.from("proposal_cache").upsert(
        {
          organization,
          signature,
          proposal: body.proposal,
          meetings: body.meetings,
          model: typeof body.model === "string" ? body.model : null,
          edited,
          edited_at: edited ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization" },
      );
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 手直しの保存。proposal だけを差し替え、edited を立てる。
    // meetings/signature は既存のまま残す（手直しは土台を変えないため）。
    if (action === "edit") {
      if (body.proposal === undefined) {
        return new Response(JSON.stringify({ error: "proposal required" }), {
          status: 400,
        });
      }
      const { data: existing, error: selErr } = await supabase
        .from("proposal_cache")
        .select("organization")
        .eq("organization", organization)
        .maybeSingle();
      if (selErr) {
        return new Response(JSON.stringify({ error: selErr.message }), { status: 500 });
      }
      if (!existing) {
        return new Response(
          JSON.stringify({ error: "この団体の提案がまだありません" }),
          { status: 404 },
        );
      }
      const { error } = await supabase
        .from("proposal_cache")
        .update({
          proposal: body.proposal,
          edited: true,
          edited_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("organization", organization);
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "unknown action" }), { status: 400 });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

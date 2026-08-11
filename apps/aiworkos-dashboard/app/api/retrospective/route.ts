import { NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";
import { windowChunks } from "@/lib/chunks";
import {
  validateDraft,
  PERIOD_TYPES,
  type RetroDraft,
  type RetroRow,
  type PeriodType,
  type SectionItem,
  type NextPlan,
} from "@/lib/retrospective";

// 振り返り（週次・月次）の読み書き。
//
//   GET                     … 全件（節を埋め込み）を新しい順に
//   POST   { draft }        … 新規登録（period_type + period_start が UNIQUE）
//   PATCH  { id, draft }    … 上書き（節は総入れ替え）
//   DELETE ?id=…            … 1件削除（節は ON DELETE CASCADE）
//
// 読み取りは anonキー（RLSで anon は SELECT のみ）、書き込みは必ず serviceCreds()。
// Notionへの書き戻しはこのAPIでは未実装（notion_page_id は読み取り・表示のみ）。

export const dynamic = "force-dynamic";

const TABLE = "retrospectives";
const SECTIONS = "retrospective_sections";
const SELECT = `select=id,period_type,period_start,period_end,title,one_liner,insights,next_plans,notion_page_id,created_at,updated_at,${SECTIONS}(id,retrospective_id,category,rating,body,items,position)`;

function missingEnv() {
  return NextResponse.json(
    { error: "サーバー設定エラー: Supabaseの環境変数が設定されていません" },
    { status: 500 }
  );
}

export async function GET() {
  const c = anonCreds();
  if (!c) return missingEnv();

  const res = await fetch(
    `${c.url}/rest/v1/${TABLE}?${SELECT}&order=period_start.desc,created_at.desc`,
    { headers: restHeaders(c.key), cache: "no-store" }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("振り返り取得エラー:", res.status, detail.slice(0, 300));
    return NextResponse.json({ error: `取得失敗 ${res.status}` }, { status: 502 });
  }

  const raw: (Omit<RetroRow, "sections"> & { retrospective_sections?: RetroRow["sections"] })[] =
    await res.json();

  // 埋め込みの節は順序が保証されないので position で並べ直す。
  const items: RetroRow[] = raw.map((r) => {
    const { retrospective_sections, ...rest } = r;
    return {
      ...rest,
      sections: [...(retrospective_sections ?? [])].sort((a, b) => a.position - b.position),
    };
  });

  return NextResponse.json({ items });
}


// ---------------------------------------------------------------------------
// 記憶層への反映
// ---------------------------------------------------------------------------

/**
 * 振り返りを memory_chunks へ載せ直す。
 *
 * これまで retrospectives は書いても他のどこからも参照されず袋小路だった。
 * 横断検索にも壁打ちにも提案エージェントにも出てこないため、月次で絞り出した
 * 示唆が翌月の提案づくりに一切効いていなかった。日記が同じ状態だったのを
 * 2026-07-26に直したのと同じ穴。
 *
 * 保存のたびに古いチャンクを消してから入れ直す（source_idの接頭辞で一掃）。
 * 追記にすると、編集で短くなった回の古い本文が残って検索に混ざる。
 *
 * ここが失敗しても振り返り本体の保存は成功として返す。記憶層への反映は
 * 付随処理で、これを理由に「保存できませんでした」と出すと書き直しを促して
 * しまうため（本体はもう入っている）。
 */
async function syncToMemory(
  c: { url: string; key: string },
  id: string,
  draft: RetroDraft
): Promise<void> {
  const anon = anonCreds();
  if (!anon) return;

  const prefix = `retrospective:${id}`;
  const label = `${draft.period_type} ${draft.period_start}〜${draft.period_end}`;

  // 検索で引ける本文を組む。節ごとの★と箇条書きも入れる——「何をしたか」は
  // 総括ではなく節の中身に書かれているため。
  const parts: string[] = [];
  if (draft.one_liner) parts.push(`【一言】${draft.one_liner}`);
  if (draft.insights.length > 0) {
    parts.push(`【示唆】\n${draft.insights.map((x) => `・${x}`).join("\n")}`);
  }
  for (const sec of draft.sections) {
    const head = sec.rating ? `【${sec.category}】★${sec.rating}` : `【${sec.category}】`;
    const items = sec.items
      .map((i) => `  - ${i.name}${i.eval ? `（${i.eval}）` : ""}: ${i.move}`)
      .join("\n");
    parts.push([head, sec.body, items].filter(Boolean).join("\n"));
  }
  if (draft.next_plans.length > 0) {
    parts.push(
      `【次期の予定】\n${draft.next_plans.map((p) => `・${p.date} ${p.label}`).join("\n")}`
    );
  }
  const body = parts.join("\n\n").trim();
  if (!body) return;

  try {
    await fetch(`${anon.url}/functions/v1/purge-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anon.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ source_id_prefix: prefix }),
      cache: "no-store",
    });

    const chunks = windowChunks(body);
    await Promise.all(
      chunks.map((chunk, i) =>
        fetch(`${anon.url}/functions/v1/store-memory`, {
          method: "POST",
          headers: { Authorization: `Bearer ${anon.key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            source_type: "振り返り",
            source_id: `${prefix}:${i + 1}`,
            title: `${draft.title || label}｜${label}｜${i + 1}/${chunks.length}`,
            content: chunk,
            event_date: draft.period_end || draft.period_start,
            metadata: {
              種別: "振り返り",
              期間: draft.period_type,
              開始: draft.period_start,
              終了: draft.period_end,
            },
          }),
          cache: "no-store",
        })
      )
    );
  } catch (err) {
    console.error("振り返りの記憶層反映に失敗:", err);
  }
}

// ---------------------------------------------------------------------------
// 入力の正規化
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeDraft(raw: unknown): RetroDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;

  const periodType = str(d.period_type) as PeriodType;
  if (!PERIOD_TYPES.includes(periodType)) return null;

  const insights = Array.isArray(d.insights)
    ? d.insights.map((x) => str(x)).filter((x) => x !== "")
    : [];

  const nextPlans: NextPlan[] = Array.isArray(d.next_plans)
    ? d.next_plans
        .map((x) => {
          const p = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
          return { date: str(p.date), label: str(p.label) };
        })
        .filter((p) => p.date !== "" || p.label !== "")
    : [];

  const sections = Array.isArray(d.sections)
    ? d.sections.map((x) => {
        const s = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
        const ratingRaw = s.rating;
        const rating =
          typeof ratingRaw === "number" && Number.isFinite(ratingRaw)
            ? Math.round(ratingRaw)
            : null;
        const items: SectionItem[] = Array.isArray(s.items)
          ? s.items
              .map((y) => {
                const i = y && typeof y === "object" ? (y as Record<string, unknown>) : {};
                return { name: str(i.name), move: str(i.move), eval: str(i.eval) };
              })
              .filter((i) => i.name !== "" || i.move !== "" || i.eval !== "")
          : [];
        return { category: str(s.category), rating, body: str(s.body), items };
      })
    : [];

  return {
    period_type: periodType,
    period_start: str(d.period_start),
    period_end: str(d.period_end),
    title: str(d.title),
    one_liner: str(d.one_liner),
    insights,
    next_plans: nextPlans,
    sections,
  };
}

function retroPayload(draft: RetroDraft) {
  return {
    period_type: draft.period_type,
    period_start: draft.period_start,
    period_end: draft.period_end,
    title: draft.title === "" ? null : draft.title,
    one_liner: draft.one_liner === "" ? null : draft.one_liner,
    insights: draft.insights,
    next_plans: draft.next_plans,
  };
}

function sectionRows(retroId: string, draft: RetroDraft) {
  return draft.sections.map((s, i) => ({
    retrospective_id: retroId,
    category: s.category.trim(),
    rating: s.rating,
    body: s.body === "" ? null : s.body,
    items: s.items,
    position: i + 1,
  }));
}

async function replaceSections(
  c: { url: string; key: string },
  retroId: string,
  draft: RetroDraft
): Promise<string | null> {
  const del = await fetch(
    `${c.url}/rest/v1/${SECTIONS}?retrospective_id=eq.${encodeURIComponent(retroId)}`,
    { method: "DELETE", headers: restHeaders(c.key) }
  );
  if (!del.ok) {
    const t = await del.text().catch(() => "");
    console.error("振り返り節の削除エラー:", del.status, t.slice(0, 300));
    return "節の入れ替えに失敗しました";
  }
  const rows = sectionRows(retroId, draft);
  if (rows.length === 0) return null;
  const ins = await fetch(`${c.url}/rest/v1/${SECTIONS}`, {
    method: "POST",
    headers: restHeaders(c.key, { Prefer: "return=minimal" }),
    body: JSON.stringify(rows),
  });
  if (!ins.ok) {
    const t = await ins.text().catch(() => "");
    console.error("振り返り節の登録エラー:", ins.status, t.slice(0, 300));
    return "節の登録に失敗しました";
  }
  return null;
}

// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const c = serviceCreds();
  if (!c) return missingEnv();

  const body: unknown = await request.json().catch(() => null);
  const draft = normalizeDraft((body as Record<string, unknown> | null)?.draft ?? body);
  if (!draft) return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });

  const invalid = validateDraft(draft);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?select=id`, {
    method: "POST",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
    body: JSON.stringify([retroPayload(draft)]),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 409) {
      return NextResponse.json(
        {
          error: `${draft.period_type}の${draft.period_start}はすでに登録されています。既存のものを編集してください。`,
        },
        { status: 409 }
      );
    }
    console.error("振り返り登録エラー:", res.status, detail.slice(0, 300));
    return NextResponse.json({ error: `登録失敗 ${res.status}` }, { status: 502 });
  }
  const rows: { id: string }[] = await res.json();
  const id = rows?.[0]?.id;
  if (!id) return NextResponse.json({ error: "登録結果を取得できませんでした" }, { status: 502 });

  const secErr = await replaceSections(c, id, draft);
  if (secErr) {
    // 節が入らなかった本体だけを残すと「節0件の振り返り」が生まれるので巻き戻す。
    await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: restHeaders(c.key),
    }).catch(() => undefined);
    return NextResponse.json({ error: secErr }, { status: 502 });
  }

  await syncToMemory(c, id, draft);
  return NextResponse.json({ id });
}

export async function PATCH(request: Request) {
  const c = serviceCreds();
  if (!c) return missingEnv();

  const body: unknown = await request.json().catch(() => null);
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const id = str(b?.id);
  if (id === "") return NextResponse.json({ error: "idが必要です" }, { status: 400 });

  const draft = normalizeDraft(b?.draft);
  if (!draft) return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });

  const invalid = validateDraft(draft);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}&select=id`, {
    method: "PATCH",
    headers: restHeaders(c.key, { Prefer: "return=representation" }),
    body: JSON.stringify({ ...retroPayload(draft), updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 409) {
      return NextResponse.json(
        { error: `${draft.period_type}の${draft.period_start}は別の振り返りが使っています` },
        { status: 409 }
      );
    }
    console.error("振り返り更新エラー:", res.status, detail.slice(0, 300));
    return NextResponse.json({ error: `更新失敗 ${res.status}` }, { status: 502 });
  }
  const rows: { id: string }[] = await res.json();
  if (!rows?.[0]?.id) {
    return NextResponse.json({ error: "対象の振り返りが見つかりません" }, { status: 404 });
  }

  const secErr = await replaceSections(c, id, draft);
  if (secErr) return NextResponse.json({ error: secErr }, { status: 502 });

  await syncToMemory(c, id, draft);
  return NextResponse.json({ id });
}

export async function DELETE(request: Request) {
  const c = serviceCreds();
  if (!c) return missingEnv();

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: restHeaders(c.key),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("振り返り削除エラー:", res.status, detail.slice(0, 300));
    return NextResponse.json({ error: `削除失敗 ${res.status}` }, { status: 502 });
  }

  // 記憶層からも消す。残すと、消したはずの内容が横断検索や壁打ちに出てくる。
  const anon = anonCreds();
  if (anon) {
    try {
      await fetch(`${anon.url}/functions/v1/purge-memory`, {
        method: "POST",
        headers: { Authorization: `Bearer ${anon.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ source_id_prefix: `retrospective:${id}` }),
        cache: "no-store",
      });
    } catch (err) {
      console.error("振り返りの記憶層削除に失敗:", err);
    }
  }
  return NextResponse.json({ ok: true });
}

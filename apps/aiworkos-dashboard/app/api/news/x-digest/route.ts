import { NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";

// X監視ダイジェスト。/news の右カラムが読む。
//
// 毎朝6時の見張り3本（キーワード急上昇／Manus公式／高野秀敏氏）の結果を、
// x-digest-collect スキルが x_digest_runs / x_digest_items へ書く。ここは読むだけ。
//
// 書き込み口をここに作っていないのは、収集がMac上のClaudeから走るため
// （Xはログイン必須でサーバから取りに行けない）。日報録やラーメンの
// フォロワー記録と同じく、ローカルのスクリプトが直接Supabaseへ入れる方が
// 経路が1本で済む。
//
// 「まだ一度も走っていない」「走ったが見られなかった」「走って0件だった」を
// 区別して返す。ここを潰すと、右カラムが毎朝空でも故障に見えなくなる。

export const dynamic = "force-dynamic";

type RunRow = {
  digest_date: string;
  collected_at: string;
  statuses: Record<string, string> | null;
  note: string | null;
};

type ItemRow = {
  section: "keyword" | "manus" | "takano";
  sort_order: number;
  label: string;
  metric: number | null;
  summary: string | null;
  original: string | null;
  url: string | null;
  note: string | null;
};

export type XDigestResponse = {
  /** 一度も収集していなければ null */
  digestDate: string | null;
  collectedAt: string | null;
  statuses: Record<string, string>;
  note: string | null;
  keywords: ItemRow[];
  manus: ItemRow[];
  takano: ItemRow[];
  error?: string;
};

const EMPTY: XDigestResponse = {
  digestDate: null,
  collectedAt: null,
  statuses: {},
  note: null,
  keywords: [],
  manus: [],
  takano: [],
};

export async function GET() {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ ...EMPTY, error: "Supabase未設定" }, { status: 500 });

  try {
    // 最新の1回ぶんだけ。過去分を遡って見たくなる画面ではない
    // （毎朝の「今朝の空気」を見るためのもので、履歴は記事側が持っている）。
    const runRes = await fetch(
      `${c.url}/rest/v1/x_digest_runs?select=digest_date,collected_at,statuses,note` +
        `&order=digest_date.desc&limit=1`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!runRes.ok) {
      return NextResponse.json({ ...EMPTY, error: `取得失敗 ${runRes.status}` }, { status: 502 });
    }
    const runs: RunRow[] = await runRes.json();
    const run = runs[0];
    if (!run) return NextResponse.json(EMPTY);

    const itemRes = await fetch(
      `${c.url}/rest/v1/x_digest_items?select=section,sort_order,label,metric,summary,original,url,note` +
        `&digest_date=eq.${run.digest_date}&order=section.asc,sort_order.asc`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!itemRes.ok) {
      return NextResponse.json({ ...EMPTY, error: `取得失敗 ${itemRes.status}` }, { status: 502 });
    }
    const items: ItemRow[] = await itemRes.json();

    return NextResponse.json({
      digestDate: run.digest_date,
      collectedAt: run.collected_at,
      statuses: run.statuses ?? {},
      note: run.note,
      keywords: items.filter((i) => i.section === "keyword"),
      manus: items.filter((i) => i.section === "manus"),
      takano: items.filter((i) => i.section === "takano"),
    } satisfies XDigestResponse);
  } catch (err) {
    console.error("GET /api/news/x-digest: 取得エラー", err);
    return NextResponse.json({ ...EMPTY, error: "取得に失敗しました" }, { status: 502 });
  }
}

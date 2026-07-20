import { NextRequest, NextResponse } from "next/server";
import {
  PART_LABEL,
  partToText,
  savePart,
  weaponIdOf,
  type Kind,
  type Weapon,
} from "../route";

// 生成された武器（今は提案書のみ対応）を、吉井さんが画面でその場修正したあとに
// 記憶(Supabase)へ上書き保存する。次の提案・壁打ち・別団体への横展開が、
// AIが最初に出した文面ではなく「本人が直した後」の内容を土台にするようにするため。
// weaponId は生成時と同じ式（organization+actions）で計算するので、上書きになり増殖しない。

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }

  const body = await req.json().catch(() => null);
  const organization =
    typeof body?.organization === "string" ? body.organization.trim() : "";
  const actions = Array.isArray(body?.actions)
    ? body.actions.filter((a: unknown): a is string => typeof a === "string" && a.trim() !== "")
    : [];
  const kind = body?.kind as Kind;
  const title = typeof body?.title === "string" && body.title.trim() ? body.title : "";
  const part = body?.part as Partial<Weapon> | undefined;

  if (!organization) return NextResponse.json({ error: "対象が不正です" }, { status: 400 });
  if (actions.length === 0)
    return NextResponse.json({ error: "打ち手が不正です" }, { status: 400 });
  if (kind !== "proposal") {
    // 今のところ手直し保存は提案書のみ対応。他種を送られても弾く。
    return NextResponse.json({ error: "この種類の保存には対応していません" }, { status: 400 });
  }
  if (!part || !Array.isArray(part.proposal) || part.proposal.length === 0) {
    return NextResponse.json({ error: "保存する内容がありません" }, { status: 400 });
  }

  const weaponId = weaponIdOf(organization, actions);
  const resolvedTitle =
    title || `${organization} ${actions[0]}${actions.length > 1 ? ` ほか${actions.length - 1}件` : ""}｜武器`;

  try {
    const savedChunks = await savePart(
      supabaseUrl,
      anonKey,
      organization,
      weaponId,
      kind,
      resolvedTitle,
      partToText(kind, part, actions)
    );
    return NextResponse.json({ savedChunks, label: PART_LABEL[kind] });
  } catch {
    return NextResponse.json({ error: "記憶への保存に失敗しました" }, { status: 502 });
  }
}

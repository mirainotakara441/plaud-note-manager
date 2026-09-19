import { NextRequest, NextResponse } from "next/server";
import { QA_OPEN_COOKIE, findVisitor, insertFeedback } from "@/lib/qaOpen";
import { sendPushToAll } from "@/lib/pushNotify";

// /qa-open からの修正案・質問を受ける。来訪者 cookie が無いと受け付けない。
// 保存後、登録済みの全端末へプッシュ通知（誰が・どのQAに・何を）を送る。
// 通知の失敗は保存の成否に影響させない（保存が正、通知は補助）。

export const dynamic = "force-dynamic";

const KINDS = new Set(["修正案", "質問", "その他"]);

export async function POST(req: NextRequest) {
  const visitorId = req.cookies.get(QA_OPEN_COOKIE)?.value ?? "";
  const visitor = await findVisitor(visitorId);
  if (!visitor) {
    return NextResponse.json({ error: "先にお名前とメールアドレスの登録が必要です" }, { status: 401 });
  }

  let body: { itemId?: unknown; kind?: unknown; message?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }
  const itemId =
    typeof body.itemId === "string" && /^[A-D]-\d{2}$/.test(body.itemId) ? body.itemId : null;
  const kind = typeof body.kind === "string" && KINDS.has(body.kind) ? body.kind : "修正案";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length < 2) return NextResponse.json({ error: "内容を入力してください" }, { status: 400 });
  if (message.length > 4000) return NextResponse.json({ error: "4,000字以内でお願いします" }, { status: 400 });

  const saved = await insertFeedback({ visitorId: visitor.id, itemId, kind, message });
  if (!saved) {
    return NextResponse.json({ error: "送信に失敗しました。時間をおいて再度お試しください" }, { status: 502 });
  }

  const head = `${visitor.name}${visitor.org ? `（${visitor.org}）` : ""}`;
  const push = await sendPushToAll({
    title: `QA${kind}：${itemId ?? "全体"}`,
    body: `${head}｜${message.slice(0, 80)}${message.length > 80 ? "…" : ""}`,
    url: "/hojin-qa/inbox",
  }).catch((e) => {
    console.error("QA修正案の通知失敗", e);
    return { sent: 0, removed: 0 };
  });

  return NextResponse.json({ ok: true, id: saved.id, notified: push.sent });
}

import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { QA_OPEN_COOKIE, findVisitor, logAccess } from "@/lib/qaOpen";
import data from "@/lib/hojinQa/data.public.json";
import QaOpenGate from "./QaOpenGate";
import QaOpenClient, { type PublicData } from "./QaOpenClient";

// 法人請求QA 外部公開版。合言葉は無く、名前・メールの登録を入口にする（lib/qaOpen.ts）。
// データは lib/hojinQa/data.public.json（scripts/build-hojin-qa-public.mjs が
// 社内版 data.json から自治体名・議員名を伏せて生成。注意欄など社内向けの欄は含まない）。
// 来訪者 cookie があれば、開くたびに qa_open_access_log へ1行残し visits を進める。

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "想定問答集（公開版）｜法人請求オンラインサービス",
  robots: { index: false, follow: false },
};

export default async function QaOpenPage() {
  const store = await cookies();
  const id = store.get(QA_OPEN_COOKIE)?.value ?? "";
  const visitor = id ? await findVisitor(id) : null;
  const d = data as PublicData;
  if (!visitor) return <QaOpenGate total={d.total} />;

  const ua = (await headers()).get("user-agent");
  await logAccess(visitor.id, "/qa-open", ua);
  return <QaOpenClient data={d} visitorName={visitor.name} />;
}

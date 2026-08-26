import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cookieValueFor } from "@/lib/auth";
import { HOJIN_QA_COOKIE_NAME, HOJIN_QA_PASSPHRASE } from "@/lib/hojinQaAuth";
import { HOJIN_SEIKYU_QA_URL } from "@/lib/externalLinks";
import QaGateForm from "./QaGateForm";

// 法人請求QA検索（外部サイト）への入り口。詳細は lib/hojinQaAuth.ts。
//
// 一度合言葉を通した端末は、cookieが生きている限りここを再訪してもフォームを
// 見せず即座に外部サイトへ送る（app/login/page.tsx と同じ「1年は素通り」の
// 考え方を、サーバー側の判定でやっている違い）。

export const dynamic = "force-dynamic";

export default async function QaGatePage() {
  const store = await cookies();
  const value = store.get(HOJIN_QA_COOKIE_NAME)?.value;
  if (value && value === (await cookieValueFor(HOJIN_QA_PASSPHRASE))) {
    redirect(HOJIN_SEIKYU_QA_URL);
  }
  return <QaGateForm />;
}

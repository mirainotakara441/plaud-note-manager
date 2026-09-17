import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cookieValueFor } from "@/lib/auth";
import { HOJIN_QA_COOKIE_NAME, hojinQaPassphrase } from "@/lib/hojinQaAuth";
import QaGateForm from "./QaGateForm";

// 法人請求QA検索（/hojin-qa）への入り口。詳細は lib/hojinQaAuth.ts。
//
// 一度合言葉を通した端末は、cookieが生きている限りここを再訪してもフォームを
// 見せず即座に /hojin-qa へ送る（app/login/page.tsx と同じ「1年は素通り」の
// 考え方を、サーバー側の判定でやっている違い）。

export const dynamic = "force-dynamic";

export default async function QaGatePage() {
  const passphrase = hojinQaPassphrase();
  if (passphrase) {
    const store = await cookies();
    const value = store.get(HOJIN_QA_COOKIE_NAME)?.value;
    if (value && value === (await cookieValueFor(passphrase))) {
      redirect("/hojin-qa");
    }
  }
  return <QaGateForm />;
}

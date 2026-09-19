import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cookieValueFor } from "@/lib/auth";
import { HOJIN_QA_COOKIE_NAME, hojinQaPassphrase } from "@/lib/hojinQaAuth";
import { listFeedback, listVisitors } from "@/lib/qaOpen";

// 外部公開版（/qa-open）に届いた修正案・質問と、来訪者のアクセス状況を見る社内ページ。
// 守りは /hojin-qa と同じ（QA専用 cookie。proxy.ts は /hojin-qa/ 配下をまとめて判定）。

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "公開版QA 受信箱" };

function jst(iso: string) {
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default async function InboxPage() {
  const passphrase = hojinQaPassphrase();
  if (!passphrase) redirect("/qa-gate");
  const store = await cookies();
  const value = store.get(HOJIN_QA_COOKIE_NAME)?.value;
  if (!value || value !== (await cookieValueFor(passphrase))) redirect("/qa-gate");

  const [feedback, visitors] = await Promise.all([listFeedback(), listVisitors()]);
  const totalVisits = visitors.reduce((a, v) => a + v.visits, 0);

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 pt-[max(1.5rem,env(safe-area-inset-top))] text-gray-900">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-bold">公開版QA 受信箱</h1>
        <a href="/hojin-qa" className="text-sm text-indigo-600 underline">QA検索へ</a>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        公開版 <a className="underline" href="/qa-open" target="_blank" rel="noreferrer">/qa-open</a> に届いたご意見と、登録者のアクセス状況。
        登録 {visitors.length} 名／延べ {totalVisits} 回。
      </p>

      <section className="mt-6">
        <h2 className="text-base font-semibold">修正案・質問（{feedback.length}件）</h2>
        {feedback.length === 0 && <p className="mt-2 text-sm text-gray-500">まだ届いていません。</p>}
        <ul className="mt-2 space-y-2">
          {feedback.map((f) => (
            <li key={f.id} className="rounded-xl border border-gray-200 bg-white p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <span className="rounded bg-indigo-100 px-1.5 py-0.5 font-medium text-indigo-900">{f.kind}</span>
                <span className="font-mono">{f.item_id ?? "全体"}</span>
                <span>{jst(f.created_at)}</span>
                <span className="ml-auto">{f.status}</span>
              </div>
              <p className="mt-1 font-medium">
                {f.qa_open_visitors?.name ?? "不明"}
                {f.qa_open_visitors?.org ? `（${f.qa_open_visitors.org}）` : ""}
                <span className="ml-2 font-normal text-gray-500">{f.qa_open_visitors?.email}</span>
              </p>
              <p className="mt-1 whitespace-pre-wrap leading-6 text-gray-800">{f.message}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-base font-semibold">登録者とアクセス回数（{visitors.length}名）</h2>
        <div className="mt-2 overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2">名前</th>
                <th className="px-3 py-2">所属</th>
                <th className="px-3 py-2">メール</th>
                <th className="px-3 py-2 text-right">回数</th>
                <th className="px-3 py-2">初回</th>
                <th className="px-3 py-2">最終</th>
              </tr>
            </thead>
            <tbody>
              {visitors.map((v) => (
                <tr key={v.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-medium">{v.name}</td>
                  <td className="px-3 py-2 text-gray-600">{v.org ?? ""}</td>
                  <td className="px-3 py-2 text-gray-600">{v.email}</td>
                  <td className="px-3 py-2 text-right font-mono">{v.visits}</td>
                  <td className="px-3 py-2 text-gray-500">{jst(v.first_seen)}</td>
                  <td className="px-3 py-2 text-gray-500">{jst(v.last_seen)}</td>
                </tr>
              ))}
              {visitors.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-3 text-center text-gray-500">まだ登録がありません。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

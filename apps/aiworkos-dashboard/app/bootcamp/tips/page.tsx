"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Salt2Tip, fmtPostedAt } from "@/lib/salt2Tips";

// SALT2 AIサマーブートキャンプ Slack「#0404_お役立ち情報」（運営からのTips投稿）のダイジェスト。
//
// このチャンネルはSlackを開かないと読めないので、外（通勤中・電車など）から
// 振り返れるようにミラーする。中身はSupabase salt2_qa_logを見るだけで、
// 新しい投稿は毎日21:30 JSTの自動同期で増えていく（このページ・APIは何も変える必要がない）。
//
// 件数は現状5件と小さいので、フィルタや検索は付けず、届いた順に上から読めば足りる
// （/salt2・/bootcamp のような絞り込みUIはこの画面には不要）。
//
// 表示順は投稿が古い→新しい。運営の説明は「昨日は〜を紹介しましたが」のように
// 前の投稿を踏まえて続くことがあるため、新着順より時系列順の方が読みやすい。

const C_TIPS = "#b45309"; // 琥珀。bootcamp（藍・朱・青緑）・salt2（青系）と混ざらない暖色

type ApiResponse = { tips: Salt2Tip[]; error?: string };

export default function BootcampTipsPage() {
  const [tips, setTips] = useState<Salt2Tip[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/bootcamp/tips", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((d: ApiResponse) => {
        if (!alive) return;
        if (d.error) setError(d.error);
        else {
          setError(null);
          setTips(d.tips ?? []);
        }
      })
      .catch(() => {
        if (alive) setError("お役立ち情報を取得できませんでした");
      });
    return () => {
      alive = false;
    };
  }, []);

  const loading = !tips && !error;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-2">
        <Link href="/bootcamp" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ブートキャンプ
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          🧂 お役立ち情報
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          Slack「SALT2 AIサマーブートキャンプ2026」#0404_お役立ち情報 の運営Tips投稿をミラー。
          新しい投稿は毎日自動で反映されます
        </p>
      </header>

      {error && (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error}
        </div>
      )}

      {loading && (
        <div className="mt-4 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-2xl border border-gray-200 bg-gray-100"
            />
          ))}
        </div>
      )}

      {tips && (
        <div className="mt-4 space-y-3">
          {tips.map((tip) => (
            <TipCard key={tip.message_ts} tip={tip} />
          ))}

          {tips.length === 0 && (
            <p className="rounded-2xl border border-gray-200 bg-white p-6 text-center text-sm leading-relaxed text-gray-500">
              まだお役立ち情報が同期されていません。
              <br />
              <span className="text-xs text-gray-400">
                毎日21:30 JSTの自動同期後にここへ表示されます。
              </span>
            </p>
          )}
        </div>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホームに戻る
        </Link>
      </div>
    </main>
  );
}

function TipCard({ tip }: { tip: Salt2Tip }) {
  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium" style={{ color: C_TIPS }}>
        {fmtPostedAt(tip.posted_at)}
      </p>
      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
        {tip.text}
      </p>
      <a
        href={tip.permalink}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-block text-xs font-medium active:opacity-70"
        style={{ color: C_TIPS }}
      >
        Slackで見る ↗
      </a>
    </article>
  );
}

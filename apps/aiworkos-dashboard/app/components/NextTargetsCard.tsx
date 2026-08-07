"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

// ホームの「🎯 次に攻める相手」。中身は /api/next-targets（/statusの抜粋）。
//
// このOSの目的は成約。ホームを開いた瞬間に「今日どの相手に何をするか」が
// 見えるようにする。名前を押すと団体別攻略（相手軸のハブ）が開き、
// 「提案する」を押すとその相手を選んだ状態で提案エージェントが開く。

type NextTarget = {
  name: string;
  meetings: number;
  last_meeting: string | null;
  has_proposal: boolean;
  stale: boolean;
};

function fmtDate(iso: string | null): string {
  if (!iso) return "接点記録なし";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function NextTargetsCard() {
  const [targets, setTargets] = useState<NextTarget[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/next-targets", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((d) => {
        if (alive) setTargets(Array.isArray(d?.targets) ? d.targets : []);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 取れない日は黙ってカードごと消す：ホームの一等地に「取得できませんでした」を
  // 置き続けると、毎朝それを読み飛ばす練習になってしまう。
  if (failed) return null;

  if (targets === null) {
    return (
      <div className="mb-6 h-[120px] animate-pulse rounded-2xl border border-gray-200 bg-gray-100" />
    );
  }

  if (targets.length === 0) return null;

  return (
    <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-gray-900">🎯 次に攻める相手</p>
        <Link href="/status" className="text-xs font-medium text-indigo-500 active:opacity-70">
          全体を見る →
        </Link>
      </div>
      <ul className="space-y-1.5">
        {targets.map((t) => (
          <li
            key={t.name}
            className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-2 ${
              t.has_proposal ? "border-gray-100 bg-gray-50" : "border-rose-200 bg-rose-50"
            }`}
          >
            <Link
              href={`/organizations?org=${encodeURIComponent(t.name)}`}
              className="min-w-[7rem] flex-1 basis-[7rem] truncate text-sm font-semibold text-gray-900 active:opacity-70"
            >
              {t.name}
            </Link>
            {!t.has_proposal && (
              <span className="shrink-0 rounded-full bg-rose-100 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-rose-700">
                提案なし
              </span>
            )}
            <span
              className={`shrink-0 text-[0.6875rem] ${t.stale ? "text-amber-600" : "text-gray-400"}`}
            >
              {fmtDate(t.last_meeting)}
              {t.stale && "⚠"}
            </span>
            <Link
              href={`/agent?org=${encodeURIComponent(t.name)}`}
              className="shrink-0 rounded-full bg-indigo-600 px-2.5 py-1 text-[0.6875rem] font-semibold text-white transition active:bg-indigo-700"
            >
              提案する
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

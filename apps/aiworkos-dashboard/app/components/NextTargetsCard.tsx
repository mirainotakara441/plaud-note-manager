"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// ホームの「🎯 次に攻める相手」。中身は /api/next-targets（/statusの抜粋）。
//
// このOSの目的は成約。ホームを開いた瞬間に「今日どの相手に何をするか」が
// 見えるようにする。名前を押すと団体別攻略（相手軸のハブ）が開き、
// 「提案する」を押すとその相手を選んだ状態で提案エージェントが開く。
//
// ★1〜3で優先順位を付けられる（★3が最優先）。機械的な指標（提案の有無・
// 最終接点）より★を先に見る——データ上は手つかずでも、いま攻める相手かどうかを
// 決められるのは吉井さんだけだから。★が無い間だけ機械の判断が前に出る。

type NextTarget = {
  name: string;
  meetings: number;
  last_meeting: string | null;
  has_proposal: boolean;
  stale: boolean;
  stars: number;
};

function fmtDate(iso: string | null): string {
  if (!iso) return "接点記録なし";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** ★を押して付け外しする。同じ数を押したら解除（3を押した状態で3→未設定）。 */
function Stars({
  value,
  disabled,
  onPick,
}: {
  value: number;
  disabled: boolean;
  onPick: (n: number) => void;
}) {
  return (
    <span className="inline-flex shrink-0 items-center">
      {[1, 2, 3].map((n) => (
        <button
          key={n}
          type="button"
          disabled={disabled}
          onClick={() => onPick(value === n ? 0 : n)}
          aria-label={`優先度★${n}`}
          title={value === n ? "押すと解除" : `★${n}にする`}
          className={`px-0.5 text-sm leading-none transition active:scale-90 disabled:opacity-40 ${
            n <= value ? "text-amber-500" : "text-gray-300"
          }`}
        >
          ★
        </button>
      ))}
    </span>
  );
}

export default function NextTargetsCard() {
  const [targets, setTargets] = useState<NextTarget[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/next-targets", { cache: "no-store" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const d = await r.json();
      setTargets(Array.isArray(d?.targets) ? d.targets : []);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function setStars(t: NextTarget, stars: number) {
    setBusy(t.name);
    try {
      const r = await fetch("/api/next-targets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: t.name, stars }),
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
      await load();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

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
            className={`rounded-lg border px-2.5 py-2 ${
              t.stars >= 3
                ? "border-amber-300 bg-amber-50"
                : t.has_proposal
                ? "border-gray-100 bg-gray-50"
                : "border-rose-200 bg-rose-50"
            } ${busy === t.name ? "opacity-50" : ""}`}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Stars
                value={t.stars}
                disabled={busy !== null}
                onPick={(n) => setStars(t, n)}
              />
              <Link
                href={`/organizations?org=${encodeURIComponent(t.name)}`}
                className="min-w-[6rem] flex-1 basis-[6rem] truncate text-sm font-semibold text-gray-900 active:opacity-70"
              >
                {t.name}
              </Link>
              {!t.has_proposal && (
                <span className="shrink-0 rounded-full bg-rose-100 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-rose-700">
                  提案なし
                </span>
              )}
              <span
                className={`shrink-0 text-[0.6875rem] ${
                  t.stale ? "text-amber-600" : "text-gray-400"
                }`}
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
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-gray-400">
        ★で優先順位（★3が最優先）。★が無い間は「提案なし → 接点が空いている順」で並びます
      </p>
    </section>
  );
}

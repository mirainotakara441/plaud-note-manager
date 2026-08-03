"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

// ホームの「今朝の気づき」。中身は /api/advisor。
//
// 出し方の考え方:
//   ・畳んだ状態でも、いちばん重い1件は必ず読める。開かないと何も分からないなら、
//     結局見に行かないのと同じになる。
//   ・件数だけのバッジにしない。「3件あります」は、開くまで何も伝えていない。
//   ・気づきが無い日は小さく静かに出す。毎朝「異常なし」を大きく出されると
//     カードそのものを読まなくなる。

type Severity = "alert" | "warn" | "info";

type Finding = {
  id: string;
  area: string;
  severity: Severity;
  title: string;
  facts: string[];
  href?: string;
  hrefLabel?: string;
};

type AdvisorResult = {
  findings: Finding[];
  counts: { alert: number; warn: number; info: number };
  failed: { name: string; reason: string }[];
};

const TONE: Record<Severity, { dot: string; chip: string; label: string }> = {
  alert: { dot: "bg-rose-500", chip: "bg-rose-100 text-rose-700", label: "要対応" },
  warn: { dot: "bg-amber-500", chip: "bg-amber-100 text-amber-700", label: "気になる" },
  info: { dot: "bg-slate-400", chip: "bg-slate-100 text-slate-600", label: "参考" },
};

function FindingRow({ f }: { f: Finding }) {
  const tone = TONE[f.severity];
  return (
    <li className="border-t border-gray-100 pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${tone.chip}`}>
              {f.area}
            </span>
            <span className="text-base font-bold leading-snug text-gray-900">{f.title}</span>
          </p>
          <ul className="mt-1.5 space-y-1">
            {f.facts.map((fact, i) => (
              <li key={i} className="text-sm leading-relaxed text-gray-600">
                ・{fact}
              </li>
            ))}
          </ul>
          {f.href && (
            <Link
              href={f.href}
              className="mt-1.5 inline-block text-sm font-bold text-indigo-600 underline active:opacity-70"
            >
              {f.hrefLabel ?? "見に行く"} →
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

export default function AdvisorCard() {
  const [data, setData] = useState<AdvisorResult | null>(null);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/advisor", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {
        if (alive) setFailedToLoad(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (failedToLoad) {
    return (
      <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-bold text-gray-900">今朝の気づき</p>
        <p className="mt-1 text-sm text-gray-500">取得できませんでした</p>
      </section>
    );
  }

  if (!data) {
    return <div className="mb-6 h-[112px] animate-pulse rounded-2xl border border-gray-200 bg-gray-100" />;
  }

  const { findings, counts, failed } = data;

  if (findings.length === 0) {
    return (
      <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-bold text-gray-900">
          🫡 今朝の気づき
          <span className="ml-2 font-medium text-gray-400">気になるところはありません</span>
        </p>
        {failed.length > 0 && (
          <p className="mt-1 text-sm text-amber-700">
            ただし{failed.length}件の検知が動かなかったので、全部を見たわけではありません
          </p>
        )}
      </section>
    );
  }

  const top = findings[0];
  const rest = findings.slice(1);

  return (
    <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-gray-900">🫡 今朝の気づき</p>
        <p className="text-xs font-bold text-gray-400">
          {counts.alert > 0 && <span className="text-rose-600">要対応{counts.alert}</span>}
          {counts.alert > 0 && (counts.warn > 0 || counts.info > 0) && " ／ "}
          {counts.warn > 0 && <span className="text-amber-600">気になる{counts.warn}</span>}
          {counts.warn > 0 && counts.info > 0 && " ／ "}
          {counts.info > 0 && <span>参考{counts.info}</span>}
        </p>
      </div>

      <ul className="space-y-3">
        <FindingRow f={top} />
        {open && rest.map((f) => <FindingRow key={f.id} f={f} />)}
      </ul>

      {rest.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-3 w-full rounded-xl border border-gray-200 py-2 text-sm font-bold text-gray-600 transition active:bg-gray-50"
        >
          {open ? "閉じる" : `残り${rest.length}件を見る`}
        </button>
      )}

      {failed.length > 0 && (
        <p className="mt-3 text-sm text-amber-700">
          {failed.map((f) => f.name).join("・")}の検知が動きませんでした。この一覧は全部ではありません。
        </p>
      )}
    </section>
  );
}

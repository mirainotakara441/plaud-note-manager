"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

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
  /** 画面から伏せたもの。?all=true のときだけ返ってくる。 */
  dismissed?: boolean;
  /** いつまでに手を打つか。null＝納期なし。 */
  due_date?: string | null;
};

type AdvisorResult = {
  findings: Finding[];
  counts: { alert: number; warn: number; info: number };
  failed: { name: string; reason: string }[];
  dismissedCount: number;
};

/** JSTの今日。納期の遅れ判定に使う。 */
function jstToday(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function dueMeta(due: string): { text: string; klass: string } {
  const today = jstToday();
  const days = Math.round(
    (Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000
  );
  const [, m, d] = due.split("-");
  const label = `${Number(m)}/${Number(d)}`;
  if (days < 0) return { text: `📅 ${label} ${-days}日超過`, klass: "border-rose-300 bg-rose-50 text-rose-700" };
  if (days === 0) return { text: `📅 ${label} 今日`, klass: "border-amber-300 bg-amber-50 text-amber-700" };
  if (days === 1) return { text: `📅 ${label} 明日`, klass: "border-amber-300 bg-amber-50 text-amber-700" };
  return { text: `📅 ${label} あと${days}日`, klass: "border-gray-300 bg-white text-gray-600" };
}

const TONE: Record<Severity, { dot: string; chip: string; label: string }> = {
  alert: { dot: "bg-rose-500", chip: "bg-rose-100 text-rose-700", label: "要対応" },
  warn: { dot: "bg-amber-500", chip: "bg-amber-100 text-amber-700", label: "気になる" },
  info: { dot: "bg-slate-400", chip: "bg-slate-100 text-slate-600", label: "参考" },
};

function FindingRow({
  f,
  busy,
  onDismiss,
  onRestore,
  onDue,
}: {
  f: Finding;
  busy: boolean;
  onDismiss: (f: Finding) => void;
  onRestore: (f: Finding) => void;
  onDue: (f: Finding, due: string | null) => void;
}) {
  const tone = TONE[f.severity];
  // 納期の入力は下書きに溜め、「決定」で保存する。保存と同時に入力欄を閉じると、
  // iPhoneの日付ピッカーが開いた直後のchangeで消えてしまう（/actions と同じ作法）。
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(f.due_date ?? "");

  return (
    <li className={`border-t border-gray-100 pt-3 first:border-t-0 first:pt-0 ${busy ? "opacity-50" : ""}`}>
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

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {f.href && (
              <Link
                href={f.href}
                className="text-sm font-bold text-indigo-600 underline active:opacity-70"
              >
                {f.hrefLabel ?? "見に行く"} →
              </Link>
            )}

            {/* 納期。気づきは出るだけでは動かないので、期限を持たせて締める */}
            {editing ? (
              <span className="inline-flex items-center gap-1">
                <input
                  type="date"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditing(false);
                    if (e.key === "Enter") {
                      onDue(f, draft || null);
                      setEditing(false);
                    }
                  }}
                  aria-label="いつまでに手を打つか"
                  className="rounded-lg border border-emerald-400 px-1.5 py-0.5 text-[0.8125rem] text-gray-700"
                />
                {draft !== (f.due_date ?? "") ? (
                  <button
                    type="button"
                    onClick={() => {
                      onDue(f, draft || null);
                      setEditing(false);
                    }}
                    className="rounded-full bg-emerald-600 px-2 py-0.5 text-[0.6875rem] font-semibold text-white active:bg-emerald-700"
                  >
                    決定
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="rounded-full px-1.5 py-0.5 text-[0.6875rem] font-medium text-gray-400 active:bg-gray-100"
                  >
                    閉じる
                  </button>
                )}
                {f.due_date && (
                  <button
                    type="button"
                    onClick={() => {
                      onDue(f, null);
                      setEditing(false);
                    }}
                    className="rounded-full border border-gray-300 px-1.5 py-0.5 text-[0.6875rem] font-medium text-gray-500 active:bg-gray-100"
                  >
                    クリア
                  </button>
                )}
              </span>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(f.due_date ?? "");
                  setEditing(true);
                }}
                title={f.due_date ? "期限を変える・外す" : "いつまでに手を打つか決める"}
                className={`rounded-full border px-1.5 py-0.5 text-[0.6875rem] transition active:scale-95 ${
                  f.due_date ? dueMeta(f.due_date).klass : "border-dashed border-gray-300 text-gray-400"
                }`}
              >
                {f.due_date ? dueMeta(f.due_date).text : "📅 期限"}
              </button>
            )}

            {f.dismissed ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onRestore(f)}
                className="rounded-full border border-gray-300 px-1.5 py-0.5 text-[0.6875rem] font-medium text-gray-500 active:bg-gray-100"
              >
                戻す
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => onDismiss(f)}
                aria-label="この気づきを消す"
                title="消す（対応済み・見なくてよい）"
                className="ml-auto rounded-md px-1.5 py-0.5 text-gray-300 transition active:bg-gray-100 active:text-rose-500"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export default function AdvisorCard() {
  const [data, setData] = useState<AdvisorResult | null>(null);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [open, setOpen] = useState(false);
  // 消したものも含めて見る切替。既定は隠す。
  const [showAll, setShowAll] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (all: boolean) => {
    try {
      const r = await fetch(`/api/advisor${all ? "?all=true" : ""}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      setData(await r.json());
      setFailedToLoad(false);
    } catch {
      setFailedToLoad(true);
    }
  }, []);

  useEffect(() => {
    load(showAll);
  }, [load, showAll]);

  // 手入れは楽観更新にしない。保存に失敗しても消えたように見えると、
  // 「消したはずのものが翌朝また出る」の原因が分からなくなる。
  async function patch(f: Finding, body: { dismissed?: boolean; due_date?: string | null }) {
    setBusyId(f.id);
    try {
      const r = await fetch("/api/advisor", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: f.id, ...body }),
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
      await load(showAll);
    } catch {
      setFailedToLoad(true);
    } finally {
      setBusyId(null);
    }
  }

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
  const dismissedCount = data.dismissedCount ?? 0;

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
        {dismissedCount > 0 && !showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="mt-2 text-xs font-medium text-gray-400 underline active:opacity-70"
          >
            消した{dismissedCount}件を見る
          </button>
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
        {[top, ...(open ? rest : [])].map((f) => (
          <FindingRow
            key={f.id}
            f={f}
            busy={busyId === f.id}
            onDismiss={(x) => patch(x, { dismissed: true })}
            onRestore={(x) => patch(x, { dismissed: false })}
            onDue={(x, due) => patch(x, { due_date: due })}
          />
        ))}
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

      {(dismissedCount > 0 || showAll) && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 w-full text-xs font-medium text-gray-400 underline active:opacity-70"
        >
          {showAll ? "消したものを隠す" : `消した${dismissedCount}件も表示`}
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

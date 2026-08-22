"use client";

import { useCallback, useEffect, useState } from "react";

// 上長への月次報告の議事メモ（monthly_briefings）。
//
// なぜ月報ページの中に置くか:
//   「その月に何をやったか（月報ドラフト）」と「それを報告して何を言われたか」は
//   同じ月・同じ文脈で読みたい。別ページに切ると、振り返るたびに往復が要る。
//   月の切替はページ側の month をそのまま使う。
//
// 保存すると Supabase の memory_chunks(source_type='月次報告') にも入る。
// 提案や壁打ちのときに「前に統括部長にこう言われた」を引けるようにするため。

export type Briefing = {
  id: string;
  month: string;
  reported_on: string | null;
  audience: string;
  title: string;
  summary: string | null;
  feedback: string | null;
  decisions: string | null;
  homework: string | null;
  note: string | null;
};

/** よく報告する相手。押すだけで入る。 */
const AUDIENCE_PRESETS = ["足立統括部長", "石田本部長", "部長"];

type Draft = {
  id?: string;
  reported_on: string;
  audience: string;
  title: string;
  summary: string;
  feedback: string;
  decisions: string;
  homework: string;
  note: string;
};

function emptyDraft(month: string): Draft {
  // 「8月度報告」は月内か翌月頭に実施することが多い。既定はその月の1日ではなく空にして、
  // 実施日を必ず自分で入れてもらう（後から振り返るとき、日付の推測が一番効かない）。
  return {
    reported_on: "",
    audience: AUDIENCE_PRESETS[0],
    title: `${Number(month.slice(5, 7))}月度報告`,
    summary: "",
    feedback: "",
    decisions: "",
    homework: "",
    note: "",
  };
}

function toDraft(b: Briefing): Draft {
  return {
    id: b.id,
    reported_on: b.reported_on ?? "",
    audience: b.audience,
    title: b.title,
    summary: b.summary ?? "",
    feedback: b.feedback ?? "",
    decisions: b.decisions ?? "",
    homework: b.homework ?? "",
    note: b.note ?? "",
  };
}

function fmtDay(day: string | null): string {
  if (!day) return "実施日なし";
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
}

const FIELDS: { key: keyof Draft; label: string; placeholder: string; rows: number }[] = [
  { key: "summary", label: "報告した内容", placeholder: "何を報告したか", rows: 4 },
  { key: "feedback", label: "言われたこと・反応", placeholder: "相手の言葉・温度感", rows: 4 },
  { key: "decisions", label: "決まったこと", placeholder: "その場で決まったこと", rows: 3 },
  { key: "homework", label: "宿題・次アクション", placeholder: "次までにやること", rows: 3 },
  { key: "note", label: "メモ", placeholder: "その他", rows: 2 },
];

export function BriefingsSection({ month }: { month: string }) {
  const [items, setItems] = useState<Briefing[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 取得失敗を「0件」と区別する。握り潰して「まだありません」と出すと、
  // 実際は記録がある月でも空に見えてしまう。
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/monthly-report/briefings?month=${month}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || json?.error) throw new Error(json?.error ?? `取得に失敗しました（${res.status}）`);
      setItems(Array.isArray(json?.items) ? json.items : []);
    } catch (e) {
      setItems([]);
      setLoadError(e instanceof Error ? e.message : "報告記録を読み込めませんでした");
    }
  }, [month]);

  useEffect(() => {
    load();
    setDraft(null);
    setNotice(null);
  }, [load]);

  async function submit() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/monthly-report/briefings", {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, month }),
      });
      const json = await res.json();
      if (!res.ok || json?.error) throw new Error(json?.error ?? "保存に失敗しました");
      setDraft(null);
      // 記憶層への流し込みが落ちても議事メモ自体は残る。黙って成功にせず正直に出す。
      setNotice(
        json?.memorySaved === false
          ? "保存しました（記憶層への登録は失敗したので、後で入れ直してください）"
          : "保存しました（記憶層にも登録済み）"
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function remove(b: Briefing) {
    if (!window.confirm(`「${b.title}」（${b.audience}）を削除します。元に戻せません。`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/monthly-report/briefings?id=${b.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || json?.error) throw new Error(json?.error ?? "削除に失敗しました");
      if (draft?.id === b.id) setDraft(null);
      setNotice("削除しました");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-gray-900">🗣 上長への報告（議事メモ）</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            報告した内容と、言われたこと・宿題を残す。記憶層にも入るので壁打ちで引ける
          </p>
        </div>
        {!draft && (
          <button
            type="button"
            onClick={() => setDraft(emptyDraft(month))}
            className="shrink-0 text-sm font-medium text-indigo-600 active:opacity-70"
          >
            記録する
          </button>
        )}
      </div>

      {error && <p className="mb-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {notice && (
        <p className="mb-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>
      )}

      {draft && (
        <div className="mb-4 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-gray-500" htmlFor="briefing-day">
              実施日
            </label>
            <input
              id="briefing-day"
              type="date"
              value={draft.reported_on}
              onChange={(e) => setDraft({ ...draft, reported_on: e.target.value })}
              className="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none"
            />
            <input
              type="text"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="見出し（例：8月度報告）"
              className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div className="mt-2">
            <p className="mb-1 text-xs text-gray-500">報告先</p>
            <div className="flex flex-wrap gap-1.5">
              {[
                ...AUDIENCE_PRESETS,
                ...(AUDIENCE_PRESETS.includes(draft.audience) ? [] : [draft.audience]),
              ].map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setDraft((d) => (d ? { ...d, audience: a } : d))}
                  aria-pressed={draft.audience === a}
                  className={`rounded-full px-3 py-1.5 text-sm transition active:scale-95 ${
                    draft.audience === a
                      ? "bg-indigo-600 text-white"
                      : "bg-white text-gray-600 ring-1 ring-gray-200"
                  }`}
                >
                  {a}
                </button>
              ))}
              <input
                type="text"
                value={AUDIENCE_PRESETS.includes(draft.audience) ? "" : draft.audience}
                onChange={(e) => setDraft({ ...draft, audience: e.target.value })}
                placeholder="他の相手"
                className="w-28 rounded-lg border border-gray-200 px-2 py-1 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          {FIELDS.map((f) => (
            <div key={f.key} className="mt-3">
              <label className="mb-1 block text-xs text-gray-500" htmlFor={`briefing-${f.key}`}>
                {f.label}
              </label>
              <textarea
                id={`briefing-${f.key}`}
                value={draft[f.key] as string}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                placeholder={f.placeholder}
                rows={f.rows}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base leading-relaxed text-gray-900 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          ))}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !draft.title.trim() || !draft.audience.trim()}
              onClick={submit}
              className="min-h-[2.5rem] rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white transition disabled:opacity-40 active:scale-95"
            >
              {busy ? "保存中…" : draft.id ? "更新する" : "登録する"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
              className="text-sm text-gray-500 active:opacity-70"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {loadError ? (
        <div className="rounded-xl bg-rose-50 px-3 py-3">
          <p className="text-sm text-rose-700">報告記録を読み込めませんでした（{loadError}）</p>
          <button
            type="button"
            onClick={load}
            className="mt-2 rounded-full bg-rose-600 px-3 py-1 text-xs font-bold text-white active:scale-95"
          >
            再読み込み
          </button>
        </div>
      ) : items.length === 0 && !draft ? (
        <p className="py-3 text-sm text-gray-400">
          この月の報告記録はまだありません。「記録する」から残せます。
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((b) => (
            <li key={b.id} className="rounded-xl bg-gray-50 px-3 py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                  {b.audience}
                </span>
                <span className="text-sm font-bold text-gray-900">{b.title}</span>
                <span className="text-xs tabular-nums text-gray-500">{fmtDay(b.reported_on)}</span>
                <button
                  type="button"
                  onClick={() => setDraft(toDraft(b))}
                  className="ml-auto text-xs font-medium text-indigo-600 active:opacity-70"
                >
                  直す
                </button>
                <button
                  type="button"
                  onClick={() => remove(b)}
                  className="text-xs text-rose-600 active:opacity-70"
                >
                  消す
                </button>
              </div>
              {FIELDS.map((f) => {
                const v = b[f.key as keyof Briefing];
                if (typeof v !== "string" || !v.trim()) return null;
                return (
                  <div key={f.key} className="mt-2">
                    <p className="text-xs font-semibold text-gray-500">{f.label}</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                      {v}
                    </p>
                  </div>
                );
              })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

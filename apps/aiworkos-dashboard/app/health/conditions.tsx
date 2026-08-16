"use client";

import { useState } from "react";
import { fmtDay } from "./charts";

// 体調の記録カード（health_conditions）。
//
// 何を残したいか:
//   「8/8から8/10まで39度の熱が出た。コロナもインフルも溶連菌も陰性で、扁桃腺炎だった」
//   —— この形をそのまま残す。数値の指標では表せない。
//
// 「違った病気」を必ず残す理由:
//   次に同じ症状が出たときに効くのは、何だったかより「何を先に潰したか」。
//   通院のときの説明材料にもなる。だから否定された検査もチップで残す。
//
// 入力の重さについて:
//   毎日つけるものではない（体調を崩したときだけ）。だから睡眠の手入力と違って
//   1タップにこだわらず、後から読んで意味が分かる情報量を優先している。

export type Condition = {
  id: string;
  start_day: string;
  end_day: string | null;
  title: string;
  max_temp_c: number | null;
  symptoms: string[];
  ruled_out: string[];
  note: string | null;
};

/** よく書く症状。押すだけで入る。ここに無いものは自由入力から足す。 */
const SYMPTOM_PRESETS = ["発熱", "喉の痛み", "咳", "鼻水", "倦怠感", "頭痛", "関節痛", "腹痛", "吐き気"];
/** 「検査して違った」もの。発熱のときはこの3つを疑われることが多い。 */
const RULED_OUT_PRESETS = ["コロナ", "インフルエンザ", "溶連菌", "アデノウイルス"];

/** 期間の見出し。終わりが無いものは継続中として出す。 */
function periodLabel(c: Condition): string {
  const start = fmtDay(c.start_day, true).replace(/^\d+年/, "");
  if (!c.end_day) return `${start}〜（続いている）`;
  if (c.end_day === c.start_day) return start;
  const end = fmtDay(c.end_day, true).replace(/^\d+年/, "");
  return `${start}〜${end}`;
}

function dayCount(c: Condition): number | null {
  if (!c.end_day) return null;
  const a = new Date(c.start_day).getTime();
  const b = new Date(c.end_day).getTime();
  return Math.round((b - a) / 86400000) + 1;
}

type Draft = {
  id?: string;
  start_day: string;
  end_day: string;
  title: string;
  max_temp_c: string;
  symptoms: string[];
  ruled_out: string[];
  note: string;
};

/** 入っていれば外す、無ければ足す。 */
function toggleIn(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

function emptyDraft(today: string): Draft {
  return {
    start_day: today,
    end_day: "",
    title: "",
    max_temp_c: "",
    symptoms: [],
    ruled_out: [],
    note: "",
  };
}

function toDraft(c: Condition): Draft {
  return {
    id: c.id,
    start_day: c.start_day,
    end_day: c.end_day ?? "",
    title: c.title,
    max_temp_c: c.max_temp_c != null ? String(c.max_temp_c) : "",
    symptoms: c.symptoms ?? [],
    ruled_out: c.ruled_out ?? [],
    note: c.note ?? "",
  };
}

export function ConditionsCard({
  items,
  today,
  onChanged,
}: {
  items: Condition[];
  today: string;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/health/conditions", {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draft.id,
          start_day: draft.start_day,
          end_day: draft.end_day,
          title: draft.title,
          max_temp_c: draft.max_temp_c,
          symptoms: draft.symptoms,
          ruled_out: draft.ruled_out,
          note: draft.note,
        }),
      });
      const json = await res.json();
      if (!res.ok || json?.error) throw new Error(json?.error ?? "保存に失敗しました");
      setDraft(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, title: string) {
    if (!window.confirm(`「${title}」の記録を消しますか？`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/health/conditions?id=${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || json?.error) throw new Error(json?.error ?? "削除に失敗しました");
      if (draft?.id === id) setDraft(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-bold text-gray-900">🤒 体調の記録</h2>
        {!draft && (
          <button
            type="button"
            onClick={() => setDraft(emptyDraft(today))}
            className="text-sm font-medium text-indigo-600 active:opacity-70"
          >
            記録する
          </button>
        )}
      </div>

      {error && (
        <p className="mb-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
      )}

      {draft && (
        <div className="mb-4 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-gray-500" htmlFor="cond-start">
              いつから
            </label>
            <input
              id="cond-start"
              type="date"
              value={draft.start_day}
              max={today}
              onChange={(e) => setDraft({ ...draft, start_day: e.target.value })}
              className="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none"
            />
            <label className="text-xs text-gray-500" htmlFor="cond-end">
              いつまで
            </label>
            <input
              id="cond-end"
              type="date"
              value={draft.end_day}
              max={today}
              onChange={(e) => setDraft({ ...draft, end_day: e.target.value })}
              className="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none"
            />
            <span className="text-xs text-gray-400">空なら「まだ続いている」</span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="病名・呼び名（例：扁桃腺炎）"
              className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none"
            />
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              value={draft.max_temp_c}
              onChange={(e) => setDraft({ ...draft, max_temp_c: e.target.value })}
              placeholder="39.0"
              className="w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-base tabular-nums text-gray-900 focus:border-indigo-500 focus:outline-none"
            />
            <span className="text-sm text-gray-500">度（最高）</span>
          </div>

          <ChipPicker
            label="症状"
            presets={SYMPTOM_PRESETS}
            selected={draft.symptoms}
            onToggle={(v) =>
              setDraft((d) => (d ? { ...d, symptoms: toggleIn(d.symptoms, v) } : d))
            }
            accent="rose"
          />
          <ChipPicker
            label="検査して違ったもの"
            presets={RULED_OUT_PRESETS}
            selected={draft.ruled_out}
            onToggle={(v) =>
              setDraft((d) => (d ? { ...d, ruled_out: toggleIn(d.ruled_out, v) } : d))
            }
            accent="slate"
          />

          <textarea
            value={draft.note}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            placeholder="メモ（受診した病院、処方、経過など）"
            rows={2}
            className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-base text-gray-900 focus:border-indigo-500 focus:outline-none"
          />

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !draft.title.trim() || !draft.start_day}
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

      {items.length === 0 && !draft ? (
        <p className="py-3 text-sm text-gray-400">
          まだ記録がありません。熱が出た日や体調を崩した期間をここに残せます。
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((c) => {
            const days = dayCount(c);
            return (
              <li key={c.id} className="rounded-xl bg-gray-50 px-3 py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-bold text-gray-900">{c.title}</span>
                  {c.max_temp_c != null && (
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
                      最高 {c.max_temp_c}度
                    </span>
                  )}
                  {!c.end_day && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                      継続中
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setDraft(toDraft(c))}
                    className="ml-auto text-xs font-medium text-indigo-600 active:opacity-70"
                  >
                    直す
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(c.id, c.title)}
                    className="text-xs text-rose-600 active:opacity-70"
                  >
                    消す
                  </button>
                </div>
                <p className="mt-0.5 text-xs tabular-nums text-gray-500">
                  {periodLabel(c)}
                  {days != null && `（${days}日間）`}
                </p>
                {c.symptoms?.length > 0 && (
                  <p className="mt-1 flex flex-wrap gap-1">
                    {c.symptoms.map((s) => (
                      <span key={s} className="rounded-full bg-white px-2 py-0.5 text-xs text-gray-600 ring-1 ring-gray-200">
                        {s}
                      </span>
                    ))}
                  </p>
                )}
                {c.ruled_out?.length > 0 && (
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-gray-500">
                    <span>検査して違った：</span>
                    {c.ruled_out.map((s) => (
                      <span
                        key={s}
                        className="rounded-full bg-white px-2 py-0.5 text-gray-400 line-through ring-1 ring-gray-200"
                      >
                        {s}
                      </span>
                    ))}
                  </p>
                )}
                {c.note && <p className="mt-1 text-xs leading-relaxed text-gray-600">{c.note}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** よく使う候補はボタン、それ以外は自由入力で足せるチップ列。 */
function ChipPicker({
  label,
  presets,
  selected,
  onToggle,
  accent,
}: {
  label: string;
  presets: string[];
  selected: string[];
  /**
   * 押された値そのものを渡す（配列は渡さない）。
   * 配列を組み立てて渡すと、続けて素早く押したときに直前の1件を取りこぼす
   * （Reactが更新をまとめる間、選択中の配列が古いままになるため）。
   * 親は setState の関数形で前の状態から作り直す。
   */
  onToggle: (value: string) => void;
  accent: "rose" | "slate";
}) {
  const [custom, setCustom] = useState("");
  // Tailwind はクラス名を静的に探すので、組み立てずに書き出す
  const onClass = accent === "rose" ? "bg-rose-500 text-white" : "bg-slate-600 text-white";

  function toggle(v: string) {
    onToggle(v);
  }

  return (
    <div className="mt-3">
      <p className="mb-1 text-xs text-gray-500">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {[...presets, ...selected.filter((s) => !presets.includes(s))].map((p) => {
          const on = selected.includes(p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => toggle(p)}
              aria-pressed={on}
              className={`rounded-full px-3 py-1.5 text-sm transition active:scale-95 ${
                on ? onClass : "bg-white text-gray-600 ring-1 ring-gray-200"
              }`}
            >
              {p}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="text"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && custom.trim()) {
              e.preventDefault();
              toggle(custom.trim());
              setCustom("");
            }
          }}
          placeholder="他にあれば入力してEnter"
          className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-1 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none"
        />
      </div>
    </div>
  );
}

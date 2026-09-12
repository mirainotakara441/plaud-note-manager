"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtMd, summarize, weekRange } from "@/lib/healthWeekly.mjs";

// 健康週次レポート。
//
// ■ 作りの前提は「自動下書き＋手直し」
//   週を選ぶと、その週の日次データをDBから引いて表を自動で埋める。
//   人が入れるのは★評価とコメントと備考だけ。数値を手で打たせない。
//
// ■ 数値はここで作らない
//   平均も合計も lib/healthWeekly.mjs の summarize() に任せる。
//   欠測日を前日の値や平均で埋めない——2026-08に歩数が平均値で潰れていた事故と
//   同じことをレポート側で繰り返さないため。記録が無い日は「記録なし」と書き、
//   平均には必ず「何日ぶんか」を添える。
//
// ■ ★は自動で付けない
//   記録が2日しかない週にも★が付いてしまい、評価が数字の見た目に引きずられる。
//   事実の並びまでがこの画面の仕事で、意味づけは吉井さんが入れる。

type DayRow = {
  day: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  muscle_kg: number | null;
  steps: number | null;
  kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  salt_g: number | null;
  sleep_h?: number | null;
};

type Rating = { stars?: number; comment?: string };
type SavedReport = {
  week_start: string;
  week_end: string;
  ratings: Record<string, Rating>;
  notes: string | null;
  updated_at: string;
};

/** 評価する指標。レポートの見本に合わせてある。 */
const METRICS = ["体重", "体脂肪率", "筋肉量", "食事", "歩数", "睡眠", "医療"] as const;

const C = "#0d9488"; // teal-600。/health の他の節と同系で、週次だけ少し濃くする

const f = (v: number | null | undefined, d = 1) =>
  v == null ? "—" : Number(v).toFixed(d);
const i = (v: number | null | undefined) =>
  v == null ? "—" : Math.round(Number(v)).toLocaleString();

/** その日を含む週の土曜。週の移動もこれ1本で済ませる。 */
function shiftWeek(start: string, deltaWeeks: number): string {
  const [y, m, d] = start.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaWeeks * 7));
  return dt.toISOString().slice(0, 10);
}

function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function WeeklyReport() {
  // 既定は「先週」。今週はまだ途中で、開いた瞬間に欠測だらけの表が出ると
  // レポートとして読めない。
  const [weekStart, setWeekStart] = useState<string>(() =>
    shiftWeek(weekRange(todayJst()).start, -1)
  );
  const range = useMemo(() => weekRange(weekStart), [weekStart]);

  const [rows, setRows] = useState<DayRow[] | null>(null);
  const [saved, setSaved] = useState<SavedReport | null>(null);
  const [savedWeeks, setSavedWeeks] = useState<string[]>([]);
  const [ratings, setRatings] = useState<Record<string, Rating>>({});
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  /** 食事の訂正モード。開いている間だけ、日ごとの数値を直接打てる。 */
  const [editMeal, setEditMeal] = useState(false);
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({});
  const [mealSaving, setMealSaving] = useState(false);
  const [mealMsg, setMealMsg] = useState<string | null>(null);

  // 保存済みの週の一覧。過去分を辿る手がかりにする。
  useEffect(() => {
    fetch("/api/health/weekly", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.weeks)) {
          setSavedWeeks(d.weeks.map((w: { week_start: string }) => w.week_start));
        }
      })
      .catch(() => {
        /* 一覧が取れなくてもレポートそのものは出せるので、黙って諦める */
      });
  }, [savedAt]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setSavedAt(null);
    Promise.all([
      fetch(`/api/health?from=${range.start}&to=${range.end}`, { cache: "no-store" }).then(
        async (r) => {
          const d = await r.json();
          if (!r.ok) throw new Error(d.error ?? "日次データの取得に失敗しました");
          return d;
        }
      ),
      fetch(`/api/health/weekly?start=${range.start}`, { cache: "no-store" }).then(
        async (r) => {
          const d = await r.json();
          if (!r.ok) throw new Error(d.error ?? "保存済みレポートの取得に失敗しました");
          return d;
        }
      ),
    ])
      .then(([day, weekly]) => {
        if (!alive) return;
        setRows((day.days ?? day.rows ?? []) as DayRow[]);
        const rep = (weekly.report ?? null) as SavedReport | null;
        setSaved(rep);
        setRatings(rep?.ratings ?? {});
        setNotes(rep?.notes ?? "");
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "取得に失敗しました"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [range.start, range.end]);

  const s = useMemo(() => summarize(rows ?? []), [rows]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/health/weekly", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          week_start: range.start,
          week_end: range.end,
          ratings,
          notes,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "保存に失敗しました");
      setSaved(d.report);
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }, [range.start, range.end, ratings, notes]);

  const setRating = (metric: string, patch: Rating) =>
    setRatings((prev) => ({ ...prev, [metric]: { ...prev[metric], ...patch } }));

  /**
   * 食事の訂正を書く。source='manual' で入れると health_range_summary が
   * カロミルより優先して採るので、自動連携が直らなくても正しい数字が残る。
   * 登録先は写メ取り込みと同じ PUT——書き込み経路を増やさない。
   */
  const saveMeal = useCallback(async () => {
    const targets = Object.entries(draft)
      .map(([day, v]) => {
        const values: Record<string, number> = {};
        for (const [k, raw] of Object.entries(v)) {
          if (raw.trim() === "") continue;
          const n = Number(raw);
          if (Number.isFinite(n)) values[k] = n;
        }
        return { day, values };
      })
      .filter((r) => Object.keys(r.values).length > 0);

    if (targets.length === 0) {
      setMealMsg("直した数値がありません");
      return;
    }
    setMealSaving(true);
    setMealMsg(null);
    try {
      const res = await fetch("/api/health/photo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "meal", source: "manual", today: todayJst(), rows: targets }),
      });
      const d = await res.json();
      if (!res.ok || d?.error) throw new Error(d?.error ?? "登録に失敗しました");
      setMealMsg(`${d?.days ?? targets.length}日ぶんを直しました`);
      setDraft({});
      setEditMeal(false);
      // 直した値で表を引き直す
      const fresh = await fetch(`/api/health?from=${range.start}&to=${range.end}`, {
        cache: "no-store",
      }).then((r) => r.json());
      setRows((fresh.days ?? fresh.rows ?? []) as DayRow[]);
    } catch (e) {
      setMealMsg(e instanceof Error ? e.message : "登録に失敗しました");
    } finally {
      setMealSaving(false);
    }
  }, [draft, range.start, range.end]);

  const thisWeekStart = weekRange(todayJst()).start;
  const isFuture = weekStart >= thisWeekStart;
  const noMeal = (rows ?? []).filter((r) => r.kcal == null).map((r) => fmtMd(r.day));

  // ★1日500kcal未満は入力漏れとみなす。
  //   吉井さんは毎日プロテイン（222kcal）を定例で記録しており、カロミルから
  //   その1件しか届かない日がある。実際には9/10はカロミル側で2,396kcalあった。
  //   つまり「少ない日」ではなく「届いていない日」。生きている人間の1日は
  //   500kcalでは終わらないので、この線より下は数字としてまず信じない。
  const MIN_DAILY_KCAL = 500;
  const lowMeal = (rows ?? [])
    .filter((r) => r.kcal != null && r.kcal < MIN_DAILY_KCAL)
    .map((r) => fmtMd(r.day));

  // ★同じ値が複数日に並んでいたら疑う。
  //   カロミルは1日の合計を1件だけ書き出す（health_metrics の extra は
  //   全栄養素・全日で n_points=1）。取り込み側は壊れていない。
  //   では何が起きているかというと、カロミルへの記録がその日1品で止まっていると、
  //   その1品の値がそのまま「1日の合計」として入る。2026-09は10日中9日が
  //   222kcal/P28.2/F5.1/C20.2/塩0.78 で完全一致していた（プロテイン1杯ぶん）。
  //   平均だけ見ていると気づけず、レポートが静かに嘘をつく。
  //   「記録が無い」より質が悪い——値が入っている顔をしているため、日を名指しする。
  const suspectMeal = useMemo(() => {
    const seen = new Map<string, string[]>();
    for (const r of rows ?? []) {
      if (r.kcal == null) continue;
      const key = [r.kcal, r.protein_g, r.fat_g, r.carbs_g, r.salt_g].join("/");
      seen.set(key, [...(seen.get(key) ?? []), fmtMd(r.day)]);
    }
    return [...seen.values()].filter((days) => days.length >= 2).flat();
  }, [rows]);

  return (
    <div>
      {/* ── 週の選択 ────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setWeekStart(shiftWeek(weekStart, -1))}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-semibold text-gray-600 transition active:opacity-70"
        >
          ← 前の週
        </button>
        <div className="text-center">
          <p className="text-[0.95rem] font-bold text-gray-900">
            {range.start.replaceAll("-", "/")} 〜 {range.end.replaceAll("-", "/")}
          </p>
          {saved && (
            <p className="text-[0.68rem]" style={{ color: C }}>
              保存済み（{saved.updated_at.slice(0, 10)}）
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setWeekStart(shiftWeek(weekStart, 1))}
          disabled={isFuture}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-semibold text-gray-600 transition active:opacity-70 disabled:opacity-30"
        >
          次の週 →
        </button>
      </div>

      {/* 保存済みの週へ一気に飛ぶ。過去分を1週ずつ戻らずに開けるようにする */}
      {savedWeeks.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <span className="py-1 text-[0.7rem] text-gray-400">保存済み</span>
          {savedWeeks.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWeekStart(w)}
              className="rounded-md border px-2 py-1 text-[0.7rem] font-semibold transition active:opacity-70"
              style={
                w === range.start
                  ? { borderColor: C, background: C, color: "#fff" }
                  : { borderColor: "#e5e7eb", background: "#fff", color: "#6b7280" }
              }
            >
              {w.slice(5).replace("-", "/")}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[0.8rem] text-rose-700">
          {error}
        </div>
      )}

      {loading && (
        <div className="mt-4 space-y-2">
          {Array.from({ length: 3 }).map((_, k) => (
            <div key={k} className="h-16 animate-pulse rounded-xl bg-gray-100" />
          ))}
        </div>
      )}

      {!loading && rows && (
        <>
          {/* ① 体組成 */}
          <Block n="①" title="体組成">
            <Table
              head={["日付", "体重", "体脂肪率", "筋肉量"]}
              rows={rows.map((r) => [
                fmtMd(r.day),
                r.weight_kg == null ? "—" : `${f(r.weight_kg, 2)}kg`,
                r.body_fat_pct == null ? "—" : `${f(r.body_fat_pct, 2)}%`,
                r.muscle_kg == null ? "—" : `${f(r.muscle_kg, 2)}kg`,
              ])}
            />
            <Foot>
              週平均：体重 {f(s.weight.avg, 2)}kg（{s.weight.days}日） ／ 体脂肪率{" "}
              {f(s.bodyFat.avg, 2)}%（{s.bodyFat.days}日） ／ 筋肉量 {f(s.muscle.avg, 2)}kg（
              {s.muscle.days}日）
            </Foot>
          </Block>

          {/* ② 食事 */}
          <Block n="②" title="食事">
            {editMeal ? (
              <MealEditor
                rows={rows}
                draft={draft}
                setDraft={setDraft}
                minKcal={MIN_DAILY_KCAL}
              />
            ) : (
              <Table
                head={["日付", "カロリー", "たんぱく質", "脂質", "炭水化物", "塩分"]}
                rows={rows.map((r) => [
                  fmtMd(r.day),
                  r.kcal == null
                    ? "記録なし"
                    : `${i(r.kcal)}kcal${r.kcal < MIN_DAILY_KCAL ? " ⚠️" : ""}`,
                  r.protein_g == null ? "—" : `${f(r.protein_g)}g`,
                  r.fat_g == null ? "—" : `${f(r.fat_g)}g`,
                  r.carbs_g == null ? "—" : `${f(r.carbs_g)}g`,
                  r.salt_g == null ? "—" : `${f(r.salt_g, 2)}g`,
                ])}
              />
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              {editMeal ? (
                <>
                  <button
                    type="button"
                    onClick={saveMeal}
                    disabled={mealSaving}
                    className="rounded-lg px-3 py-1.5 text-xs font-bold text-white transition active:opacity-70 disabled:opacity-40"
                    style={{ background: C }}
                  >
                    {mealSaving ? "登録中…" : "直した値を登録"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditMeal(false);
                      setDraft({});
                      setMealMsg(null);
                    }}
                    className="text-xs text-gray-500 underline active:opacity-70"
                  >
                    やめる
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setEditMeal(true);
                    setMealMsg(null);
                  }}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 transition active:opacity-70"
                >
                  ✎ 手入力で直す
                </button>
              )}
              {mealMsg && <span className="text-[0.72rem] text-teal-700">{mealMsg}</span>}
            </div>
            <Foot>
              記録があったのは {s.kcal.days}日。平均 {i(s.kcal.avg)}kcal ／ たんぱく質{" "}
              {f(s.protein.avg)}g ／ 脂質 {f(s.fat.avg)}g ／ 炭水化物 {f(s.carbs.avg)}g ／ 塩分{" "}
              {f(s.salt.avg, 2)}g
              {noMeal.length > 0 && (
                <>
                  <br />※ {noMeal.join("・")} は食事の記録がありません
                </>
              )}
            </Foot>
            {lowMeal.length > 0 && (
              <p className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[0.72rem] leading-relaxed text-amber-900">
                ⚠️ <strong>{lowMeal.join("・")}</strong> が{MIN_DAILY_KCAL}kcal未満です。
                <strong>入力漏れとみて、この数字は使わないでください。</strong>
                定例のプロテイン（222kcal）だけが届いている状態です。「手入力で直す」から正しい値を入れると、
                カロミルより優先して残ります。
              </p>
            )}
            {suspectMeal.length > 0 && lowMeal.length === 0 && (
              <p className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[0.72rem] leading-relaxed text-amber-900">
                ⚠️ <strong>{suspectMeal.join("・")}</strong> が1gの狂いもなく同じ値で並んでいます。
                同じ内容を続けて食べたのでなければ、届いていない日です。
              </p>
            )}
          </Block>

          {/* ③ 歩数 */}
          <Block n="③" title="歩数">
            <Table
              head={["日付", "歩数"]}
              rows={rows.map((r) => [fmtMd(r.day), r.steps == null ? "—" : `${i(r.steps)}歩`])}
            />
            <Foot>
              週間総歩数 {i(s.steps.sum)}歩 ／ 平均 {i(s.steps.avg)}歩（{s.steps.days}日ぶん）
            </Foot>
          </Block>

          {/* ④ 睡眠。記録が無い週は表ごと出さない */}
          <Block n="④" title="睡眠">
            {s.sleep.days === 0 ? (
              <p className="text-[0.8rem] text-gray-400">記録がありません。</p>
            ) : (
              <>
                <Table
                  head={["日付", "睡眠"]}
                  rows={rows.map((r) => [
                    fmtMd(r.day),
                    r.sleep_h == null ? "—" : `${f(r.sleep_h)}時間`,
                  ])}
                />
                <Foot>
                  平均 {f(s.sleep.avg)}時間（{s.sleep.days}日ぶん）
                </Foot>
              </>
            )}
          </Block>

          {/* ⑤ 総合評価。ここだけ人が入れる */}
          <div className="mt-5 border-t border-gray-100 pt-4">
            <h4 className="text-[0.8rem] font-bold text-gray-700">総合評価</h4>
            <p className="mt-0.5 text-[0.7rem] text-gray-400">
              ★とコメントは自動で付けない。記録が2日しかない週にも★が付くと、評価が数字の見た目に引きずられる。
            </p>

            <div className="mt-3 space-y-2.5">
              {METRICS.map((m) => (
                <div key={m} className="rounded-xl bg-gray-50 p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-[0.78rem] font-semibold text-gray-700">
                      {m}
                    </span>
                    <div className="flex gap-0.5">
                      {[1, 2, 3, 4, 5].map((n) => {
                        const on = (ratings[m]?.stars ?? 0) >= n;
                        return (
                          <button
                            key={n}
                            type="button"
                            aria-label={`${m} ${n}つ星`}
                            onClick={() =>
                              setRating(m, {
                                // 同じ星をもう一度押したら解除。付け間違いを消せないと直せない
                                stars: ratings[m]?.stars === n ? undefined : n,
                              })
                            }
                            className="px-0.5 text-lg leading-none transition active:opacity-60"
                            style={{ color: on ? "#f59e0b" : "#d1d5db" }}
                          >
                            ★
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <input
                    value={ratings[m]?.comment ?? ""}
                    onChange={(e) => setRating(m, { comment: e.target.value })}
                    placeholder="コメント（任意）"
                    className="mt-1.5 w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[0.78rem] outline-none placeholder:text-gray-300 focus:border-teal-400"
                  />
                </div>
              ))}
            </div>

            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="備考（受診結果、その週の出来事など）"
              className="mt-3 w-full rounded-xl border border-gray-200 px-3 py-2 text-[0.8rem] outline-none placeholder:text-gray-300 focus:border-teal-400"
            />

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded-xl px-4 py-2 text-sm font-bold text-white transition active:opacity-70 disabled:opacity-40"
                style={{ background: C }}
              >
                {saving ? "保存中…" : saved ? "上書き保存" : "この週を保存"}
              </button>
              {savedAt && <span className="text-[0.75rem] text-teal-700">保存しました</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 食事の訂正フォーム。
 * 既に入っている値を初期表示にせず、placeholder に出す。初期値として入れると
 * 「触っていない日」と「同じ値で直した日」が区別できず、直していない日まで
 * 手入力として上書きされる。空欄のままの項目は送らない。
 */
function MealEditor({
  rows,
  draft,
  setDraft,
  minKcal,
}: {
  rows: DayRow[];
  draft: Record<string, Record<string, string>>;
  setDraft: (f: (p: Record<string, Record<string, string>>) => Record<string, Record<string, string>>) => void;
  minKcal: number;
}) {
  const cols: { key: string; label: string; get: (r: DayRow) => number | null }[] = [
    { key: "energy", label: "kcal", get: (r) => r.kcal },
    { key: "protein", label: "P", get: (r) => r.protein_g },
    { key: "fat", label: "F", get: (r) => r.fat_g },
    { key: "carbs", label: "C", get: (r) => r.carbs_g },
    { key: "salt", label: "塩", get: (r) => r.salt_g },
  ];

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="w-full text-[0.76rem]" style={{ minWidth: "28rem" }}>
        <thead>
          <tr className="bg-gray-50">
            <th className="px-2 py-1.5 text-left font-bold text-gray-500">日付</th>
            {cols.map((c) => (
              <th key={c.key} className="px-1.5 py-1.5 text-left font-bold text-gray-500">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const low = r.kcal != null && r.kcal < minKcal;
            return (
              <tr key={r.day} className="border-t border-gray-100">
                <td
                  className={`whitespace-nowrap px-2 py-1 ${low ? "font-bold text-amber-700" : "text-gray-700"}`}
                >
                  {fmtMd(r.day)}
                  {low && " ⚠️"}
                </td>
                {cols.map((c) => {
                  const cur = c.get(r);
                  return (
                    <td key={c.key} className="px-1 py-1">
                      <input
                        type="number"
                        inputMode="decimal"
                        value={draft[r.day]?.[c.key] ?? ""}
                        placeholder={cur == null ? "—" : String(cur)}
                        onChange={(e) =>
                          setDraft((p) => ({
                            ...p,
                            [r.day]: { ...p[r.day], [c.key]: e.target.value },
                          }))
                        }
                        className="w-[4.5rem] rounded border border-gray-200 px-1.5 py-1 text-[0.75rem] tabular-nums outline-none focus:border-teal-400"
                      />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-2 py-1.5 text-[0.68rem] leading-relaxed text-gray-400">
        打ち直した欄だけが登録されます。空欄のままの日は触りません。灰色の数字は今入っている値です。
      </p>
    </div>
  );
}

function Block({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <h4 className="mb-1.5 text-[0.8rem] font-bold text-gray-700">
        <span style={{ color: C }}>{n}</span> {title}
      </h4>
      {children}
    </div>
  );
}

/** 横に長い表はここだけ横スクロールさせる。画面ごと横に動くと読めない。 */
function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="w-full text-[0.76rem]" style={{ minWidth: head.length > 2 ? "26rem" : 0 }}>
        <thead>
          <tr className="bg-gray-50">
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap px-2.5 py-1.5 text-left font-bold text-gray-500">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, k) => (
            <tr key={k} className="border-t border-gray-100">
              {r.map((cell, j) => (
                <td
                  key={j}
                  className={`whitespace-nowrap px-2.5 py-1.5 tabular-nums ${
                    cell === "記録なし" ? "text-gray-400" : "text-gray-700"
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 平均には必ず「何日ぶんか」を添える。平均だけ出すと欠測が見えなくなる。 */
function Foot({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-[0.73rem] leading-relaxed text-gray-500">{children}</p>;
}

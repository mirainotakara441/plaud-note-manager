"use client";

import { useState } from "react";
import {
  CATEGORIES,
  PERIOD_TYPES,
  addDays,
  formatStars,
  parseRetrospectiveMarkdown,
  validateDraft,
  type DraftSection,
  type ParseWarning,
  type PeriodType,
  type RetroDraft,
} from "@/lib/retrospective";

// 振り返りの登録・編集フォーム。
//
// 入力方式は「Claudeが整形したMarkdownを貼って解析 → 構造化フォームで確認・修正 → 保存」。
// 貼り付け一発で完結させないのは、解析が外した箇所を必ず人の目に通したいから。
// 解釈できなかった行は warnings に出したうえで、下のフォームで手直しできる。
// 貼り付けを使わず、最初からフォームだけで作ることもできる。

const PLACEHOLDER = `例（Claudeが整形したMarkdownをそのまま貼る）:

# 大阪市攻略が「トップ×ボトム」で前進した週
期間：2026-07-27 〜 2026-07-31
種別：週次

## 一言で
地震を乗り越え、両輪で大阪市が前進した週

## 仕事（総括） ★★★★☆
熊本出張は中止になったが、空いた時間を資料化に充てた。

## 自治体 ★★★★☆
大阪市は実施意思確認と議員との関係強化が同日に重なった。

| 団体 | 動き | 評価 |
|---|---|---|
| 熊本市 | 地震で出張延期。お見舞い連絡 | ⚠️延期だが関係は維持 |
| 大阪市 | 7/31面談で実施意思確認 | ✅前進 |

## 示唆
- 不測の事態でも代替の一手で埋め合わせられる
- 議員ネットワークは「個別攻略」から「裾野拡大」へ

## 次期の予定
- 8/1 家族サービス
- 8/3 大谷クリニック検査`;

type Props = {
  mode: "new" | "edit";
  initialDraft: RetroDraft;
  retroId?: string;
  onSaved: (id: string) => void;
  onCancel: () => void;
};

export default function RetrospectiveForm({
  mode,
  initialDraft,
  retroId,
  onSaved,
  onCancel,
}: Props) {
  const [draft, setDraft] = useState<RetroDraft>(initialDraft);
  const [paste, setPaste] = useState("");
  const [warnings, setWarnings] = useState<ParseWarning[]>([]);
  const [parsed, setParsed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (p: Partial<RetroDraft>) => setDraft((d) => ({ ...d, ...p }));

  const patchSection = (i: number, p: Partial<DraftSection>) =>
    setDraft((d) => ({
      ...d,
      sections: d.sections.map((s, j) => (j === i ? { ...s, ...p } : s)),
    }));

  function applyPaste() {
    setError(null);
    if (paste.trim() === "") {
      setError("貼り付ける本文が空です");
      return;
    }
    const { draft: parsedDraft, warnings: w } = parseRetrospectiveMarkdown(paste);
    setDraft(parsedDraft);
    setWarnings(w);
    setParsed(true);
  }

  function moveSection(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= draft.sections.length) return;
    const next = [...draft.sections];
    [next[i], next[j]] = [next[j], next[i]];
    patch({ sections: next });
  }

  async function save() {
    const invalid = validateDraft(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/retrospective", {
        method: mode === "new" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "new" ? { draft } : { id: retroId, draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "保存に失敗しました");
      onSaved(data.id ?? retroId ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  const label = "mb-1 block text-xs font-bold text-gray-500";
  const input =
    "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-indigo-400";

  return (
    <div className="space-y-5">
      {/* 1. 貼り付け */}
      <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-bold text-gray-900">
          {mode === "new" ? "本文を貼って解析" : "本文を貼り直して差し替え（任意）"}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">
          Claudeが整形したMarkdown（★・表を含む）をそのまま貼ってください。解析後は下のフォームで
          確認・修正できます。読み取れなかった行は捨てずに警告として出します。
        </p>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={PLACEHOLDER}
          rows={10}
          className="mt-3 w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs leading-relaxed text-gray-900 outline-none focus:border-indigo-400"
        />
        <button
          onClick={applyPaste}
          className="mt-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition active:scale-95"
        >
          解析してフォームに反映
        </button>
        {parsed && (
          <p className="mt-2 text-xs text-emerald-700">
            解析しました（節 {draft.sections.length}件・示唆 {draft.insights.length}件・予定{" "}
            {draft.next_plans.length}件）。下の内容を確認してから保存してください。
          </p>
        )}
      </section>

      {/* 2. 解釈できなかったもの */}
      {warnings.length > 0 && (
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-sm font-bold text-amber-900">
            解釈できなかった／推測した箇所（{warnings.length}件）
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-amber-800">
            捨てずにここに出しています。下のフォームで拾い直すか、本文を直して貼り直してください。
          </p>
          <ul className="mt-3 space-y-2">
            {warnings.map((w, i) => (
              <li key={i} className="rounded-lg bg-white/70 px-3 py-2">
                <p className="text-xs font-bold text-amber-900">{w.label}</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-amber-800">
                  {w.detail}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 3. 基本情報 */}
      <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-bold text-gray-900">基本情報</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className={label}>種別</label>
            <select
              value={draft.period_type}
              onChange={(e) => patch({ period_type: e.target.value as PeriodType })}
              className={input}
            >
              {PERIOD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>開始日</label>
            <input
              type="date"
              value={draft.period_start}
              onChange={(e) => {
                const v = e.target.value;
                patch({
                  period_start: v,
                  period_end:
                    draft.period_end === "" || draft.period_end < v
                      ? addDays(v, draft.period_type === "週次" ? 6 : 29)
                      : draft.period_end,
                });
              }}
              className={input}
            />
          </div>
          <div>
            <label className={label}>終了日</label>
            <input
              type="date"
              value={draft.period_end}
              onChange={(e) => patch({ period_end: e.target.value })}
              className={input}
            />
          </div>
        </div>
        <div className="mt-3">
          <label className={label}>タイトル</label>
          <input
            type="text"
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="その期を一本の線で言い切る見出し"
            className={input}
          />
        </div>
        <div className="mt-3">
          <label className={label}>一言で</label>
          <textarea
            value={draft.one_liner}
            onChange={(e) => patch({ one_liner: e.target.value })}
            rows={2}
            className={`${input} resize-y`}
          />
        </div>
      </section>

      {/* 4. 節 */}
      <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-bold text-gray-900">節（{draft.sections.length}）</h2>
          <button
            onClick={() =>
              patch({
                sections: [
                  ...draft.sections,
                  { category: "", rating: null, body: "", items: [] },
                ],
              })
            }
            className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-600 active:scale-95"
          >
            ＋ 節を追加
          </button>
        </div>

        <datalist id="retro-categories">
          {CATEGORIES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>

        <div className="space-y-4">
          {draft.sections.map((s, i) => (
            <div key={i} className="rounded-xl border border-gray-200 p-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <label className={label}>節の名前</label>
                  <input
                    type="text"
                    list="retro-categories"
                    value={s.category}
                    onChange={(e) => patchSection(i, { category: e.target.value })}
                    className={input}
                  />
                </div>
                <div className="w-32 shrink-0">
                  <label className={label}>★評価</label>
                  <select
                    value={s.rating ?? ""}
                    onChange={(e) =>
                      patchSection(i, {
                        rating: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                    className={input}
                  >
                    <option value="">★なし</option>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {formatStars(n)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mt-2">
                <label className={label}>評価コメント</label>
                <textarea
                  value={s.body}
                  onChange={(e) => patchSection(i, { body: e.target.value })}
                  rows={3}
                  className={`${input} resize-y`}
                />
              </div>

              <div className="mt-2">
                <div className="mb-1 flex items-baseline justify-between">
                  <span className={label}>表（対象・動き・評価）</span>
                  <button
                    onClick={() =>
                      patchSection(i, {
                        items: [...s.items, { name: "", move: "", eval: "" }],
                      })
                    }
                    className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 active:scale-95"
                  >
                    ＋ 行
                  </button>
                </div>
                <div className="space-y-2">
                  {s.items.map((it, k) => (
                    <div key={k} className="rounded-lg bg-gray-50 p-2">
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-[1fr_2fr_1fr]">
                        <input
                          type="text"
                          value={it.name}
                          placeholder="対象"
                          onChange={(e) =>
                            patchSection(i, {
                              items: s.items.map((x, y) =>
                                y === k ? { ...x, name: e.target.value } : x
                              ),
                            })
                          }
                          className={input}
                        />
                        <input
                          type="text"
                          value={it.move}
                          placeholder="動き"
                          onChange={(e) =>
                            patchSection(i, {
                              items: s.items.map((x, y) =>
                                y === k ? { ...x, move: e.target.value } : x
                              ),
                            })
                          }
                          className={input}
                        />
                        <input
                          type="text"
                          value={it.eval}
                          placeholder="評価"
                          onChange={(e) =>
                            patchSection(i, {
                              items: s.items.map((x, y) =>
                                y === k ? { ...x, eval: e.target.value } : x
                              ),
                            })
                          }
                          className={input}
                        />
                      </div>
                      <button
                        onClick={() =>
                          patchSection(i, { items: s.items.filter((_, y) => y !== k) })
                        }
                        className="mt-1 text-xs text-rose-500 active:opacity-70"
                      >
                        この行を削除
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-2 flex items-center gap-3 text-xs">
                <button
                  onClick={() => moveSection(i, -1)}
                  disabled={i === 0}
                  className="text-gray-500 disabled:opacity-30"
                >
                  ↑ 上へ
                </button>
                <button
                  onClick={() => moveSection(i, 1)}
                  disabled={i === draft.sections.length - 1}
                  className="text-gray-500 disabled:opacity-30"
                >
                  ↓ 下へ
                </button>
                <button
                  onClick={() => patch({ sections: draft.sections.filter((_, j) => j !== i) })}
                  className="ml-auto text-rose-500 active:opacity-70"
                >
                  この節を削除
                </button>
              </div>
            </div>
          ))}
          {draft.sections.length === 0 && (
            <p className="py-4 text-center text-sm text-gray-400">
              節がありません。本文を貼って解析するか、「＋ 節を追加」で作ってください。
            </p>
          )}
        </div>
      </section>

      {/* 5. 示唆 */}
      <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-bold text-gray-900">示唆（{draft.insights.length}）</h2>
          <button
            onClick={() => patch({ insights: [...draft.insights, ""] })}
            className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-600 active:scale-95"
          >
            ＋ 追加
          </button>
        </div>
        <div className="space-y-2">
          {draft.insights.map((v, i) => (
            <div key={i} className="flex items-start gap-2">
              <textarea
                value={v}
                rows={2}
                onChange={(e) =>
                  patch({ insights: draft.insights.map((x, j) => (j === i ? e.target.value : x)) })
                }
                className={`${input} resize-y`}
              />
              <button
                onClick={() => patch({ insights: draft.insights.filter((_, j) => j !== i) })}
                className="shrink-0 pt-2 text-xs text-rose-500 active:opacity-70"
              >
                削除
              </button>
            </div>
          ))}
          {draft.insights.length === 0 && (
            <p className="py-2 text-center text-sm text-gray-400">示唆はまだありません。</p>
          )}
        </div>
      </section>

      {/* 6. 次期の予定 */}
      <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-bold text-gray-900">
            次期の予定（{draft.next_plans.length}）
          </h2>
          <button
            onClick={() => patch({ next_plans: [...draft.next_plans, { date: "", label: "" }] })}
            className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-600 active:scale-95"
          >
            ＋ 追加
          </button>
        </div>
        <div className="space-y-2">
          {draft.next_plans.map((p, i) => (
            <div key={i} className="rounded-lg bg-gray-50 p-2">
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-[10rem_1fr]">
                <input
                  type="date"
                  value={p.date}
                  onChange={(e) =>
                    patch({
                      next_plans: draft.next_plans.map((x, j) =>
                        j === i ? { ...x, date: e.target.value } : x
                      ),
                    })
                  }
                  className={input}
                />
                <input
                  type="text"
                  value={p.label}
                  placeholder="予定の内容"
                  onChange={(e) =>
                    patch({
                      next_plans: draft.next_plans.map((x, j) =>
                        j === i ? { ...x, label: e.target.value } : x
                      ),
                    })
                  }
                  className={input}
                />
              </div>
              {p.date === "" && (
                <p className="mt-1 text-xs text-amber-700">
                  日付が空です（このままでも保存できますが、日付順には並びません）
                </p>
              )}
              <button
                onClick={() => patch({ next_plans: draft.next_plans.filter((_, j) => j !== i) })}
                className="mt-1 text-xs text-rose-500 active:opacity-70"
              >
                削除
              </button>
            </div>
          ))}
          {draft.next_plans.length === 0 && (
            <p className="py-2 text-center text-sm text-gray-400">予定はまだありません。</p>
          )}
        </div>
      </section>

      {error && (
        <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm leading-relaxed text-rose-700">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3 pb-4">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-full bg-indigo-600 px-6 py-3 text-sm font-bold text-white transition active:scale-95 disabled:opacity-50"
        >
          {saving ? "保存中…" : mode === "new" ? "この内容で登録" : "この内容で更新"}
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="rounded-full px-4 py-3 text-sm text-gray-500 active:opacity-70 disabled:opacity-50"
        >
          キャンセル
        </button>
      </div>

      <p className="pb-8 text-xs leading-relaxed text-gray-400">
        保存先は Supabase（retrospectives / retrospective_sections）です。
        Notion振り返りDBへの書き戻しはこの画面では未実装です。
      </p>
    </div>
  );
}

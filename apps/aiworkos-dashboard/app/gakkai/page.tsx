"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

// 学会書類。毎朝8時にローカルの定期タスクが取り込む書類（要約・納期・会合日）を
// 1枚で見る。上段は「納期が近い順」で出さなあかんものだけ、下段は全書類。
//
// 紙で受け取る書類は机の上で埋もれ、提出期限を当日に気づくことが多かった。
// 取込は Mac 側、3段階の納期リマインド（3日前/前日/当日）は Vercel Cron 側
// （/api/gakkai/notify）で、Macが閉じていても通知は落ちない。

type GakkaiEvent = { date?: string; title?: string };

type GakkaiDoc = {
  id: string;
  file_name: string | null;
  category: string | null;
  doc_type: string | null;
  summary: string | null;
  action_required: string | null;
  doc_date: string | null;
  deadline: string | null;
  deadline_label: string | null;
  events: GakkaiEvent[] | null;
  status: string;
  created_at: string | null;
};

// 絞り込みの並びは組織の近い順（自分の本部→支部→上位組織→その他）。
const CATEGORIES = [
  "西池袋池田本部",
  "城西支部",
  "池袋光城支部",
  "千川広宣本部",
  "豊島総区",
  "その他",
];

// 押すたびに 未対応→対応中→完了→未対応 と一周する。完了から未対応へ戻せるのは
// 押し間違いをその場で直せるようにするため（確認ダイアログを挟むほどの操作やない）。
const STATUS_CYCLE: Record<string, string> = {
  未対応: "対応中",
  対応中: "完了",
  完了: "未対応",
};

const STATUS_STYLE: Record<string, string> = {
  未対応: "bg-gray-100 text-gray-600",
  対応中: "bg-sky-100 text-sky-700",
  完了: "bg-emerald-100 text-emerald-700",
};

function fmtDate(d: string | null): string {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  return `${y}/${Number(m)}/${Number(day)}`;
}

// JST基準の今日（YYYY-MM-DD）。端末の時計は基本JSTだが、サーバー側の
// リマインド判定（/api/gakkai/notify）と同じ計算に揃えて、表示と通知で
// 「あと何日」が食い違わないようにする。
function jstTodayStr(): string {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// deadline - today の日数（当日=0、超過は負）。
function daysUntil(deadlineStr: string, todayStr: string): number {
  const deadline = new Date(`${deadlineStr}T00:00:00Z`).getTime();
  const today = new Date(`${todayStr}T00:00:00Z`).getTime();
  return Math.round((deadline - today) / (24 * 60 * 60 * 1000));
}

// 残り日数バッジ。3日以内は警告色、当日・超過は強調して逃さない。
function DeadlineBadge({ days }: { days: number }) {
  let cls = "bg-gray-100 text-gray-600";
  let label = `あと${days}日`;
  if (days < 0) {
    cls = "bg-rose-600 text-white";
    label = `${-days}日超過`;
  } else if (days === 0) {
    cls = "bg-rose-600 text-white";
    label = "今日が期限";
  } else if (days <= 3) {
    cls = "bg-amber-100 text-amber-800";
  }
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold ${cls}`}>
      {label}
    </span>
  );
}

export default function GakkaiPage() {
  const [rows, setRows] = useState<GakkaiDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("すべて");
  // status更新中の書類id（連打で同じ行へPATCHが重なるのを防ぐ）
  const [updating, setUpdating] = useState<string | null>(null);

  const today = jstTodayStr();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/gakkai", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました");
      setRows(data.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function cycleStatus(doc: GakkaiDoc) {
    const next = STATUS_CYCLE[doc.status] ?? "対応中";
    setUpdating(doc.id);
    try {
      const res = await fetch("/api/gakkai", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: doc.id, status: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "更新に失敗しました");
      // 一覧を再取得せず手元の行だけ差し替える（並びが変わって目が迷子にならない）。
      setRows((rs) => rs.map((r) => (r.id === doc.id ? { ...r, status: next } : r)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setUpdating(null);
    }
  }

  const filtered = useMemo(() => {
    if (categoryFilter === "すべて") return rows;
    if (categoryFilter === "その他") {
      // categoryが空・未知の書類も「その他」に寄せる（絞り込みで行方不明にしない）
      return rows.filter((r) => !r.category || !CATEGORIES.slice(0, -1).includes(r.category));
    }
    return rows.filter((r) => r.category === categoryFilter);
  }, [rows, categoryFilter]);

  // 上段: 納期がある未完了書類だけ。APIが deadline 昇順で返すのでそのまま使う。
  const dueSoon = useMemo(
    () => filtered.filter((r) => r.deadline && r.status !== "完了"),
    [filtered]
  );

  function statusButton(doc: GakkaiDoc) {
    return (
      <button
        type="button"
        onClick={() => cycleStatus(doc)}
        disabled={updating === doc.id}
        className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold active:scale-95 disabled:opacity-50 ${
          STATUS_STYLE[doc.status] ?? STATUS_STYLE["未対応"]
        }`}
        title="タップで 未対応→対応中→完了 を切替"
      >
        {updating === doc.id ? "更新中…" : doc.status}
      </button>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          学会書類
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          毎朝8時に自動で取り込まれる書類の要約・提出期限・会合日を1枚で。納期の3日前・前日・当日に通知が届きます
        </p>
      </header>

      <div className="mb-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-gray-700">{rows.length} 件</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {["すべて", ...CATEGORIES].map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setCategoryFilter(name)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                categoryFilter === name
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600 active:bg-gray-200"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="py-10 text-center text-sm text-gray-400">読み込み中…</p>}
      {error && (
        <p className="mb-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>
      )}

      {!loading && rows.length === 0 && !error && (
        <p className="rounded-2xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-400 shadow-sm">
          まだ書類が登録されてません
          <br />
          （毎朝8時に自動で取り込まれます）
        </p>
      )}

      {!loading && rows.length > 0 && (
        <>
          {/* 上段: 納期が近い順。出さなあかんものだけを絞って先頭に置く */}
          <section className="mb-8">
            <h2 className="mb-3 text-base font-bold text-gray-900">⏰ 納期が近い順</h2>
            {dueSoon.length === 0 ? (
              <p className="rounded-2xl border border-gray-200 bg-white p-4 text-sm text-gray-400 shadow-sm">
                期限つきの未対応書類はありません
              </p>
            ) : (
              <div className="space-y-3">
                {dueSoon.map((r) => {
                  const days = daysUntil(r.deadline as string, today);
                  return (
                    <div
                      key={r.id}
                      className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <DeadlineBadge days={days} />
                            <span className="text-xs text-gray-500">
                              {fmtDate(r.deadline)} 締切
                            </span>
                          </div>
                          <p className="mt-1.5 text-sm font-bold leading-snug text-gray-900">
                            {r.deadline_label || r.file_name || "（無題の書類）"}
                          </p>
                          {r.deadline_label && r.file_name && (
                            <p className="mt-0.5 text-xs text-gray-400">{r.file_name}</p>
                          )}
                        </div>
                        {statusButton(r)}
                      </div>
                      {r.action_required && (
                        <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-800">
                          ✍️ {r.action_required}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 下段: 全書類。納期の有無にかかわらず、何が来ているかを一覧する */}
          <section>
            <h2 className="mb-3 text-base font-bold text-gray-900">📄 書類一覧</h2>
            {filtered.length === 0 ? (
              <p className="rounded-2xl border border-gray-200 bg-white p-4 text-sm text-gray-400 shadow-sm">
                該当する書類はありません
              </p>
            ) : (
              <div className="space-y-3">
                {filtered.map((r) => {
                  const events = Array.isArray(r.events) ? r.events : [];
                  return (
                    <div
                      key={r.id}
                      className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-bold leading-snug text-gray-900">
                            {r.file_name || "（無題の書類）"}
                          </p>
                          <p className="mt-1 text-xs text-gray-500">
                            {r.category || "その他"}
                            {r.doc_type && (
                              <>
                                <span className="mx-1.5 text-gray-300">|</span>
                                {r.doc_type}
                              </>
                            )}
                            {r.doc_date && (
                              <>
                                <span className="mx-1.5 text-gray-300">|</span>
                                {fmtDate(r.doc_date)}
                              </>
                            )}
                          </p>
                        </div>
                        {statusButton(r)}
                      </div>

                      {r.summary && (
                        <p className="mt-2 text-sm leading-relaxed text-gray-600">
                          {r.summary}
                        </p>
                      )}

                      {r.deadline && (
                        <p className="mt-2 text-xs text-gray-600">
                          ⏰ {fmtDate(r.deadline)} 締切
                          {r.deadline_label && `: ${r.deadline_label}`}
                        </p>
                      )}

                      {events.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                          {events.map((ev, i) => (
                            <span key={i} className="text-xs text-indigo-600">
                              📅 {fmtDate(ev.date ?? null) || "日付未定"}{" "}
                              {ev.title ?? ""}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
      </div>
    </main>
  );
}

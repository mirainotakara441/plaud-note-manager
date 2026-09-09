"use client";

import { useCallback, useEffect, useState } from "react";

import type { ScoutsResponse } from "@/app/api/scouts/route";
import {
  BackToHome,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  REPLY_STATUS_LABEL,
  SourceBadge,
  daysSince,
  daysUntil,
  fmtDate,
} from "@/app/components/ui";
import type { ReplyStatus, ScoutWithRecruiter } from "@/lib/types";

// スカウト受信箱。
//
// この画面の目的は「返信漏れを潰すこと」の一点。放置日数が長いものほど上に来る
// （並べ替えは /api/scouts 側で確定済み：未返信を先頭、その中は受信が古い順）。
// 再送が来ているスカウトは、こちらが返していないから相手が催促している状態なので、
// 警告色で必ず目に入るようにしている。

const FILTERS = [
  { value: "pending", label: "未返信のみ" },
  { value: "all", label: "全部" },
] as const;

type FilterValue = (typeof FILTERS)[number]["value"];

/** 返信ステータスを変えるボタンの定義。押した値をそのまま PATCH する。 */
const ACTIONS: { value: ReplyStatus; label: string; on: string; off: string }[] = [
  {
    value: "replied",
    label: "返信した",
    on: "bg-emerald-600 text-white",
    off: "bg-emerald-50 text-emerald-700",
  },
  {
    value: "declined",
    label: "見送り",
    on: "bg-gray-500 text-white",
    off: "bg-gray-100 text-gray-600",
  },
  {
    value: "ignored",
    label: "無視",
    on: "bg-gray-500 text-white",
    off: "bg-gray-100 text-gray-600",
  },
];

/** 経過日数のチップ。7日以上は赤、3日以上は橙。返信漏れの温度計。 */
function ElapsedChip({ days, pending }: { days: number | null; pending: boolean }) {
  if (days === null) {
    return (
      <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[0.6875rem] font-bold text-gray-500">
        受信日不明
      </span>
    );
  }
  // 返信済みのものは日数で煽る必要がないので、常に静かな色にする。
  const tone = !pending
    ? "bg-gray-100 text-gray-500"
    : days >= 7
    ? "bg-rose-100 text-rose-700"
    : days >= 3
    ? "bg-amber-100 text-amber-800"
    : "bg-gray-100 text-gray-600";
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-bold ${tone}`}>
      {days === 0 ? "本日" : `${days}日経過`}
    </span>
  );
}

/** 締切の残り日数。3日以内と超過は赤で出す。 */
function DeadlineChip({ deadlineAt }: { deadlineAt: string | null }) {
  const left = daysUntil(deadlineAt);
  if (left === null) return null;
  const urgent = left <= 3;
  const text =
    left < 0 ? `締切超過（${fmtDate(deadlineAt)}）` : left === 0 ? "本日締切" : `締切まで${left}日`;
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[0.6875rem] font-bold ${
        urgent ? "bg-rose-100 text-rose-700" : "bg-sky-100 text-sky-800"
      }`}
    >
      ⏳ {text}
    </span>
  );
}

export default function ScoutsPage() {
  const [filter, setFilter] = useState<FilterValue>("pending");
  const [rows, setRows] = useState<ScoutWithRecruiter[]>([]);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scouts?filter=${filter}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as
        | (ScoutsResponse & { error?: string })
        | null;
      if (!res.ok || !data) {
        throw new Error(data?.error ?? `スカウトの取得に失敗しました（${res.status}）`);
      }
      setRows(data.rows);
      setPending(data.pending);
    } catch (e) {
      setError(e instanceof Error ? e.message : "スカウトの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 返信ステータスの更新。押した瞬間に画面へ反映し（楽観的更新）、失敗したら巻き戻す。
   * 「未返信のみ」表示のときは、処理済みになった1件をその場で消して受信箱を減らす。
   */
  async function patchScout(scout: ScoutWithRecruiter, next: ReplyStatus) {
    // 同じボタンをもう一度押したら未返信へ戻す（押し間違いをその場で消せるように）。
    const value: ReplyStatus = scout.reply_status === next ? "pending" : next;
    const snapshot = rows;
    const snapshotPending = pending;

    setActionError(null);
    setSavingId(scout.id);
    setRows((prev) =>
      prev.map((r) => (r.id === scout.id ? { ...r, reply_status: value } : r))
    );
    setPending((p) =>
      scout.reply_status === "pending" && value !== "pending"
        ? Math.max(p - 1, 0)
        : scout.reply_status !== "pending" && value === "pending"
        ? p + 1
        : p
    );

    try {
      const res = await fetch("/api/scouts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: scout.id, reply_status: value }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? `更新に失敗しました（${res.status}）`);

      // 「未返信のみ」で未返信でなくなったものは、少し置いてから受信箱から外す
      // （押した手応えが残るように、消える前に色の変化を見せる）。
      if (filter === "pending" && value !== "pending") {
        setTimeout(() => {
          setRows((prev) => prev.filter((r) => r.id !== scout.id));
        }, 450);
      }
    } catch (e) {
      setRows(snapshot); // 巻き戻し
      setPending(snapshotPending);
      setActionError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(2.5rem,env(safe-area-inset-top))]">
      <PageHeader
        title="スカウト受信箱"
        lead="ヘッドハンターからの打診を、放置日数の長い順に潰す"
      />

      {/* フィルタ＋未返信件数 */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-full px-4 py-1.5 text-xs font-bold transition active:scale-95 ${
                filter === f.value
                  ? "bg-teal-700 text-white"
                  : "border border-gray-200 bg-white text-gray-600"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {!loading && !error && (
          <p
            className={`shrink-0 text-xs font-bold ${
              pending > 0 ? "text-rose-600" : "text-gray-400"
            }`}
          >
            未返信 {pending}件
          </p>
        )}
      </div>

      {actionError && (
        <p className="mb-3 rounded-xl bg-rose-50 px-4 py-2 text-xs leading-relaxed text-rose-700">
          {actionError}
        </p>
      )}

      {loading ? (
        <LoadingBlock label="スカウトを読み込み中…" />
      ) : error ? (
        <ErrorBlock message={error} onRetry={load} />
      ) : rows.length === 0 ? (
        filter === "pending" ? (
          <EmptyBlock
            icon="✅"
            title="未返信のスカウトはありません"
            hint="返信漏れはゼロです。過去のやり取りを見返すときは「全部」に切り替えてください。新しい打診はホームの「今すぐ取込」で拾えます。"
            action={{ href: "/", label: "ホームに戻る" }}
          />
        ) : (
          <EmptyBlock
            icon="📬"
            title="まだスカウトがありません"
            hint="まだ取込していません。ホームの「今すぐ取込」を押してください。メールからヘッドハンターの打診を拾い上げ、返信待ちの古い順にここへ並べます。"
            action={{ href: "/", label: "ホームで取込する" }}
          />
        )
      ) : (
        <div className="space-y-3">
          {rows.map((s) => {
            const isPending = s.reply_status === "pending";
            const days = daysSince(s.received_at);
            const overdue = isPending && days !== null && days >= 7;
            return (
              <article
                key={s.id}
                className={`rounded-2xl border p-4 shadow-sm transition ${
                  overdue ? "border-rose-300 bg-rose-50" : "border-gray-200 bg-white"
                }`}
              >
                {/* ヘッドハンター名・所属・経過日数 */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-base font-bold leading-snug text-gray-900">
                      {s.recruiter?.name ?? "担当者不明"}
                    </h2>
                    <p className="mt-0.5 text-xs leading-relaxed text-gray-500">
                      {s.recruiter?.company ?? "所属不明"}
                      {s.recruiter?.rank && (
                        <span className="ml-1.5 rounded-md bg-violet-100 px-1.5 py-0.5 font-bold text-violet-700">
                          {s.recruiter.rank}
                        </span>
                      )}
                    </p>
                  </div>
                  <ElapsedChip days={days} pending={isPending} />
                </div>

                {/* 紹介先・ポジション・年収 */}
                <div className="mt-2.5 rounded-xl bg-gray-50 px-3 py-2">
                  <p className="text-sm font-bold leading-snug text-gray-900">
                    {s.company ?? "紹介先の記載なし"}
                  </p>
                  {s.position_title && (
                    <p className="mt-0.5 text-sm leading-relaxed text-gray-700">
                      {s.position_title}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-gray-600">
                    {s.salary_text?.trim() ? s.salary_text : "年収記載なし"}
                  </p>
                </div>

                {/* 受信日・出典・再送・締切 */}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-gray-500">
                  <span>受信 {fmtDate(s.received_at)}</span>
                  <SourceBadge source={s.source} />
                  {!isPending && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[0.6875rem] font-bold text-gray-600">
                      {REPLY_STATUS_LABEL[s.reply_status]}
                    </span>
                  )}
                  {s.resend_count > 0 && (
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[0.6875rem] font-bold text-rose-700">
                      ⚠️ 再送{s.resend_count}回
                    </span>
                  )}
                  <DeadlineChip deadlineAt={s.deadline_at} />
                </div>

                {/* 件名・本文抜粋 */}
                {s.subject && (
                  <p className="mt-2.5 text-xs font-bold leading-relaxed text-gray-700">
                    {s.subject}
                  </p>
                )}
                {s.body_excerpt && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs font-bold text-teal-700">
                      本文の抜粋を見る
                    </summary>
                    <p className="mt-1.5 whitespace-pre-wrap rounded-xl bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600">
                      {s.body_excerpt}
                    </p>
                  </details>
                )}

                {s.note && (
                  <p className="mt-2 whitespace-pre-wrap rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                    {s.note}
                  </p>
                )}

                {/* 返信ステータス */}
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
                  {ACTIONS.map((a) => (
                    <button
                      key={a.value}
                      onClick={() => patchScout(s, a.value)}
                      disabled={savingId === s.id}
                      className={`rounded-full px-3 py-1.5 text-xs font-bold active:scale-95 disabled:opacity-50 ${
                        s.reply_status === a.value ? a.on : a.off
                      }`}
                    >
                      {a.label}
                    </button>
                  ))}
                  {s.replied_at && (
                    <span className="ml-auto text-[0.6875rem] text-gray-400">
                      {fmtDate(s.replied_at)} に返信
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <BackToHome />
    </main>
  );
}

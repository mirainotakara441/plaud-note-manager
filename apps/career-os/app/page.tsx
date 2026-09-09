"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { HomeStats } from "@/app/api/home-stats/route";
import {
  ErrorBlock,
  ScoreBadge,
  SourceBadge,
  Spinner,
  daysSince,
  fmtDate,
  fmtDateTime,
  formatSalary,
} from "@/app/components/ui";

// ホーム（作戦盤）。
//
// この画面だけ見れば「今週なにが来ていて、どれを放置しているか」が分かる状態を作る。
// 数字は /api/home-stats を1回叩いて取る（個別APIを4本叩かない）。
//
// 一番の実害は「ヘッドハンターへの返信漏れ」。未返信が1件でもあれば数字カードを
// 赤系に振り、経過日数つきで上位3件を直に出す。0件のときだけ静かな見た目に戻る。

type NavCard = {
  href: string;
  icon: string;
  title: string;
  desc: string;
  accent: string;
};

const NAV_CARDS: NavCard[] = [
  {
    href: "/jobs",
    icon: "📮",
    title: "求人一覧",
    desc: "届いた求人を適合スコア順に並べ、気になる／見送りで仕分ける",
    accent: "bg-teal-100 text-teal-700",
  },
  {
    href: "/scouts",
    icon: "📬",
    title: "スカウト受信箱",
    desc: "ヘッドハンターからの打診を、放置日数の長い順に潰す",
    accent: "bg-rose-100 text-rose-700",
  },
  {
    href: "/fit",
    icon: "🎯",
    title: "適合診断",
    desc: "判断軸の重みを調整し、気になる求人を判断軸ごとに深掘り採点",
    accent: "bg-amber-100 text-amber-700",
  },
  {
    href: "/jobs?status=interested",
    icon: "⭐️",
    title: "気になるリスト",
    desc: "「気になる」を付けた求人だけを抜き出して見直す",
    accent: "bg-sky-100 text-sky-700",
  },
];

type StatCard = {
  href: string;
  label: string;
  value: number;
  caption: string;
  /** 未返信スカウトが残っているときだけ、目立つ配色に切り替える */
  alert?: boolean;
};

function buildStatCards(stats: HomeStats): StatCard[] {
  const c = stats.counts;
  return [
    { href: "/jobs?sort=new", label: "新着求人", value: c.new_jobs_7d, caption: "過去7日" },
    {
      href: "/scouts",
      label: "未返信スカウト",
      value: c.pending_scouts,
      caption: c.pending_scouts > 0 ? "返信待ち" : "残なし",
      alert: c.pending_scouts > 0,
    },
    { href: "/jobs?sort=fit", label: "本命候補", value: c.top_fit, caption: "スコア85以上" },
    {
      href: "/jobs?status=interested",
      label: "気になる",
      value: c.interested,
      caption: "仕分け済み",
    },
  ];
}

/** 経過日数のチップ。7日以上は赤、3日以上は橙。返信漏れの温度計。 */
function ElapsedChip({ days }: { days: number | null }) {
  if (days === null) {
    return (
      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[0.6875rem] font-bold text-gray-500">
        受信日不明
      </span>
    );
  }
  const tone =
    days >= 7
      ? "bg-rose-100 text-rose-700"
      : days >= 3
      ? "bg-amber-100 text-amber-800"
      : "bg-gray-100 text-gray-600";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-bold ${tone}`}>
      {days === 0 ? "本日" : `${days}日経過`}
    </span>
  );
}

export default function HomePage() {
  const [stats, setStats] = useState<HomeStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);
  const [ingestFailed, setIngestFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/home-stats", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `取得に失敗しました（${res.status}）`);
      setStats(data as HomeStats);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 手動取込。/api/ingest は別担当が作成中なので、
   * 404（HTMLが返る）でも 500 でもここで受け止め、画面は壊さない。
   */
  async function runIngest() {
    if (ingesting) return;
    setIngesting(true);
    setIngestMsg(null);
    setIngestFailed(false);
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: "manual" }),
      });
      // 取込APIが未実装だと HTML が返るため、JSON解析は必ず握り潰す。
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;

      if (!res.ok) {
        setIngestFailed(true);
        const apiMsg = typeof data?.error === "string" ? data.error : null;
        setIngestMsg(
          apiMsg ??
            (res.status === 404
              ? "取込APIはまだ準備中です（この画面は正常です）"
              : `取込APIがエラーを返しました（${res.status}）`)
        );
        return;
      }

      const parts: string[] = [];
      if (typeof data?.new_jobs === "number") parts.push(`新着求人 ${data.new_jobs}件`);
      if (typeof data?.new_scouts === "number") parts.push(`新着スカウト ${data.new_scouts}件`);
      setIngestMsg(parts.length > 0 ? `取込が完了しました：${parts.join(" / ")}` : "取込が完了しました");
      await load();
    } catch {
      setIngestFailed(true);
      setIngestMsg("取込を開始できませんでした（通信エラー）");
    } finally {
      setIngesting(false);
    }
  }

  const cards = stats ? buildStatCards(stats) : [];
  const isEmpty =
    stats !== null &&
    stats.stale_scouts.length === 0 &&
    stats.top_jobs.length === 0 &&
    stats.counts.new_jobs_7d === 0 &&
    stats.last_ingest === null;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(2.5rem,env(safe-area-inset-top))]">
      <header className="mb-8 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">キャリアOS</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">
          メールを、自分の判断軸で並べ替える。
          <br />
          求人・スカウト・適合診断を1枚でつなぐ作戦盤
        </p>
      </header>

      {/* 今週の数字 */}
      {loading ? (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-[88px] animate-pulse rounded-2xl border border-gray-200 bg-gray-100"
            />
          ))}
        </div>
      ) : error ? (
        <div className="mb-6">
          <ErrorBlock message={error} onRetry={load} />
        </div>
      ) : (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {cards.map((c) => (
            <Link
              key={c.label}
              href={c.href}
              className={`rounded-2xl border p-3 shadow-sm transition active:scale-95 ${
                c.alert ? "border-rose-300 bg-rose-50" : "border-gray-200 bg-white"
              }`}
            >
              <p
                className={`text-xs font-bold ${c.alert ? "text-rose-700" : "text-gray-500"}`}
              >
                {c.label}
              </p>
              <p
                className={`mt-1 text-2xl font-bold ${
                  c.alert ? "text-rose-700" : "text-gray-900"
                }`}
              >
                {c.value}
              </p>
              <p className={`mt-0.5 text-xs ${c.alert ? "text-rose-500" : "text-gray-400"}`}>
                {c.caption}
              </p>
            </Link>
          ))}
        </div>
      )}

      {/* 一部だけ取得できなかった場合の控えめな注意書き。画面自体は出し続ける。 */}
      {stats && stats.errors.length > 0 && (
        <p className="mb-6 rounded-xl bg-amber-50 px-4 py-2 text-xs leading-relaxed text-amber-800">
          一部の集計を取得できませんでした：{stats.errors.join(" / ")}
        </p>
      )}

      {/* まだ1件もデータが無いとき。最初に開いた人がここで詰まらないようにする。 */}
      {isEmpty && (
        <section className="mb-6 rounded-2xl border border-dashed border-teal-300 bg-teal-50 px-5 py-6 text-center">
          <p className="text-3xl" aria-hidden>
            📥
          </p>
          <p className="mt-3 text-sm font-bold text-teal-900">まだ何も取り込んでいません</p>
          <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-teal-800">
            下の「今すぐ取込」を押すと、メールから求人とスカウトを拾い上げます。
            取込が終わると、この作戦盤に数字と一覧が並びます。
          </p>
        </section>
      )}

      {/* 未返信で日数が経っているスカウト */}
      {stats && stats.stale_scouts.length > 0 && (
        <section className="mb-6">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-bold text-gray-500">放置している未返信スカウト</h2>
            <Link href="/scouts" className="text-xs text-teal-700 active:opacity-70">
              すべて見る →
            </Link>
          </div>
          <div className="space-y-2">
            {stats.stale_scouts.map((s) => {
              const days = daysSince(s.received_at);
              const overdue = days !== null && days >= 7;
              return (
                <Link
                  key={s.id}
                  href="/scouts"
                  className={`block rounded-2xl border p-4 shadow-sm transition active:bg-gray-50 ${
                    overdue ? "border-rose-300 bg-rose-50" : "border-gray-200 bg-white"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 text-sm font-bold text-gray-900">
                      {s.recruiter?.name ?? "担当者不明"}
                      {s.recruiter?.company && (
                        <span className="ml-1 text-xs font-medium text-gray-500">
                          （{s.recruiter.company}）
                        </span>
                      )}
                    </p>
                    <ElapsedChip days={days} />
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-gray-600">
                    {s.company ?? "紹介先未記載"}
                    {s.position_title ? ` / ${s.position_title}` : ""}
                  </p>
                  {s.resend_count > 0 && (
                    <p className="mt-1.5 inline-block rounded-full bg-rose-100 px-2 py-0.5 text-[0.6875rem] font-bold text-rose-700">
                      再送{s.resend_count}回
                    </p>
                  )}
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* 適合スコア上位 */}
      {stats && stats.top_jobs.length > 0 && (
        <section className="mb-6">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-bold text-gray-500">適合スコア上位</h2>
            <Link href="/jobs?sort=fit" className="text-xs text-teal-700 active:opacity-70">
              すべて見る →
            </Link>
          </div>
          <div className="space-y-2">
            {stats.top_jobs.map((j) => (
              <Link
                key={j.id}
                href="/jobs?sort=fit"
                className="block rounded-2xl border border-gray-200 bg-white p-4 shadow-sm transition active:bg-gray-50"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-gray-900">{j.company}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-gray-600">{j.title}</p>
                  </div>
                  <ScoreBadge score={j.fit_score} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                  <span>{formatSalary(j)}</span>
                  {j.location && <span>{j.location}</span>}
                  <SourceBadge source={j.source} />
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 4画面への導線 */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-bold text-gray-500">画面</h2>
        <div className="space-y-3">
          {NAV_CARDS.map((f) => (
            <Link
              key={f.href}
              href={f.href}
              className="flex items-center gap-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm transition active:bg-gray-50"
            >
              <span
                className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-2xl ${f.accent}`}
                aria-hidden
              >
                {f.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-bold text-gray-900">{f.title}</span>
                <span className="mt-0.5 block text-sm leading-relaxed text-gray-500">
                  {f.desc}
                </span>
              </span>
              <span className="shrink-0 text-lg text-gray-300" aria-hidden>
                →
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* 取込 */}
      <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-bold text-gray-900">メールの取込</p>
            <p className="mt-0.5 text-xs leading-relaxed text-gray-500">
              {loading
                ? "最終取込を確認中…"
                : stats?.last_ingest
                ? `最終取込 ${fmtDateTime(stats.last_ingest.finished_at)}（求人${stats.last_ingest.new_jobs}件 / スカウト${stats.last_ingest.new_scouts}件）`
                : "まだ取込の記録がありません"}
            </p>
          </div>
          <button
            onClick={runIngest}
            disabled={ingesting}
            className="flex shrink-0 items-center gap-2 rounded-full bg-teal-700 px-4 py-2 text-sm font-bold text-white transition active:bg-teal-800 disabled:opacity-50"
          >
            {ingesting && <Spinner />}
            {ingesting ? "取込中…" : "今すぐ取込"}
          </button>
        </div>

        {stats?.last_ingest?.error && (
          <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
            前回の取込でエラーが記録されています（{fmtDate(stats.last_ingest.finished_at)}）：
            {stats.last_ingest.error}
          </p>
        )}

        {ingestMsg && (
          <p
            className={`mt-3 rounded-xl px-3 py-2 text-xs leading-relaxed ${
              ingestFailed ? "bg-amber-50 text-amber-800" : "bg-teal-50 text-teal-800"
            }`}
          >
            {ingestMsg}
          </p>
        )}
      </section>

      <p className="mt-8 text-center text-xs leading-relaxed text-gray-400">
        この画面の内容は現職に知られたくないもの。共有・スクリーンショットに注意。
      </p>
    </main>
  );
}

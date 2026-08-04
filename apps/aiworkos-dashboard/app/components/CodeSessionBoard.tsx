"use client";

import { useEffect, useMemo, useState } from "react";

// ホームの「セッションの鮮度」。中身は /api/code-sessions。
//
// 出し方の考え方（AdvisorCard と同じ作法）:
//   ・畳んだ状態でも、いちばん重い1行は読める。見出しに「昨日から動いたのは N本／
//     中断 M本／3日以上放置 K本」を置き、開かなくても状況が分かるようにする。
//   ・件数だけのバッジにしない。盤面そのものを最初から見せる。
//   ・測れないものは出さない。セッションに「完了」の定義が無いので進捗率(%)は作らない。
//     出すのは動きの鮮度（最後に動いてからの日数）と詰まり方（中断）だけ。
//   ・今日のスナップショットが無い日は、古い盤面を今日の状態として出さない。
//     「最終取得 MM/DD時点」と明示し、「昨日から」も言わない
//     （進捗の実装で、古い値を黙って今日の顔で出す罠を一度踏んでいる）。
//
// 盤面の読み方:
//   1マス＝セッション1本（アーカイブ済みは出さない）。
//   濃さ＝最後に動いてからの経過日数。今日動いたものが濃く、放置されるほど薄くなる。
//   色相＝中断したまま止まっているか（藍=通常／橙=中断）。薄さとは別の軸にしてある。
//   枠＝ピン留め。

type BoardSession = {
  id: string;
  title: string;
  place: string;
  days_idle: number | null;
  last_activity_at: string | null;
  last_event: string;
  pinned: boolean;
  stalled: boolean;
};

type BoardResponse = {
  today: string;
  snapshot_date: string | null;
  sessions: BoardSession[];
  moved_since_prev: number | null;
  prev_date: string | null;
  error?: string;
};

// 鮮度の段階。境目は「今日／昨日／2日／1週間／2週間／それ以上」。
// いちばん薄い段を indigo-50 まで落とすと白地に溶けて、放置の塊が「見えない」のではなく
// 「無い」ように見えてしまう。薄い側は 100 で止めて、必ず面として残す。
const STEPS = [
  { limit: 1, live: "bg-indigo-700", stalled: "bg-amber-600" },
  { limit: 2, live: "bg-indigo-500", stalled: "bg-amber-500" },
  { limit: 3, live: "bg-indigo-400", stalled: "bg-amber-400" },
  { limit: 7, live: "bg-indigo-300", stalled: "bg-amber-300" },
  { limit: 14, live: "bg-indigo-200", stalled: "bg-amber-200" },
  { limit: Infinity, live: "bg-indigo-100", stalled: "bg-amber-100" },
] as const;

/**
 * 中断を名前で並べる本数の上限。超えたぶんは「ほか N本」に畳む。
 *
 * 数だけを出していた頃は「中断6本」としか読めず、どれが止まっているのかは
 * 盤面のマスに触って回るまで分からなかった。中断は普段ひと桁なので、
 * 名前をそのまま置ける。放置（3桁になる）は数のままでよい。
 */
const NAMED_STALLED_MAX = 4;

function toneOf(s: BoardSession): string {
  // 経過日数が読めなかったマスは、いちばん薄い段に置く（勝手に「今日」にしない）。
  const idle = s.days_idle ?? Infinity;
  const step = STEPS.find((t) => idle < t.limit) ?? STEPS[STEPS.length - 1];
  return s.stalled ? step.stalled : step.live;
}

function shortDate(day: string): string {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function idleText(days: number | null): string {
  if (days === null) return "最終更新が読めません";
  const hours = Math.floor(days * 24);
  if (hours < 1) return "1時間以内";
  if (days < 1) return `${hours}時間前`;
  return `${Math.floor(days)}日前`;
}

function Cell({
  s,
  active,
  onPick,
}: {
  s: BoardSession;
  active: boolean;
  onPick: (s: BoardSession) => void;
}) {
  return (
    <button
      type="button"
      onMouseEnter={() => onPick(s)}
      onFocus={() => onPick(s)}
      onClick={() => onPick(s)}
      title={`${s.title}／${idleText(s.days_idle)}／${s.place}`}
      aria-label={`${s.title}、${idleText(s.days_idle)}、${s.place}`}
      className={`aspect-square rounded-[3px] transition ${toneOf(s)} ${
        s.pinned ? "ring-2 ring-slate-800" : ""
      } ${active ? "scale-125" : ""}`}
    />
  );
}

export default function CodeSessionBoard() {
  const [data, setData] = useState<BoardResponse | null>(null);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [picked, setPicked] = useState<BoardSession | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/code-sessions", { cache: "no-store" })
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

  const summary = useMemo(() => {
    if (!data) return null;
    const list = data.sessions;
    // 中断は、新しく止まったものほど手を戻しやすい。経過の浅い順に並べて、
    // 名前で読める本数だけ前に出す。数だけでは「どれが」が分からず、
    // 結局この盤面を開き直すことになる。
    const stalledList = list
      .filter((s) => s.stalled)
      .sort((a, b) => (a.days_idle ?? Infinity) - (b.days_idle ?? Infinity));
    return {
      total: list.length,
      stalledList,
      stalledNamed: stalledList.slice(0, NAMED_STALLED_MAX),
      stalledRest: Math.max(0, stalledList.length - NAMED_STALLED_MAX),
      stale: list.filter((s) => (s.days_idle ?? Infinity) >= 3).length,
    };
  }, [data]);

  if (failedToLoad) {
    return (
      <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-bold text-gray-900">🗂️ セッションの鮮度</p>
        <p className="mt-1 text-sm text-gray-500">取得できませんでした</p>
      </section>
    );
  }

  if (!data || !summary) {
    return (
      <div className="mb-6 h-[168px] animate-pulse rounded-2xl border border-gray-200 bg-gray-100" />
    );
  }

  if (!data.snapshot_date || summary.total === 0) {
    return (
      <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-bold text-gray-900">
          🗂️ セッションの鮮度
          <span className="ml-2 font-medium text-gray-400">走査結果がまだありません</span>
        </p>
        <p className="mt-1 text-sm text-gray-500">
          進捗（毎晩22:30）が一度も届いていません。
        </p>
      </section>
    );
  }

  const isToday = data.snapshot_date === data.today;
  // 今日の盤面でない日は「昨日から」を言わない。日付がずれたまま昨日比を出すと、
  // 何日ぶんの動きなのか分からない数字になる。
  const showMoved = isToday && data.moved_since_prev !== null;

  return (
    <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-gray-900">🗂️ セッションの鮮度</p>
        <p className="text-xs font-bold text-gray-400">
          {isToday ? `全${summary.total}本` : `最終取得 ${shortDate(data.snapshot_date)}時点`}
        </p>
      </div>

      {/* 数だけの行は「6本ある」以上のことを伝えない。中断は普段ひと桁なので、
          どれが止まっているのかを名前で書く。放置は3桁になるので数のままにする。 */}
      <p className="mb-2 text-sm leading-relaxed text-gray-600">
        {showMoved && (
          <>
            昨日から
            <span className="font-bold text-gray-900">{data.moved_since_prev}本</span>
            が動いた
            {" ／ "}
          </>
        )}
        3日以上動いていないのが
        <span className="font-bold text-gray-900">{summary.stale}本</span>
        {!isToday && <span className="text-gray-400">（{shortDate(data.snapshot_date)}時点）</span>}
      </p>

      {summary.stalledList.length > 0 ? (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-sm font-bold text-amber-800">
            中断したまま {summary.stalledList.length}本
          </p>
          <ul className="mt-1 space-y-0.5">
            {summary.stalledNamed.map((s) => (
              <li key={s.id} className="text-sm leading-snug text-amber-900">
                <span className="font-medium">{s.title}</span>
                <span className="text-amber-700">
                  {" — "}
                  {idleText(s.days_idle)}
                  {s.last_event ? `・${s.last_event}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {summary.stalledRest > 0 && (
            <p className="mt-1 text-sm text-amber-700">
              ほか {summary.stalledRest}本（盤面の橙のマス）
            </p>
          )}
        </div>
      ) : (
        <p className="mb-3 text-sm text-gray-500">中断したまま止まっているものはありません。</p>
      )}

      {!isToday && (
        <p className="mb-3 text-sm text-amber-700">
          今日の走査がまだ届いていません。この盤面は
          {shortDate(data.snapshot_date)}時点のもので、今の状態ではありません。
        </p>
      )}

      {/* 列数は幅任せ（auto-fill）。実測で iPhone(375px)は14列、PC(1280px)は33列になり、
          どちらも1枚のカードに収まる。列数を固定するとどちらかで溢れるか間延びする。 */}
      <div
        className="grid gap-[3px] rounded-xl bg-slate-50 p-2"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(18px, 1fr))" }}
      >
        {data.sessions.map((s) => (
          <Cell key={s.id} s={s} active={picked?.id === s.id} onPick={setPicked} />
        ))}
      </div>

      <div className="mt-3 min-h-[2.75rem] rounded-xl bg-gray-50 px-3 py-2">
        {picked ? (
          <>
            <p className="truncate text-sm font-bold text-gray-900">
              {picked.pinned && <span className="mr-1">📌</span>}
              {picked.title}
            </p>
            <p className="mt-0.5 text-xs text-gray-500">
              {idleText(picked.days_idle)}
              {" ／ "}
              {picked.place}
              {picked.stalled && (
                <span className="font-bold text-amber-700">{" ／ "}中断</span>
              )}
              {picked.last_event && <span>（{picked.last_event}）</span>}
            </p>
          </>
        ) : (
          <p className="text-xs leading-relaxed text-gray-400">
            マスに触れるとセッション名・経過・場所が出ます
          </p>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
        <span className="flex items-center gap-1">
          今日
          <span className="h-3 w-3 rounded-[3px] bg-indigo-700" aria-hidden />
          <span className="h-3 w-3 rounded-[3px] bg-indigo-400" aria-hidden />
          <span className="h-3 w-3 rounded-[3px] bg-indigo-200" aria-hidden />
          <span className="h-3 w-3 rounded-[3px] bg-indigo-100" aria-hidden />
          2週以上
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded-[3px] bg-amber-400" aria-hidden />
          中断
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded-[3px] bg-indigo-300 ring-2 ring-slate-800" aria-hidden />
          ピン留め
        </span>
      </div>
    </section>
  );
}

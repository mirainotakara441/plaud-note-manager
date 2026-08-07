"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// ホームの「セッションの鮮度」。中身は /api/code-sessions。
//
// 出し方の考え方（AdvisorCard と同じ作法）:
//   ・畳んだ状態でも、いちばん重い1行は読める。
//   ・件数だけのバッジにしない。実際にどのセッションなのかを名前で出す。
//   ・測れないものは出さない。セッションに「完了」の定義が無いので進捗率(%)は作らない。
//     出すのは動きの鮮度（最後に動いてからの日数）と詰まり方（中断）だけ。
//   ・今日のスナップショットが無い日は、古い盤面を今日の状態として出さない。
//     「最終取得 MM/DD時点」と明示し、「昨日から」も言わない
//     （進捗の実装で、古い値を黙って今日の顔で出す罠を一度踏んでいる）。
//
// 見せ方（2026-08-04に作り替え）:
//   もとは1マス＝1セッションの濃淡ヒートマップだったが、192マスの濃さの差を
//   読み解くのは実際には無理があった。「今日／2週以上／中断／ピン留め」の
//   凡例を見比べないと意味が取れず、どれが止まっているのかはマスに触って回る
//   まで分からない。数を一望する形より、**名前で読める一覧**に寄せる。
//
//   ・「今日動いた」「1週間以内」「中断」の3つに切り替える。既定は今日。
//   ・中断は濃さではなく橙の面で区別する（他の軸と混ざらないよう色相を分ける）。
//   ・長い尾（1週間以上動いていない大量のセッション）は数だけを最後に1行で出す。
//     一覧に混ぜると読む気が失せ、結局どれも読まれなくなる。

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

type TabKey = "today" | "week" | "stalled";

/**
 * 一覧に名前を並べる上限。超えたぶんは「ほか N本」に畳む。
 *
 * 1週間以内は数十本になることがある。全部並べるとホームが一覧で埋まって、
 * 下にある機能カードまで辿り着けなくなる。上限を切って、続きは数で示す。
 */
const LIST_MAX = 12;

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

// ピン留めを先頭に、あとは動きが新しい順。中断は「新しく止まったものほど
// 手を戻しやすい」ので、同じ並びでよい。
function byFreshness(a: BoardSession, b: BoardSession): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return (a.days_idle ?? Infinity) - (b.days_idle ?? Infinity);
}

function Row({
  s,
  busy,
  onPin,
  onHide,
}: {
  s: BoardSession;
  busy: boolean;
  onPin: (s: BoardSession) => void;
  onHide: (s: BoardSession) => void;
}) {
  return (
    <li
      className={`rounded-lg border px-3 py-2 ${
        s.stalled ? "border-amber-200 bg-amber-50" : "border-gray-100 bg-gray-50"
      } ${busy ? "opacity-50" : ""}`}
    >
      <p className="flex items-start gap-1.5 text-sm font-medium leading-snug text-gray-900">
        <button
          type="button"
          onClick={() => onPin(s)}
          disabled={busy}
          aria-pressed={s.pinned}
          aria-label={s.pinned ? "ピン留めを外す" : "ピン留めする"}
          title={s.pinned ? "ピン留めを外す" : "ピン留めする（上に固定）"}
          className={`shrink-0 rounded px-0.5 transition active:scale-90 ${
            s.pinned ? "" : "opacity-25 grayscale"
          }`}
        >
          📌
        </button>
        <span className="min-w-0 flex-1">{s.title}</span>
        {s.stalled && (
          <span className="shrink-0 rounded-full bg-amber-200 px-1.5 py-0.5 text-[0.6875rem] font-bold text-amber-900">
            中断
          </span>
        )}
        <button
          type="button"
          onClick={() => onHide(s)}
          disabled={busy}
          aria-label="盤面から消す"
          title="盤面から消す（会話そのものは消えません）"
          className="shrink-0 rounded-md px-1 text-gray-300 transition active:bg-gray-200 active:text-rose-500"
        >
          ✕
        </button>
      </p>
      <p
        className={`mt-0.5 text-xs leading-relaxed ${
          s.stalled ? "text-amber-700" : "text-gray-500"
        }`}
      >
        {idleText(s.days_idle)}
        {" ／ "}
        {s.place}
        {s.last_event && `（${s.last_event}）`}
      </p>
    </li>
  );
}

export default function CodeSessionBoard() {
  const [data, setData] = useState<BoardResponse | null>(null);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [tab, setTab] = useState<TabKey>("today");
  const [reloading, setReloading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/code-sessions", { cache: "no-store" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      setData(await r.json());
      setFailedToLoad(false);
    } catch {
      setFailedToLoad(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ピン留め／盤面から消す。どちらも見え方だけを変える操作で、
  // Macの中の会話には触らない。反映は読み直しで確かめる（楽観更新にすると、
  // 保存に失敗しても消えたように見えてしまう）。
  async function setPref(s: BoardSession, patch: { hidden?: boolean; pinned?: boolean }) {
    setBusyId(s.id);
    try {
      const r = await fetch("/api/code-sessions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: s.id, ...patch }),
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
      await load();
    } catch {
      setFailedToLoad(true);
    } finally {
      setBusyId(null);
    }
  }

  function hideSession(s: BoardSession) {
    if (!window.confirm(`「${s.title}」を盤面から消します。\n会話そのものは消えません。よろしいですか？`)) return;
    setPref(s, { hidden: true });
  }

  async function reload() {
    setReloading(true);
    await load();
    setReloading(false);
  }

  const buckets = useMemo(() => {
    if (!data) return null;
    const list = data.sessions;
    // days_idle が読めなかったものは「今日動いた」に混ぜない（勝手に新しくしない）。
    const idle = (s: BoardSession) => s.days_idle ?? Infinity;
    return {
      total: list.length,
      today: list.filter((s) => idle(s) < 1).sort(byFreshness),
      week: list.filter((s) => idle(s) < 7).sort(byFreshness),
      stalled: list.filter((s) => s.stalled).sort(byFreshness),
      cold: list.filter((s) => idle(s) >= 7).length,
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

  if (!data || !buckets) {
    return (
      <div className="mb-6 h-[168px] animate-pulse rounded-2xl border border-gray-200 bg-gray-100" />
    );
  }

  if (!data.snapshot_date || buckets.total === 0) {
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

  const TABS: { key: TabKey; label: string; list: BoardSession[] }[] = [
    { key: "today", label: "今日動いた", list: buckets.today },
    { key: "week", label: "1週間以内", list: buckets.week },
    { key: "stalled", label: "中断", list: buckets.stalled },
  ];
  const current = TABS.find((t) => t.key === tab) ?? TABS[0];
  const shown = current.list.slice(0, LIST_MAX);
  const rest = current.list.length - shown.length;

  return (
    <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-gray-900">🗂️ セッションの鮮度</p>
        <div className="flex items-baseline gap-2">
          <p className="text-xs font-bold text-gray-400">
            {isToday ? `全${buckets.total}本` : `最終取得 ${shortDate(data.snapshot_date)}時点`}
          </p>
          <button
            type="button"
            onClick={reload}
            disabled={reloading}
            className="rounded-full border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-500 transition active:bg-gray-100 disabled:opacity-40"
          >
            {reloading ? "更新中" : "更新"}
          </button>
        </div>
      </div>

      {showMoved && (
        <p className="mb-2 text-sm leading-relaxed text-gray-600">
          昨日から
          <span className="font-bold text-gray-900">{data.moved_since_prev}本</span>
          が動きました
        </p>
      )}

      {!isToday && (
        <p className="mb-2 text-sm text-amber-700">
          今日の走査がまだ届いていません。以下は
          {shortDate(data.snapshot_date)}時点のもので、今の状態ではありません。
        </p>
      )}

      {/* 切り替え。件数をラベルに載せて、開かなくても分布が分かるようにする */}
      <div className="mb-2 flex gap-1 rounded-xl bg-gray-100 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-pressed={t.key === tab}
            className={`flex-1 rounded-lg px-1 py-1.5 transition ${
              t.key === tab
                ? t.key === "stalled"
                  ? "bg-amber-500 text-white"
                  : "bg-white text-gray-900 shadow-sm"
                : "text-gray-500 active:bg-gray-200"
            }`}
          >
            {/* iPhone幅では「今日動いた」が折り返す。3つとも
                ラベル＋件数の2段に固定して、高さと重心を揃える */}
            <span className="block whitespace-nowrap text-[0.8125rem] font-medium leading-tight">
              {t.label}
            </span>
            <span className="block text-sm font-bold leading-tight">{t.list.length}</span>
          </button>
        ))}
      </div>

      {shown.length > 0 ? (
        <ul className="space-y-1.5">
          {shown.map((s) => (
            <Row
              key={s.id}
              s={s}
              busy={busyId === s.id}
              onPin={(x) => setPref(x, { pinned: !x.pinned })}
              onHide={hideSession}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-lg bg-gray-50 px-3 py-3 text-sm text-gray-500">
          {tab === "stalled"
            ? "中断したまま止まっているものはありません。"
            : "この期間に動いたセッションはありません。"}
        </p>
      )}

      {rest > 0 && (
        <p className="mt-1.5 text-sm text-gray-500">ほか {rest}本</p>
      )}

      {/* 長い尾は数だけ。一覧に混ぜると読む気が失せる */}
      {buckets.cold > 0 && (
        <p className="mt-2 border-t border-gray-100 pt-2 text-xs text-gray-400">
          1週間以上動いていないのが {buckets.cold}本
        </p>
      )}
    </section>
  );
}

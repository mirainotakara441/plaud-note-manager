"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import IntegrationPanel from "@/app/components/IntegrationPanel";
import AdvisorCard from "@/app/components/AdvisorCard";
import CodeSessionBoard from "@/app/components/CodeSessionBoard";
import NextTargetsCard from "@/app/components/NextTargetsCard";

// 全体設計図（v2.0）と進捗スコアカードは、アプリ内の /blueprint ページで常に開ける。
// 中身は public/ の自己完結HTML（合言葉認証の内側・claude.ai ログイン不要）。
//
// ホーム上部の「今日の作戦盤」は /api/home-stats を1回叩き、当日ToDoの残数と
// 今週の週報KPI（接点・宿題消化）、今週のClaude利用時間をタップ導線つきで見せる
// （Claude利用時間のみリンク無し）。
// 未完リストのプレビュー（旧TodoReminder）はここでは重複表示になるため外し、
// コンポーネント自体は他画面での再利用のため残してある。

type Feature = {
  href: string;
  icon: string;
  title: string;
  desc: string;
  accent: string; // アイコンチップの配色
};

const RECORD_FEATURES: Feature[] = [
  {
    href: "/diary",
    icon: "📓",
    title: "一行日記を登録",
    desc: "その日の日記を貼るだけでNotionと記憶に反映",
    accent: "bg-violet-100 text-violet-700",
  },
  {
    href: "/deliverables",
    icon: "📎",
    title: "成果物を登録",
    desc: "提案書・実習書・スライド・メモを取り込み、提案の土台にする",
    accent: "bg-purple-100 text-purple-700",
  },
  {
    href: "/refine",
    icon: "💬",
    title: "壁打ち",
    desc: "成果物・スライド・提出文書をひとつの入口で深掘り。答えるほど熟成し記憶に還る",
    accent: "bg-teal-100 text-teal-700",
  },
];

// 並びは「探す・相手を知る」→「作る」。前半が攻める相手を決める道具、
// 後半がその相手に出すものを作る道具。
const PROPOSE_FEATURES: Feature[] = [
  {
    href: "/search",
    icon: "🔍",
    title: "横断検索",
    desc: "日記・会議・学び・成果物を自然言語でまとめて検索",
    accent: "bg-indigo-100 text-indigo-700",
  },
  {
    href: "/organizations",
    icon: "🧭",
    title: "団体別攻略",
    desc: "団体ごとの状態・課題・施策と、会議・週報・成果物の時系列を1画面に",
    accent: "bg-fuchsia-100 text-fuchsia-700",
  },
  {
    href: "/legislators",
    icon: "🏛️",
    title: "議員リスト",
    desc: "会派・議会の階層で議員を辿り、接触履歴とこれからの予定を1画面で確認",
    accent: "bg-indigo-100 text-indigo-700",
  },
  {
    href: "/agent",
    icon: "🤖",
    title: "提案エージェント",
    desc: "団体を選ぶと、経緯・論点・打ち手・骨子を自動提案",
    accent: "bg-blue-100 text-blue-700",
  },
  {
    href: "/weapons",
    icon: "⚔️",
    title: "武器を出す",
    desc: "決めた打ち手を想定ストーリー・想定問答・スライド構成案にする",
    accent: "bg-amber-100 text-amber-700",
  },
];

// 並びは「日々 → 週 → 月」。手前ほど頻繁に開くものを置く。
// 団体別攻略・議員リストは、振り返るものではなく攻める相手を決める道具なので
// PROPOSE_FEATURES 側に置いてある。
const REVIEW_FEATURES: Feature[] = [
  {
    href: "/actions",
    icon: "✅",
    title: "日々のToDo",
    desc: "日記の「やってみよう」「本日のポイント」を積み上げてチェック消し込み",
    accent: "bg-emerald-100 text-emerald-700",
  },
  {
    href: "/retrospective",
    icon: "🪞",
    title: "振り返り",
    desc: "週次・月次の★評価と総括・示唆・次期の予定を溜め、節ごとの推移を追う",
    accent: "bg-violet-100 text-violet-700",
  },
  {
    href: "/weekly-report",
    icon: "🗂️",
    title: "週報ダッシュボード",
    desc: "自治体・事業者・議員・委託会社の週次活動をカテゴリー別に一枚で確認",
    accent: "bg-cyan-100 text-cyan-700",
  },
  {
    href: "/monthly-report",
    icon: "🗓️",
    title: "月報ドラフト自動生成",
    desc: "暦月を選ぶと週報のKPI集計とAI月報ドラフトを生成し、サイト・Notionへ登録",
    accent: "bg-orange-100 text-orange-700",
  },
];

// 仕事の振り返りではなく、AIワークOSそのものが健全に回っているかを見る群。
// 見る目的が違うものを「振り返る」に混ぜると、毎日開く場所が薄まる。
const SYSTEM_FEATURES: Feature[] = [
  {
    href: "/status",
    icon: "📊",
    title: "連携ダッシュボード",
    desc: "Supabaseの蓄積・取込ジョブ・壁打ち・ニュース収集の状況を監視",
    accent: "bg-rose-100 text-rose-700",
  },
  {
    href: "/nippo",
    icon: "📒",
    title: "日報録",
    desc: "各セッションで何をどこまで進めたかを日付ごとに記録・一覧",
    accent: "bg-sky-100 text-sky-700",
  },
];

const LEARN_FEATURES: Feature[] = [
  {
    href: "/bootcamp",
    icon: "📘",
    title: "ブートキャンプ学習",
    desc: "Sprintごとの学びとQ&Aを溜め、新規事業への応用に変える",
    accent: "bg-indigo-100 text-indigo-700",
  },
  {
    href: "/salt2",
    icon: "🎓",
    title: "SALT2人脈DB",
    desc: "ブートキャンプ受講生を業界・立場・趣味から引き、共通点を見つけて繋がる",
    accent: "bg-blue-100 text-blue-700",
  },
];

const LIFESTYLE_HEALTH_FEATURES: Feature[] = [
  {
    href: "/health",
    icon: "🩺",
    title: "健康推移",
    desc: "体重・体脂肪率・歩数・摂取カロリー・歩行の質の日次推移を確認",
    accent: "bg-lime-100 text-lime-700",
  },
  {
    href: "/ramen",
    icon: "🍜",
    title: "ラーメン",
    desc: "食べログの口コミとXの投稿を一杯ごとにつなぎ、通算杯数と店の履歴を追う",
    accent: "bg-orange-100 text-orange-700",
  },
  {
    href: "/family",
    icon: "👨‍👩‍👧‍👦",
    title: "ファミリー",
    desc: "子どもたちとどこへ行き何があったかを、写真ごと残して振り返る",
    accent: "bg-rose-100 text-rose-700",
  },
  {
    href: "/home-visit",
    icon: "🏠",
    title: "家庭訪問",
    desc: "壮年部・男子部を人ごとに、いつ訪ね会えたか・何を話したかと次の予定を残す",
    accent: "bg-violet-100 text-violet-700",
  },
];

type HomeStats = {
  today: string;
  todo: { total: number; remaining: number };
  week: {
    week_start: string | null;
    contacts: number;
    homework_total: number;
    homework_done: number;
  };
  claude_hours: number;
  error?: string;
};

const WD = ["日", "月", "火", "水", "木", "金", "土"];

function greeting(hour: number): string {
  if (hour >= 5 && hour < 10) return "おはようございます。";
  if (hour >= 17) return "おつかれさまです。";
  return "今日も一つずつ、進めていきましょう。";
}

type StatCard = {
  href?: string;
  label: string;
  value: string;
  caption: string;
};

function buildStatCards(stats: HomeStats | null, fetchFailed: boolean): StatCard[] {
  const err = stats?.error;
  const todoFailed = fetchFailed || (!!err && (err.includes("daily_actions") || err.includes("ToDo")));
  const weekFailed = fetchFailed || (!!err && (err.includes("weekly_reports") || err.includes("週報")));
  const noWeek = !weekFailed && !stats?.week.week_start;

  const todoCard: StatCard = todoFailed
    ? { href: "/actions", label: "今日のToDo", value: "—", caption: "取得できませんでした" }
    : stats && stats.todo.total === 0
    ? { href: "/actions", label: "今日のToDo", value: "0", caption: "今日のToDoはありません" }
    : {
        href: "/actions",
        label: "今日のToDo",
        value: `${stats?.todo.remaining ?? 0}/${stats?.todo.total ?? 0}`,
        caption: "残り / 全件",
      };

  // 「今週の接点」は中身が伝わらなかった（何が1件なのか分からない）。
  // 実体は今週の週報に書いた活動の行数なので、そのまま名前にする。
  const contactsCard: StatCard = weekFailed
    ? { href: "/weekly-report", label: "今週の活動", value: "—", caption: "取得できませんでした" }
    : noWeek
    ? { href: "/weekly-report", label: "今週の活動", value: "—", caption: "週報データがまだありません" }
    : {
        href: "/weekly-report",
        label: "今週の活動",
        value: `${stats?.week.contacts ?? 0}`,
        caption: "週報に書いた件数",
      };

  const homeworkCard: StatCard = weekFailed
    ? { href: "/weekly-report", label: "宿題消化", value: "—", caption: "取得できませんでした" }
    : noWeek
    ? { href: "/weekly-report", label: "宿題消化", value: "—", caption: "週報データがまだありません" }
    : stats && stats.week.homework_total === 0
    ? { href: "/weekly-report", label: "宿題消化", value: "—", caption: "宿題なし" }
    : {
        href: "/weekly-report",
        label: "宿題消化",
        value: `${stats?.week.homework_done ?? 0}/${stats?.week.homework_total ?? 0}`,
        caption: "完了 / 全件",
      };

  const claudeHoursFailed =
    fetchFailed || (!!err && (err.includes("claude_usage_daily") || err.includes("Claude利用時間")));

  const claudeHoursCard: StatCard = claudeHoursFailed
    ? { label: "今週のClaude利用時間", value: "—", caption: "取得できませんでした" }
    : { label: "今週のClaude利用時間", value: `${stats?.claude_hours ?? 0}h`, caption: "合計" };

  return [todoCard, contactsCard, homeworkCard, claudeHoursCard];
}

// ホーム上部の飛び先。id は FeatureGroup と1対1で対応させる。
// iPhoneだと機能カードが縦に20枚以上並び、下の群は毎回スクロールで掘り当てることになる。
const GROUPS = [
  { id: "g-record", short: "記録", title: "📥 記録する" },
  { id: "g-review", short: "振り返る", title: "📊 振り返る" },
  { id: "g-propose", short: "提案", title: "⚔️ 提案する" },
  { id: "g-learn", short: "学ぶ", title: "🎓 学ぶ" },
  { id: "g-life", short: "ライフ", title: "🌱 ライフスタイル・ヘルス" },
  { id: "g-system", short: "システム", title: "🛠 システム" },
] as const;

/** 上部に貼り付く群への近道。押すとその群の見出しまで飛ぶ。 */
function GroupNav() {
  return (
    <nav
      aria-label="カテゴリー"
      className="sticky top-0 z-10 -mx-4 mb-4 border-b border-gray-200 bg-gray-50/95 px-4 py-2 backdrop-blur"
    >
      {/* 横スクロール1行。折り返して2段にすると、貼り付いた時に画面を食いすぎる */}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5">
        {GROUPS.map((g) => (
          <a
            key={g.id}
            href={`#${g.id}`}
            className="shrink-0 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 transition active:bg-gray-100"
          >
            {g.short}
          </a>
        ))}
      </div>
    </nav>
  );
}

// 機能カードは2列グリッド・説明文なし。縦長の原因は「カード20枚×説明文」で、
// 説明はもう覚えられている。desc は title 属性（PCのホバー）にだけ残す。
//
// collapsible な群（ライフ・システム）は既定で畳む。毎日開くものではないので、
// 畳んでもホームの役割（今日の作戦から始める）は損なわれない。
function FeatureGroup({
  id,
  title,
  features,
  collapsible,
}: {
  id: string;
  title: string;
  features: Feature[];
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);

  return (
    // scroll-mt は貼り付いたナビの下に見出しが隠れないための余白。
    <section id={id} className="mb-5 scroll-mt-16">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mb-2 flex w-full items-center justify-between text-sm font-bold text-gray-500 active:opacity-70"
        >
          <span>{title}</span>
          <span className="text-gray-300">{open ? "▲" : "▼"}</span>
        </button>
      ) : (
        <h2 className="mb-2 text-sm font-bold text-gray-500">{title}</h2>
      )}
      {open && (
        <div className="grid grid-cols-2 gap-2">
          {features.map((f) => (
            <Link
              key={f.href}
              href={f.href}
              title={f.desc}
              className="flex items-center gap-2.5 rounded-xl border border-gray-200 bg-white px-3 py-2.5 shadow-sm transition active:bg-gray-50"
            >
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg ${f.accent}`}
                aria-hidden
              >
                {f.icon}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-bold text-gray-900">
                {f.title}
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export default function Home() {
  const [stats, setStats] = useState<HomeStats | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [now] = useState(() => new Date());

  useEffect(() => {
    let alive = true;
    fetch("/api/home-stats", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((d) => {
        if (alive) setStats(d);
      })
      .catch(() => {
        if (alive) setFetchFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const loading = !stats && !fetchFailed;
  const cards = buildStatCards(stats, fetchFailed);
  const weekday = WD[now.getDay()];

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(2.5rem,env(safe-area-inset-top))]">
      <header className="mb-8 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">
          AIワークOS
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">
          記録を記憶に、記憶を提案に。
          <br />
          入力 → 記憶 → 提案・出力を1枚でつなぐワークスペース
        </p>
      </header>

      <section className="mb-6">
        <div className="mb-3 flex items-baseline justify-between">
          <p className="text-sm font-bold text-gray-900">
            {now.getMonth() + 1}月{now.getDate()}日（{weekday}）
          </p>
          <p className="text-xs text-gray-400">{greeting(now.getHours())}</p>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-[88px] animate-pulse rounded-2xl border border-gray-200 bg-gray-100"
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {cards.map((c) =>
              c.href ? (
                <Link
                  key={c.label}
                  href={c.href}
                  className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm transition active:scale-95"
                >
                  <p className="text-xs font-bold text-gray-500">{c.label}</p>
                  <p className="mt-1 text-2xl font-bold text-gray-900">{c.value}</p>
                  <p className="mt-0.5 text-xs text-gray-400">{c.caption}</p>
                </Link>
              ) : (
                <div
                  key={c.label}
                  className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm"
                >
                  <p className="text-xs font-bold text-gray-500">{c.label}</p>
                  <p className="mt-1 text-2xl font-bold text-gray-900">{c.value}</p>
                  <p className="mt-0.5 text-xs text-gray-400">{c.caption}</p>
                </div>
              )
            )}
          </div>
        )}
      </section>

      {/* 「今朝の気づき」は作戦盤のすぐ下。各ダッシュボードは見に行けば分かるが、
          見に行かなければ分からない。溜まったデータ側から声をかける役をここに置く。 */}
      <AdvisorCard />

      {/* 次に攻める相手。このOSの目的は成約で、ホームは機能の棚である前に
          「今日どの相手に何をするか」から始まるべき。/status の抜粋。 */}
      <NextTargetsCard />

      {/* セッションの鮮度。並行して抱えている本数が多く、どれがどこまで進んだか
          分からなくなる。進捗率は測れない（セッションに「完了」の定義が無い）ので、
          出すのは動きの鮮度と詰まり方だけ。放置されている帯が薄い塊として浮かぶ。 */}
      <CodeSessionBoard />

      <GroupNav />

      <FeatureGroup id="g-record" title="📥 記録する" features={RECORD_FEATURES} />
      <FeatureGroup id="g-review" title="📊 振り返る" features={REVIEW_FEATURES} />
      <FeatureGroup id="g-propose" title="⚔️ 提案する" features={PROPOSE_FEATURES} />
      <FeatureGroup id="g-learn" title="🎓 学ぶ" features={LEARN_FEATURES} />
      <FeatureGroup
        id="g-life"
        title="🌱 ライフスタイル・ヘルス"
        features={LIFESTYLE_HEALTH_FEATURES}
        collapsible
      />
      <FeatureGroup id="g-system" title="🛠 システム" features={SYSTEM_FEATURES} collapsible />

      <IntegrationPanel />

      <div className="mb-6">
        <Link
          href="/blueprint"
          className="flex items-center gap-4 rounded-2xl border border-emerald-300 bg-emerald-50 p-4 shadow-sm transition active:bg-emerald-100"
        >
          <span
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-2xl text-white"
            aria-hidden
          >
            📐
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-bold text-emerald-900">
              全体設計図 v2.0
            </span>
            <span className="mt-0.5 block text-sm leading-relaxed text-emerald-700">
              システム構成と今後のロードマップ（改訂版）。進捗スコアカードも同じページで。
            </span>
          </span>
          <span className="shrink-0 text-lg text-emerald-400" aria-hidden>
            →
          </span>
        </Link>
      </div>

      <p className="mt-8 text-center text-xs font-medium text-gray-400">
        記憶の蓄積状況は{" "}
        <Link href="/status" className="text-indigo-500 underline active:opacity-70">
          連携ダッシュボード
        </Link>{" "}
        で確認
      </p>

      {/* 使っているAI・アプリの全体像（2026-08-01作成）。
          claude.ai のArtifactに置いてあるため、開くには claude.ai のログインが要る
          （/blueprint のように public/ へ自己完結HTMLを置く手もあるが、
           全体図は随時更新するのでArtifact側を正としてリンクだけ張る）。 */}
      <div className="mt-6">
        <a
          href="https://claude.ai/code/artifact/1626f997-74d7-4d7b-804f-955e9ca3101e"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-4 rounded-2xl border border-indigo-300 bg-indigo-50 p-4 shadow-sm transition active:bg-indigo-100"
        >
          <span
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-2xl text-white"
            aria-hidden
          >
            🗺️
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-bold text-indigo-900">
              AIワークOS ／ ライフOS 全体図 v1.0
            </span>
            <span className="mt-0.5 block text-sm leading-relaxed text-indigo-700">
              使っているAI・アプリ・連携の全体像（2026年8月時点）。claude.ai で開きます。
            </span>
          </span>
          <span className="shrink-0 text-lg text-indigo-400" aria-hidden>
            ↗
          </span>
        </a>
      </div>
    </main>
  );
}

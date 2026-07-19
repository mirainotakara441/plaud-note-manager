import Link from "next/link";
import IntegrationPanel from "@/app/components/IntegrationPanel";

// 全体設計図（v2.0）と進捗スコアカードは、アプリ内の /blueprint ページで常に開ける。
// 中身は public/ の自己完結HTML（合言葉認証の内側・claude.ai ログイン不要）。

type Feature = {
  href: string;
  icon: string;
  title: string;
  desc: string;
  accent: string; // アイコンチップの配色
};

const FEATURES: Feature[] = [
  {
    href: "/search",
    icon: "🔍",
    title: "横断検索",
    desc: "日記・会議・学び・成果物を自然言語でまとめて検索",
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
    href: "/refine",
    icon: "💬",
    title: "壁打ち",
    desc: "登録内容をAIが深掘り質問。答えるほど熟成し記憶に還る",
    accent: "bg-teal-100 text-teal-700",
  },
  {
    href: "/weapons",
    icon: "⚔️",
    title: "武器を出す",
    desc: "決めた打ち手を想定ストーリー・想定問答・スライド構成案にする",
    accent: "bg-amber-100 text-amber-700",
  },
  {
    href: "/deliverables",
    icon: "📎",
    title: "成果物を登録",
    desc: "提案書・実習書・スライド・メモを取り込み、提案の土台にする",
    accent: "bg-purple-100 text-purple-700",
  },
  {
    href: "/status",
    icon: "📊",
    title: "連携ダッシュボード",
    desc: "Supabaseの蓄積・取込ジョブ・壁打ち・ニュース収集の状況を監視",
    accent: "bg-rose-100 text-rose-700",
  },
];

export default function Home() {
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

      <div className="space-y-3">
        {FEATURES.map((f) => (
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
              <span className="block text-base font-bold text-gray-900">
                {f.title}
              </span>
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

      <IntegrationPanel />

      <p className="mt-8 text-center text-xs font-medium text-gray-400">
        記憶の蓄積状況は{" "}
        <Link href="/status" className="text-indigo-500 underline active:opacity-70">
          連携ダッシュボード
        </Link>{" "}
        で確認
      </p>
    </main>
  );
}

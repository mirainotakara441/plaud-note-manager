import Link from "next/link";
import IntegrationPanel from "@/app/components/IntegrationPanel";

// 全体設計図と進捗スコアカード（Claude Artifact）。常に上部から開けるようにする。
// ※Artifactは非公開設定のため、claude.ai にログイン中の本人のみ閲覧可。
const BLUEPRINT_URL =
  "https://claude.ai/code/artifact/a3ead75e-f51b-4831-8faa-5f97cdf5b57b";
const SCORECARD_URL =
  "https://claude.ai/code/artifact/8f707b8c-418b-43a9-b51d-b24c7c5d5ee0";

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
        <a
          href={BLUEPRINT_URL}
          target="_blank"
          rel="noopener noreferrer"
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
              システム構成と今後のロードマップ（改訂版）
            </span>
          </span>
          <span className="shrink-0 text-lg text-emerald-400" aria-hidden>
            ↗
          </span>
        </a>
        <p className="mt-2 text-center text-xs font-medium text-gray-400">
          進捗の突き合わせは{" "}
          <a
            href={SCORECARD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-600 underline active:opacity-70"
          >
            設計図 vs 現在地 スコアカード
          </a>
        </p>
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

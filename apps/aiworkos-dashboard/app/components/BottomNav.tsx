"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 下部固定のタブバー。PWAで毎日開く5画面（ホーム・日記・ToDo・週報・健康）へ
// どの画面からもワンタップで移れるようにする。ホームまで戻ってカードを探す往復が
// 積み重なると、記録そのものが億劫になるため。
//
// タブは増やさない。6つ以上並べると1つあたりの幅が縮んで押し間違いが増える。
// 「よく開くがタブに入らない」ものはホームの「よく使う」チップ行が受け持つ。
const TABS = [
  { href: "/", icon: "🏠", label: "ホーム" },
  { href: "/diary", icon: "📓", label: "日記" },
  { href: "/actions", icon: "✅", label: "ToDo" },
  { href: "/weekly-report", icon: "🗂️", label: "週報" },
  { href: "/health", icon: "🩺", label: "健康" },
];

export default function BottomNav() {
  const pathname = usePathname();

  // ログイン画面（合言葉ゲート）ではまだ中に入っていないので、導線を見せない。
  if (pathname === "/login" || pathname.startsWith("/login/")) return null;

  return (
    <nav
      aria-label="主要ページ"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-gray-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <div className="mx-auto flex max-w-2xl">
        {TABS.map((t) => {
          const active =
            pathname === t.href || (t.href !== "/" && pathname.startsWith(`${t.href}/`));
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              // min-h-[44px]: 指で確実に押せる下限（iOSのタップ領域指針）
              className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 transition active:bg-gray-100 ${
                active ? "text-indigo-600" : "text-gray-400"
              }`}
            >
              <span className="text-lg leading-none" aria-hidden>
                {t.icon}
              </span>
              <span className="text-[0.625rem] font-bold leading-none">{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

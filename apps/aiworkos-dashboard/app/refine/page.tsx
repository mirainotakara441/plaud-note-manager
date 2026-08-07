"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import DeliverableRefine from "@/app/components/refine/DeliverableRefine";
import SlideRefine from "@/app/components/refine/SlideRefine";
import ProcedureRefine from "@/app/components/refine/ProcedureRefine";

// 壁打ちの唯一の入口。もともと /refine（成果物）・/slide-refine・/procedure-refine の
// 3ページに分かれていたが、利用実態（3ページ合計でもセッションが少ない）に対して入口が
// 多すぎたため、モード切替つきの1ページに統合した。チャットエンジンは3つのままで、
// それぞれの中身を app/components/refine/ に移しただけ（エンジン統合はスコープ外）。
// 旧URLは /refine?mode=… へのリダイレクトとして残している。

type Mode = "deliverable" | "slide" | "procedure";

const MODES: { id: Mode; icon: string; label: string; desc: string }[] = [
  {
    id: "deliverable",
    icon: "🗨",
    label: "成果物",
    desc: "登録内容を土台にAIが深掘り質問。答えるほど内容が熟成し、成果物として記憶に還ります",
  },
  {
    id: "slide",
    icon: "🎯",
    label: "スライド",
    desc: "目的・聞き手・ゴールをAIが深掘り。答えるほど構成が固まり、スライド構成案と簡易ビジュアルまで作ります",
  },
  {
    id: "procedure",
    icon: "📋",
    label: "提出文書",
    desc: "実施理由書・実施要領書・スキーム整理を文書の型ごとの急所から深掘り。章立て・表・要確認事項まで作ります",
  },
];

// 不正な値や未指定は成果物モードに倒す（旧 /refine のブックマークがそのまま動く）。
function parseMode(raw: string | null): Mode {
  if (raw === "slide" || raw === "procedure") return raw;
  return "deliverable";
}

function RefineEntryInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // モードはURLクエリだけを正とする（stateに二重に持つと戻る操作や共有リンクとずれる）。
  const mode = parseMode(searchParams.get("mode"));
  const current = MODES.find((m) => m.id === mode) ?? MODES[0];

  function switchMode(next: Mode) {
    if (next === mode) return;
    // 成果物モードはクエリ無しの素の /refine にする（従来のURLと同じ形を保つ）。
    router.replace(next === "deliverable" ? "/refine" : `/refine?mode=${next}`, {
      scroll: false,
    });
  }

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">壁打ち</h1>
        {/* モード切替。iPhone幅(375px)でも3つ並ぶよう、短いラベル＋アイコンにしている */}
        <div className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-gray-100 p-1">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => switchMode(m.id)}
              className={`rounded-lg px-2 py-2 text-sm font-semibold transition ${
                m.id === mode
                  ? "bg-white text-indigo-700 shadow-sm"
                  : "text-gray-500 active:opacity-70"
              }`}
            >
              {m.icon} {m.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">{current.desc}</p>
      </header>

      {/* keyを付けてモード切替時に必ず作り直す（前モードの進行中stateを持ち越さない） */}
      {mode === "slide" ? (
        <SlideRefine key="slide" />
      ) : mode === "procedure" ? (
        <ProcedureRefine key="procedure" />
      ) : (
        <DeliverableRefine key="deliverable" />
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
      </div>
    </main>
  );
}

export default function RefinePage() {
  return (
    <Suspense fallback={<main className="p-4 text-sm text-gray-500">読み込み中...</main>}>
      <RefineEntryInner />
    </Suspense>
  );
}

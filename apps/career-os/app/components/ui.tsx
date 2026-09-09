"use client";

import Link from "next/link";

import { scoreBand } from "@/lib/profile";
import type { CareerJob, JobSource, JobStatus, ReplyStatus } from "@/lib/types";

// キャリアOS 4画面（ホーム・求人一覧・スカウト受信箱・適合診断）で共通に使う小さな部品。
//
// ここに寄せている理由は2つ。
//   1. 「読み込み中 / エラー / 空」の3状態を、どの画面でも同じ見た目で必ず出すため。
//      データが1件も無い状態で最初に開かれるアプリなので、空状態が最重要の画面になる。
//   2. アクセントカラー（teal）と、適合スコアの色分け（lib/profile.ts の scoreBand）を
//      1か所に集約するため。AIワークOS は indigo なので、並べたときに別アプリだと分かる。
//
// 表示の寸法は iPhone を基準にしている。globals.css で 768px 以上は基準フォントが
// 18px に拡大されるため、rem 前提の Tailwind クラスをそのまま書けばPCでも読める。

/* ------------------------------------------------------------------ *
 * 見出し・戻り導線
 * ------------------------------------------------------------------ */

/** 各画面の上部。ホームへの戻り導線・タイトル・一言説明をまとめて出す。 */
export function PageHeader({ title, lead }: { title: string; lead: string }) {
  return (
    <header className="mb-6">
      <Link href="/" className="text-sm text-teal-700 active:opacity-70">
        ← ホーム
      </Link>
      <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">{title}</h1>
      <p className="mt-1 text-sm leading-relaxed text-gray-500">{lead}</p>
    </header>
  );
}

/** 画面末尾のホーム導線。長いリストを下まで見た後に戻れるようにする。 */
export function BackToHome() {
  return (
    <div className="mt-8 text-center">
      <Link href="/" className="text-sm text-teal-700 active:opacity-70">
        ← ホーム
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 状態表示（読み込み中 / エラー / 空）
 * ------------------------------------------------------------------ */

/** 回転するスピナー。取込・再採点など時間のかかる処理のボタン内でも使う。 */
export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
      aria-hidden
    />
  );
}

export function LoadingBlock({ label = "読み込み中…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-12 text-sm text-gray-400 shadow-sm">
      <Spinner />
      {label}
    </div>
  );
}

/** APIが返した日本語メッセージをそのまま見せる。再試行できる画面では再読込ボタンも出す。 */
export function ErrorBlock({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4">
      <p className="text-sm leading-relaxed text-rose-800">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 rounded-full bg-rose-600 px-4 py-1.5 text-xs font-bold text-white active:scale-95"
        >
          もう一度読み込む
        </button>
      )}
    </div>
  );
}

/**
 * 空状態。真っ白にせず、必ず「次に何をすればいいか」を書く。
 * DBが空の状態で最初に開かれるので、この文言が実質のオンボーディングになる。
 */
export function EmptyBlock({
  icon,
  title,
  hint,
  action,
}: {
  icon: string;
  title: string;
  hint: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-5 py-10 text-center">
      <p className="text-3xl" aria-hidden>
        {icon}
      </p>
      <p className="mt-3 text-sm font-bold text-gray-700">{title}</p>
      <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-gray-500">{hint}</p>
      {action && (
        <Link
          href={action.href}
          className="mt-4 inline-block rounded-full bg-teal-700 px-5 py-2 text-xs font-bold text-white active:bg-teal-800"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 適合スコア
 * ------------------------------------------------------------------ */

// scoreBand() が返す tone を実際のクラス名に対応させる。
// Tailwind はソース中の文字列を走査してCSSを生成するため、
// `bg-${tone}-100` のような動的組み立てにはできない（クラスが生成されず無色になる）。
const SCORE_TONE: Record<"emerald" | "sky" | "amber" | "slate", string> = {
  emerald: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  sky: "bg-sky-100 text-sky-800 ring-sky-200",
  amber: "bg-amber-100 text-amber-800 ring-amber-200",
  slate: "bg-slate-100 text-slate-600 ring-slate-200",
};

/** 適合スコアのバッジ。数値とラベル（本命候補 / 検討に値する …）を一体で出す。 */
export function ScoreBadge({
  score,
  size = "sm",
}: {
  score: number | null | undefined;
  size?: "sm" | "lg";
}) {
  const band = scoreBand(score);
  const tone = SCORE_TONE[band.tone];
  const scored = score !== null && score !== undefined;

  if (size === "lg") {
    return (
      <div className={`rounded-2xl px-4 py-3 text-center ring-1 ${tone}`}>
        <p className="text-3xl font-bold leading-none">{scored ? score : "—"}</p>
        <p className="mt-1 text-xs font-bold">{band.label}</p>
      </div>
    );
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${tone}`}
    >
      <span className="text-sm leading-none">{scored ? score : "—"}</span>
      <span className="font-medium">{band.label}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * ラベル（DBの英字コードを日本語に直す）
 * ------------------------------------------------------------------ */

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  new: "新着",
  interested: "気になる",
  casual: "カジュアル面談",
  applied: "応募済み",
  screening: "選考中",
  final: "最終選考",
  offer: "オファー",
  declined: "見送り",
  archived: "アーカイブ",
};

/** 求人ステータスのチップ。進行中のものだけ色を付け、それ以外は静かに出す。 */
const JOB_STATUS_TONE: Record<JobStatus, string> = {
  new: "bg-teal-50 text-teal-700",
  interested: "bg-amber-100 text-amber-800",
  casual: "bg-sky-100 text-sky-800",
  applied: "bg-sky-100 text-sky-800",
  screening: "bg-indigo-100 text-indigo-800",
  final: "bg-violet-100 text-violet-800",
  offer: "bg-emerald-100 text-emerald-800",
  declined: "bg-gray-100 text-gray-500",
  archived: "bg-gray-100 text-gray-500",
};

export function JobStatusChip({ status }: { status: JobStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[0.6875rem] font-bold ${JOB_STATUS_TONE[status]}`}
    >
      {JOB_STATUS_LABEL[status]}
    </span>
  );
}

export const REPLY_STATUS_LABEL: Record<ReplyStatus, string> = {
  pending: "未返信",
  replied: "返信済み",
  declined: "見送り",
  ignored: "無視",
};

export const SOURCE_LABEL: Record<JobSource, string> = {
  doda_x: "doda X",
  eight: "Eight",
  bizreach: "ビズリーチ",
  recruit: "リクルート",
  other: "その他",
};

/** 出典バッジ。どのサービス経由で来た話かが一目で分かるようにする。 */
export function SourceBadge({ source }: { source: JobSource | null }) {
  return (
    <span className="inline-block rounded-md bg-gray-100 px-2 py-0.5 text-[0.6875rem] font-medium text-gray-600">
      {source ? SOURCE_LABEL[source] ?? source : "出典不明"}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * 表示用のフォーマッタ
 * ------------------------------------------------------------------ */

/**
 * 年収の表示。数値レンジがあればそれを優先し、無ければ求人票の原文（salary_text）を使う。
 * どちらも無い求人は珍しくないので「年収記載なし」で潰す（空文字で崩れないように）。
 */
export function formatSalary(
  job: Pick<CareerJob, "salary_min" | "salary_max" | "salary_text">
): string {
  const { salary_min: min, salary_max: max } = job;
  if (min !== null && max !== null) return `${min}万〜${max}万円`;
  if (min !== null) return `${min}万円〜`;
  if (max !== null) return `〜${max}万円`;
  const text = job.salary_text?.trim();
  return text && text !== "" ? text : "年収記載なし";
}

/** ISO日時 → 「8/2」。年をまたぐものだけ「2025/12/30」と年を足す。 */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 受信からの経過日数。今日なら 0。日時が無ければ null。 */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/** 締切までの残り日数。過ぎていれば負の数。 */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

/** 「7/28 15:04」形式。最終取込日時のように、時刻まで見たい場所で使う。 */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${fmtDate(iso)} ${hh}:${mm}`;
}

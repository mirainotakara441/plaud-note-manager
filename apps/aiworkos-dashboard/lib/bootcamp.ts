// SALT2 AIサマーブートキャンプ（2026年8月〜9月）の学習ログの共通部品。
//
// 運営の「ブートキャンプアプリ」（https://r2b-webapp.vercel.app/）が
// 教材・提出・公式クイズ・進捗率をすでに持っているので、同じものは作らない。
// ここが担うのは運営アプリに無い次の3つ。
//   1. 学習内容を自分の手元に溜める（運営アプリは読むだけで残らない）
//   2. 溜めた内容から自分専用のテストを作る（運営クイズは固定問題）
//   3. 学んだことを公共事業0→1の仕事にどう繋げるか（運営アプリに無い観点）
//
// 3つ目が本命。ただの学習記録で終わらせず、2ヶ月後に
// 「自分の事業に何が効いたか」が残る形にするため business_application を必須にしている。
//
// このファイルは /bootcamp ページ（クライアント）から読むので、
// next/server などサーバー専用のものは import しない。

// ── Sprintとフェーズ ──────────────────────────────────────────────
//
// 運営アプリの進捗表と同じ並びにしてある（往復しても迷わないように）。
// ビジネストラックはSprint1・Sprint2の2本立て。

export const SPRINTS = ["Sprint1", "Sprint2"] as const;
export type Sprint = (typeof SPRINTS)[number];

export const PHASES = [
  "Learn",
  "Design",
  "Build",
  "Review",
  "Presentation",
] as const;
export type Phase = (typeof PHASES)[number];

// フェーズが何をする時間なのかは、運営アプリの説明と揃えている。
export const PHASE_LABEL: Record<Phase, string> = {
  Learn: "概念を理解・確認する",
  Design: "要件定義・設計をする",
  Build: "AIと協働して実装する",
  Review: "動く仕組みを読み解く",
  Presentation: "発表資料を作り、発表する",
};

// ── QAセッション ──────────────────────────────────────────────────
//
// qa-thinking スキル（講義Q&A形式で段階的に理解するスキル）の結果を、
// 構造を保ったまま持つ。生の本文コピペより、こちらの方がクイズの材料として上等。
// すでにQとAの形になっているぶん、4択問題への変換が素直に効くため。
//   example（例え話）→ 誤答選択肢の作りどころ
//   summary（3点まとめ）→ 解説文の下敷き
//
// 講は3つまでに集約する運用なので、chapters は通常3件。

export type QaPair = {
  q: string;
  a: string;
  example?: string; // 日常の例え話。無い設問もあるので任意
};

export type QaChapter = {
  no: number;
  title: string;
  goal?: string;
  qa: QaPair[];
  summary?: string[];
};

export type QaSession = {
  theme: string;
  recorded_on?: string;
  structure_note?: string;
  chapters: QaChapter[];
};

// ── クイズ ────────────────────────────────────────────────────────

export type QuizQuestion = {
  question: string;
  choices: string[];
  answer_index: number;
  explanation?: string;
};

export type Quiz = {
  generated_at?: string;
  questions: QuizQuestion[];
};

// ── 学習ログ本体 ──────────────────────────────────────────────────

export type BootcampLog = {
  id: string;
  sprint: string;
  phase: string;
  topic: string;
  source_content: string | null;
  source_url: string | null;
  notes: string | null;
  // 壁打ちで「何をどう判断したか」。結論だけでなく理由まで残すための欄。
  // 2ヶ月後に読み返したとき、ここがあるかどうかで価値がまるで変わる。
  decisions: string | null;
  // 新規事業への応用ポイント。DB側で NOT NULL にして書き忘れを構造で防いでいる。
  business_application: string;
  qa_session: QaSession | null;
  quiz: Quiz | null;
  created_at: string;
};

// ── 集計・絞り込み ────────────────────────────────────────────────

export function logsOf(
  logs: BootcampLog[],
  sprint: string,
  phase: string
): BootcampLog[] {
  return logs.filter((l) => l.sprint === sprint && l.phase === phase);
}

export function countByPhase(
  logs: BootcampLog[],
  sprint: string
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of PHASES) counts[p] = 0;
  for (const l of logs) {
    if (l.sprint !== sprint) continue;
    if (counts[l.phase] === undefined) counts[l.phase] = 0;
    counts[l.phase] += 1;
  }
  return counts;
}

// QAセッションの設問数。「39問ぶん溜まっている」と実感が持てるようにする。
export function qaCount(log: BootcampLog): number {
  if (!log.qa_session) return 0;
  return log.qa_session.chapters.reduce((n, c) => n + c.qa.length, 0);
}

export function totalQaCount(logs: BootcampLog[]): number {
  return logs.reduce((n, l) => n + qaCount(l), 0);
}

// ── 表示用 ────────────────────────────────────────────────────────

// 「2026-08-04T10:00:00+09:00」→「8/4」。カードは狭いので月日だけ出す。
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// フリーワード検索の対象。応用ポイントや判断の理由からも引けるようにする
// （「あのとき何て判断したっけ」で戻ってこられるのが、この画面の値打ち）。
export function haystack(l: BootcampLog): string {
  const qa = l.qa_session
    ? l.qa_session.chapters
        .flatMap((c) => [
          c.title,
          c.goal ?? "",
          ...c.qa.flatMap((p) => [p.q, p.a, p.example ?? ""]),
          ...(c.summary ?? []),
        ])
        .join(" ")
    : "";
  return [
    l.sprint,
    l.phase,
    l.topic,
    l.notes ?? "",
    l.decisions ?? "",
    l.business_application,
    l.source_content ?? "",
    l.qa_session?.theme ?? "",
    qa,
  ]
    .join(" ")
    .toLowerCase();
}

export function matches(l: BootcampLog, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const hay = haystack(l);
  // スペース区切りは AND 検索（「Sprint1 設計」で絞れる）
  return q.split(/\s+/).every((word) => hay.includes(word));
}

// ── 運営アプリ ────────────────────────────────────────────────────
//
// 学習中は教材と進捗で何度も往復するので、毎回ブックマークを探さずに済むよう
// 画面上部に常設する。役割分担が目で見て分かることも狙い。
export const OFFICIAL_APP_URL = "https://r2b-webapp.vercel.app/dashboard";

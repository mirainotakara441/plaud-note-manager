// キャリアOS 共通型。Supabase の career_* テーブルと 1:1 で対応する。
// スキーマを変えたらここも必ず合わせること（API と UI の両方がこの型を見ている）。

/** メールの分類。noise は人事向けメルマガ等、転職活動に無関係なもの。 */
export type EmailKind = "job_intro" | "scout" | "selection" | "noise" | "unknown";

/** 送信元サービスの分類。 */
export type JobSource = "doda_x" | "eight" | "bizreach" | "recruit" | "other";

/** 求人のパイプライン上の位置。Phase 1 では new / interested / archived のみ使う。 */
export type JobStatus =
  | "new"
  | "interested"
  | "casual"
  | "applied"
  | "screening"
  | "final"
  | "offer"
  | "declined"
  | "archived";

export type ReplyStatus = "pending" | "replied" | "declined" | "ignored";

export type CareerEmail = {
  id: string;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  sender: string | null;
  sender_domain: string | null;
  subject: string | null;
  received_at: string | null;
  source: JobSource | null;
  kind: EmailKind | null;
  snippet: string | null;
  body_text: string | null;
  processed_at: string | null;
  extract_error: string | null;
  created_at: string;
};

export type CareerJob = {
  id: string;
  dedup_key: string;
  company: string;
  title: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_text: string | null;
  location: string | null;
  employment_type: string | null;
  industry: string | null;
  description: string | null;
  url: string | null;
  source: JobSource | null;
  source_email_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  status: JobStatus;
  fit_score: number | null;
  fit_summary: string | null;
  fit_pros: string[] | null;
  fit_cons: string[] | null;
  fit_model: string | null;
  fit_scored_at: string | null;
  tags: string[] | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type CareerRecruiter = {
  id: string;
  dedup_key: string;
  name: string;
  company: string | null;
  email: string | null;
  source: JobSource | null;
  rank: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type CareerScout = {
  id: string;
  source_email_id: string | null;
  recruiter_id: string | null;
  gmail_thread_id: string | null;
  subject: string | null;
  body_excerpt: string | null;
  received_at: string | null;
  company: string | null;
  position_title: string | null;
  salary_text: string | null;
  source: JobSource | null;
  reply_status: ReplyStatus;
  replied_at: string | null;
  deadline_at: string | null;
  resend_count: number;
  dedup_key: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type CareerCriterion = {
  id: string;
  label: string;
  description: string | null;
  weight: number;
  sort_order: number;
  active: boolean;
  created_at: string;
};

export type CareerIngestRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: string | null;
  fetched: number;
  new_emails: number;
  new_jobs: number;
  updated_jobs: number;
  new_scouts: number;
  scored: number;
  error: string | null;
  created_at: string;
};

/** スカウト一覧で使う、担当者を結合した形。 */
export type ScoutWithRecruiter = CareerScout & {
  recruiter: Pick<CareerRecruiter, "id" | "name" | "company" | "rank"> | null;
};

/** 適合スコアの採点結果。AI が返す JSON の形と一致させる。 */
export type FitResult = {
  score: number;
  summary: string;
  pros: string[];
  cons: string[];
  /** 判断軸ごとの内訳。label は career_criteria.label と一致する。 */
  breakdown?: { label: string; score: number; comment: string }[];
};

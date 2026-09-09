// Gmailの「転職」ラベル → Supabase への取込パイプライン。
//
// 1日1回 Vercel Cron から叩かれる。手動実行も /api/ingest から可能。
//
// この処理の一番大事な性質は「冪等であること」。
// 同じメールを2回処理しても求人が2件に増えたりスカウトが二重に積まれたりしてはいけない。
// それを担保しているのが以下の3点:
//   1. career_emails.gmail_message_id が UNIQUE。処理前に既存IDを引いてスキップする
//   2. career_jobs.dedup_key が UNIQUE。既存なら last_seen_at 更新 + seen_count +1
//   3. career_scouts.dedup_key が UNIQUE。再送を検知したら resend_count +1
//
// もう1つ大事なのが「1通コケても止まらないこと」。
// 3,000通のラベルを相手にする以上、変な MIME 構造のメールや AI の一時エラーは必ず起きる。
// 1通ぶんの失敗はそのメールの extract_error に書いて次へ進む。

import { select, selectOne, insert, update, upsert } from "./db";
import { scoreJob, activeCriteria } from "./fit";
import {
  listMessageIds,
  getMessage,
  toParsedMessage,
  defaultLabelId,
  defaultMaxResults,
  type ParsedMessage,
} from "./gmail";
import {
  extractFromEmail,
  classifySource,
  jobDedupKey,
  recruiterDedupKey,
  scoutDedupKey,
} from "./extract";
import type { CareerEmail, CareerIngestRun, CareerJob, CareerRecruiter, CareerScout } from "./types";

/**
 * 1回の実行で処理するメールの上限。
 *
 * Vercel の関数実行は最大300秒。1通あたり Gmail取得 + AI抽出で3〜8秒かかるので、
 * 安全側に倒して 40 通で切る。残りは次回の実行に回る（未処理のものから順に拾われる）。
 */
const MAX_MESSAGES_PER_RUN = 40;

/**
 * 1回の実行で採点する求人の上限。
 *
 * 採点は1件あたり1回のAI呼び出し。初回の遡り取込で数百件出ることがあるので、
 * ここで頭打ちにして時間切れを防ぐ。採点漏れは次回以降の実行が拾う
 * （fit_score IS NULL の求人を毎回探しにいくため、放っておいても収束する）。
 */
const MAX_SCORED_PER_RUN = 20;

/** PostgREST の in.(...) に一度に渡すIDの数。URL長の上限に当たらないよう分割する。 */
const ID_CHUNK = 80;

export type IngestOptions = {
  /** 実行のきっかけ。"cron" か "manual"。career_ingest_runs.trigger に入る。 */
  trigger: string;
  /** Gmailから取得する最大メール数。未指定なら GMAIL_MAX_RESULTS。 */
  maxResults?: number;
  /** 直近N日に絞る。日次実行では7程度を入れると無駄な取得が減る。 */
  newerThanDays?: number;
  /**
   * この実行で採点する求人の上限。未指定なら MAX_SCORED_PER_RUN。
   *
   * 採点は1件$0.03（Sonnet 5・実測）かかる。遡り取込では求人が数百件出るので、
   * 予算を握るための明示的なつまみとして外から渡せるようにしてある。
   */
  maxScored?: number;
  /**
   * true なら抽出だけして採点をまったく行わない。
   *
   * 遡り取込の定石はこれ。まず抽出だけ回して「重複を除くと何件になるか」を
   * 実数で確認してから、採点にいくら出すかを決める。
   * 採点していない求人は fit_score が null のまま残り、次回以降の実行が拾う。
   */
  skipScoring?: boolean;
};

export type IngestSummary = {
  runId: string | null;
  /** Gmailから一覧取得したメール数。 */
  fetched: number;
  /** 既に career_emails にあってスキップしたメール数。 */
  skipped: number;
  newEmails: number;
  newJobs: number;
  updatedJobs: number;
  newScouts: number;
  /** 再送と判定して resend_count を積んだスカウト数。 */
  resentScouts: number;
  scored: number;
  /** 1通単位で起きたエラー（全体は止めていない）。 */
  errors: string[];
  /** 実行そのものが落ちた場合のエラー。正常時は null。 */
  error: string | null;
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 既に career_emails に入っている gmail_message_id を引く。 */
async function existingMessageIds(ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const rows = await select<Pick<CareerEmail, "gmail_message_id">>(
      "career_emails",
      `select=gmail_message_id&gmail_message_id=in.(${chunk.map((id) => `"${id}"`).join(",")})`
    );
    for (const row of rows) found.add(row.gmail_message_id);
  }
  return found;
}

/**
 * Gmailから対象のメッセージIDを集める。
 * 1ページ最大500件なので、maxResults に届くまでページを繰る。
 */
async function collectMessageIds(opts: {
  maxResults: number;
  newerThanDays?: number;
}): Promise<{ id: string; threadId: string | null }[]> {
  const labelId = defaultLabelId();
  const collected: { id: string; threadId: string | null }[] = [];
  let pageToken: string | undefined;

  while (collected.length < opts.maxResults) {
    const remaining = opts.maxResults - collected.length;
    const page = await listMessageIds({
      labelId,
      maxResults: Math.min(remaining, 500),
      newerThanDays: opts.newerThanDays,
      pageToken,
    });
    collected.push(...page.ids);
    if (!page.nextPageToken || page.ids.length === 0) break;
    pageToken = page.nextPageToken;
  }

  return collected.slice(0, opts.maxResults);
}

/** 求人1件をDBへ。新規なら insert、既存なら last_seen_at 更新 + seen_count +1。 */
async function upsertJob(
  job: {
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
  },
  ctx: { source: string; sourceEmailId: string; seenAt: string }
): Promise<"new" | "updated"> {
  const dedupKey = jobDedupKey(job.company, job.title);
  const existing = await selectOne<CareerJob>(
    "career_jobs",
    `select=id,seen_count&dedup_key=eq.${encodeURIComponent(dedupKey)}`
  );

  if (existing) {
    // 既存求人の再掲。fit_score には触れない（再採点しない）。
    // 何度も載ってくる求人は seen_count が伸びるので、UI側で「よく出てくる求人」を出せる。
    await update("career_jobs", `id=eq.${existing.id}`, {
      last_seen_at: ctx.seenAt,
      seen_count: (existing.seen_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
    });
    return "updated";
  }

  await insert("career_jobs", [
    {
      dedup_key: dedupKey,
      company: job.company,
      title: job.title,
      salary_min: job.salary_min,
      salary_max: job.salary_max,
      salary_text: job.salary_text,
      location: job.location,
      employment_type: job.employment_type,
      industry: job.industry,
      description: job.description,
      url: job.url,
      source: ctx.source,
      source_email_id: ctx.sourceEmailId,
      first_seen_at: ctx.seenAt,
      last_seen_at: ctx.seenAt,
      seen_count: 1,
      status: "new",
    },
  ]);
  return "new";
}

/** スカウトの担当者をDBへ。既存があればその行を使う。 */
async function upsertRecruiter(
  name: string,
  company: string | null,
  email: string | null,
  source: string
): Promise<string | null> {
  const dedupKey = recruiterDedupKey(company, name);
  // 名前が空なら名寄せキーが立たないので担当者行は作らない。
  if (normalizeIsEmpty(dedupKey)) return null;

  const rows = await upsert<CareerRecruiter>(
    "career_recruiters",
    [
      {
        dedup_key: dedupKey,
        name,
        company,
        email,
        source,
        updated_at: new Date().toISOString(),
      },
    ],
    "dedup_key"
  );
  return rows[0]?.id ?? null;
}

/** dedup_key が「|」だけ（＝両側とも空）かどうか。 */
function normalizeIsEmpty(dedupKey: string): boolean {
  return dedupKey.replace(/\|/g, "") === "";
}

/**
 * スカウト1件をDBへ。
 * 同一 dedup_key の既存行があれば「再送」とみなし、新規行を作らず resend_count を +1 する。
 */
async function upsertScout(
  scout: {
    recruiter_name: string | null;
    recruiter_company: string | null;
    company: string | null;
    position_title: string | null;
    salary_text: string | null;
    deadline: string | null;
  },
  ctx: {
    gmailMessageId: string;
    gmailThreadId: string | null;
    sourceEmailId: string;
    subject: string | null;
    bodyExcerpt: string;
    receivedAt: string | null;
    source: string;
    senderEmail: string | null;
  }
): Promise<"new" | "resent"> {
  const dedupKey = scoutDedupKey(ctx.gmailMessageId, {
    recruiterCompany: scout.recruiter_company,
    company: scout.company,
    positionTitle: scout.position_title,
  });

  const existing = await selectOne<CareerScout>(
    "career_scouts",
    `select=id,resend_count&dedup_key=eq.${encodeURIComponent(dedupKey)}`
  );

  if (existing) {
    // 同じ案件の再送。行を増やさず回数だけ積む。
    // received_at も更新して「最後にいつ来たか」が分かるようにする。
    await update("career_scouts", `id=eq.${existing.id}`, {
      resend_count: (existing.resend_count ?? 0) + 1,
      received_at: ctx.receivedAt,
      updated_at: new Date().toISOString(),
    });
    return "resent";
  }

  const recruiterId = scout.recruiter_name
    ? await upsertRecruiter(
        scout.recruiter_name,
        scout.recruiter_company,
        ctx.senderEmail,
        ctx.source
      )
    : null;

  await insert("career_scouts", [
    {
      source_email_id: ctx.sourceEmailId,
      recruiter_id: recruiterId,
      gmail_thread_id: ctx.gmailThreadId,
      subject: ctx.subject,
      body_excerpt: ctx.bodyExcerpt,
      received_at: ctx.receivedAt,
      company: scout.company,
      position_title: scout.position_title,
      salary_text: scout.salary_text,
      source: ctx.source,
      reply_status: "pending",
      deadline_at: scout.deadline,
      resend_count: 0,
      dedup_key: dedupKey,
    },
  ]);
  return "new";
}

/** メール1通ぶんの処理。ここで投げた例外は呼び出し側で握って次のメールへ進む。 */
async function processMessage(
  parsed: ParsedMessage,
  summary: IngestSummary
): Promise<void> {
  const source = classifySource(parsed.senderDomain);
  const seenAt = parsed.receivedAt ?? new Date().toISOString();

  // 先にメール行を作る。抽出が落ちてもこの行は残るので、
  // 次回の実行で同じメールを何度も掴み直すことがなくなる（冪等性の要）。
  const emailRows = await upsert<CareerEmail>(
    "career_emails",
    [
      {
        gmail_message_id: parsed.gmailMessageId,
        gmail_thread_id: parsed.gmailThreadId,
        sender: parsed.sender,
        sender_domain: parsed.senderDomain,
        subject: parsed.subject,
        received_at: parsed.receivedAt,
        source,
        kind: null,
        snippet: parsed.snippet,
        body_text: parsed.bodyText,
        processed_at: null,
        extract_error: null,
      },
    ],
    "gmail_message_id"
  );
  const emailRow = emailRows[0];
  if (!emailRow) throw new Error("career_emails への保存に失敗しました（行が返りませんでした）");
  summary.newEmails += 1;

  try {
    const extracted = await extractFromEmail(parsed);

    for (const job of extracted.jobs) {
      // 会社名か職種名が空の求人は名寄せキーが立たず、後で必ず衝突する。取り込まない。
      if (!job.company?.trim() || !job.title?.trim()) continue;
      const outcome = await upsertJob(job, {
        source,
        sourceEmailId: emailRow.id,
        seenAt,
      });
      if (outcome === "new") summary.newJobs += 1;
      else summary.updatedJobs += 1;
    }

    if (extracted.scout) {
      const outcome = await upsertScout(extracted.scout, {
        gmailMessageId: parsed.gmailMessageId,
        gmailThreadId: parsed.gmailThreadId,
        sourceEmailId: emailRow.id,
        subject: parsed.subject,
        bodyExcerpt: parsed.bodyText.slice(0, 1000),
        receivedAt: parsed.receivedAt,
        source,
        senderEmail: parsed.senderEmail,
      });
      if (outcome === "new") summary.newScouts += 1;
      else summary.resentScouts += 1;
    }

    await update("career_emails", `id=eq.${emailRow.id}`, {
      kind: extracted.kind,
      processed_at: new Date().toISOString(),
      extract_error: null,
    });
  } catch (err) {
    // 抽出・保存の失敗はこのメールの問題として記録し、全体は止めない。
    const message = errText(err);
    summary.errors.push(`${parsed.gmailMessageId}: ${message}`);
    await update("career_emails", `id=eq.${emailRow.id}`, {
      processed_at: new Date().toISOString(),
      extract_error: message.slice(0, 1000),
    }).catch(() => {
      // エラーの記録自体が失敗しても、取込全体を落とす理由にはならない。
    });
  }
}

/** 未採点の求人に適合スコアを付ける。採点できた件数を返す。 */
async function scoreNewJobs(summary: IngestSummary, limit: number): Promise<void> {
  if (limit <= 0) return;
  const pending = await select<CareerJob>(
    "career_jobs",
    `select=*&fit_score=is.null&order=first_seen_at.desc&limit=${limit}`
  );
  if (pending.length === 0) return;

  // 判断軸は全求人で共通なので1回だけ取る（求人ごとに引くとDB往復が無駄）。
  const criteria = await activeCriteria();

  for (const job of pending) {
    try {
      const result = await scoreJob(job, { criteria });
      await update("career_jobs", `id=eq.${job.id}`, {
        fit_score: result.score,
        fit_summary: result.summary,
        fit_pros: result.pros,
        fit_cons: result.cons,
        fit_model: result.model,
        fit_scored_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      summary.scored += 1;
    } catch (err) {
      // 採点の失敗は致命的ではない。fit_score が null のまま残るので次回また拾われる。
      summary.errors.push(`採点失敗 job=${job.id}: ${errText(err)}`);
    }
  }
}

/**
 * 取込の本体。
 *
 * 流れ:
 *   1. career_ingest_runs に開始行を作る
 *   2. Gmailからメッセージ一覧を取る
 *   3. 既に career_emails にあるIDを除く（冪等性）
 *   4. 未処理のぶんだけ本文取得 → 分類 → 抽出 → 保存
 *   5. 未採点の新規求人を採点
 *   6. career_ingest_runs を件数とともに閉じる
 */
export async function runIngest(opts: IngestOptions): Promise<IngestSummary> {
  const summary: IngestSummary = {
    runId: null,
    fetched: 0,
    skipped: 0,
    newEmails: 0,
    newJobs: 0,
    updatedJobs: 0,
    newScouts: 0,
    resentScouts: 0,
    scored: 0,
    errors: [],
    error: null,
  };

  // 実行ログの開始行。ここで落ちたら取込そのものを始めない
  // （記録の残らない実行を作らないため）。
  const runRows = await insert<CareerIngestRun>("career_ingest_runs", [
    { started_at: new Date().toISOString(), trigger: opts.trigger },
  ]);
  const runId = runRows[0]?.id ?? null;
  summary.runId = runId;

  try {
    const maxResults = Math.min(
      opts.maxResults ?? defaultMaxResults(),
      // Gmailから何百件引いても1回で処理できるのは MAX_MESSAGES_PER_RUN 件。
      // ただし既処理ぶんはスキップされるので、一覧は少し多めに引いておく。
      MAX_MESSAGES_PER_RUN * 10
    );

    const listed = await collectMessageIds({
      maxResults,
      newerThanDays: opts.newerThanDays,
    });
    summary.fetched = listed.length;

    const known = await existingMessageIds(listed.map((m) => m.id));
    const pending = listed.filter((m) => !known.has(m.id));
    summary.skipped = listed.length - pending.length;

    // 実行時間の上限があるので、1回で処理するのはここまで。
    const targets = pending.slice(0, MAX_MESSAGES_PER_RUN);

    for (const target of targets) {
      try {
        const message = await getMessage(target.id);
        await processMessage(toParsedMessage(message), summary);
      } catch (err) {
        // Gmail取得の失敗など、メール行を作る前のエラー。記録して次へ。
        summary.errors.push(`${target.id}: ${errText(err)}`);
      }
    }

    // 遡り取込では「まず抽出だけ回して実数を見てから採点予算を決める」ができるよう、
    // 採点は明示的に0件へ絞れるようにしてある（skipScoring / maxScored）。
    await scoreNewJobs(summary, opts.skipScoring ? 0 : (opts.maxScored ?? MAX_SCORED_PER_RUN));
  } catch (err) {
    // 認証切れやSupabase障害など、実行全体を止めるレベルのエラー。
    summary.error = errText(err);
    console.error("runIngest: 取込に失敗", err);
  }

  if (runId) {
    // 実行ログを閉じる。ここが失敗しても取込結果は既にDBに入っているので、
    // 呼び出し元へは summary をそのまま返す。
    await update("career_ingest_runs", `id=eq.${runId}`, {
      finished_at: new Date().toISOString(),
      fetched: summary.fetched,
      new_emails: summary.newEmails,
      new_jobs: summary.newJobs,
      updated_jobs: summary.updatedJobs,
      new_scouts: summary.newScouts,
      scored: summary.scored,
      // 個別メールのエラーも記録しておく。全体エラーがあればそちらを優先。
      error:
        summary.error ??
        (summary.errors.length > 0 ? summary.errors.slice(0, 10).join(" / ").slice(0, 2000) : null),
    }).catch((err) => {
      console.error("runIngest: 実行ログの更新に失敗", err);
    });
  }

  return summary;
}

import { NextResponse } from "next/server";
import { anonCreds, serviceCreds } from "@/lib/supabase";
import {
  fetchDeliverables,
  fetchMeetings,
  fetchStakeholders,
  fetchWeeklyReports,
  groupDeliverables,
  groupMeetings,
  extractSection,
  extractActionSection,
  type MeetingDoc,
  type WeeklyReportRow,
} from "@/lib/organizations";
import { toJstDateString } from "@/lib/date";

// 団体別攻略／「タイムライン以外」：その団体の“いまの状態・課題・打ち手・基礎データ”を
// 時系列ではなく静的な要約として返す。
//
// 組み立て方（データにあるものだけを使い、無い項目は素直に空で返す。捏造しない）:
//   状態     … weekly_reports の最新週の summary を主役に、直近3週分の推移を添える。
//               週報が1件も無ければ、最新会議本文の「事実：」節を代替として出す。
//   課題     … weekly_reports の insight ＋ 会議本文の「課題：」節（直近3会議）。
//   施策     … weekly_reports の直近3週の tactic（最新週に印を付ける）＋
//               最新会議本文の「アクション：」節。
//   基礎データ… stakeholders マスタの登録有無、会議/週報/成果物の件数、
//               初回接点日・最終接点日・最終接点からの経過日数。
//
// 週報は organization ILIKE 部分一致（タイムラインと同じ）で拾うため、
// 「横浜市」で「尾崎横浜市議会議員」のような近縁レコードも入ってくる。
// 完全一致の行を優先して主役に据え、部分一致の行は団体名を添えて区別する。

export const dynamic = "force-dynamic";

const RECENT_WEEK_LIMIT = 3;
const MEETING_ISSUE_LIMIT = 3;
/** これ以下の記録件数なら「情報が少ない」と正直に出す */
const SPARSE_RECORD_THRESHOLD = 2;

export type ProfileWeek = {
  weekStart: string;
  category: string;
  organization: string | null;
  /** 選択した団体名と完全一致の週報か（部分一致ヒットと区別する） */
  exact: boolean;
  summary: string;
};

export type ProfileNote = {
  id: string;
  source: "週報" | "会議";
  date: string;
  /** 出所の見出し（週報なら「2026-07-27週」、会議なら会議名） */
  label: string;
  text: string;
  /** 最新の1件かどうか（施策で「今の主戦場」を強調するのに使う） */
  latest?: boolean;
};

export type OrganizationProfile = {
  organization: string;
  status: {
    headline: ProfileWeek | null;
    recent: ProfileWeek[];
    /** 週報が無いときの代替（最新会議の「事実」節） */
    fallback: { date: string; label: string; text: string } | null;
  };
  issues: ProfileNote[];
  tactics: ProfileNote[];
  basics: {
    master: { registered: boolean; category: string | null };
    meetingCount: number;
    weeklyCount: number;
    deliverableCount: number;
    firstContactDate: string | null;
    lastContactDate: string | null;
    daysSinceLastContact: number | null;
  };
  /** 記録が薄い団体かどうか */
  sparse: boolean;
  /** 「情報が少ない」旨を利用者に伝えるための注記 */
  notes: string[];
};

function todayJst(): string {
  return toJstDateString(new Date().toISOString());
}

function diffDays(fromDate: string, toDate: string): number | null {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function nonEmpty(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

function toProfileWeek(row: WeeklyReportRow, org: string): ProfileWeek {
  return {
    weekStart: row.week_start,
    category: row.category,
    organization: row.organization,
    exact: (row.organization ?? "").trim() === org,
    summary: row.summary,
  };
}

/** 週報の主役を選ぶ。完全一致の最新週を優先し、無ければ部分一致の最新週。 */
function pickHeadline(rows: WeeklyReportRow[], org: string): WeeklyReportRow | null {
  if (rows.length === 0) return null;
  const exact = rows.filter((r) => (r.organization ?? "").trim() === org);
  return (exact.length > 0 ? exact : rows)[0];
}

function buildIssues(
  weeklyRows: WeeklyReportRow[],
  meetingDocs: MeetingDoc[]
): ProfileNote[] {
  const notes: ProfileNote[] = [];

  for (const r of weeklyRows) {
    const text = nonEmpty(r.insight);
    if (!text) continue;
    notes.push({
      id: `weekly-insight:${r.id}`,
      source: "週報",
      date: r.week_start,
      label: `${r.organization ?? ""} ${r.week_start}週`.trim(),
      text,
    });
  }

  for (const doc of meetingDocs.slice(0, MEETING_ISSUE_LIMIT)) {
    const text = extractSection(doc.content, "課題");
    if (!text) continue;
    notes.push({
      id: `meeting-issue:${doc.id}`,
      source: "会議",
      date: doc.date,
      label: doc.title,
      text,
    });
  }

  return notes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function buildTactics(
  weeklyRows: WeeklyReportRow[],
  meetingDocs: MeetingDoc[]
): ProfileNote[] {
  const withTactic = weeklyRows
    .filter((r) => !!nonEmpty(r.tactic))
    .slice(0, RECENT_WEEK_LIMIT);

  const notes: ProfileNote[] = withTactic.map((r, i) => ({
    id: `weekly-tactic:${r.id}`,
    source: "週報" as const,
    date: r.week_start,
    label: `${r.organization ?? ""} ${r.week_start}週`.trim(),
    text: nonEmpty(r.tactic) as string,
    latest: i === 0,
  }));

  // 最新会議のアクション。週報の打ち手より粒度が細かいことが多いので補助として1件だけ。
  const latestMeeting = meetingDocs[0];
  if (latestMeeting) {
    const action = extractActionSection(latestMeeting.content);
    if (action) {
      notes.push({
        id: `meeting-action:${latestMeeting.id}`,
        source: "会議",
        date: latestMeeting.date,
        label: latestMeeting.title,
        text: action,
      });
    }
  }

  return notes;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const org = searchParams.get("org")?.trim();
  if (!org) {
    return NextResponse.json({ error: "org は必須です" }, { status: 400 });
  }

  const anon = anonCreds();
  const service = serviceCreds();
  if (!anon || !service) {
    return NextResponse.json(
      { error: "サーバー設定エラー: 環境変数が設定されていません" },
      { status: 500 }
    );
  }

  try {
    const [meetings, deliverables, weeklyRows, stakeholders] = await Promise.all([
      fetchMeetings(anon.url, anon.key, org),
      fetchDeliverables(service.url, service.key, org),
      fetchWeeklyReports(anon.url, anon.key, org),
      fetchStakeholders(anon.url, anon.key),
    ]);

    // 会議・成果物はチャンクを1件にまとめてから、日付降順で扱う
    const meetingDocs = groupMeetings(meetings).sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : 0
    );
    const deliverableDocs = groupDeliverables(deliverables).sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : 0
    );
    // fetchWeeklyReports は week_start 降順で返る
    const weekly = [...weeklyRows];

    // ---- 状態 ----
    const headlineRow = pickHeadline(weekly, org);
    const recent = weekly.slice(0, RECENT_WEEK_LIMIT).map((r) => toProfileWeek(r, org));
    const headline = headlineRow ? toProfileWeek(headlineRow, org) : null;
    const fallback =
      !headline && meetingDocs[0]
        ? (() => {
            const fact =
              extractSection(meetingDocs[0].content, "事実") ??
              meetingDocs[0].content.replace(/\s+/g, " ").trim();
            return fact
              ? { date: meetingDocs[0].date, label: meetingDocs[0].title, text: fact }
              : null;
          })()
        : null;

    // ---- 課題・施策 ----
    const issues = buildIssues(weekly, meetingDocs);
    const tactics = buildTactics(weekly, meetingDocs);

    // ---- 基礎データ ----
    const master = stakeholders.find((s) => s.name.trim() === org) ?? null;
    const allDates = [
      ...meetingDocs.map((d) => d.date),
      ...deliverableDocs.map((d) => d.date),
      ...weekly.map((r) => r.week_start),
    ]
      .filter((d): d is string => !!d)
      .sort();
    const firstContactDate = allDates[0] ?? null;
    const lastContactDate = allDates[allDates.length - 1] ?? null;
    const daysSinceLastContact = lastContactDate
      ? diffDays(lastContactDate, todayJst())
      : null;

    const recordCount =
      meetingDocs.length + deliverableDocs.length + weekly.length;

    // ---- 情報の薄さを正直に伝える ----
    const notes: string[] = [];
    if (recordCount === 0) {
      notes.push("この団体の記録はまだ登録されていません。");
    } else if (recordCount <= SPARSE_RECORD_THRESHOLD) {
      notes.push(
        `記録が${recordCount}件しかありません。状態・課題・打ち手は限られた情報から拾っています。`
      );
    }
    if (weekly.length === 0) {
      notes.push("週報が未登録のため、「状態」「打ち手」は会議メモからの抜粋です。");
    } else if (weekly.length === 1) {
      notes.push("週報は1週分のみです。推移は追えません。");
    }
    if (issues.length === 0) {
      notes.push("課題として記録された記述は見つかりませんでした。");
    }
    if (!master) {
      notes.push("ステークホルダー・マスタに未登録の名前です（表記ゆれの可能性あり）。");
    }

    const profile: OrganizationProfile = {
      organization: org,
      status: { headline, recent, fallback },
      issues,
      tactics,
      basics: {
        master: {
          registered: !!master,
          category: master ? master.category : null,
        },
        meetingCount: meetingDocs.length,
        weeklyCount: weekly.length,
        deliverableCount: deliverableDocs.length,
        firstContactDate,
        lastContactDate,
        daysSinceLastContact,
      },
      sparse: recordCount <= SPARSE_RECORD_THRESHOLD,
      notes,
    };

    return NextResponse.json(profile);
  } catch (error) {
    console.error("団体プロフィール取得エラー:", error);
    return NextResponse.json(
      { error: "団体の状態・課題・施策の取得でエラーが発生しました" },
      { status: 502 }
    );
  }
}

// 検知器：記録に穴が空いていないか。
//
// 日記・週報・振り返りは「書かなかった日」が後から取り返せない。溜まってから
// 気づくと、その期間はもう再現できない。だから穴は早いうちに言う。
//
// 「入れていないだけ」と「仕組みが壊れている」はここでは区別しない（できない）。
// 抜けている日付を並べるところまでが仕事。

import { getRows } from "../client";
import type { Ctx, Detector, Finding } from "../types";
import { daysAgo, daysBetween, shortDate } from "../types";

/** 日記の穴を見に行く期間。長すぎると毎朝同じ古い穴を言い続けることになる。 */
const DIARY_WINDOW_DAYS = 14;

/**
 * 振り返りが何日空いたら言うか。週次で回す前提なので、2回ぶん飛んだあたり。
 * 1回飛ばしただけで鳴らすと、忙しい週に毎朝責められることになる。
 */
const RETROSPECTIVE_STALE_DAYS = 17;

/** 未消化ToDoが何件を超えたら言うか。数件は普通に残るので、溜まった時だけ。 */
const TODO_PILEUP_THRESHOLD = 20;

async function run(ctx: Ctx): Promise<Finding[]> {
  const findings: Finding[] = [];

  // --- 一行日記の穴 ---
  // 今日は「まだ書いていないだけ」なので必ず除く。前日ぶんを翌朝書く運用なので
  // 昨日も除く。それより前で空いている日だけを穴とみなす。
  const from = daysAgo(ctx.today, DIARY_WINDOW_DAYS);
  const chunks = await getRows<{ event_date: string | null }>(
    ctx,
    `memory_chunks?select=event_date&source_type=eq.${encodeURIComponent("日記")}` +
      `&event_date=gte.${from}&event_date=not.is.null&limit=1000`
  );
  const written = new Set(chunks.map((c) => c.event_date).filter((d): d is string => !!d));

  const holes: string[] = [];
  for (let i = 2; i <= DIARY_WINDOW_DAYS; i++) {
    const day = daysAgo(ctx.today, i);
    if (!written.has(day)) holes.push(day);
  }
  if (holes.length > 0) {
    findings.push({
      id: "diary:holes",
      area: "記録",
      severity: holes.length >= 3 ? "warn" : "info",
      title: `一行日記が${holes.length}日ぶん入っていません`,
      facts: [
        `抜けている日：${holes.map(shortDate).join("、")}`,
        `直近${DIARY_WINDOW_DAYS}日を見ています（今日と昨日は書く前なので数えていません）`,
      ],
      href: "/diary",
      hrefLabel: "日記を登録する",
    });
  }

  // --- 週報 ---
  const weeks = await getRows<{ week_start: string }>(
    ctx,
    "weekly_reports?select=week_start&order=week_start.desc&limit=200"
  );
  const weekStarts = [...new Set(weeks.map((w) => w.week_start))].sort().reverse();
  if (weekStarts.length > 0) {
    const latest = weekStarts[0];
    const gap = daysBetween(ctx.today, latest);
    // 週報は週明けに前週ぶんを書く。今週ぶんがまだ無いのは普通なので、
    // 「前の週のぶんも無い」＝14日以上空いたときだけ言う。
    if (gap >= 14) {
      findings.push({
        id: "weekly:stale",
        area: "記録",
        severity: "warn",
        title: `週報が${Math.floor(gap / 7)}週ぶん入っていません`,
        facts: [`いちばん新しい週報は ${latest} の週`],
        href: "/weekly-report",
        hrefLabel: "週報を見る",
      });
    }
  }

  // --- 振り返り ---
  const retros = await getRows<{ period_end: string; period_type: string }>(
    ctx,
    "retrospectives?select=period_end,period_type&order=period_end.desc&limit=10"
  );
  if (retros.length === 0) {
    findings.push({
      id: "retro:none",
      area: "記録",
      severity: "info",
      title: "振り返りがまだ1件もありません",
      facts: ["★の推移を見るには最低2件が要ります"],
      href: "/retrospective",
      hrefLabel: "振り返りを書く",
    });
  } else {
    const gap = daysBetween(ctx.today, retros[0].period_end);
    if (retros.length === 1) {
      findings.push({
        id: "retro:only-one",
        area: "記録",
        severity: "info",
        title: "振り返りが1件だけで、まだ推移になっていません",
        facts: [
          `いちばん新しいのは ${retros[0].period_end} まで（${gap}日前）`,
          "2件目が入ると★が線としてつながります",
        ],
        href: "/retrospective",
        hrefLabel: "振り返りを書く",
      });
    } else if (gap >= RETROSPECTIVE_STALE_DAYS) {
      findings.push({
        id: "retro:stale",
        area: "記録",
        severity: "warn",
        title: `振り返りが${gap}日空いています`,
        facts: [`いちばん新しいのは ${retros[0].period_end} まで`],
        href: "/retrospective",
        hrefLabel: "振り返りを書く",
      });
    }
  }

  // --- 未消化のToDo ---
  const undone = await getRows<{ entry_date: string }>(
    ctx,
    "daily_actions?select=entry_date&done=eq.false&order=entry_date.asc&limit=500"
  );
  if (undone.length >= TODO_PILEUP_THRESHOLD) {
    const oldest = undone[0].entry_date;
    findings.push({
      id: "todo:pileup",
      area: "記録",
      severity: "info",
      title: `未消化のToDoが${undone.length}件たまっています`,
      facts: [
        `いちばん古いのは ${oldest}（${daysBetween(ctx.today, oldest)}日前）`,
        `${TODO_PILEUP_THRESHOLD}件を超えたら出すようにしています`,
      ],
      href: "/actions",
      hrefLabel: "ToDoを見る",
    });
  }

  return findings;
}

export const recordsDetector: Detector = { name: "記録の穴", run };

// 検知器：取り込みが止まっていないか。
//
// 「データが増えていない」だけでは休日と故障を見分けられないため、
// ジョブ側が打刻した心拍（job_heartbeats / service_health）を見る。
// 行が無いジョブは「まだ一度も成功していない」だけなので黙っている。
// 動いていたものが止まった時だけ言う。
//
// job_heartbeats は成功だけでなく失敗も持つ（2026-08-04）。「走ったが落ちた」と
// 「Macが閉じていて走らなかった」は別の話なので、判定も分けている。
// 分け方は lib/advisor/watchlist.ts の judgeJob() が唯一の正。

import { getRows } from "../client";
import {
  WATCHED_JOBS,
  WATCHED_SERVICES,
  JOB_HEARTBEAT_SELECT,
  judgeJob,
  type JobHeartbeat,
} from "../watchlist";
import { guardianFailureAlerts } from "../../guardian";
import type { Ctx, Detector, Finding } from "../types";
import { hoursSince } from "../types";

/** 起票されたまま誰も拾っていない取込ジョブを「溜まっている」とみなす時間。 */
const QUEUED_STUCK_HOURS = 24;

async function run(ctx: Ctx): Promise<Finding[]> {
  const findings: Finding[] = [];

  // --- 定期実行ジョブの心拍 ---
  const beats = await getRows<JobHeartbeat>(ctx, `job_heartbeats?select=${JOB_HEARTBEAT_SELECT}`);
  const beatMap = new Map(beats.map((b) => [b.job, b]));
  for (const w of WATCHED_JOBS) {
    // 判定そのものは watchlist.ts に置いてある。朝のPush通知も同じ関数を呼ぶ。
    const verdict = judgeJob(w, beatMap.get(w.job), ctx.now);
    if (!verdict) continue;
    findings.push({
      id: `job:${w.job}`,
      area: "取り込み",
      severity: "alert",
      title: verdict.title,
      facts: verdict.facts,
    });
  }

  // --- 監視対象に未登録のジョブが落ちていないか（OS Guardian） ---
  // 上の WATCHED_JOBS の輪では拾えない範囲だけを埋める。判定は lib/guardian.ts の
  // judgeGuardian() をそのまま使い、条件はここに書き写さない。
  // 既に上で鳴らしたジョブは guardianFailureAlerts() 側で除いてあるので二重にならない。
  for (const a of guardianFailureAlerts(beats, ctx.now)) {
    findings.push({
      id: `job:${a.job}`,
      area: "取り込み",
      severity: "alert",
      title: a.title,
      facts: a.facts,
    });
  }

  // --- Claudeスケジュールタスクの自己申告 ---
  const services = await getRows<{ service: string; last_ok_at: string | null; last_note: string | null }>(
    ctx,
    "service_health?select=service,last_ok_at,last_note"
  );
  const serviceMap = new Map(services.map((s) => [s.service, s]));
  for (const w of WATCHED_SERVICES) {
    const row = serviceMap.get(w.service);
    if (!row?.last_ok_at) continue;
    const days = Math.floor(hoursSince(row.last_ok_at, ctx.now) / 24);
    if (days < w.staleDays) continue;
    const facts = [
      `最後に成功したのは ${row.last_ok_at.slice(0, 10)}（${days}日前）`,
      `${w.staleDays}日を超えたら出すようにしています`,
    ];
    if (row.last_note) facts.push(`そのときの記録：${row.last_note.slice(0, 100)}`);
    findings.push({
      id: `service:${w.service}`,
      area: "取り込み",
      severity: days >= w.staleDays * 2 ? "alert" : "warn",
      title: `${w.label}が${days}日止まっています`,
      facts,
    });
  }

  // --- 取込ジョブのキュー（起票はされたが片付いていないもの） ---
  const jobs = await getRows<{ kind: string; status: string; error: string | null; created_at: string }>(
    ctx,
    "integration_jobs?select=kind,status,error,created_at&order=created_at.desc&limit=200"
  );

  const errored = jobs.filter((j) => j.status === "error");
  if (errored.length > 0) {
    const byKind = new Map<string, number>();
    for (const j of errored) byKind.set(j.kind, (byKind.get(j.kind) ?? 0) + 1);
    findings.push({
      id: "jobs:error",
      area: "取り込み",
      severity: "info",
      title: `失敗したままの取込ジョブが${errored.length}件あります`,
      facts: [
        [...byKind.entries()].map(([k, n]) => `${k} ${n}件`).join("、"),
        `いちばん新しいものは ${errored[0].created_at.slice(0, 10)}`,
        errored[0].error ? `直近のエラー：${errored[0].error.slice(0, 120)}` : "エラー内容は記録されていません",
      ],
      href: "/",
      hrefLabel: "取込パネルで見る",
    });
  }

  const stuck = jobs.filter(
    (j) => j.status === "queued" && hoursSince(j.created_at, ctx.now) >= QUEUED_STUCK_HOURS
  );
  if (stuck.length > 0) {
    findings.push({
      id: "jobs:queued",
      area: "取り込み",
      severity: "warn",
      title: `${QUEUED_STUCK_HOURS}時間以上、誰も拾っていない取込ジョブが${stuck.length}件あります`,
      facts: [
        `いちばん古いものは ${stuck[stuck.length - 1].created_at.slice(0, 10)} の起票`,
        "実行はMac側のワーカーが拾う仕組みなので、Macを開いたときに動きます",
      ],
      href: "/",
      hrefLabel: "取込パネルで見る",
    });
  }

  return findings;
}

export const ingestDetector: Detector = { name: "取り込みの途絶", run };

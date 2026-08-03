// 検知器：取り込みが止まっていないか。
//
// 「データが増えていない」だけでは休日と故障を見分けられないため、
// ジョブ側が成功のたびに打刻した心拍（job_heartbeats / service_health）を見る。
// 行が無いジョブは「まだ一度も成功していない」だけなので黙っている。
// 動いていたものが止まった時だけ言う。

import { getRows } from "../client";
import { WATCHED_JOBS, WATCHED_SERVICES } from "../watchlist";
import type { Ctx, Detector, Finding } from "../types";
import { hoursSince } from "../types";

/** 起票されたまま誰も拾っていない取込ジョブを「溜まっている」とみなす時間。 */
const QUEUED_STUCK_HOURS = 24;

async function run(ctx: Ctx): Promise<Finding[]> {
  const findings: Finding[] = [];

  // --- 定期実行ジョブの心拍 ---
  const beats = await getRows<{ job: string; last_ok_at: string }>(
    ctx,
    "job_heartbeats?select=job,last_ok_at"
  );
  const beatMap = new Map(beats.map((b) => [b.job, b.last_ok_at]));
  for (const w of WATCHED_JOBS) {
    const last = beatMap.get(w.job);
    if (!last) continue;
    const hours = hoursSince(last, ctx.now);
    if (hours < w.staleHours) continue;
    findings.push({
      id: `job:${w.job}`,
      area: "取り込み",
      severity: "alert",
      title: `${w.label}が止まっています`,
      facts: [
        `最後に成功したのは ${last.slice(0, 16).replace("T", " ")}（${Math.floor(hours / 24)}日前）`,
        `${w.staleHours}時間を超えたら出すようにしています`,
      ],
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

// 毎朝の参謀。検知器を全部走らせて、重い順に並べて返す。
//
// 検知器を足すときはここに1行加えるだけ。1つが落ちても他は出す作りにしてある
// （全部まとめて落ちると「今日は気づきなし」と区別がつかず、静かに壊れる。
//  それは日記の断絶・日報録の停止で二度やった失敗なので、繰り返さない）。

import type { Ctx, Detector, Finding } from "./types";
import { sortFindings } from "./types";
import { ingestDetector } from "./detectors/ingest";
import { recordsDetector } from "./detectors/records";
import { goalsDetector } from "./detectors/goals";
import { dictionaryDetector } from "./detectors/dictionary";
import { typosDetector } from "./detectors/typos";
import { memoryDetector } from "./detectors/memory";

export const DETECTORS: Detector[] = [
  goalsDetector,
  ingestDetector,
  memoryDetector,
  recordsDetector,
  dictionaryDetector,
  typosDetector,
];

export type AdvisorResult = {
  findings: Finding[];
  counts: { alert: number; warn: number; info: number };
  /** 走らせたのに落ちた検知器。空でないなら、この結果は全体像ではない。 */
  failed: { name: string; reason: string }[];
  generatedAt: string;
};

export async function runAdvisor(ctx: Ctx): Promise<AdvisorResult> {
  const settled = await Promise.allSettled(DETECTORS.map((d) => d.run(ctx)));

  const findings: Finding[] = [];
  const failed: { name: string; reason: string }[] = [];

  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      findings.push(...r.value);
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`advisor: 検知器「${DETECTORS[i].name}」が失敗`, r.reason);
      failed.push({ name: DETECTORS[i].name, reason });
    }
  });

  const sorted = sortFindings(findings);
  return {
    findings: sorted,
    counts: {
      alert: sorted.filter((f) => f.severity === "alert").length,
      warn: sorted.filter((f) => f.severity === "warn").length,
      info: sorted.filter((f) => f.severity === "info").length,
    },
    failed,
    generatedAt: new Date().toISOString(),
  };
}

export type { Finding, Severity, Area } from "./types";

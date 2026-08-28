// 検知器：音声由来の誤字が本文に残っていないか。
//
// 辞書（transcription_dictionary）は取り込み時にしか効かない。辞書に語を足しても、
// それより前に入った行は誤字のまま残る。放っておくと「辞書に入れたから直った」と
// 思い込んだまま古い表記が検索や提案に混ざり続ける。
//
// 候補を洗う実体はSupabaseの refresh_typo_candidates()（毎月2日8時にpg_cronが実行）。
// ここは出てきた候補を読むだけで、直しはしない。何を直すかは判断が要るため——
// 同名の別人（北九州の西山係長）や、わざと途中で切ってある語（法人請求オンライン）を
// 無人で置換すると本文が壊れる。直すのは /transcription-typo-fix スキルで人が回す。

import { getRows } from "../client";
import { TYPO_STALE_THRESHOLD_DAYS } from "../watchlist";
import { hoursSince, type Ctx, type Detector, type Finding } from "../types";

type Candidate = { kind: string; wrong: string; suggested: string; hits: number };
type Heartbeat = { last_ok_at: string };

/**
 * 月1のジョブなので、これを超えて心拍が無ければ止まっているとみなす。
 * 値の定義は lib/advisor/watchlist.ts（他の閾値と同じ置き場）。/status の
 * 「ジョブの成否」も同じ定数を読むので、数字は1か所にしかない。
 */
const STALE_DAYS = TYPO_STALE_THRESHOLD_DAYS;

/** これ以上の行数で残っていれば、ひと目で気づけるよう格上げする。 */
const NOISY_HITS = 3;

async function run(ctx: Ctx): Promise<Finding[]> {
  const [candidates, beats] = await Promise.all([
    getRows<Candidate>(
      ctx,
      "typo_candidates?select=kind,wrong,suggested,hits&order=hits.desc&limit=50"
    ),
    getRows<Heartbeat>(
      ctx,
      "job_heartbeats?job=eq.typo-candidates&select=last_ok_at"
    ),
  ]);

  const findings: Finding[] = [];

  // 心拍。候補0件と「そもそも走っていない」は見た目が同じなので、先に区別する。
  const lastOk = beats[0]?.last_ok_at;
  const days = lastOk ? Math.floor(hoursSince(lastOk, ctx.now) / 24) : null;
  if (days === null || days > STALE_DAYS) {
    findings.push({
      id: "typo:stale",
      area: "辞書",
      severity: "warn",
      title:
        days === null
          ? "誤字候補の洗い出しが一度も走っていません"
          : `誤字候補の洗い出しが${days}日止まっています`,
      facts: [
        "毎月2日8時に refresh_typo_candidates() が走る想定です",
        "止まっている間は、候補が0件でも「誤字なし」の意味にはなりません",
      ],
    });
    // 止まっているなら中身は古い。件数を語らずここで返す。
    return findings;
  }

  if (candidates.length === 0) return findings;

  const total = candidates.reduce((sum, c) => sum + c.hits, 0);
  const worst = candidates[0];
  const samples = candidates
    .slice(0, 4)
    .map((c) => `${c.wrong}→${c.suggested}（${c.hits}行）`)
    .join("、");

  findings.push({
    id: "typo:remaining",
    area: "辞書",
    severity: worst.hits >= NOISY_HITS ? "warn" : "info",
    title: `本文に誤字候補が${candidates.length}語・のべ${total}行残っています`,
    facts: [
      `${samples}${candidates.length > 4 ? " ほか" : ""}`,
      "辞書は取り込み時にしか効かないので、登録より前に入った行は残ります",
      "直すかどうかは語ごとの判断が要ります（同名の別人・わざと切ってある語があるため）",
    ],
  });

  return findings;
}

export const typosDetector: Detector = { name: "本文の誤字", run };

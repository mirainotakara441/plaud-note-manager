// 検知器：音声入力の誤変換辞書が本文を壊す形になっていないか。
//
// 辞書は「誤変換を直す」ためのものなので、辞書自身が壊れていると、
// 直したつもりで吉井さんが書いていない表記を作ってしまう。しかも本文に
// 混ざるので後から見ても誤変換なのか辞書のせいなのか分からない。
//
// lib/transcriptionDictionary.ts はコード側でも危険な語を弾いている（保険）。
// ここはその保険が働いている＝辞書に残っている、という状態を可視化する役。
// 消すかどうかは吉井さんが決めるので、こちらでは触らない。

import { getRows } from "../client";
import type { Ctx, Detector, Finding } from "../types";

type Rule = { wrong: string; correct: string; enabled: boolean };

/** ひらがな短語の危険な長さ。3文字以下は普通の文の一部として現れる。 */
const RISKY_KANA_MAX_LEN = 3;

const ALL_HIRAGANA = /^[ぁ-ん]+$/;

async function run(ctx: Ctx): Promise<Finding[]> {
  const rules = await getRows<Rule>(
    ctx,
    "transcription_dictionary?select=wrong,correct,enabled&limit=2000"
  );

  const risky = rules.filter(
    (r) => r.wrong.length <= RISKY_KANA_MAX_LEN && ALL_HIRAGANA.test(r.wrong)
  );
  const noop = rules.filter((r) => r.wrong === r.correct);

  // 循環（A→B と B→A が両方ある）。適用順によって結果が変わり、再現しない不具合になる。
  const forward = new Map(rules.filter((r) => r.enabled).map((r) => [r.wrong, r.correct]));
  const cyclic = rules.filter(
    (r) => r.enabled && forward.get(r.correct) === r.wrong && r.wrong !== r.correct
  );

  const findings: Finding[] = [];

  if (risky.length > 0) {
    const live = risky.filter((r) => r.enabled);
    const samples = risky.slice(0, 5).map((r) => `${r.wrong}→${r.correct}`).join("、");
    findings.push({
      id: "dict:risky-kana",
      area: "辞書",
      // 有効になっているものが1件でもあれば本文が壊れうる。無効なら残っているだけ。
      severity: live.length > 0 ? "alert" : "info",
      title:
        live.length > 0
          ? `本文を壊しうる短い辞書が${live.length}件、有効になっています`
          : `本文を壊しうる短い辞書が${risky.length}件、無効のまま残っています`,
      facts: [
        `${RISKY_KANA_MAX_LEN}文字以下のひらがなは普通の文の一部に出ます（「ここみたいな話」→「心美たいな話」）`,
        `例：${samples}${risky.length > 5 ? " ほか" : ""}`,
        live.length > 0
          ? `うち${live.length}件が有効です`
          : "すべて無効なので、いま本文が壊れることはありません",
      ],
    });
  }

  if (noop.length > 0) {
    findings.push({
      id: "dict:noop",
      area: "辞書",
      severity: "info",
      title: `置換前と後が同じ辞書が${noop.length}件あります`,
      facts: [`例：${noop.slice(0, 3).map((r) => r.wrong).join("、")}`, "動作には影響しませんが、直したつもりで効いていません"],
    });
  }

  if (cyclic.length > 0) {
    findings.push({
      id: "dict:cyclic",
      area: "辞書",
      severity: "warn",
      title: `打ち消し合う辞書が${cyclic.length}件あります`,
      facts: [
        `例：${cyclic.slice(0, 3).map((r) => `${r.wrong}→${r.correct}`).join("、")}`,
        "逆向きの組が両方有効だと、適用順で結果が変わります",
      ],
    });
  }

  return findings;
}

export const dictionaryDetector: Detector = { name: "辞書の汚染", run };

// 分身AIのシステムプロンプトを組み立てる。
//
// 3つのファイルを連結しているだけ：
//   content/instruction.md … ワークショップで作った指示文（判断の芯＋語り口）。本体。
//   content/voice.md       … 社内会議での本人の発言（配布版）。語り口ではなく「考え方」の材料。
//   content/decisions.md   … 判断実例集（配布版）。「〜のときは〜する」の型。
//
// ★配布版について
// voice.md / decisions.md は、事業の継続可否・特定個人の力量評価・社内の値付けや
// 法務手続きに関わる項目を落としてある（Desktop/AI/分身AI/ にある素材_*.md が全量）。
// メンバーが使うAIがそれを喋ると事故になるため、ここに置くのは配布版だけにすること。

import { readFileSync } from "node:fs";
import { join } from "node:path";

let cached: string | null = null;

function read(name: string): string {
  return readFileSync(join(process.cwd(), "content", name), "utf-8");
}

export function systemPrompt(): string {
  if (cached) return cached;

  const instruction = read("instruction.md");
  const voice = read("voice.md");
  const decisions = read("decisions.md");

  cached = [
    instruction,
    "",
    "---",
    "",
    "# 参考資料A：本人の発言（社内会議より）",
    "",
    "これは**考え方の材料**です。語り口は上の『4. 語り口』の見本（「私」＋ですます）に従ってください。",
    "以下に出てくる「俺」「〜じゃん」等のため口は1対1の場での話し方なので、そのまま真似しないこと。",
    "",
    voice,
    "",
    "---",
    "",
    "# 参考資料B：判断の実例",
    "",
    "「〈こういう条件〉のときは〈こうする〉」の型です。相談がこの型に当てはまるときは、",
    "実例の理屈を踏まえて答えてください。当てはまらないときは無理に当てはめないこと。",
    "",
    decisions,
    "",
    "---",
    "",
    "# この場（メンバーに配っている分身AI）での追加の線引き",
    "",
    "・事業の継続可否（撤退するのかどうか）、特定のメンバーの力量評価、社内の値付けや法務手続きの是非は、",
    "　この場では答えない。「それは吉井嗣和さん本人に直接聞いてください」と返す。",
    "・参考資料に無い数字・日付・団体名は「確認が必要」と言う。推測で埋めない。",
    "・参考資料は伏せ字（〇〇）になっている。伏せ字の実名を推測して答えない。",
  ].join("\n");

  return cached;
}

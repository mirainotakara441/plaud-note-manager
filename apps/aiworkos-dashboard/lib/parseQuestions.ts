// 参謀の返答から深掘り質問を切り出す。
// /refine では、切り出した問いごとに入力欄を並べて「問い → その下に答える」形にする。
//
// 参謀は SYSTEM_PROMPT の指示で各問いを `**Q1. 見出し**` の行で始める。
// ただしモデルの出力なので崩れることはある。パースできなければ questions が空になり、
// 呼び出し側は従来どおり単一の入力欄にフォールバックする。

export type ParsedQuestion = {
  /** "Q1" / "Q2（再確認）" など、見出し行のラベル部分 */
  label: string;
  /** 問いの本文（見出しからラベルを除いたもの） */
  heading: string;
  /** 見出しに続く補足説明 */
  body: string;
};

export type ParsedMessage = {
  /** 最初の問いより前の前置き */
  intro: string;
  questions: ParsedQuestion[];
};

// 例: **Q1. 5つの打ち手の間に「順序」はありますか。**
//     **Q2（再確認）. 「8月中に事務センター」の完了基準は何ですか。**
const HEADING_RE = /^\s*\*\*(Q\d+(?:（[^）]*）)?)[.．、:：]?\s*(.*?)\*\*\s*$/;

/** `**強調**` を落として素のテキストにする（UIは太字表示を自前で行うため） */
export function stripBold(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1");
}

export function parseQuestions(content: string): ParsedMessage {
  const lines = content.split("\n");
  const introLines: string[] = [];
  const questions: ParsedQuestion[] = [];
  let current: { label: string; heading: string; body: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      if (current) {
        questions.push({
          label: current.label,
          heading: current.heading,
          body: current.body.join("\n").trim(),
        });
      }
      current = { label: m[1], heading: stripBold(m[2]).trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else introLines.push(line);
  }
  if (current) {
    questions.push({
      label: current.label,
      heading: current.heading,
      body: current.body.join("\n").trim(),
    });
  }

  // 見出しだけあって中身が無いような崩れ方をしていたら、パース失敗として扱う
  const usable = questions.filter((q) => q.heading.length > 0);
  if (usable.length === 0) {
    return { intro: stripBold(content).trim(), questions: [] };
  }

  return { intro: stripBold(introLines.join("\n")).trim(), questions: usable };
}

/** 問いごとの回答を、1本の返信メッセージに組み立てる */
export function composeReply(
  questions: ParsedQuestion[],
  answers: Record<string, string>,
  skipped: Record<string, boolean>,
  note: string
): string {
  const parts: string[] = [];
  for (const q of questions) {
    const a = (answers[q.label] ?? "").trim();
    let body: string;
    if (skipped[q.label]) body = "スキップ（この問いには答えない）。";
    else if (a) body = a;
    else body = "未回答。";
    parts.push(`${q.label}. ${q.heading}\n→ ${body}`);
  }
  const n = note.trim();
  if (n) parts.push(`補足:\n${n}`);
  return parts.join("\n\n");
}

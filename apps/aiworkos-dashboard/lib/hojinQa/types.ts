// 法人請求QA検索のデータ型。
// 実体は lib/hojinQa/data.json（scripts/build-hojin-qa.mjs が Markdown から生成する）。
// 型はその JSON の形をそのまま写したもので、ここで値を作ったり加工したりはしない。

/** カテゴリ記号。A 職員に訴求 / B やらない理由 / C 議員に訴求 / D 議員と職員 */
export type HojinQaCategory = "A" | "B" | "C" | "D";

/** 使用条件の正規化値。null は条件なし */
export type HojinQaConstraint = "委託限定" | "規模限定" | "会計・出納部門向け";

export type HojinQaCategoryInfo = {
  /** 見出し名（例：職員に訴求すべきポイント） */
  name: string;
  /** Markdown 側で宣言されていた件数 */
  declared: number;
  /** カテゴリ全体に効く方針。複数行・**太字** を含む */
  policy: string;
};

export type HojinQaNumberRow = {
  /** 項目名。**太字** を含むことがある */
  item: string;
  /** 値。**太字** を含むことがある */
  value: string;
};

export type HojinQaItem = {
  /** 例："A-10"。番号は連続とは限らない */
  id: string;
  cat: HojinQaCategory;
  num: number;
  /** 見出し（【】の条件表記は除いてある） */
  title: string;
  /** 使用条件の正規化値。null は条件なし */
  constraint: HojinQaConstraint | null;
  /** 使用条件の原文（例："委託限定で特に有効"、"規模限定：人口3万人未満"） */
  constraintLabel: string | null;
  /** 使う場面 */
  scene: string;
  /** 相手の発言。原文が「―」だった場合は null（何も表示しない） */
  said: string | null;
  /**
   * 本文。改行に意味があり、行頭の全角スペース「　」も保つ。
   * **太字** を含む。カテゴリ D は
   * **【議員の問い】** / **【職員の答弁例】** / **【議員の再質問】**
   * の3つの話者マーカーがそれぞれ単独行で入る。
   */
  body: string;
  /** 根拠。複数行・**太字** を含むことがある */
  evidence: string;
  /** 注意。複数行・**太字** を含むことがある */
  caution: string;
  tags: string[];
};

export type HojinQaData = {
  title: string;
  intro: string;
  /** 生成元の Markdown ファイル名 */
  sourceFile: string;
  /** 生成日時（ISO 8601） */
  generatedAt: string;
  total: number;
  counts: Record<HojinQaCategory, number>;
  categories: Record<HojinQaCategory, HojinQaCategoryInfo>;
  /** 「この表の使い方」。**太字** と改行を含む */
  usage: string[];
  /** 「全件に効くルール」。**太字** と改行を含む */
  rules: string[];
  /** 「数字の唯一の正」の見出し */
  numbersHeading: string;
  numbers: HojinQaNumberRow[];
  numbersNote: string;
  items: HojinQaItem[];
};

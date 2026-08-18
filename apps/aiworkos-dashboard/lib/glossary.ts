// 用語集（/glossary）の共通部品。
//
// Sprint3で分からんかった言葉を、一般的な辞書やなく
// 「なぜそれが必要になったか」から書き残すための器。
// 説明は3段構えで持つ。
//   short      … 一言でいうと
//   essence    … 本質。なぜそれが要るのか、何を買っているのか
//   usage_note … 吉井さんの仕事のどこに出てくるか
//
// このファイルは /glossary ページ（クライアント）から読むので、
// next/server などサーバー専用のものは import しない。

export type Term = {
  id: string;
  term: string;
  reading: string;
  aliases: string[];
  category: string;
  short: string;
  essence: string;
  usage_note: string | null;
  related: string[];
  source_sprint: string | null;
  source_chapter: string | null;
  created_at: string;
};

// ── 並べ方 ────────────────────────────────────────────────────────
//
// 「あいうえお順」と「アルファベット順」を切り替えられるようにする。
// 英字の用語にも読み（ひらがな）を持たせてあるので、
// あいうえお順ではLLMが「え」の位置に入る。探し方が2通りある状態にしておく。

export type SortMode = "kana" | "alpha";

// あいうえお順の見出し。濁点・小書きは清音に寄せて数える。
const KANA_ROWS: { label: string; chars: string }[] = [
  { label: "あ行", chars: "あいうえおぁぃぅぇぉ" },
  { label: "か行", chars: "かきくけこがぎぐげご" },
  { label: "さ行", chars: "さしすせそざじずぜぞ" },
  { label: "た行", chars: "たちつてとだぢづでどっ" },
  { label: "な行", chars: "なにぬねの" },
  { label: "は行", chars: "はひふへほばびぶべぼぱぴぷぺぽ" },
  { label: "ま行", chars: "まみむめも" },
  { label: "や行", chars: "やゆよゃゅょ" },
  { label: "ら行", chars: "らりるれろ" },
  { label: "わ行", chars: "わをん" },
];

export function kanaGroup(reading: string): string {
  const head = (reading || "").trim().charAt(0);
  const row = KANA_ROWS.find((r) => r.chars.includes(head));
  return row ? row.label : "その他";
}

export const KANA_GROUP_ORDER = [...KANA_ROWS.map((r) => r.label), "その他"];

// アルファベット順の見出し。英字で始まらん用語は「和文」にまとめる。
export function alphaGroup(term: string): string {
  const head = (term || "").trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(head) ? head : "和文";
}

export const ALPHA_GROUP_ORDER = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  "和文",
];

// 見出しごとにまとめて返す。空の見出しは落とす。
export function groupTerms(
  terms: Term[],
  mode: SortMode
): { label: string; terms: Term[] }[] {
  const order = mode === "kana" ? KANA_GROUP_ORDER : ALPHA_GROUP_ORDER;
  const keyOf = (t: Term) =>
    mode === "kana" ? kanaGroup(t.reading) : alphaGroup(t.term);
  const sortKey = (t: Term) =>
    mode === "kana" ? t.reading || t.term : t.term.toLowerCase();

  const buckets = new Map<string, Term[]>();
  for (const t of terms) {
    const k = keyOf(t);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(t);
  }
  return order
    .filter((label) => buckets.has(label))
    .map((label) => ({
      label,
      terms: buckets
        .get(label)!
        .sort((a, b) => sortKey(a).localeCompare(sortKey(b), "ja")),
    }));
}

// ── 検索 ──────────────────────────────────────────────────────────
//
// 表記・読み・別名・説明の全部を対象にする。
// 「あの、AIが毎回違う形で返してくるやつ」のように、
// 用語を思い出せんときでも説明文から引けるようにするため。

export function matches(t: Term, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    t.term,
    t.reading,
    t.category,
    t.short,
    t.essence,
    t.usage_note ?? "",
    ...t.aliases,
    ...t.related,
  ]
    .join(" ")
    .toLowerCase();
  // スペース区切りはAND検索
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

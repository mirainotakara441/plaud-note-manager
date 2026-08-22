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
//
// 1文字ずつ（A〜Z）だと見出しボタンが26個並んで、かえって探しにくい。
// 5文字ずつの帯にまとめて、押した先で目視で追える量にする。
const ALPHA_BANDS = ["A-E", "F-J", "K-O", "P-T", "U-Z"] as const;

export function alphaGroup(term: string): string {
  const head = (term || "").trim().charAt(0).toUpperCase();
  if (!/^[A-Z]$/.test(head)) return "和文";
  // 'A'(65) からの距離を5で割ると、そのまま帯の番号になる（Zは4番目に収まる）。
  return ALPHA_BANDS[Math.min(Math.floor((head.charCodeAt(0) - 65) / 5), 4)];
}

export const ALPHA_GROUP_ORDER = [...ALPHA_BANDS, "和文"];

// ── スプリント × フェーズでの絞り込み ────────────────────────────
//
// 「どのスプリントのどの回で出てきた言葉か」で引きたい場面がある。
// source_sprint は "Sprint3"、source_chapter は "Learn 02" のように入っているので、
// 章の頭の語（Learn / Design / Build）だけを取ってスプリントと組み合わせる。
// 一覧は実データから作るので、Sprint1 の語が入れば自動で選択肢に出る。

const PHASES = ["Learn", "Design", "Build"];

/** "Sprint3" + "Learn 02" → "Sprint3 Learn"。判別できなければ null。 */
export function sprintPhaseOf(t: Term): string | null {
  const sprint = (t.source_sprint ?? "").trim();
  if (!sprint) return null;
  const chapter = (t.source_chapter ?? "").trim();
  const phase = PHASES.find((p) => chapter.toLowerCase().startsWith(p.toLowerCase()));
  return phase ? `${sprint} ${phase}` : sprint;
}

/** 実データにあるスプリント×フェーズを、件数つきで並べて返す。 */
export function sprintPhaseGroups(terms: Term[]): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of terms) {
    const k = sprintPhaseOf(t);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Array.from(m.entries())
    .map(([label, count]) => ({ label, count }))
    // スプリント番号 → Learn/Design/Build の順
    .sort((a, b) => {
      const s = a.label.localeCompare(b.label, "ja", { numeric: true });
      const pa = PHASES.findIndex((p) => a.label.endsWith(p));
      const pb = PHASES.findIndex((p) => b.label.endsWith(p));
      if (a.label.split(" ")[0] === b.label.split(" ")[0]) return pa - pb;
      return s;
    });
}

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

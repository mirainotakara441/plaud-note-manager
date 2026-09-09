// 協力企業の人脈DB（/partners）の型と、絞り込みの純粋ロジック。
//
// ■ なぜ議員リストと分けたか
//   議員は「会派→議会」という公的な階層があり、名簿という正がある。
//   企業には正が無く、上場していれば有価証券報告書、非上場なら自社サイトと、
//   出所がばらける。だから画面も別にして、代わりに**出典を必ず持たせる**。
//
// ■ 会社と人を2テーブルに分けてある
//   「その会社が大事にしていること」は会社に1つ、「経歴」は人ごとに1つで
//   粒度が違う。1つにまとめると、役員5人ぶん同じ理念がコピーされ、
//   直すときに片方だけ直る。
//
// ■ 区分は週報ダッシュボードと同じ語を使う
//   委託会社 … **自治体の中で郵送請求業務を受託している会社。** うちのパートナー。
//              エイジェックとは業務連携協定を結び、キャリアリンクとは協力関係にある。
//              単なる取引先ではなく、自治体へ一緒に入っていく相手。
//   事業者   … **法人請求オンラインサービスの利用者。** 債権保全のために住民票を
//              取り寄せる民間企業（カード・クレジット・消費者金融・債権回収）と、
//              自治体向け郵送請求を代行するBPO事業者。
//   攻め方が逆向きなので、混ぜると使えない台帳になる。
//
// ■ relationship は区分と別に持つ
//   区分は「どういう立場の会社か」しか表さない。「もう使ってくれているのか」
//   「まだ申込だけか」「協定まで結んだ相手か」が消えると、攻め方を間違える。
//   （アグレックスを当初「委託会社」と誤って登録した。自治体BPOの担い手に見えたが、
//     実際は自治体向け郵送請求を代行する側＝利用者だった。2026-09-09に訂正）

export type PartnerCategory = "委託会社" | "事業者";

export type Executive = {
  id: string;
  company_id: string;
  name: string;
  name_kana: string | null;
  title: string;
  career: string | null;
  source_url: string | null;
  sort_order: number;
  memo: string | null;
  as_of: string | null;
};

export type Company = {
  id: string;
  name: string;
  name_kana: string | null;
  category: PartnerCategory;
  website: string | null;
  headquarters: string | null;
  founded: string | null;
  listing: string | null;
  employees: string | null;
  revenue: string | null;
  business: string | null;
  certifications: string | null;
  values_summary: string | null;
  values_quote: string | null;
  values_source: string | null;
  /** うちとその会社の関係。利用中／トライアル申込済み／業務連携協定を締結 など。 */
  relationship: string | null;
  memo: string | null;
  as_of: string | null;
};

export type CompanyWithExecutives = Company & { executives: Executive[] };

export const CATEGORIES: PartnerCategory[] = ["委託会社", "事業者"];

export const CATEGORY_DESC: Record<PartnerCategory, string> = {
  委託会社:
    "自治体の中で郵送請求業務を受託している会社。単なる取引先でなく、自治体へ一緒に入っていくパートナー",
  事業者:
    "法人請求オンラインサービスの利用者。債権保全で住民票を取り寄せる民間企業と、郵送請求を代行するBPO事業者",
};

/**
 * 会社に人をぶら下げる。並びは sort_order（社長を先頭に置いてある）。
 * 会社の並びは「区分 → 名前のかな」。かなが無い会社は名前で並べる。
 */
export function buildTree(
  companies: Company[],
  executives: Executive[]
): CompanyWithExecutives[] {
  const byCompany = new Map<string, Executive[]>();
  for (const e of executives) {
    const list = byCompany.get(e.company_id) ?? [];
    list.push(e);
    byCompany.set(e.company_id, list);
  }
  for (const list of byCompany.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ja"));
  }
  return [...companies]
    .sort((a, b) =>
      (a.name_kana ?? a.name).localeCompare(b.name_kana ?? b.name, "ja")
    )
    .map((c) => ({ ...c, executives: byCompany.get(c.id) ?? [] }));
}

/**
 * 検索。**社名だけでなく役員の氏名・役職・経歴も対象にする。**
 *   「あの元金融庁の人、どこの会社やったっけ」から辿れないと、
 *   人脈DBとして使い物にならない。理念と備考も対象に含める。
 */
export function matches(c: CompanyWithExecutives, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    c.name,
    c.name_kana,
    c.relationship,
    c.business,
    c.values_summary,
    c.values_quote,
    c.memo,
    c.headquarters,
    c.listing,
    c.certifications,
    ...c.executives.flatMap((e) => [e.name, e.name_kana, e.title, e.career, e.memo]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((w) => haystack.includes(w));
}

/**
 * 「★」で始まる行を要注意として拾う。
 * memo には出典の不確かさ・行政処分・要確認事項を★付きで書いてあり、
 * それを畳んだままにすると、いちばん見てほしいものが埋もれる。
 */
export function starredLines(text: string | null): string[] {
  if (!text) return [];
  return text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("★"));
}

/** 経歴が取れている役員の割合。非上場ほど下がるので、その事実を画面に出す。 */
export function careerCoverage(c: CompanyWithExecutives): {
  known: number;
  total: number;
} {
  return {
    known: c.executives.filter((e) => e.career && e.career.trim() !== "").length,
    total: c.executives.length,
  };
}

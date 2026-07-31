// 「自治体」カテゴリーの中をさらに 政令市 / 特別区 / 市役所 / その他 へ細分するための判定。
//
// なぜ名前リストで判定するか:
//   末尾の文字だけで判定すると「大阪市北区」のような政令市の行政区を
//   東京23区（特別区）と誤判定する。特別区は東京23区だけ、政令市は全国20市だけ、
//   という閉じた集合なので、名前を定数で持って突合するのが確実。
//
// 判定できないものは推測せず「その他」に落とす。
// リストに無い「〜市」は自動的に「市役所」、「〜町/村/都/道/府/県」は「その他」に
// 入るので、今後 団体が増えても分類が壊れない（新しい政令市が生まれたときだけ
// ORDINANCE_DESIGNATED_CITIES に足せばよい）。

/** 表示順もこの並び。0件の小分類は呼び出し側で出さないこと。 */
export const MUNICIPALITY_SUBCATEGORIES = [
  "政令市",
  "特別区",
  "市役所",
  "その他",
] as const;

export type MunicipalitySubcategory = (typeof MUNICIPALITY_SUBCATEGORIES)[number];

/** 政令指定都市（全国20市）。2026-07時点。増えたらここに足す。 */
export const ORDINANCE_DESIGNATED_CITIES = [
  "札幌市",
  "仙台市",
  "さいたま市",
  "千葉市",
  "横浜市",
  "川崎市",
  "相模原市",
  "新潟市",
  "静岡市",
  "浜松市",
  "名古屋市",
  "京都市",
  "大阪市",
  "堺市",
  "神戸市",
  "岡山市",
  "広島市",
  "北九州市",
  "福岡市",
  "熊本市",
] as const;

/** 特別区（東京23区）。政令市の行政区（例: 大阪市北区）はここに含めないこと。 */
export const TOKYO_SPECIAL_WARDS = [
  "千代田区",
  "中央区",
  "港区",
  "新宿区",
  "文京区",
  "台東区",
  "墨田区",
  "江東区",
  "品川区",
  "目黒区",
  "大田区",
  "世田谷区",
  "渋谷区",
  "中野区",
  "杉並区",
  "豊島区",
  "北区",
  "荒川区",
  "板橋区",
  "練馬区",
  "足立区",
  "葛飾区",
  "江戸川区",
] as const;

const ORDINANCE_SET: ReadonlySet<string> = new Set(ORDINANCE_DESIGNATED_CITIES);
const WARD_SET: ReadonlySet<string> = new Set(TOKYO_SPECIAL_WARDS);

// 全角・半角の空白だけを落とす。法人格の除去はしない（自治体名には付かない）。
function key(name: string): string {
  return name.replace(/[\s　]/g, "");
}

/**
 * 自治体名 → 小分類。
 *
 * 優先順:
 *   1. 政令指定都市20市の名前と完全一致 → 政令市
 *   2. 東京23区の名前と完全一致 → 特別区
 *   3. 「〜市」で終わる → 市役所（政令市に入らなかった市）
 *   4. 「〜町/村/都/道/府/県」で終わる → その他
 *   5. それ以外（「大阪市北区」のような行政区を含む）→ その他
 *
 * 注意: 3の判定は1・2の後にしかしない。「大阪市北区」は「〜区」なので3に当たらず、
 * WARD_SET にも無いので「その他」へ落ちる（特別区に誤って混ざらない）。
 */
export function municipalitySubcategory(name: string): MunicipalitySubcategory {
  const k = key(name ?? "");
  if (k === "") return "その他";
  if (ORDINANCE_SET.has(k)) return "政令市";
  if (WARD_SET.has(k)) return "特別区";
  if (k.endsWith("市")) return "市役所";
  return "その他";
}

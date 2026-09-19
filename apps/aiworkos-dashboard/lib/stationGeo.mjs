// 駅名と座標の純粋ロジック（/ramen の地図用）。I/Oは持たない。
//
// ■ 役割
//   - stationKey … 食べログの最寄り駅表記を、表の鍵になる形に揃える
//   - pickStation … HeartRails が返す候補（同名駅が全国にある）から1つ選ぶ
//   - keysForRows … 訪問と百名店から、座標が要る駅名の集合を作る

/**
 * 食べログの最寄り駅表記 → 鍵。
 *   "地下鉄成増、成増"       → "地下鉄成増"（先頭の駅だけ）
 *   "早稲田（メトロ）駅"     → "早稲田"
 *   "つつじケ丘駅"           → "つつじヶ丘"（HeartRails は ヶ）
 *   "府中市"                 → "府中市"（駅ではないがそのまま。引けなければ座標なし）
 * @param {string|null|undefined} area
 * @returns {string|null}
 */
export function stationKey(area) {
  if (!area) return null;
  const first = String(area).split(/[、,]/)[0] ?? "";
  const k = first
    .normalize("NFKC")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/駅$/, "")
    .replace(/ケ/g, "ヶ")
    .trim();
  return k === "" ? null : k;
}

// 同名駅が複数の都道府県にあるとき、本人の生活圏を優先する順
const PREF_PRIORITY = ["東京都", "埼玉県", "神奈川県", "千葉県"];

// 食べログの店URLの地域 → 都道府県。同名駅の取り違え（大阪の北浜が北海道の北浜になる）を
// 防ぐためのヒント。出てきたぶんだけ足す
const TABELOG_REGION = {
  tokyo: "東京都", kanagawa: "神奈川県", saitama: "埼玉県", chiba: "千葉県",
  osaka: "大阪府", kyoto: "京都府", hyogo: "兵庫県", nara: "奈良県",
  aichi: "愛知県", shizuoka: "静岡県", nagano: "長野県",
  hokkaido: "北海道", miyagi: "宮城県",
  fukuoka: "福岡県", nagasaki: "長崎県", kumamoto: "熊本県", kagoshima: "鹿児島県",
  hiroshima: "広島県", okayama: "岡山県", okinawa: "沖縄県",
};

/**
 * 食べログの店URLから都道府県のヒント。分からなければ null。
 *   "https://tabelog.com/osaka/A2701/A270102/27087777/" → "大阪府"
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function prefectureHint(url) {
  const m = String(url ?? "").match(/tabelog\.com\/([a-z]+)\//);
  return m ? (TABELOG_REGION[m[1]] ?? null) : null;
}

/**
 * HeartRails の候補配列から1つ選ぶ。
 * ヒントの都道府県があればそれを最優先、無ければ首都圏を優先。
 * 同じ駅の別路線（座標がほぼ同じ）は先頭を取る。候補が無ければ null。
 * @param {{name:string,line?:string,prefecture?:string,x:number|string,y:number|string}[]} candidates
 * @param {string|null} [hint] 都道府県（例: "大阪府"）
 * @returns {{lat:number,lng:number,line:string|null,prefecture:string|null}|null}
 */
export function pickStation(candidates, hint = null) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const rank = (c) => {
    if (hint && c.prefecture === hint) return -1;
    const i = PREF_PRIORITY.indexOf(c.prefecture ?? "");
    return i === -1 ? 99 : i;
  };
  const sorted = [...candidates].sort((a, b) => rank(a) - rank(b));
  const c = sorted[0];
  const lat = Number(c.y);
  const lng = Number(c.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, line: c.line ?? null, prefecture: c.prefecture ?? null };
}

/**
 * 座標が要る駅の鍵と、都道府県のヒント（訪問の area と百名店の station から）。
 * ヒントは訪問なら食べログの店URLの地域、百名店（TOKYO版）なら東京都。
 * 同じ駅に複数の行があれば、最初に見つかったヒントを使う。
 * @param {{area?:string|null, tabelog_shop_url?:string|null}[]} ramenRows
 * @param {{station?:string|null}[]} hyakuRows
 * @returns {{station:string, hint:string|null}[]} 重複なし・出現順
 */
export function keysForRows(ramenRows, hyakuRows) {
  const out = [];
  const idx = new Map();
  const add = (raw, hint) => {
    const k = stationKey(raw);
    if (!k) return;
    if (idx.has(k)) {
      const cur = out[idx.get(k)];
      if (!cur.hint && hint) cur.hint = hint;
      return;
    }
    idx.set(k, out.length);
    out.push({ station: k, hint: hint ?? null });
  };
  for (const r of ramenRows) add(r.area, prefectureHint(r.tabelog_shop_url));
  for (const h of hyakuRows) add(h.station, "東京都");
  return out;
}

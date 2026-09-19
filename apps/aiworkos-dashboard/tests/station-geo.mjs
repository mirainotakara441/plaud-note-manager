#!/usr/bin/env node
// 駅名の正規化と候補選び（lib/stationGeo.mjs）のテスト。
// 守りたいのは「同じ駅が表記の差で別物にならないこと」と「同名駅で遠くの県を掴まないこと」。

import { stationKey, pickStation, keysForRows, prefectureHint } from "../lib/stationGeo.mjs";

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else { failed += 1; console.error(`\x1b[31m✗ ${label}\x1b[0m\n    期待: ${e}\n    実際: ${a}`); }
}

check("先頭の駅だけ", stationKey("地下鉄成増、成増"), "地下鉄成増");
check("末尾の駅を外す", stationKey("池袋駅"), "池袋");
check("括弧を外す", stationKey("早稲田（メトロ）駅"), "早稲田");
check("半角括弧も", stationKey("早稲田(メトロ)"), "早稲田");
check("ケ→ヶ", stationKey("つつじケ丘駅"), "つつじヶ丘");
check("駅でない地名はそのまま", stationKey("府中市"), "府中市");
check("空は null", stationKey(""), null);
check("null は null", stationKey(null), null);
check("全角空白の混入", stationKey("　池袋　、要町"), "池袋");

const cands = [
  { name: "中野", line: "JR函館本線", prefecture: "北海道", x: "140.7", y: "41.8" },
  { name: "中野", line: "JR中央線", prefecture: "東京都", x: "139.665", y: "35.705" },
];
check("同名駅は東京都を優先", pickStation(cands), { lat: 35.705, lng: 139.665, line: "JR中央線", prefecture: "東京都" });
check("首都圏に無ければ先頭", pickStation([cands[0]]), { lat: 41.8, lng: 140.7, line: "JR函館本線", prefecture: "北海道" });
const kitahama = [
  { name: "北浜", line: "JR釧網本線", prefecture: "北海道", x: "144.3", y: "43.9" },
  { name: "北浜", line: "京阪本線", prefecture: "大阪府", x: "135.508", y: "34.691" },
];
check("ヒントの都道府県があればそれを取る（大阪の北浜）", pickStation(kitahama, "大阪府").prefecture, "大阪府");
check("ヒントが無ければ首都圏優先→無ければ先頭（北海道）", pickStation(kitahama).prefecture, "北海道");
check("ヒントが候補に無ければ通常の順", pickStation(cands, "大阪府").prefecture, "東京都");
check("食べログURLから都道府県", prefectureHint("https://tabelog.com/osaka/A2701/A270102/27087777/"), "大阪府");
check("東京", prefectureHint("https://tabelog.com/tokyo/A1322/A132204/13200351/"), "東京都");
check("知らない地域は null", prefectureHint("https://tabelog.com/mars/A1/A11/1/"), null);
check("URL無しは null", prefectureHint(null), null);
check("候補なしは null", pickStation([]), null);
check("座標が数にならなければ null", pickStation([{ name: "x", x: "abc", y: "" }]), null);

check("訪問と百名店から重複なしで鍵とヒントを作る",
  keysForRows(
    [{ area: "池袋、要町", tabelog_shop_url: "https://tabelog.com/tokyo/A1/A11/1/" },
     { area: "北浜、淀屋橋", tabelog_shop_url: "https://tabelog.com/osaka/A2/A22/2/" },
     { area: null }],
    [{ station: "池袋駅" }, { station: "早稲田（メトロ）駅" }]),
  [{ station: "池袋", hint: "東京都" }, { station: "北浜", hint: "大阪府" }, { station: "早稲田", hint: "東京都" }]);
check("同じ駅の後の行にヒントがあれば拾う",
  keysForRows([{ area: "北浜" }, { area: "北浜", tabelog_shop_url: "https://tabelog.com/osaka/A2/A22/2/" }], []),
  [{ station: "北浜", hint: "大阪府" }]);

console.log(`\n駅座標: ${passed} 合格 / ${failed} 失敗`);
process.exit(failed === 0 ? 0 : 1);

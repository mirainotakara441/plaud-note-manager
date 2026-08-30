// 健康習慣レポート（週次）の下書きを組み立てる純粋ロジック。
//
// ■ 役割
//   health_range_summary が返した1週ぶんの日次データから、レポートの本文を組む。
//   I/Oを持たないので、合成データでそのまま試せる（tests/health-weekly.mjs）。
//
// ■ 数値はここで作らない
//   平均も合計もDBの値から素直に計算するだけで、補正も推測もしない。
//   欠測日を「前日と同じ」で埋めたりしない——2026-08の歩数が平均値で潰れていた件と
//   同じ事故になる。記録が無い日は「記録なし」と書く。
//
// ■ ★は付けない
//   総合評価の★とコメントは人が入れる。データから機械的に星を付けると、
//   記録が2日しかない週にも★が付いてしまい、評価が数字の見た目に引きずられる。
//   ここが出すのは「事実の並び」までで、意味づけは吉井さんの仕事。

/**
 * @typedef {Object} DayRow
 * @property {string} day
 * @property {number|null} weight_kg
 * @property {number|null} body_fat_pct
 * @property {number|null} muscle_kg
 * @property {number|null} steps
 * @property {number|null} kcal
 * @property {number|null} protein_g
 * @property {number|null} fat_g
 * @property {number|null} carbs_g
 * @property {number|null} salt_g
 * @property {number|null} [sleep_h]
 */

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** その週の土曜始まり。8/15(土)〜8/21(金) がこれまでの形。 */
export function weekRange(anyDay) {
  const [y, m, d] = anyDay.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // 土曜(6)を週の頭にする
  const back = (dt.getUTCDay() + 1) % 7;
  const start = new Date(dt.getTime() - back * 86400000);
  const end = new Date(start.getTime() + 6 * 86400000);
  const iso = (x) => x.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

export function fmtMd(day) {
  const [, m, d] = day.split("-");
  const dt = new Date(Number(day.slice(0, 4)), Number(m) - 1, Number(d));
  return `${Number(m)}/${Number(d)}(${WEEKDAYS[dt.getDay()]})`;
}

function nums(rows, key) {
  return rows.map((r) => r[key]).filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
}

function avg(list) {
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}

/**
 * 1週ぶんの集計。**記録がある日数も必ず一緒に返す。**
 * 平均だけ出すと、2日しか記録の無い週の平均が7日ぶんの平均と同じ顔をする。
 */
export function summarize(rows) {
  const pick = (key) => {
    const list = nums(rows, key);
    return { avg: avg(list), min: list.length ? Math.min(...list) : null,
             max: list.length ? Math.max(...list) : null,
             sum: list.length ? list.reduce((a, b) => a + b, 0) : null, days: list.length };
  };
  return {
    weight: pick("weight_kg"),
    bodyFat: pick("body_fat_pct"),
    muscle: pick("muscle_kg"),
    steps: pick("steps"),
    kcal: pick("kcal"),
    protein: pick("protein_g"),
    fat: pick("fat_g"),
    carbs: pick("carbs_g"),
    salt: pick("salt_g"),
    sleep: pick("sleep_h"),
  };
}

const f = (v, d = 1) => (v == null ? "—" : Number(v).toFixed(d));
const i = (v) => (v == null ? "—" : Math.round(Number(v)).toLocaleString());

/**
 * レポート本文（Markdown）を組む。
 * @param {{start:string,end:string}} range
 * @param {DayRow[]} rows
 * @param {{ratings?:Record<string,{stars?:number,comment?:string}>, notes?:string}} [manual]
 */
export function buildReport(range, rows, manual = {}) {
  const s = summarize(rows);
  const L = [];
  L.push(`健康週間レポート（${range.start.replaceAll("-", "/")}〜${range.end.replaceAll("-", "/")}）`);
  L.push("");

  // ① 体組成
  L.push("① 体組成");
  L.push("");
  L.push("| 日付 | 体重 | 体脂肪率 | 筋肉量 |");
  L.push("|---|---|---|---|");
  for (const r of rows) {
    L.push(
      `| ${fmtMd(r.day)} | ${f(r.weight_kg, 2)}kg | ${f(r.body_fat_pct, 2)}% | ${f(r.muscle_kg, 2)}kg |`
    );
  }
  L.push("");
  L.push(
    `週平均：体重 ${f(s.weight.avg, 2)}kg（${s.weight.days}日） / ` +
      `体脂肪率 ${f(s.bodyFat.avg, 2)}%（${s.bodyFat.days}日） / ` +
      `筋肉量 ${f(s.muscle.avg, 2)}kg（${s.muscle.days}日）`
  );
  L.push("");

  // ② 食事
  L.push("② 食事");
  L.push("");
  L.push("| 日付 | カロリー | たんぱく質 | 脂質 | 炭水化物 | 塩分 |");
  L.push("|---|---|---|---|---|---|");
  for (const r of rows) {
    const none = r.kcal == null;
    L.push(
      `| ${fmtMd(r.day)} | ${none ? "記録なし" : `${i(r.kcal)}kcal`} | ${f(r.protein_g)}g | ` +
        `${f(r.fat_g)}g | ${f(r.carbs_g)}g | ${f(r.salt_g, 2)}g |`
    );
  }
  L.push("");
  const noMeal = rows.filter((r) => r.kcal == null).map((r) => fmtMd(r.day));
  L.push(
    `記録があったのは ${s.kcal.days}日。平均 ${i(s.kcal.avg)}kcal / ` +
      `たんぱく質 ${f(s.protein.avg)}g / 脂質 ${f(s.fat.avg)}g / ` +
      `炭水化物 ${f(s.carbs.avg)}g / 塩分 ${f(s.salt.avg, 2)}g`
  );
  if (noMeal.length) L.push(`※ ${noMeal.join("・")} は食事の記録がありません`);
  L.push("");

  // ③ 歩数
  L.push("③ 歩数");
  L.push("");
  L.push("| 日付 | 歩数 |");
  L.push("|---|---|");
  for (const r of rows) L.push(`| ${fmtMd(r.day)} | ${i(r.steps)}歩 |`);
  L.push("");
  L.push(
    `週間総歩数 ${i(s.steps.sum)}歩 / 平均 ${i(s.steps.avg)}歩（${s.steps.days}日ぶん）`
  );
  L.push("");

  // ④ 睡眠
  L.push("④ 睡眠");
  L.push("");
  if (s.sleep.days === 0) {
    L.push("記録がありません。");
  } else {
    L.push("| 日付 | 睡眠 |");
    L.push("|---|---|");
    for (const r of rows) L.push(`| ${fmtMd(r.day)} | ${f(r.sleep_h)}時間 |`);
    L.push("");
    L.push(`平均 ${f(s.sleep.avg)}時間（${s.sleep.days}日ぶん）`);
  }
  L.push("");

  // ⑤ 総合評価（人が入れたぶんだけ出す）
  const ratings = manual.ratings ?? {};
  const keys = Object.keys(ratings).filter((k) => ratings[k]?.stars || ratings[k]?.comment);
  if (keys.length) {
    L.push("総合評価");
    L.push("");
    L.push("| 指標 | 評価 | コメント |");
    L.push("|---|---|---|");
    for (const k of keys) {
      const n = Number(ratings[k]?.stars ?? 0);
      const stars = n > 0 ? "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n)) : "—";
      L.push(`| ${k} | ${stars} | ${ratings[k]?.comment ?? ""} |`);
    }
    L.push("");
  }
  if (manual.notes && manual.notes.trim()) {
    L.push(manual.notes.trim());
    L.push("");
  }

  return L.join("\n").trimEnd();
}

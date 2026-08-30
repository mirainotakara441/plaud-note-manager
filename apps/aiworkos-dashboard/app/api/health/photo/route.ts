import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { structured, isLlmConfigured, llmErrorMessage, llmErrorStatus } from "@/lib/llm";
import { toJstDateString } from "@/lib/date";

// 健康アプリのスクリーンショットを読んで health_metrics に入れる。
// 歩数（歩数計アプリの一覧）と、体重・体脂肪率（体組成計アプリの一覧）に対応する。
//
// なぜ要るか:
//   自動連携は止まる。歩数は 2026年7月中ずっと1日38歩のような平均値で潰れていたし、
//   体重(HealthPlanet)も日が飛ぶ。壊れた期間は後からアプリの画面を見て埋めるしかない。
//
// 2段階に分けている理由:
//   POST … 画像を読むだけ。DBには一切書かない。
//   PUT  … 画面で確認した行だけを書く。
//   読み取りは間違えることがある。しかも health_range_summary は source='photo' を
//   最優先で採るので、誤読がそのまま「その日の値」になる。必ず人が見てから書く。
//
// 画像は保存しない:
//   残すべきは数字であって、アプリの画面そのものではない。

export const dynamic = "force-dynamic";
// 画像を数枚まとめて読ませるので、既定の実行時間では足りないことがある。
export const maxDuration = 60;

const TABLE = "health_metrics";
/** 自動取り込み（Apple Health / HealthPlanet / mirainotakara441）と区別する印。 */
const PHOTO_SOURCE = "photo";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 1回に読ませる枚数の上限。Vercelのリクエスト上限(4.5MB)と実行時間の両方に効く。 */
const MAX_IMAGES = 6;
/** 一度に書き込める日数の上限。1〜2か月ぶんをまとめて入れる想定。 */
const MAX_ROWS = 120;

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 読み取る対象の定義。1つの kind に複数の指標がぶら下がる（体重＋体脂肪率）。 */
type FieldSpec = {
  /** 画面・JSONでのキー */
  key: string;
  /** health_metrics の metric 名 */
  metric: string;
  unit: string;
  label: string;
  min: number;
  max: number;
  /** 表示・保存の小数桁 */
  decimals: number;
  /** その kind の中で、この指標が無い行は捨てるか（主の指標かどうか） */
  required: boolean;
};

const KINDS: Record<
  string,
  {
    label: string;
    hint: string;
    fields: FieldSpec[];
    /**
     * 画面に日付が写っているか。
     * 体組成や歩数の一覧には日付が並んでいるが、食事アプリの日次サマリは
     * その日の合計だけで日付が入らないことがある。false のときは
     * 画面で選んだ日付（body.day）を使う。推測で今日にしない。
     */
    dated?: boolean;
  }
> = {
  steps: {
    label: "歩数",
    hint: "日付ごとの歩数が並んだ一覧",
    fields: [
      {
        key: "steps",
        metric: "step_count",
        unit: "count",
        label: "歩数",
        min: 0,
        max: 100000,
        decimals: 0,
        required: true,
      },
    ],
  },
  weight: {
    label: "体重・体脂肪率・筋肉量",
    hint: "日付ごとの体重・体脂肪率・筋肉量が並んだ一覧（HealthPlanet など）",
    fields: [
      {
        key: "weight",
        metric: "weight_body_mass",
        unit: "kg",
        label: "体重",
        min: 20,
        max: 200,
        decimals: 1,
        required: true,
      },
      {
        key: "bodyFat",
        metric: "body_fat_percentage",
        unit: "%",
        label: "体脂肪率",
        min: 3,
        max: 60,
        decimals: 1,
        required: false,
      },
      {
        // 体組成計の一覧には体重・体脂肪率と並んで筋肉量も出ている。
        // 週次レポートに載せているのに、これまで取り込めていなかった唯一の項目。
        key: "muscle",
        metric: "muscle_mass",
        unit: "kg",
        label: "筋肉量",
        min: 10,
        max: 120,
        decimals: 1,
        required: false,
      },
    ],
  },
  meal: {
    label: "食事（カロミル）",
    hint: "1日ぶんの合計が出ている栄養サマリ（カロリー・PFC・塩分）",
    // 画面に日付が入らないので、UIで選んだ日付を使う。
    dated: false,
    fields: [
      // ★単位に注意。HealthKit 由来の dietary_energy は kJ、sodium は mg で入っている。
      //   こちらは画面に出ている kcal / g をそのまま入れたいので、別の metric 名にする。
      //   混ぜると同じ列に kJ と kcal が並び、グラフが8倍ずれる。
      {
        key: "energy",
        metric: "meal_energy",
        unit: "kcal",
        label: "カロリー",
        min: 0,
        max: 8000,
        decimals: 0,
        required: true,
      },
      {
        key: "protein",
        metric: "meal_protein",
        unit: "g",
        label: "たんぱく質",
        min: 0,
        max: 500,
        decimals: 1,
        required: false,
      },
      {
        key: "fat",
        metric: "meal_fat",
        unit: "g",
        label: "脂質",
        min: 0,
        max: 400,
        decimals: 1,
        required: false,
      },
      {
        key: "carbs",
        metric: "meal_carbs",
        unit: "g",
        label: "炭水化物",
        min: 0,
        max: 900,
        decimals: 1,
        required: false,
      },
      {
        key: "sugar",
        metric: "meal_sugar",
        unit: "g",
        label: "糖質",
        min: 0,
        max: 900,
        decimals: 1,
        required: false,
      },
      {
        key: "fiber",
        metric: "meal_fiber",
        unit: "g",
        label: "食物繊維",
        min: 0,
        max: 200,
        decimals: 1,
        required: false,
      },
      {
        key: "salt",
        metric: "meal_salt",
        unit: "g",
        label: "塩分",
        min: 0,
        max: 50,
        decimals: 2,
        required: false,
      },
    ],
  },
};

function kindOf(v: unknown) {
  return typeof v === "string" && v in KINDS ? KINDS[v] : null;
}

function buildSchema(fields: FieldSpec[]) {
  const valueProps: Record<string, unknown> = {};
  for (const f of fields) {
    valueProps[f.key] = {
      type: ["number", "null"],
      description: `${f.label}（${f.unit}）。画面に出ていなければ null。`,
    };
  }
  return {
    type: "object",
    properties: {
      entries: {
        type: "array",
        description:
          "画面に日付ごとに並んでいる記録。1行1日ぶん。複数枚の画像にまたがっていても、見えている行はすべて拾う。",
        items: {
          type: "object",
          properties: {
            md: {
              type: "string",
              description: "画面に出ている月日。「8/10」の形（ゼロ埋めしない）。年は書かない。",
            },
            weekday: {
              type: "string",
              description:
                "画面に括弧書きされている曜日1文字（月火水木金土日）。書かれていなければ空文字。",
            },
            values: {
              type: "object",
              properties: valueProps,
              required: fields.map((f) => f.key),
              additionalProperties: false,
            },
          },
          required: ["md", "weekday", "values"],
          additionalProperties: false,
        },
      },
      summaries: {
        type: "array",
        description:
          "「1週間のデータ」「AVG」「平均」のような、日別ではない集計の表示。これは entries には絶対に入れないこと。",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "見出しの文言" },
            text: { type: "string", description: "そこに出ている数字をそのまま" },
          },
          required: ["label", "text"],
          additionalProperties: false,
        },
      },
      notes: {
        type: "array",
        description: "読み取れなかった行や、判断に迷った点があれば日本語で1つずつ。無ければ空配列。",
        items: { type: "string" },
      },
    },
    required: ["entries", "summaries", "notes"],
    additionalProperties: false,
  };
}

function buildSystem(fields: FieldSpec[], dated: boolean) {
  const list = fields.map((f) => `- ${f.label}（${f.unit}）`).join("\n");

  // 日付が並んでいる一覧と、1日ぶんのサマリでは、守るべきことが違う。
  const perKind = dated
    ? `- 画面に見えている「日付ごとの記録」の行だけを entries に入れる。
- 「平均」「AVG」「合計」「1週間のデータ」のような集計値は、日別の記録ではない。
  これらは entries に入れず summaries に分けること。ここを混ぜると、平均値が
  その日1日の値として記録されてしまう。
- 同じ日が複数の画像に出てくる場合も、見えたものをそのまま両方入れてよい（後で突き合わせる）。`
    : `- この画面は1日ぶんの合計です。entries は1件だけにすること。
- 日付は画面に出ていないので md と weekday は空文字にする。**推測して日付を書かない。**
- ★「1916 / 1800kcal」「69.0 / 81.0g」のように2つの数字が並んでいたら、
  **左が実績、右が目標**。拾うのは必ず左の実績のほう。目標値を入れると、
  食べた量ではなく設定値がその日の記録として残ってしまう。
- 「あと12.0g」「+7.6g」のような目標との差分は拾わない。それは実績ではない。`;

  return `あなたは健康アプリのスクリーンショットから数字を書き起こす作業をしています。

拾うもの:
${list}

守ること:
${perKind}
- 画面に出ていない項目は推測せず null にする。
- 途中で切れていて数字が読み切れない行は、推測で埋めず notes に書いて entries から外す。
- 数字は画面に出ている値をそのまま。四捨五入や補正をしない。`;
}

type OcrResult = {
  entries: { md: string; weekday: string; values: Record<string, number | null> }[];
  summaries: { label: string; text: string }[];
  notes: string[];
};

/** data URL / 生base64 のどちらでも受け、Anthropicに渡せる形に均す。 */
function parseImage(input: unknown): { media_type: string; data: string } | null {
  if (typeof input !== "string" || input.length === 0) return null;
  // base64本体に改行が混ざることがあるので [\s\S] で受ける（s フラグは target が es2017 で使えない）
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([\s\S]+)$/.exec(input);
  if (m) return { media_type: m[1], data: m[2] };
  if (/^[A-Za-z0-9+/=\s]+$/.test(input)) return { media_type: "image/jpeg", data: input.trim() };
  return null;
}

function todayLocalFallback(): string {
  return toJstDateString(new Date().toISOString());
}

/**
 * 「8/10」＋曜日から西暦を決める。
 *
 * 画面には年が出ていない。今年として読むと、1月に12月のスクショを入れたときに
 * 未来の日付になる。そこで「今日より後にならない直近の年」を選び、
 * さらに曜日が画面と一致するかで裏を取る（合わなければ警告を付けて人に見せる）。
 */
function resolveDay(
  md: string,
  weekday: string,
  today: string
): { day: string; warning?: string } | null {
  const m = /^(\d{1,2})\s*[/月]\s*(\d{1,2})/.exec(md.trim());
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  const thisYear = Number(today.slice(0, 4));
  for (const y of [thisYear, thisYear - 1]) {
    const dt = new Date(y, mm - 1, dd);
    if (dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return null; // 2/30 など
    const day = `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    if (day > today) continue;
    const actual = WEEKDAYS[dt.getDay()];
    if (weekday && weekday.trim() && !weekday.includes(actual)) {
      return { day, warning: `画面は${weekday.trim()}曜ですが${day}は${actual}曜です` };
    }
    return { day };
  }
  return null;
}

function round(v: number, decimals: number) {
  const p = Math.pow(10, decimals);
  return Math.round(v * p) / p;
}

function weekdayOf(day: string) {
  return WEEKDAYS[
    new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))).getDay()
  ];
}

/** 画像を読む（DBには書かない）。 */
export async function POST(req: NextRequest) {
  if (!isLlmConfigured()) {
    return NextResponse.json({ error: "AIの設定がありません" }, { status: 500 });
  }

  const body = await req.json().catch(() => null);
  const kind = kindOf(body?.kind);
  if (!kind) return NextResponse.json({ error: "読み取る種類の指定が不正です" }, { status: 400 });

  const rawImages = Array.isArray(body?.images) ? body.images : [];
  if (rawImages.length === 0) {
    return NextResponse.json({ error: "画像がありません" }, { status: 400 });
  }
  if (rawImages.length > MAX_IMAGES) {
    return NextResponse.json({ error: `一度に読めるのは${MAX_IMAGES}枚までです` }, { status: 400 });
  }
  const parsed = (rawImages as unknown[]).map(parseImage);
  if (parsed.some((i) => i === null)) {
    return NextResponse.json({ error: "読めない画像が混ざっています" }, { status: 400 });
  }
  const ready = parsed as { media_type: string; data: string }[];

  const today =
    typeof body?.today === "string" && DAY_RE.test(body.today) ? body.today : todayLocalFallback();

  let read: OcrResult;
  try {
    read = await structured<OcrResult>({
      system: buildSystem(kind.fields, kind.dated !== false),
      messages: [
        {
          role: "user",
          content: [
            ...ready.map((img) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: img.media_type as "image/jpeg",
                data: img.data,
              },
            })),
            {
              type: "text" as const,
              text: `この画面（${kind.hint}）から、日付ごとの${kind.label}を書き起こしてください。今日は${today}です。`,
            },
          ],
        },
      ],
      schema: buildSchema(kind.fields) as unknown as Record<string, unknown>,
      // 画像から数字を写す作業で、思考させても精度は上がらない一方、
      // 枚数ぶん入力が長いので実行時間だけが伸びる（60秒の壁に当たる）。
      // 誤読は画面の確認手順で潰す設計なので、ここは速さを取る。
      thinking: false,
      maxTokens: 8000,
      label: `健康スクショ読み取り(${kind.label})`,
    });
  } catch (e) {
    console.error("健康スクショ読み取り失敗:", e);
    return NextResponse.json(
      {
        error: llmErrorMessage(e, e instanceof Error ? e.message : "画像を読み取れませんでした"),
      },
      { status: llmErrorStatus(e) }
    );
  }

  // ── 年を決めて、同じ日が複数枚に写っていた場合をまとめる ──────────────
  const byDay = new Map<string, { values: Record<string, number>; warning?: string }>();
  const dropped: string[] = [];
  // 日付が画面に無い種類（食事サマリなど）は、選んだ日付を使う。
  // ここを「読めなければ今日」にしない。昨日ぶんを入れているのに今日の行が
  // できると、あとから見て取り違えようがない嘘になる。
  const chosenDay =
    typeof body?.day === "string" && DAY_RE.test(body.day) ? body.day : null;
  if (kind.dated === false && !chosenDay) {
    return NextResponse.json(
      { error: "この種類は画面に日付が出ないので、日付を選んでから読み取ってください" },
      { status: 400 }
    );
  }

  for (const e of Array.isArray(read.entries) ? read.entries : []) {
    const r =
      kind.dated === false
        ? { day: chosenDay as string, warning: undefined as string | undefined }
        : resolveDay(String(e?.md ?? ""), String(e?.weekday ?? ""), today);
    if (!r) {
      dropped.push(`「${e?.md ?? "?"}」は日付として読めませんでした`);
      continue;
    }
    const values: Record<string, number> = {};
    let badRange = false;
    for (const f of kind.fields) {
      const raw = e?.values?.[f.key];
      if (raw == null) continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < f.min || n > f.max) {
        dropped.push(`${e.md} の${f.label}（${raw}）は範囲外なので外しました`);
        if (f.required) badRange = true;
        continue;
      }
      values[f.key] = round(n, f.decimals);
    }
    if (badRange) continue;
    const missingRequired = kind.fields.some((f) => f.required && values[f.key] == null);
    if (missingRequired) {
      dropped.push(`${e.md} は${kind.fields.find((f) => f.required)?.label}が読めませんでした`);
      continue;
    }

    const prev = byDay.get(r.day);
    if (prev) {
      // 同じ日が2枚に写っていて数字が食い違う＝どちらかが誤読。人に見せる。
      const diff = kind.fields.find((f) => values[f.key] != null && prev.values[f.key] !== values[f.key]);
      if (diff) {
        prev.warning = `別の画像では${diff.label}が${values[diff.key]}と読めました`;
      }
      continue;
    }
    byDay.set(r.day, { values, warning: r.warning });
  }

  const days = Array.from(byDay.keys()).sort();

  // ── 今DBに入っている値を並べて出す（入れ替わるのか、新しく埋まるのかを見せる）──
  const current = new Map<string, Record<string, number>>();
  const c = serviceCreds();
  if (c && days.length > 0) {
    const metrics = kind.fields.map((f) => f.metric).join(",");
    const res = await fetch(
      `${c.url}/rest/v1/${TABLE}?select=day,metric,source,value&metric=in.(${metrics})` +
        `&day=gte.${days[0]}&day=lte.${days[days.length - 1]}&limit=4000`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (res.ok) {
      const rows: { day: string; metric: string; source: string; value: number | null }[] =
        await res.json();
      // 画面と同じ優先順位で「今その日に使われている値」を決める。
      // 歩数は全ソースの最大、それ以外は最初に見つかったもの（写メ優先は集計関数側）。
      for (const f of kind.fields) {
        for (const row of Array.isArray(rows) ? rows : []) {
          if (row.metric !== f.metric || row.value == null) continue;
          const v = round(Number(row.value), f.decimals);
          const cur = current.get(row.day) ?? {};
          if (f.metric === "step_count") {
            cur[f.key] = Math.max(cur[f.key] ?? 0, v);
          } else if (cur[f.key] == null || row.source === PHOTO_SOURCE) {
            cur[f.key] = v;
          }
          current.set(row.day, cur);
        }
      }
    }
  }

  const rows = days.map((day) => {
    const e = byDay.get(day)!;
    return {
      day,
      weekday: weekdayOf(day),
      values: e.values,
      current: current.get(day) ?? {},
      warning: e.warning,
    };
  });

  return NextResponse.json({
    kind: body.kind,
    fields: kind.fields.map((f) => ({ key: f.key, label: f.label, unit: f.unit, decimals: f.decimals })),
    rows,
    summaries: Array.isArray(read.summaries) ? read.summaries : [],
    notes: [...(Array.isArray(read.notes) ? read.notes : []), ...dropped],
  });
}

/** 画面で確認した行を書き込む。 */
export async function PUT(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const kind = kindOf(body?.kind);
  if (!kind) return NextResponse.json({ error: "読み取る種類の指定が不正です" }, { status: 400 });

  const raw = Array.isArray(body?.rows) ? body.rows : [];
  if (raw.length === 0) {
    return NextResponse.json({ error: "登録する行がありません" }, { status: 400 });
  }
  if (raw.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `一度に登録できるのは${MAX_ROWS}日ぶんまでです` },
      { status: 400 }
    );
  }

  const today =
    typeof body?.today === "string" && DAY_RE.test(body.today) ? body.today : todayLocalFallback();

  const now = new Date().toISOString();
  const payload: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const day = r?.day;
    if (typeof day !== "string" || !DAY_RE.test(day)) {
      return NextResponse.json({ error: `日付が不正です: ${String(day)}` }, { status: 400 });
    }
    if (day > today) {
      return NextResponse.json({ error: "未来の日付には登録できません" }, { status: 400 });
    }
    if (seen.has(day)) {
      return NextResponse.json({ error: `${day} が重複しています` }, { status: 400 });
    }
    seen.add(day);

    for (const f of kind.fields) {
      const v = r?.values?.[f.key];
      if (v == null || v === "") continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < f.min || n > f.max) {
        return NextResponse.json(
          { error: `${day} の${f.label}が範囲外です（${f.min}〜${f.max}${f.unit}）` },
          { status: 400 }
        );
      }
      payload.push({
        day,
        metric: f.metric,
        value: round(n, f.decimals),
        unit: f.unit,
        source: PHOTO_SOURCE,
        extra: { entered_via: "health-page-photo" },
        updated_at: now,
      });
    }
  }

  if (payload.length === 0) {
    return NextResponse.json({ error: "登録できる数値がありません" }, { status: 400 });
  }

  const res = await fetch(`${c.url}/rest/v1/${TABLE}?on_conflict=metric,day,source`, {
    method: "POST",
    headers: restHeaders(c.key, {
      // 同じ日を2回読み込ませても行は増えない（UNIQUE (metric, day, source)）
      Prefer: "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("健康スクショの登録に失敗:", res.status, t.slice(0, 300));
    return NextResponse.json(
      { error: `登録に失敗 ${res.status}: ${t.slice(0, 200)}` },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, days: seen.size, saved: payload.length });
}

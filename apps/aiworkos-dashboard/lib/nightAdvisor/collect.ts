// 夜間参謀の材料集め。ここはLLMを一切呼ばない。
//
// ■ なぜ収集を切り離すか
//   設計（docs/night-advisor-design.md §7）の関門2で「まずLLM抜きで、集まった
//   材料を目視確認する」と決めている。材料が薄いまま考えさせると、出てくるのは
//   もっともらしいだけの空振りで、しかもそれがAIの出来の問題なのか材料の問題なのか
//   切り分けられない。先に材料だけを見られる形にしておく。
//
// ■ 領域横断であることが本体
//   いまの各ルートは縦割りで、健康ルートは健康しか読まず提案ルートは営業しか読まない。
//   「体調の落ち方と商談の失速が同じ週から始まっている」のような気づきを出せる場所が
//   どこにも無い——それを作るのがここ。だから健康と営業と日記を同じ卓に載せる。
//
// ■ 過去の示唆も材料に含める
//   これが繰り返しを防ぐ唯一の手段。過去に何を言ったかを読めないと、参謀は毎晩
//   同じことを言い、そのうち誰も読まなくなる。

import { restHeaders, type Creds } from "@/lib/supabase";

/** 収集の対象期間（日数）。材料ごとに適切な長さが違う。 */
export const WINDOWS = {
  /** 日記。本人の状態は直近ほど効くが、1週間だと波が見えない。 */
  diary: 14,
  /** 会議。相手の反応・懸念。 */
  meeting: 14,
  /** 週報。団体ごとの動き。4週あれば「止まっている」が見える。 */
  weekly: 28,
  /** 健康。月単位の推移を見たいので長めに取る。 */
  health: 28,
  /** 過去の示唆。繰り返し検知のため。 */
  insight: 30,
} as const;

export type Chunk = {
  event_date: string | null;
  title: string | null;
  content: string;
  organization?: string | null;
};

export type WeeklyRow = {
  week_start: string;
  category: string;
  organization: string | null;
  summary: string | null;
  insight: string | null;
  tactic: string | null;
};

export type HealthDay = Record<string, unknown>;

export type ActionRow = {
  entry_date: string;
  kind: string;
  content: string;
  due_date: string | null;
};

export type TodoRow = {
  task_name: string;
  genre: string;
  status: string;
  target_month: string | null;
  due_date: string | null;
};

export type RetroRow = {
  period_start: string;
  period_end: string;
  one_liner: string | null;
  insights: unknown;
  action_guideline: string | null;
};

export type PastInsight = {
  id: string;
  generated_on: string;
  kind: string;
  title: string;
  body: string;
  verdict: string | null;
  verdict_note: string | null;
  outcome: string | null;
};

export type AskEntry = {
  question: string;
  rating: string | null;
  created_at: string;
};

export type Materials = {
  /** 基準日（JSTの今日）。 */
  today: string;
  diaries: Chunk[];
  meetings: Chunk[];
  weekly: WeeklyRow[];
  health: HealthDay[];
  actions: ActionRow[];
  todos: TodoRow[];
  retros: RetroRow[];
  pastInsights: PastInsight[];
  /** 相談窓口(/ask)に投げられた問い。何に悩んでいるかの一次資料。 */
  asks: AskEntry[];
  /** 取得に失敗した材料の名前。1つこけても他は出す。 */
  failed: string[];
};

function daysAgo(today: string, n: number): string {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

/**
 * 1本の取得。失敗しても例外を投げず、空配列と失敗名を返す。
 *
 * 既存の参謀（lib/advisor）が Promise.allSettled で「1本落ちても他は出す」形に
 * しているのと同じ考え方。全部落ちて「示唆なし」に見える状態を構造的に防ぐ。
 */
async function grab<T>(
  c: Creds,
  path: string,
  label: string,
  failed: string[]
): Promise<T[]> {
  try {
    const res = await fetch(`${c.url}/rest/v1/${path}`, {
      headers: restHeaders(c.key),
      cache: "no-store",
    });
    if (!res.ok) {
      failed.push(label);
      return [];
    }
    return (await res.json()) as T[];
  } catch {
    failed.push(label);
    return [];
  }
}

/** 夜間参謀が読む材料を、すべて集めて返す。LLMは呼ばない。 */
export async function collectMaterials(c: Creds, today: string): Promise<Materials> {
  const enc = encodeURIComponent;
  const failed: string[] = [];

  const from = {
    diary: daysAgo(today, WINDOWS.diary),
    meeting: daysAgo(today, WINDOWS.meeting),
    weekly: daysAgo(today, WINDOWS.weekly),
    health: daysAgo(today, WINDOWS.health),
    insight: daysAgo(today, WINDOWS.insight),
  };

  const [diaries, meetings, weekly, health, actions, todos, retros, pastInsights, asks] =
    await Promise.all([
      // ★どの材料にも today の上限を掛ける。
      //   通常の実行（today＝今日）では効かないが、過去の晩を再現して出来を比べるとき
      //   （mode:dry に today を渡す）に上限が無いと、その晩には存在しなかったはずの
      //   記録まで読んでしまう。後から見れば当たっているように見えるだけの示唆が出て、
      //   評価にならない。
      grab<Chunk>(
        c,
        `memory_chunks?select=event_date,title,content&source_type=eq.${enc("日記")}` +
          `&event_date=gte.${from.diary}&event_date=lte.${today}&order=event_date.asc`,
        "一行日記",
        failed
      ),
      grab<Chunk>(
        c,
        `memory_chunks?select=event_date,title,content,organization&source_type=eq.${enc("会議")}` +
          `&event_date=gte.${from.meeting}&event_date=lte.${today}&order=event_date.asc`,
        "会議録",
        failed
      ),
      grab<WeeklyRow>(
        c,
        `weekly_reports?select=week_start,category,organization,summary,insight,tactic` +
          `&week_start=gte.${from.weekly}&week_start=lte.${today}&order=week_start.asc`,
        "週報",
        failed
      ),
      // 健康はRPC。他と同じ grab には乗らないので個別に書く。
      (async () => {
        try {
          const res = await fetch(`${c.url}/rest/v1/rpc/health_range_summary`, {
            method: "POST",
            headers: restHeaders(c.key),
            body: JSON.stringify({ from_day: from.health, to_day: today }),
            cache: "no-store",
          });
          if (!res.ok) {
            failed.push("健康の実測");
            return [] as HealthDay[];
          }
          return (await res.json()) as HealthDay[];
        } catch {
          failed.push("健康の実測");
          return [] as HealthDay[];
        }
      })(),
      // 未完のToDo。詰まっている場所が出る。
      // ここだけは「今の状態」しか取れない（消し込みの履歴を持っていないため）。
      // 過去の晩を再現するときは、ToDoだけ現在の状態が混ざる点に注意。
      grab<ActionRow>(
        c,
        `daily_actions?select=entry_date,kind,content,due_date&done=eq.false` +
          `&order=entry_date.asc&limit=100`,
        "日々のToDo",
        failed
      ),
      grab<TodoRow>(
        c,
        `strategic_todos?select=task_name,genre,status,target_month,due_date` +
          `&status=neq.${enc("完了")}&order=target_month.asc&limit=100`,
        "戦略ToDo",
        failed
      ),
      // 直近の振り返り2件。本人が既に自覚していることを重ねて言わないため。
      grab<RetroRow>(
        c,
        `retrospectives?select=period_start,period_end,one_liner,insights,action_guideline` +
          `&period_end=lte.${today}&order=period_start.desc&limit=2`,
        "振り返り",
        failed
      ),
      // 過去の示唆。繰り返し検知と「解決したか」の判定に使う。
      //
      // ここだけ grab を使わない。insights 表がまだ無い環境（＝初回導入前）でも
      // 落とさないのは同じだが、それを「取得に失敗した材料」に混ぜてはいけない。
      // 失敗扱いにすると「この材料については何も言うな」という指示が出てしまい、
      // 初回の晩に過去の示唆を参照させない指示と読める。表が無いのと取れなかったのは
      // 別の話なので、静かに空配列を返す。
      (async () => {
        try {
          const res = await fetch(
            `${c.url}/rest/v1/insights?select=id,generated_on,kind,title,body,verdict,verdict_note,outcome` +
              `&generated_on=gte.${from.insight}&generated_on=lt.${today}&order=generated_on.desc&limit=60`,
            { headers: restHeaders(c.key), cache: "no-store" }
          );
          if (!res.ok) return [] as PastInsight[];
          return (await res.json()) as PastInsight[];
        } catch {
          return [] as PastInsight[];
        }
      })(),
      // 相談窓口の問い。答えは要らない（長い）。**何を聞いたか**だけで
      // 「いま何に悩んでいるか」が分かる。insights と同じ理由で failed には混ぜない
      // （ask_log 未作成の環境で「この材料について何も言うな」が出るのを避ける）。
      (async () => {
        try {
          const res = await fetch(
            `${c.url}/rest/v1/ask_log?select=question,rating,created_at` +
              `&created_at=gte.${from.insight}&created_at=lt.${today}T23:59:59` +
              `&order=created_at.desc&limit=20`,
            { headers: restHeaders(c.key), cache: "no-store" }
          );
          if (!res.ok) return [] as AskEntry[];
          return (await res.json()) as AskEntry[];
        } catch {
          return [] as AskEntry[];
        }
      })(),
    ]);

  return {
    today,
    diaries,
    meetings,
    weekly,
    health,
    actions,
    todos,
    retros,
    pastInsights,
    asks,
    failed,
  };
}

/** 材料が薄すぎて考えさせる意味が無い状態か。 */
export function tooThin(m: Materials): string | null {
  if (m.diaries.length === 0 && m.meetings.length === 0 && m.weekly.length === 0) {
    return "日記・会議録・週報がいずれも0件です。材料が無いので示唆は作れません。";
  }
  return null;
}

// ---- プロンプトへ載せる形に整える -------------------------------------
// 会議録は全文だと長すぎる。週次振り返りの下書きで、13件4万字を渡したら
// 3分かかってソケットが切れた実績がある（app/api/retrospective/draft）。
// 欲しいのは「誰が何と言ったか」なので、1件あたりと総量の両方で切る。

const MEETING_CHARS = 1800;
const MEETING_TOTAL = 20000;
const DIARY_CHARS = 1200;
const DIARY_TOTAL = 14000;

/**
 * 総量の上限に収める。
 *
 * ★新しいものから詰めて、出すときは日付順に戻す★
 *   rows は日付の昇順（古い順）で渡ってくる。素直に先頭から詰めると、上限に当たった
 *   ときに落ちるのは新しい会議になる。直近ほど重い材料なのに、いちばん重いものから
 *   捨てることになり、しかも件数だけは合っているので気づけない。
 *   実測では会議録が14日で170チャンクあり、上限20,000字は確実に効く。
 *   詰める向きと読ませる向きを分けておく。
 */
function clip(
  rows: Chunk[],
  perItem: number,
  total: number,
  head: (r: Chunk) => string
): string {
  let used = 0;
  const kept: string[] = [];
  let dropped = 0;
  // 新しい順に詰める
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const h = head(r);
    const body = (r.content ?? "").slice(0, perItem);
    if (used + h.length + body.length > total && kept.length > 0) {
      dropped = i + 1;
      break;
    }
    used += h.length + body.length;
    kept.push(h + body);
  }
  // 読ませるのは古い順（時系列で追えるように）
  kept.reverse();
  const note =
    dropped > 0
      ? `（これより古い ${dropped} 件は長さの都合で省略。直近を優先して載せている）\n\n`
      : "";
  return note + kept.join("\n\n");
}

/**
 * 健康の実測を1日1行に畳む。
 *
 * 生のJSONをそのまま渡すと、値が入っていない列の "null" だけで6千字を超える。
 * 読ませたいのは「28日ぶんの推移」であって列名の繰り返しではない。
 *
 * 摂取カロリーが極端に低い日は入力漏れとして扱い、数字ではなく「未入力」と書く。
 * /health が500kcal未満を入力漏れとして扱っているのと同じ線を引く。これをやらないと
 * 「食べていない日が続いている」という事実でない話を作ってしまう。
 */
const KCAL_UNRELIABLE = 500;

function renderHealth(days: HealthDay[]): string {
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  const lines = days.map((d) => {
    const kcalRaw = n(d.kcal);
    const kcal =
      kcalRaw === null
        ? "未入力"
        : kcalRaw < KCAL_UNRELIABLE
          ? `未入力(${kcalRaw})`
          : `${kcalRaw}kcal`;
    const bits = [
      `${d.day}`,
      n(d.weight_kg) !== null ? `体重${n(d.weight_kg)}kg` : "",
      n(d.body_fat_pct) !== null ? `体脂肪${n(d.body_fat_pct)}%` : "",
      n(d.muscle_kg) !== null ? `筋肉${n(d.muscle_kg)}kg` : "",
      n(d.steps) !== null ? `歩数${n(d.steps)}` : "",
      `食事${kcal}`,
      n(d.protein_g) !== null ? `P${n(d.protein_g)}g` : "",
      n(d.walking_speed_kmh) !== null ? `歩行${n(d.walking_speed_kmh)}km/h` : "",
    ].filter(Boolean);
    return `- ${bits.join(" ")}`;
  });
  return (
    lines.join("\n") +
    `\n※「食事未入力」は記録が無い日。食べていない日ではないので、そう読まないこと。`
  );
}

/** 材料を1本のテキストにする。LLMへ渡すのはこれ。 */
export function renderMaterials(m: Materials): string {
  const parts: string[] = [];

  parts.push(
    `# 基準日\n${m.today}（この日の夜に考えている。直近の日付ほど重い）`
  );

  parts.push(
    `# 一行日記（直近${WINDOWS.diary}日・${m.diaries.length}件）\n` +
      (m.diaries.length
        ? clip(m.diaries, DIARY_CHARS, DIARY_TOTAL, (r) => `## ${r.event_date}\n`)
        : "（記録なし）")
  );

  parts.push(
    `# 会議録（直近${WINDOWS.meeting}日・${m.meetings.length}件）\n` +
      (m.meetings.length
        ? clip(
            m.meetings,
            MEETING_CHARS,
            MEETING_TOTAL,
            (r) => `## ${r.event_date} ${r.organization ?? ""} ${r.title ?? ""}\n`
          )
        : "（記録なし）")
  );

  parts.push(
    `# 週報（直近${WINDOWS.weekly}日・${m.weekly.length}行）\n` +
      (m.weekly.length
        ? m.weekly
            .map(
              (w) =>
                `- ${w.week_start} [${w.category}] ${w.organization ?? ""}\n` +
                `  事実: ${w.summary ?? ""}\n` +
                `  示唆: ${w.insight ?? ""}\n` +
                `  打ち手: ${w.tactic ?? ""}`
            )
            .join("\n")
        : "（記録なし）")
  );

  parts.push(
    `# 健康の実測（直近${WINDOWS.health}日・${m.health.length}日ぶん）\n` +
      (m.health.length ? renderHealth(m.health) : "（記録なし）")
  );

  parts.push(
    `# 未完のToDo（日々 ${m.actions.length}件 / 戦略 ${m.todos.length}件）\n` +
      [
        ...m.actions.map(
          (a) => `- [${a.entry_date}起票/${a.kind}] ${a.content}${a.due_date ? `（期限 ${a.due_date}）` : ""}`
        ),
        ...m.todos.map(
          (t) => `- [戦略/${t.genre}/${t.status}] ${t.task_name}${t.target_month ? `（${t.target_month}）` : ""}`
        ),
      ].join("\n") || "（なし）"
  );

  parts.push(
    `# 直近の振り返り（${m.retros.length}件）\n` +
      (m.retros.length
        ? m.retros
            .map(
              (r) =>
                `## ${r.period_start}〜${r.period_end}\n` +
                `一言: ${r.one_liner ?? ""}\n` +
                `示唆: ${JSON.stringify(r.insights ?? [])}\n` +
                `行動指針: ${r.action_guideline ?? ""}`
            )
            .join("\n\n")
        : "（記録なし）")
  );

  parts.push(
    `# 相談窓口に投げられた問い（直近${WINDOWS.insight}日・${m.asks.length}件）\n` +
      (m.asks.length
        ? m.asks
            .map(
              (a) =>
                `- [${a.created_at.slice(0, 10)}] ${a.question.slice(0, 160)}` +
                (a.rating === "helpful" ? "（回答は役に立った）" : a.rating === "off" ? "（回答はずれていた）" : "")
            )
            .join("\n") +
          `\n※問いの中身そのものが「いま何に悩んでいるか」の一次資料。繰り返し出てくるテーマがあれば示唆の種にする`
        : "（なし）")
  );

  // ★ここが繰り返しを防ぐ材料。
  parts.push(
    `# 過去に自分（夜間参謀）が出した示唆（直近${WINDOWS.insight}日・${m.pastInsights.length}件）\n` +
      (m.pastInsights.length
        ? m.pastInsights
            .map(
              (p) =>
                `- [${p.generated_on}/${p.kind}] (id:${p.id}) ${p.title}\n` +
                `  本文: ${p.body}\n` +
                `  吉井さんの判断: ${p.verdict ?? "未判断"}` +
                (p.verdict_note ? `（理由: ${p.verdict_note}）` : "") +
                (p.outcome ? ` / 結果: ${p.outcome}` : "")
            )
            .join("\n")
        : "（まだ1件も出していない。今回が初回）")
  );

  if (m.failed.length) {
    parts.push(
      `# 取得に失敗した材料\n${m.failed.join(" / ")}\n` +
        `※ この材料については何も言わないこと（無いのか取れなかったのか区別できないため）`
    );
  }

  return parts.join("\n\n---\n\n");
}

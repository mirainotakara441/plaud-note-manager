// /ask（相談窓口）がAIに渡す道具。
//
// ■ 位置づけ
//   これまでの全ルートは「固定件数を先に引いて渡す」形だった（/agent は成果物40件・
//   共通20件の決め打ち）。ここは逆で、AIが問いに応じて自分で検索を重ねる。
//   「北九州の懸念って前に何かあったか」→ 会議を引く → 人名が出る → その人で
//   もう一度引く、という多段の調べ方は、決め打ちでは構造的にできなかったもの。
//
// ■ 道具は読み取り専用
//   全部が既存の読み口（search-memory / org-history / weekly_reports）のラッパー。
//   書き込む道具は渡さない。相談窓口は考える場所であって、実行する場所ではない。
//
// ■ 結果は圧縮して返す
//   道具の結果はそのまま次のリクエストの入力トークンになる。全文を返すと
//   数往復で入力が膨らみ、遅く・高くなる。1件あたりと総量の両方で切る
//   （切り方は nightAdvisor/collect.ts と同じ考え方。直近・上位を優先）。

import type { ToolDef } from "@/lib/llm";
import { restHeaders, type Creds } from "@/lib/supabase";
import { logSearch } from "@/lib/searchLog";

// /api/search と同じ一覧。memory_chunks の CHECK制約を変えたらここも直すこと
// （search/route.ts の同名配列のコメントを参照。過去に2回、絞り込みが黙って
// 無効になる事故が起きている）。
const VALID_SOURCE_TYPES = [
  "日記",
  "会議",
  "学び",
  "成果物",
  "振り返り",
  "学会",
  "PDF",
  "その他",
  "月次報告",
  "週報",
];

const CLIP_ITEM = 700;
const CLIP_TOTAL = 9000;

function clipRows(rows: string[]): string {
  let used = 0;
  const out: string[] = [];
  for (const r of rows) {
    if (used + r.length > CLIP_TOTAL) {
      out.push(`…（残り${rows.length - out.length}件は省略。必要なら条件を絞ってもう一度引くこと）`);
      break;
    }
    used += r.length;
    out.push(r);
  }
  return out.join("\n\n");
}

/** /ask がAIへ渡す道具一式を作る。認証情報はサーバー側に閉じる。 */
export function buildAskTools(creds: Creds, anonKey: string): ToolDef[] {
  const searchMemory: ToolDef = {
    name: "search_memory",
    description:
      "吉井さんの記憶層（日記・会議録・成果物・週報・学び等）をベクトル検索する。" +
      "問いに出てくる固有名詞や論点で検索し、必要なら言い換えて複数回引くこと。" +
      "1回で core が引けなくても、出てきた人名・団体名・論点で引き直すと届くことが多い。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索文。固有名詞をそのまま使う" },
        source_type: {
          type: "string",
          enum: VALID_SOURCE_TYPES,
          description: "絞り込み。省略すると全種類から",
        },
        match_count: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "取得件数。既定10",
        },
      },
      required: ["query"],
    },
    run: async (input) => {
      const payload: Record<string, unknown> = {
        query: String(input.query ?? "").trim(),
        match_count:
          Number.isInteger(input.match_count) &&
          (input.match_count as number) >= 1 &&
          (input.match_count as number) <= 20
            ? input.match_count
            : 10,
      };
      if (
        typeof input.source_type === "string" &&
        VALID_SOURCE_TYPES.includes(input.source_type)
      ) {
        payload.source_type = input.source_type;
      }
      const t0 = Date.now();
      const res = await fetch(`${creds.url}/functions/v1/search-memory`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${anonKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`search-memory ${res.status}`);
      const data = await res.json();
      const rows: {
        source_type: string;
        title: string;
        content: string;
        event_date: string | null;
        similarity: number;
      }[] = Array.isArray(data?.results) ? data.results : [];

      // 検索ログ（W3「生成ログの記録」）。AIが問いのために何を引いたかを残す。
      await logSearch(creds, {
        source: "ask",
        query: payload.query as string,
        filters: { source_type: payload.source_type, match_count: payload.match_count },
        results: rows,
        ms: Date.now() - t0,
      });
      if (rows.length === 0) return "該当なし。言い換えるか、別の種類で引き直すこと。";
      return clipRows(
        rows.map(
          (r) =>
            `[${r.source_type}] ${r.event_date ?? "日付不明"} ${r.title}（類似度${
              typeof r.similarity === "number" ? r.similarity.toFixed(2) : "?"
            }）\n${(r.content ?? "").slice(0, CLIP_ITEM)}`
        )
      );
    },
  };

  const orgHistory: ToolDef = {
    name: "org_history",
    description:
      "特定の団体（自治体・事業者）の会議履歴を時系列で取る。団体の経緯・相手の反応・" +
      "懸念を追うときは、search_memory より先にこちらを使うこと（時系列が保たれる）。",
    input_schema: {
      type: "object",
      properties: {
        organization: {
          type: "string",
          description: "団体名。「堺市」「東洋紙業」のように正式な呼び名で",
        },
      },
      required: ["organization"],
    },
    run: async (input) => {
      const res = await fetch(`${creds.url}/functions/v1/org-history`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${anonKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organization: String(input.organization ?? "").trim() }),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`org-history ${res.status}`);
      const data = await res.json();
      const meetings: {
        title: string;
        content: string;
        event_date: string | null;
      }[] = Array.isArray(data?.meetings) ? data.meetings : [];
      if (meetings.length === 0) {
        return "この団体の会議履歴は無い。名前の表記が違う可能性もある（例:「堺市」と「堺」）。";
      }
      // 直近を優先（nightAdvisor と同じ理由。古い方から詰めると新しい会議が落ちる）。
      const recent = meetings.slice(-15);
      const dropped = meetings.length - recent.length;
      return (
        (dropped > 0 ? `（古い${dropped}件は省略。直近15件を新しい順に近い形で載せる）\n\n` : "") +
        clipRows(
          recent.map(
            (m) => `${m.event_date ?? "日付不明"} ${m.title}\n${(m.content ?? "").slice(0, CLIP_ITEM)}`
          )
        )
      );
    },
  };

  const weeklyReports: ToolDef = {
    name: "weekly_reports",
    description:
      "週報（営業活動の事実ログ）を引く。団体別の直近の動き・打ち手・数字はここが一番正確。" +
      "organization を渡すとその団体だけ、省略すると直近の全件。",
    input_schema: {
      type: "object",
      properties: {
        organization: { type: "string", description: "団体名で絞る（部分一致）。省略可" },
        weeks: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "何週ぶん遡るか。既定4",
        },
      },
      required: [],
    },
    run: async (input) => {
      const weeks =
        Number.isInteger(input.weeks) && (input.weeks as number) >= 1 && (input.weeks as number) <= 12
          ? (input.weeks as number)
          : 4;
      const from = new Date(Date.now() - weeks * 7 * 86400000).toISOString().slice(0, 10);
      let path =
        `weekly_reports?select=week_start,category,organization,summary,insight,tactic` +
        `&week_start=gte.${from}&order=week_start.desc&limit=80`;
      const org = typeof input.organization === "string" ? input.organization.trim() : "";
      if (org) path += `&organization=ilike.${encodeURIComponent(`*${org}*`)}`;
      const res = await fetch(`${creds.url}/rest/v1/${path}`, {
        headers: restHeaders(creds.key),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`weekly_reports ${res.status}`);
      const rows: {
        week_start: string;
        category: string;
        organization: string | null;
        summary: string | null;
        insight: string | null;
        tactic: string | null;
      }[] = await res.json();
      if (rows.length === 0) return "該当する週報は無い。";
      return clipRows(
        rows.map(
          (w) =>
            `${w.week_start} [${w.category}] ${w.organization ?? ""}\n事実: ${w.summary ?? ""}` +
            (w.insight ? `\n示唆: ${w.insight}` : "") +
            (w.tactic ? `\n打ち手: ${w.tactic}` : "")
        )
      );
    },
  };

  return [searchMemory, orgHistory, weeklyReports];
}

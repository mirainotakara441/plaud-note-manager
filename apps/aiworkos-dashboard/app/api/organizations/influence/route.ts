import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";
import {
  llmErrorMessage,
  llmErrorStatus,
  isLlmConfigured,
  structured,
} from "@/lib/llm";
import { fetchMeetings, groupMeetings, type MeetingDoc } from "@/lib/organizations";

// 団体別攻略／「影響力マップ」：人脈DB（notion_contacts）は「点」の名簿でしかなく、
// 攻略に要るのは「誰が誰に影響するか」という「線」。その線は既に手元の資料に
// 眠っている——会議録（memory_chunks, source_type=会議）には同席情報が、
// 人脈DBのメモ欄には後任情報（例: 伊藤友樹→小野友弘）が書かれている。
// ここでは Claude にその2種類の資料だけを読ませ、人物間の関係を influence_edges へ
// status='draft'（下書き）で貯める。確定（confirmed）にするのは必ず吉井さんの目視。
// AIの抽出をそのまま「事実」に昇格させないための2段階になっている。
//
//   GET    ?org=…                 : その団体の線（edges）＋点（人物一覧）
//   POST   { org, action:"extract" } : 会議録＋人脈DBメモから関係を抽出し draft 保存
//   PATCH  { id, status }         : draft → confirmed（吉井さんの確定）
//   DELETE ?id=…                  : 1件削除（誤抽出の掃除）
//
// RLS: influence_edges は deny-by-default（service role のみ）なので読み書きとも
// serviceCreds() 必須。notion_contacts は anon に SELECT を許可済み（legislators と同じ）。

// 抽出は thinking 込みの Claude 呼び出しなので、Vercel の関数タイムアウトを引き上げる。
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// DBの CHECK 制約と同じ並び。ここを増やすときはマイグレーションとセットで。
const RELATIONS = [
  "上司",
  "部下",
  "後任",
  "前任",
  "推薦",
  "紹介",
  "同席",
  "慎重派",
  "決裁",
] as const;

type Relation = (typeof RELATIONS)[number];

function isRelation(v: unknown): v is Relation {
  return typeof v === "string" && (RELATIONS as readonly string[]).includes(v);
}

export type InfluenceEdge = {
  id: string;
  org_name: string;
  from_person: string;
  to_person: string;
  relation: Relation;
  note: string | null;
  source_ref: string | null;
  status: "draft" | "confirmed";
  created_at: string;
  updated_at: string;
};

export type InfluencePerson = {
  name: string;
  department: string | null;
  title: string | null;
  flag: string | null;
};

const EDGE_SELECT =
  "id,org_name,from_person,to_person,relation,note,source_ref,status,created_at,updated_at";

// ---------------------------------------------------------------------------
// 取得ヘルパー
// ---------------------------------------------------------------------------

async function fetchEdges(
  url: string,
  key: string,
  org: string
): Promise<InfluenceEdge[]> {
  const res = await fetch(
    `${url}/rest/v1/influence_edges?select=${EDGE_SELECT}&org_name=eq.${encodeURIComponent(
      org
    )}&order=created_at.asc`,
    { headers: restHeaders(key), cache: "no-store" }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`influence_edges 取得エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  const rows: unknown = await res.json();
  return Array.isArray(rows) ? (rows as InfluenceEdge[]) : [];
}

// 人脈DBの写しから、その団体の人物を取る。memo は抽出（POST）のときだけ要るので
// 引数で出し分ける（GET応答にメモ全文を垂れ流さないため）。
async function fetchContacts(
  url: string,
  key: string,
  org: string,
  withMemo: boolean
): Promise<(InfluencePerson & { memo?: string | null })[]> {
  const select = withMemo
    ? "name,department,title,flag,memo"
    : "name,department,title,flag";
  const res = await fetch(
    `${url}/rest/v1/notion_contacts?select=${select}&org_name=eq.${encodeURIComponent(
      org
    )}&order=department.asc.nullslast,name.asc`,
    { headers: restHeaders(key), cache: "no-store" }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`notion_contacts 取得エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  const rows: unknown = await res.json();
  return Array.isArray(rows)
    ? (rows as (InfluencePerson & { memo?: string | null })[])
    : [];
}

// ---------------------------------------------------------------------------
// GET: 線（edges）＋点（人物）
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const org = request.nextUrl.searchParams.get("org")?.trim();
  if (!org) {
    return NextResponse.json({ error: "org は必須です" }, { status: 400 });
  }

  const anon = anonCreds();
  const service = serviceCreds();
  if (!anon || !service) {
    return NextResponse.json(
      { error: "サーバー設定エラー: 環境変数が設定されていません" },
      { status: 500 }
    );
  }

  try {
    const [edges, people] = await Promise.all([
      fetchEdges(service.url, service.key, org),
      fetchContacts(anon.url, anon.key, org, false),
    ]);
    return NextResponse.json({ organization: org, edges, people });
  } catch (error) {
    console.error("影響力マップ取得エラー:", error);
    return NextResponse.json(
      { error: "影響力マップの取得でエラーが発生しました" },
      { status: 502 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST: 会議録＋人脈DBメモから関係を抽出（draft 保存）
// ---------------------------------------------------------------------------

// 抽出結果の1行。DBの行と同じ向きの定義をスキーマの description に書き、
// プロンプト側と食い違わないようにする。
type ExtractedEdge = {
  from_person: string;
  to_person: string;
  relation: string;
  note: string;
  source_ref: string;
};

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    edges: {
      type: "array",
      description:
        "資料から直接読み取れた人物間の関係。1件も読み取れなければ空配列でよい（無理に作らない）。",
      items: {
        type: "object",
        properties: {
          from_person: { type: "string", description: "起点の人物名（資料の表記のまま）" },
          to_person: { type: "string", description: "相手の人物名（資料の表記のまま）" },
          relation: {
            type: "string",
            enum: [...RELATIONS],
            description: "関係の種類。向きの定義はプロンプトの指示に従う。",
          },
          note: {
            type: "string",
            description: "根拠。資料中の該当記述を短く引用または要約する。",
          },
          source_ref: {
            type: "string",
            description:
              "出所。会議なら「会議録: {日付} {会議名}」、メモなら「人脈DBメモ: {氏名}」。",
          },
        },
        required: ["from_person", "to_person", "relation", "note", "source_ref"],
        additionalProperties: false,
      },
    },
  },
  required: ["edges"],
  additionalProperties: false,
} as const;

// 人名の創作を防ぐ縛りが本体。関係の「向き」もここで固定する
// （向きが揺れると「AがBの上司」と「BがAの上司」が混在して線が読めなくなる）。
const EXTRACT_SYSTEM = `あなたは自治体営業の人物関係アナリストです。与えられた「会議録」と「人脈DBメモ」から、人物間の関係（影響力の線）を抽出します。

厳守事項:
- 資料の本文に実際に登場する人名だけを使うこと。資料に無い人名を創作・補完・推測してはならない。
- 関係は資料の記述から直接読み取れるものだけ。役職名からの推測（例: 課長だから係長の上司だろう）で関係を作らない。
- 姓しか書かれていない人物は姓のみで出す。勝手に名を補わない。
- 確信が持てない関係は出さない。1件も無ければ空配列でよい。
- note には根拠となる資料中の記述を短く書く（引用または要約）。
- source_ref には出所を書く（会議録: 日付 会議名 ／ 人脈DBメモ: 氏名）。

関係の向き（from_person → to_person）:
- 上司・部下・後任・前任・決裁: from_person から見て to_person がその関係にあたる（例: 後任なら「to_person が from_person の後任」）。
- 推薦・紹介: from_person が to_person を推薦・紹介した。
- 同席: 同じ会議に同席した2人。向きは問わない。同じ2人の組を両向きに重複させない。全出席者の機械的な総当たりは作らず、営業攻略上意味のある組（キーパーソン同士など）に絞る。
- 慎重派: to_person がこの案件に慎重な立場であることが from_person との関係の中で示されている。`;

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "日付不明";
  return dateStr.slice(0, 10);
}

function buildExtractPrompt(
  org: string,
  meetings: MeetingDoc[],
  contacts: (InfluencePerson & { memo?: string | null })[]
): string {
  const meetingsText =
    meetings.length > 0
      ? meetings
          .map((m) => `【会議録: ${formatDate(m.date)} ${m.title}】\n${m.content}`)
          .join("\n\n")
      : "（会議録なし）";

  // メモが空の人物も名簿として渡す（会議録に出てくる姓と突き合わせる材料になる）。
  const contactsText =
    contacts.length > 0
      ? contacts
          .map((c) => {
            const head = [c.name, c.department, c.title]
              .filter((s) => !!s)
              .join(" / ");
            return c.memo?.trim() ? `- ${head}\n  メモ: ${c.memo.trim()}` : `- ${head}`;
          })
          .join("\n")
      : "（人脈DB登録なし）";

  return `対象団体: ${org}

以下は、この団体に関する会議録です。同席・推薦・慎重派・決裁などの関係の材料になります。
==== 会議録 ====
${meetingsText}

以下は、人脈DB（この団体の人物一覧とメモ欄）です。メモ欄には後任・異動などの情報が書かれていることがあります。
==== 人脈DB ====
${contactsText}

上記の資料から直接読み取れる人物間の関係だけを、指定の JSON スキーマで返してください。資料に無い人名・関係を作ってはいけません。`;
}

/** 表記ゆれ（空白・全角空白）を潰した照合用文字列。 */
function squash(s: string): string {
  return s.replace(/[\s　]+/g, "");
}

export async function POST(request: NextRequest) {
  const anon = anonCreds();
  const service = serviceCreds();
  if (!anon || !service) {
    return NextResponse.json(
      { error: "サーバー設定エラー: 環境変数が設定されていません" },
      { status: 500 }
    );
  }
  if (!isLlmConfigured()) {
    return NextResponse.json(
      { error: "ANTHROPIC_APIキーが未設定です。.env.local に ANTHROPIC_API_KEY を設定してください。" },
      { status: 500 }
    );
  }

  let body: { org?: unknown; action?: unknown };
  try {
    body = await request.json();
  } catch (err) {
    console.error("POST /api/organizations/influence: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const org = typeof body.org === "string" ? body.org.trim() : "";
  if (!org) {
    return NextResponse.json({ error: "org は必須です" }, { status: 400 });
  }
  if (body.action !== "extract") {
    return NextResponse.json({ error: "action は extract のみ対応しています" }, { status: 400 });
  }

  // 材料集め。会議録は org-history（既存の名寄せ・チャンク結合に乗る）、
  // メモは notion_contacts の写しから。
  let meetings: MeetingDoc[];
  let contacts: (InfluencePerson & { memo?: string | null })[];
  try {
    const [rawMeetings, rawContacts] = await Promise.all([
      fetchMeetings(anon.url, anon.key, org),
      fetchContacts(anon.url, anon.key, org, true),
    ]);
    meetings = groupMeetings(rawMeetings);
    contacts = rawContacts;
  } catch (error) {
    console.error("影響力マップ抽出: 材料取得エラー:", error);
    return NextResponse.json(
      { error: "会議録・人脈DBの取得に失敗しました" },
      { status: 502 }
    );
  }

  if (meetings.length === 0 && contacts.length === 0) {
    return NextResponse.json(
      { error: "この団体には会議録も人脈DB登録も無く、抽出の材料がありません" },
      { status: 400 }
    );
  }

  // Claude で関係を抽出する。
  let extracted: ExtractedEdge[];
  try {
    const result = await structured<{ edges?: ExtractedEdge[] }>({
      system: EXTRACT_SYSTEM,
      prompt: buildExtractPrompt(org, meetings, contacts),
      schema: EXTRACT_SCHEMA as unknown as Record<string, unknown>,
      // 会議録が長い団体でも本文の出力枠を確保する（agent と同じ引き上げ）。
      maxTokens: 16000,
      label: "影響力抽出",
    });
    extracted = Array.isArray(result.edges) ? result.edges : [];
  } catch (error) {
    console.error("影響力マップ抽出エラー:", error);
    return NextResponse.json(
      { error: llmErrorMessage(error, "AIによる関係の抽出に失敗しました。") },
      { status: llmErrorStatus(error) }
    );
  }

  // プロンプトで縛ってはいるが、念のためサーバー側でも「資料に居る人名か」を照合する
  // （空白の有無だけ吸収した部分一致）。落ちた件数は rejected として返し、黙って捨てない。
  const materialText = squash(
    [
      ...meetings.map((m) => m.content),
      ...contacts.map((c) => `${c.name} ${c.memo ?? ""}`),
    ].join(" ")
  );
  const inMaterial = (name: string): boolean =>
    name !== "" && materialText.includes(squash(name));

  // 既存行との重複判定キー。同一 (org, from, to, relation) は追加しない。
  let existing: InfluenceEdge[];
  try {
    existing = await fetchEdges(service.url, service.key, org);
  } catch (error) {
    console.error("影響力マップ抽出: 既存行取得エラー:", error);
    return NextResponse.json(
      { error: "既存の関係の取得に失敗しました" },
      { status: 502 }
    );
  }
  const seen = new Set(
    existing.map((e) => `${e.from_person}|${e.to_person}|${e.relation}`)
  );

  const toInsert: Omit<InfluenceEdge, "id" | "created_at" | "updated_at">[] = [];
  let duplicateCount = 0;
  let rejectedCount = 0;
  for (const e of extracted) {
    const from = typeof e.from_person === "string" ? e.from_person.trim() : "";
    const to = typeof e.to_person === "string" ? e.to_person.trim() : "";
    if (!from || !to || from === to || !isRelation(e.relation)) {
      rejectedCount += 1;
      continue;
    }
    if (!inMaterial(from) || !inMaterial(to)) {
      // 資料に無い人名＝創作の疑い。draft にすら入れない。
      rejectedCount += 1;
      continue;
    }
    const key = `${from}|${to}|${e.relation}`;
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key); // AIの出力内での重複もここで潰れる
    toInsert.push({
      org_name: org,
      from_person: from,
      to_person: to,
      relation: e.relation,
      note: typeof e.note === "string" && e.note.trim() !== "" ? e.note.trim() : null,
      source_ref:
        typeof e.source_ref === "string" && e.source_ref.trim() !== ""
          ? e.source_ref.trim()
          : null,
      status: "draft",
    });
  }

  let inserted: InfluenceEdge[] = [];
  if (toInsert.length > 0) {
    try {
      const res = await fetch(`${service.url}/rest/v1/influence_edges`, {
        method: "POST",
        headers: restHeaders(service.key, { Prefer: "return=representation" }),
        body: JSON.stringify(toInsert),
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`influence_edges 保存エラー ${res.status}: ${text.slice(0, 200)}`);
      }
      const rows: unknown = await res.json();
      inserted = Array.isArray(rows) ? (rows as InfluenceEdge[]) : [];
    } catch (error) {
      console.error("影響力マップ抽出: 保存エラー:", error);
      return NextResponse.json(
        { error: "抽出した関係の保存に失敗しました" },
        { status: 502 }
      );
    }
  }

  return NextResponse.json({
    organization: org,
    insertedCount: inserted.length,
    duplicateCount,
    rejectedCount,
    inserted,
  });
}

// ---------------------------------------------------------------------------
// PATCH: draft → confirmed（吉井さんの確定）
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const service = serviceCreds();
  if (!service) {
    return NextResponse.json(
      { error: "サーバー設定エラー: 環境変数が設定されていません" },
      { status: 500 }
    );
  }

  let body: { id?: unknown; status?: unknown };
  try {
    body = await request.json();
  } catch (err) {
    console.error("PATCH /api/organizations/influence: リクエストJSON解析失敗", err);
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const status = body.status;
  if (!id) {
    return NextResponse.json({ error: "id は必須です" }, { status: 400 });
  }
  // 差し戻し（confirmed→draft）も同じ経路でできるよう両方通す。
  if (status !== "confirmed" && status !== "draft") {
    return NextResponse.json(
      { error: "status は draft か confirmed を指定してください" },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(
      `${service.url}/rest/v1/influence_edges?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: restHeaders(service.key, { Prefer: "return=representation" }),
        // updated_at はDBトリガーに頼らず明示的に進める（テーブル側に無い前提で安全に）。
        body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
        cache: "no-store",
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`influence_edges 更新エラー ${res.status}: ${text.slice(0, 200)}`);
    }
    const rows: unknown = await res.json();
    const edge = Array.isArray(rows) && rows.length > 0 ? (rows[0] as InfluenceEdge) : null;
    if (!edge) {
      return NextResponse.json({ error: "指定された関係が見つかりません" }, { status: 404 });
    }
    return NextResponse.json({ edge });
  } catch (error) {
    console.error("影響力マップ更新エラー:", error);
    return NextResponse.json(
      { error: "関係の確定に失敗しました" },
      { status: 502 }
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE: 誤抽出の掃除（1件削除）
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest) {
  const service = serviceCreds();
  if (!service) {
    return NextResponse.json(
      { error: "サーバー設定エラー: 環境変数が設定されていません" },
      { status: 500 }
    );
  }

  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) {
    return NextResponse.json({ error: "id は必須です" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${service.url}/rest/v1/influence_edges?id=eq.${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        // 消えた行を返させて「本当に1件消えたか」を確かめる（0件なら404にする）。
        headers: restHeaders(service.key, { Prefer: "return=representation" }),
        cache: "no-store",
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`influence_edges 削除エラー ${res.status}: ${text.slice(0, 200)}`);
    }
    const rows: unknown = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: "指定された関係が見つかりません" }, { status: 404 });
    }
    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("影響力マップ削除エラー:", error);
    return NextResponse.json({ error: "関係の削除に失敗しました" }, { status: 502 });
  }
}

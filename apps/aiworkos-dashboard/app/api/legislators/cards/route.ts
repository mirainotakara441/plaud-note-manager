import { NextRequest, NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";
import { structured, isLlmConfigured, llmErrorMessage, llmErrorStatus } from "@/lib/llm";
import { isOrgCategory, type OrgCategory } from "@/lib/categories";
import {
  notionToken,
  notionCreateOrgPage,
  notionCreateContactPage,
  isWithinOneYear,
} from "@/lib/notionContacts";
import { orgKey } from "@/lib/orgTargets";
import { toJstDateString } from "@/lib/date";

// 名刺（Eightの一覧画面・紙の名刺）の写メから人脈DBへ入れる。
// 画面は /legislators の「名刺を写メで追加」タブ。
//
// なぜ要るか:
//   これまで名刺の取り込みはMac上のスキル（eight-to-jinmyaku）専用だった。
//   Eightの一覧はブラウザ操作が要るので自動では回せず、Macを開くまで溜まる。
//   写メなら iPhone のその場で入れられる。議員は会った直後に登録したい相手なので、
//   「Macに戻るまで待つ」がいちばん効く場面で効かない。
//
// 2段階に分けている理由（/api/health/photo と同じ思想）:
//   POST … 画像を読むだけ。NotionにもSupabaseにも一切書かない。
//   PUT  … 画面で確認した行だけを書く。
//   OCRは間違える。人脈DBは提案・議事・週報の突合先なので、誤読が1件入ると
//   その人物にぶら下がる記録が全部ずれる。必ず人が見てから書く。
//
// 書き込みはライトスルー（Notionが正 → 写しへも入れる）:
//   写し(notion_contacts)にだけ入れると、毎時の同期(mark and sweep)で消える。
//   「登録したのに勝手に消える」がいちばんタチの悪い壊れ方なので、順番を守る。
//
// 守っているガードレール（名刺スキル ROLE.md）:
//   §3-4 推測で氏名を確定しない  → 読み取り結果は候補として出すだけ。確定は画面の人。
//   §3-5 名刺が古いだけで過去担当にしない → フラグは交換日1年以内のときだけ「現担当」。
//   既存行の上書きをしない → 同名・同団体が既に居る行は、画面に出すが登録させない。
//
// 画像は保存しない。残すべきは名刺の内容であって、写真そのものではない。

export const dynamic = "force-dynamic";
// 名刺を数枚まとめて読ませるので、既定の実行時間では足りないことがある。
export const maxDuration = 60;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 1回に読ませる枚数の上限。Vercelのリクエスト上限(4.5MB)と実行時間の両方に効く。 */
const MAX_IMAGES = 6;
/** 一度に登録できる人数の上限。Notionは約3req/秒なので、間隔を空けても収まる範囲。 */
const MAX_ROWS = 20;

type ReadCard = {
  name: string;
  company: string;
  deptTitle: string;
  tel: string;
  email: string;
  exchanged: string;
  raw: string;
};

type OcrResult = {
  cards: ReadCard[];
  notes: string[];
};

const SCHEMA = {
  type: "object",
  properties: {
    cards: {
      type: "array",
      description:
        "画面・写真に写っている名刺を1件1要素で。Eightの一覧なら並んでいる人ぜんぶ、紙の名刺なら1枚1件。",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "氏名。名刺の表記のまま（ひらがな名刺ならひらがなで）。読めなければ空文字。",
          },
          company: {
            type: "string",
            description:
              "会社名・団体名・政党名。名刺に書かれていなければ空文字。推測して補わない。",
          },
          deptTitle: {
            type: "string",
            description:
              "部署と役職。名刺に書かれている文字列をそのまま1本で（分割しない）。無ければ空文字。",
          },
          tel: { type: "string", description: "電話番号。無ければ空文字。" },
          email: { type: "string", description: "メールアドレス。無ければ空文字。" },
          exchanged: {
            type: "string",
            description:
              "Eightの一覧に交換日が出ていれば YYYY-MM-DD。出ていなければ空文字。推測して今日を入れない。",
          },
          raw: {
            type: "string",
            description: "その名刺に書かれている文字を、見えたまま1行にまとめたもの。",
          },
        },
        required: ["name", "company", "deptTitle", "tel", "email", "exchanged", "raw"],
        additionalProperties: false,
      },
    },
    notes: {
      type: "array",
      description: "読み取れなかった箇所や、判断に迷った点があれば日本語で1つずつ。無ければ空配列。",
      items: { type: "string" },
    },
  },
  required: ["cards", "notes"],
  additionalProperties: false,
} as const;

const SYSTEM = `あなたは名刺の写真やEightの連絡先一覧のスクリーンショットから、書かれている内容を書き起こす作業をしています。

守ること:
- 名刺に書かれていることだけを写す。書かれていない項目は空文字にし、推測で補わない。
- 会社名が名刺に無い人は company を空文字にする。肩書きから会社を推測しない。
- 部署と役職は分割せず、書かれている文字列をそのまま deptTitle に入れる。
- 「Eightネットワーク」「こちらの方も登録されています」のような、交換していない他人の
  おすすめ枠が写り込んでいたら、それは名刺ではないので cards に入れず notes に書く。
- 文字が切れていて読み切れない項目は、推測で埋めず空文字にして notes に書く。
- 同じ人が複数の画像に写っている場合も、見えたぶんをそのまま出す（後で突き合わせる）。`;

/** data URL / 生base64 のどちらでも受け、Anthropicに渡せる形に均す。 */
function parseImage(input: unknown): { media_type: string; data: string } | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([\s\S]+)$/.exec(input);
  if (m) return { media_type: m[1], data: m[2] };
  if (/^[A-Za-z0-9+/=\s]+$/.test(input)) return { media_type: "image/jpeg", data: input.trim() };
  return null;
}

function todayJst(): string {
  return toJstDateString(new Date().toISOString());
}

/**
 * 「部署／役職」の1本の文字列を分ける。
 *
 * 末尾が役職語のときだけ割り、判断がつかないものは全部を部署に入れる
 * （名刺スキル MANUAL.md「部署と役職の分け方」）。無理に割ると、役職欄に
 * 部署名の断片が入って読めなくなる。
 * ここで出すのはあくまで案で、画面で直せる。
 */
const TITLE_WORDS = [
  "統括本部長", "本部長", "支社長", "センター長", "エリア長", "課長代理", "課長補佐",
  "担当部長", "副部長", "次長", "部長", "課長", "係長", "室長", "所長", "主幹", "主査",
  "主任", "主事", "マネージャー", "マネジャー", "リーダー", "職員", "副参事", "参事",
  "調査役", "常務取締役", "取締役", "執行役員",
];

export function splitDeptTitle(s: string): { department: string | null; title: string | null } {
  const t = s.trim();
  if (t === "") return { department: null, title: null };
  for (const w of TITLE_WORDS) {
    if (t.endsWith(w)) {
      const dept = t.slice(0, t.length - w.length).replace(/[\s　/／・]+$/, "");
      return { department: dept === "" ? null : dept, title: w };
    }
  }
  return { department: t, title: null };
}

type OrgRowLite = { notion_page_id: string; name: string; category: string | null };
type ContactLite = {
  name: string;
  org_name: string | null;
  department: string | null;
  title: string | null;
  eight_registered_on: string | null;
};

async function fetchOrgs(url: string, key: string): Promise<OrgRowLite[]> {
  const res = await fetch(
    `${url}/rest/v1/notion_organizations?select=notion_page_id,name,category&limit=2000`,
    { headers: restHeaders(key), cache: "no-store" }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function fetchContacts(url: string, key: string): Promise<ContactLite[]> {
  const res = await fetch(
    `${url}/rest/v1/notion_contacts?select=name,org_name,department,title,eight_registered_on&limit=5000`,
    { headers: restHeaders(key), cache: "no-store" }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

/** 画像を読むだけ。DBには一切書かない。 */
export async function POST(req: NextRequest) {
  if (!isLlmConfigured()) {
    return NextResponse.json({ error: "AIの設定がされていません" }, { status: 500 });
  }
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const images: unknown[] = Array.isArray(body?.images) ? body.images : [];
  if (images.length === 0) {
    return NextResponse.json({ error: "画像がありません" }, { status: 400 });
  }
  if (images.length > MAX_IMAGES) {
    return NextResponse.json(
      { error: `一度に読めるのは${MAX_IMAGES}枚までです` },
      { status: 400 }
    );
  }
  const ready = images.map(parseImage).filter((x): x is { media_type: string; data: string } => !!x);
  if (ready.length === 0) {
    return NextResponse.json({ error: "画像を読み取れる形式ではありません" }, { status: 400 });
  }

  const today = typeof body?.today === "string" && DAY_RE.test(body.today) ? body.today : todayJst();

  let read: OcrResult;
  try {
    read = await structured<OcrResult>({
      system: SYSTEM,
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
              text: `この画像から名刺の内容を書き起こしてください。今日は${today}です。`,
            },
          ],
        },
      ],
      schema: SCHEMA as unknown as Record<string, unknown>,
      // 文字を写す作業なので思考させても精度は上がらず、枚数ぶん実行時間だけ伸びる
      // （60秒の壁に当たる）。誤読は画面の確認手順で潰す設計。
      thinking: false,
      maxTokens: 8000,
      label: "名刺スクショ読み取り",
    });
  } catch (e) {
    console.error("名刺スクショ読み取り失敗:", e);
    return NextResponse.json(
      { error: llmErrorMessage(e, e instanceof Error ? e.message : "画像を読み取れませんでした") },
      { status: llmErrorStatus(e) }
    );
  }

  const [orgs, contacts] = await Promise.all([
    fetchOrgs(c.url, c.key),
    fetchContacts(c.url, c.key),
  ]);
  const orgByKey = new Map(orgs.map((o) => [orgKey(o.name), o]));

  const cards = (Array.isArray(read.cards) ? read.cards : [])
    .map((raw, i) => {
      const name = String(raw?.name ?? "").trim();
      if (name === "") return null;
      const company = String(raw?.company ?? "").trim();
      const deptTitle = String(raw?.deptTitle ?? "").trim();
      const exchanged = DAY_RE.test(String(raw?.exchanged ?? "")) ? String(raw.exchanged) : null;

      const org = company === "" ? null : (orgByKey.get(orgKey(company)) ?? null);
      // 既に人脈DBに居るか。同姓同名がありうるので、氏名一致は「候補」であって確定ではない。
      // 団体まで一致していれば同一人物とみなして登録させない（重複行を作らないため）。
      const sameName = contacts.filter((x) => x.name === name);
      const existing =
        sameName.find((x) => company !== "" && x.org_name && orgKey(x.org_name) === orgKey(company)) ??
        sameName[0] ??
        null;

      const warnings: string[] = [];
      if (company === "") warnings.push("名刺に会社名がありません。団体を選んでから登録してください");
      if (existing) {
        warnings.push(
          `人脈DBに同じ氏名の行があります（${existing.org_name ?? "団体なし"}／${
            existing.title ?? existing.department ?? "役職なし"
          }）`
        );
      }
      if (!exchanged) warnings.push("交換日が読めませんでした。画面で入れてください");
      else if (!isWithinOneYear(exchanged, today)) {
        warnings.push("交換日が1年より前です。フラグ「現担当」は付けません");
      }

      return {
        id: `c${i}`,
        name,
        company,
        deptTitle,
        ...splitDeptTitle(deptTitle),
        tel: String(raw?.tel ?? "").trim(),
        email: String(raw?.email ?? "").trim(),
        exchanged,
        raw: String(raw?.raw ?? "").trim(),
        orgMatch: org ? { name: org.name, category: org.category } : null,
        // 同名が居るかどうかは見せるが、同一人物かどうかは決めない（ROLE.md §3-4）。
        duplicate: existing
          ? {
              name: existing.name,
              org_name: existing.org_name,
              department: existing.department,
              title: existing.title,
              eight_registered_on: existing.eight_registered_on,
              sameOrg:
                company !== "" && !!existing.org_name && orgKey(existing.org_name) === orgKey(company),
            }
          : null,
        warnings,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return NextResponse.json({
    today,
    cards,
    notes: Array.isArray(read.notes) ? read.notes : [],
    orgs: orgs
      .filter((o) => o.category)
      .map((o) => ({ name: o.name, category: o.category }))
      .sort((a, b) => a.name.localeCompare(b.name, "ja")),
  });
}

type SaveRow = {
  name?: unknown;
  orgName?: unknown;
  orgCategory?: unknown;
  department?: unknown;
  title?: unknown;
  exchanged?: unknown;
  tel?: unknown;
  email?: unknown;
  raw?: unknown;
};

/** 画面で確認した行だけを書き込む。Notion（正）→ 写し の順。 */
export async function PUT(req: NextRequest) {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const raw: SaveRow[] = Array.isArray(body?.rows) ? body.rows : [];
  if (raw.length === 0) {
    return NextResponse.json({ error: "登録する行がありません" }, { status: 400 });
  }
  if (raw.length > MAX_ROWS) {
    return NextResponse.json({ error: `一度に登録できるのは${MAX_ROWS}名までです` }, { status: 400 });
  }
  const today =
    typeof body?.today === "string" && DAY_RE.test(body.today) ? body.today : todayJst();

  const token = await notionToken();
  if (!token) {
    return NextResponse.json(
      { error: "Notionトークンが取得できないため登録できません" },
      { status: 500 }
    );
  }

  const orgs = await fetchOrgs(c.url, c.key);
  const orgByKey = new Map(orgs.map((o) => [orgKey(o.name), o]));

  const created: string[] = [];
  const createdOrgs: string[] = [];
  const failed: { name: string; reason: string }[] = [];

  for (const r of raw) {
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const orgName = typeof r.orgName === "string" ? r.orgName.trim() : "";
    if (name === "" || orgName === "") {
      failed.push({ name: name || "（氏名なし）", reason: "氏名と団体の両方が要ります" });
      continue;
    }
    const exchanged =
      typeof r.exchanged === "string" && DAY_RE.test(r.exchanged) ? r.exchanged : null;
    if (exchanged && exchanged > today) {
      failed.push({ name, reason: "交換日が未来です" });
      continue;
    }

    try {
      // ① 団体を用意する。人物のリレーション先が無いと作れない。
      let org = orgByKey.get(orgKey(orgName)) ?? null;
      if (!org) {
        const cat = typeof r.orgCategory === "string" ? r.orgCategory : "";
        if (!isOrgCategory(cat)) {
          failed.push({ name, reason: `団体「${orgName}」が未登録です。種別を選んでください` });
          continue;
        }
        const row = await notionCreateOrgPage(token, { name: orgName, category: cat as OrgCategory });
        await fetch(`${c.url}/rest/v1/notion_organizations?on_conflict=notion_page_id`, {
          method: "POST",
          headers: restHeaders(c.key, {
            Prefer: "resolution=merge-duplicates,return=minimal",
          }),
          body: JSON.stringify([{ ...row, synced_at: new Date().toISOString() }]),
          cache: "no-store",
        });
        org = { notion_page_id: row.notion_page_id, name: row.name, category: row.category };
        orgByKey.set(orgKey(orgName), org);
        createdOrgs.push(orgName);
      }

      // ② メモを組む。いつ・どこから取り込んだかと、名刺の原表記を必ず残す
      //    （後から吉井さんが検証できるようにするため。ROLE.md §3-9）。
      const tel = typeof r.tel === "string" ? r.tel.trim() : "";
      const email = typeof r.email === "string" ? r.email.trim() : "";
      const cardRaw = typeof r.raw === "string" ? r.raw.trim() : "";
      const memo =
        `${today} 名刺の写メから登録（/legislators）。` +
        (exchanged ? `交換日 ${exchanged}。` : "交換日は名刺から読めず。") +
        (tel ? `TEL ${tel}／` : "") +
        (email ? `Mail ${email}。` : tel ? "。" : "") +
        (cardRaw ? `名刺の原表記：${cardRaw}` : "");

      const contact = await notionCreateContactPage(
        token,
        {
          name,
          orgPageId: org.notion_page_id,
          department: typeof r.department === "string" && r.department.trim() !== "" ? r.department.trim() : null,
          title: typeof r.title === "string" && r.title.trim() !== "" ? r.title.trim() : null,
          exchangedOn: exchanged,
          memo,
          today,
        },
        org.name
      );

      // ③ 写しへも入れる。次の同期を待たずに議員リストへ出すため。
      //    ここが失敗してもNotionには作れているので、次の同期で写しが追いつく。
      const up = await fetch(`${c.url}/rest/v1/notion_contacts?on_conflict=notion_page_id`, {
        method: "POST",
        headers: restHeaders(c.key, {
          Prefer: "resolution=merge-duplicates,return=minimal",
        }),
        body: JSON.stringify([{ ...contact, synced_at: new Date().toISOString() }]),
        cache: "no-store",
      });
      if (!up.ok) {
        const t = await up.text().catch(() => "");
        console.error("名刺の写しへの反映に失敗", up.status, t.slice(0, 300));
      }
      created.push(name);
    } catch (e) {
      console.error("名刺の登録に失敗", name, e);
      failed.push({ name, reason: e instanceof Error ? e.message : "登録に失敗しました" });
    }
  }

  if (created.length === 0) {
    return NextResponse.json(
      { error: failed.map((f) => `${f.name}: ${f.reason}`).join(" / ") || "登録できませんでした" },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true, created, createdOrgs, failed });
}

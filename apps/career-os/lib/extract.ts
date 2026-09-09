// メール1通 → 分類 + 構造化抽出。
//
// 設計方針:
//   1. 送信元ドメインでの機械的な足切りを先にやる（AIに投げる前にnoiseを落とす）
//   2. 残ったものだけ Claude に投げて分類と抽出を同時にやらせる
//
// 1 を挟むのは単なるコスト削減ではない。人事担当者向けメルマガは文面が求人紹介と
// よく似ていて、AIだけに任せると一定確率で job_intro に化ける。送信元で確実に落とせる
// ものは落としておくほうが、精度でもトークンでも得。
//
// 逆に「AIだけ」でも「ドメインだけ」でもダメで、doda X のように同じドメインから
// 求人紹介もスカウトも催促も来る送信元があるため、両方を併用する。

import { structured, EXTRACT_MODEL } from "./anthropic";
import type { EmailKind, JobSource } from "./types";
import type { ParsedMessage } from "./gmail";

/**
 * 明らかに転職案件ではない送信元。
 *
 * ここに載っているのは「人事担当者向けのメルマガ・セミナー案内・キャリア系記事配信」で、
 * 吉井さん個人への求人ではない。転職ラベルに入ってはいるが、求人としては1件も価値がない。
 * AIに投げる前にここで落とす。
 */
const NOISE_SENDERS = new Set([
  "hrpromailmagazine@hrpro.co.jp",
  "cp@biz-study.com",
  "hr@biz-study.com",
  "dx@biz-study.com",
  "marketing@wantedly.com",
  "info@pivot.inc",
  "mailmagazine@newspicks.com",
]);

/** 送信元ドメイン単位で落とすもの（アドレスの枝番が増えても効くように）。 */
const NOISE_DOMAINS = new Set([
  "biz-study.com",
  "hrpro.co.jp",
  "pivot.inc",
  "newspicks.com",
]);

/**
 * 送信元だけで noise と断定できるか。
 *
 * true を返したメールは AI に投げず、kind="noise" として保存だけする
 * （保存はする。次回以降スキップするための冪等性の記録になるため）。
 */
export function isKnownNoiseSender(email: string | null, domain: string | null): boolean {
  if (email && NOISE_SENDERS.has(email)) return true;
  if (domain && NOISE_DOMAINS.has(domain)) return true;
  return false;
}

/** 送信元ドメインから出典サービスを判定する。 */
export function classifySource(domain: string | null): JobSource {
  if (!domain) return "other";
  if (domain.endsWith("doda-x.jp")) return "doda_x";
  if (domain.endsWith("8card.net")) return "eight";
  if (domain.includes("bizreach")) return "bizreach";
  if (domain.includes("recruit")) return "recruit";
  return "other";
}

/**
 * 名寄せキー用の正規化。
 *
 * やること:
 *   1. NFKC で全角→半角（「株式会社ＵＡＣＪ」と「株式会社UACJ」を同一にするのに必須）
 *   2. 小文字化
 *   3. 法人格表記の除去（株式会社 / (株) / 有限会社 / Inc. など）
 *   4. 記号・空白の除去（残すのは英数字とかな・カナ・漢字だけ）
 *
 * 3 を 4 より先にやること。先に記号を消すと「(株)」が「株」になって残ってしまう。
 */
export function normalizeKey(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.normalize("NFKC").toLowerCase();

  // 法人格・団体格の表記ゆれを落とす。前後どちらに付いていても効くように単純置換。
  const legalForms = [
    "株式会社",
    "有限会社",
    "合同会社",
    "合資会社",
    "合名会社",
    "一般社団法人",
    "公益社団法人",
    "一般財団法人",
    "公益財団法人",
    "特定非営利活動法人",
    "医療法人",
    "学校法人",
    "社会福祉法人",
    "npo法人",
    "(株)",
    "(有)",
    "(同)",
  ];
  for (const form of legalForms) {
    s = s.split(form).join("");
  }
  // 英語圏の法人格。単語境界を見ないと "incident" などを壊すので、末尾寄りの塊として落とす。
  s = s.replace(/\b(inc|corp|corporation|co\.?,?\s*ltd|ltd|llc|k\.?k)\b\.?/g, "");

  // 英数字と日本語（ひらがな・カタカナ・漢字・半角カナ）以外を捨てる。
  // \p{...} は tsconfig の target 次第で扱いが変わるため、明示的なコードポイント範囲で書く。
  return s.replace(/[^0-9a-z぀-ゟ゠-ヿ一-鿿ｦ-ﾟ]/g, "");
}

/** career_jobs.dedup_key。会社名 + 職種名で1件とみなす。 */
export function jobDedupKey(company: string, title: string): string {
  return `${normalizeKey(company)}|${normalizeKey(title)}`;
}

/** career_recruiters.dedup_key。所属会社 + 担当者名で1人とみなす。 */
export function recruiterDedupKey(company: string | null, name: string): string {
  return `${normalizeKey(company)}|${normalizeKey(name)}`;
}

/**
 * career_scouts.dedup_key。
 *
 * 基本は「エージェント会社 + 紹介先企業 + ポジション」の内容ベース。
 * こうしておくと、同一案件の再送（実データで FLUX 社から複数回来ている）が
 * 同じキーになり、新規行を作らずに resend_count を積める。
 *
 * 会社名もポジションも読み取れなかった場合だけ gmail_message_id にフォールバックする。
 * dedup_key が衝突しないことを保証しておかないと、内容の薄いスカウトが
 * 全部1行にまとまってしまうため。
 */
export function scoutDedupKey(
  gmailMessageId: string,
  parts: { recruiterCompany: string | null; company: string | null; positionTitle: string | null }
): string {
  const content = [parts.recruiterCompany, parts.company, parts.positionTitle]
    .map((v) => normalizeKey(v))
    .filter((v) => v !== "");
  if (content.length === 0) return `msg:${gmailMessageId}`;
  return `scout:${content.join("|")}`;
}

/** 求人1件ぶんの抽出結果。DBに入れる前の素の形。 */
export type ExtractedJob = {
  company: string;
  title: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_text: string | null;
  location: string | null;
  employment_type: string | null;
  industry: string | null;
  description: string | null;
  url: string | null;
};

/** スカウト1件ぶんの抽出結果。 */
export type ExtractedScout = {
  recruiter_name: string | null;
  recruiter_company: string | null;
  company: string | null;
  position_title: string | null;
  salary_text: string | null;
  /** 応募・返信の期限。ISO日付（YYYY-MM-DD）。 */
  deadline: string | null;
};

/** メール1通の分類 + 抽出結果。 */
export type ExtractionResult = {
  kind: EmailKind;
  /** その分類にした理由。1文。デバッグ用にDBには入れないがログには出せる。 */
  reason: string;
  jobs: ExtractedJob[];
  scout: ExtractedScout | null;
};

// null を許す項目は anyOf で表現する。
// output_config の json_schema は anyOf をサポートしているので、
// 「読み取れなかったら null」を型として表現できる。
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const nullableInteger = { anyOf: [{ type: "integer" }, { type: "null" }] };

const SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["job_intro", "scout", "selection", "noise"],
      description:
        "メールの種別。job_intro=求人紹介メール / scout=ヘッドハンターからの個別スカウト / selection=選考・面談の連絡 / noise=転職案件ではないもの",
    },
    reason: {
      type: "string",
      description: "その種別にした理由を1文で。判定に迷った場合はその旨も書く",
    },
    jobs: {
      type: "array",
      description:
        "kind=job_intro のとき、メールに載っている求人をすべて。1通に複数社ぶん入っていることが多いので取りこぼさないこと。それ以外の kind では空配列",
      items: {
        type: "object",
        properties: {
          company: { type: "string", description: "企業名。求人票の表記のまま" },
          title: { type: "string", description: "ポジション名・職種名。求人票の表記のまま" },
          salary_min: {
            ...nullableInteger,
            description: "想定年収の下限。万円単位の整数。「628万円〜1080万円」なら628。記載が無ければ null",
          },
          salary_max: {
            ...nullableInteger,
            description: "想定年収の上限。万円単位の整数。「628万円〜1080万円」なら1080。記載が無ければ null",
          },
          salary_text: { ...nullableString, description: "年収の記載の原文。加工しないこと" },
          location: { ...nullableString, description: "勤務地。記載が無ければ null" },
          employment_type: { ...nullableString, description: "雇用形態。記載が無ければ null" },
          industry: { ...nullableString, description: "業種。記載が無ければ null" },
          description: {
            ...nullableString,
            description:
              "仕事内容・求める人物像などの要点。200〜400字程度。原文の具体性を保ち、抽象的な要約に丸めないこと",
          },
          url: { ...nullableString, description: "求人詳細ページのURL。記載が無ければ null" },
        },
        required: [
          "company",
          "title",
          "salary_min",
          "salary_max",
          "salary_text",
          "location",
          "employment_type",
          "industry",
          "description",
          "url",
        ],
        additionalProperties: false,
      },
    },
    scout: {
      description: "kind=scout のときだけ埋める。それ以外は null",
      anyOf: [
        {
          type: "object",
          properties: {
            recruiter_name: { ...nullableString, description: "担当ヘッドハンターの氏名" },
            recruiter_company: { ...nullableString, description: "担当者の所属エージェント会社名" },
            company: { ...nullableString, description: "紹介先の企業名" },
            position_title: { ...nullableString, description: "紹介ポジション名" },
            salary_text: { ...nullableString, description: "年収の記載の原文" },
            deadline: {
              ...nullableString,
              description: "返信・応募の期限。YYYY-MM-DD 形式。記載が無ければ null",
            },
          },
          required: [
            "recruiter_name",
            "recruiter_company",
            "company",
            "position_title",
            "salary_text",
            "deadline",
          ],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
  },
  required: ["kind", "reason", "jobs", "scout"],
  additionalProperties: false,
} as const;

const SYSTEM = `
あなたは、転職活動中の候補者のメールボックスを整理する担当者です。
受け取ったメール1通を分類し、求人情報を構造化して取り出します。

## 分類の基準
- job_intro: 求人紹介メール。転職サービスが候補者向けに求人を並べて送ってくるもの。
  **1通に20〜30件ぶんの求人が入っていることがある**（実測: doda X のメール1通に30件）。
  件名に出ているのは先頭の数社だけで、本文にはその後ろにずっと続いている。
  途中で打ち切らず、本文の最後まで見て全件を取り出すこと。取りこぼしが一番やってはいけない失敗。
  同じ企業が別ポジションで複数回出てくることもある（実測: 積水化学工業が3件）。
  同じ企業だからといってまとめず、ポジションごとに1件として扱うこと。
- scout: ヘッドハンター・エージェント担当者から候補者個人に宛てた個別スカウト。
  差出人が個人名で、特定の1案件について打診しているもの。
- selection: 面談日程の調整、書類選考の結果連絡など、進行中の選考に関する事務連絡。
- noise: 人事担当者向けのメールマガジン、セミナー・ウェビナーの案内、キャリア系の記事配信、
  サービスの利用案内など。候補者本人への求人ではないもの。判断に迷ったら noise にせず、
  内容に即した種別を選ぶこと。

## 絶対に守ること
- **求人票に書いていない情報を推測で埋めないこと。** 年収も勤務地も業種も、
  書いていなければ null にする。「たぶんこのくらい」で数字を入れてはいけない。
  ここで作り話が混ざると、後段の適合スコアがまとめて狂う。
- 企業名とポジション名は求人票の表記をそのまま使う。言い換えたり短縮したりしない。
- 年収は万円単位の整数に直す。「1,080万円」→1080、「800〜1200万」→ min 800 / max 1200。
  「応相談」「経験に応じて」など数値でないものは salary_min/max を null にし、
  salary_text に原文を残す。
- 日本語で出力する。
`.trim();

/**
 * メール1通を分類し、求人・スカウトを構造化して取り出す。
 *
 * 送信元だけで noise と分かるものは AI を呼ばずに返す（トークン節約）。
 */
export async function extractFromEmail(msg: ParsedMessage): Promise<ExtractionResult> {
  // 機械的な足切り。ここで落ちたものは AI を通さない。
  if (isKnownNoiseSender(msg.senderEmail, msg.senderDomain)) {
    return {
      kind: "noise",
      reason: "送信元が人事担当者向けメルマガ・セミナー案内の配信元のため、AI判定を行わず noise とした",
      jobs: [],
      scout: null,
    };
  }

  // 本文が実質空のメール（画像だけ、など）も AI に投げる価値がない。
  if (msg.bodyText.trim().length < 20) {
    return {
      kind: "noise",
      reason: "本文がほぼ空のため判定不能。noise として記録した",
      jobs: [],
      scout: null,
    };
  }

  const prompt = `
==== メールのヘッダ ====
差出人: ${msg.sender ?? "（不明）"}
件名: ${msg.subject ?? "（件名なし）"}
受信日時: ${msg.receivedAt ?? "（不明）"}

==== 本文 ====
${msg.bodyText}

このメールを分類し、指定のJSONスキーマで返してください。
求人紹介メール(job_intro)の場合は、本文に載っている求人を1件も落とさずに jobs 配列へ入れてください。
`.trim();

  const result = await structured<ExtractionResult>({
    model: EXTRACT_MODEL,
    system: SYSTEM,
    prompt,
    schema: SCHEMA as unknown as Record<string, unknown>,
    // max_tokens は「思考 + 本文」の合計に効く上限。
    // 実測で1通に求人30件入っていることがあり、JSONだけで6000トークン前後になる。
    // 既定の16000だと思考ぶんで押し出されて末尾が切れる恐れがあるため広く取る。
    // （切れると JSON.parse が落ちて extract_error に記録され、その求人は取り込めない。）
    maxTokens: 32000,
  });

  // AI が kind と jobs/scout で矛盾した組み合わせを返した場合に備えて整合を取る。
  // （スキーマで形は保証されるが、意味の整合までは保証されない。）
  const kind: EmailKind = result.kind ?? "unknown";
  return {
    kind,
    reason: result.reason ?? "",
    jobs: kind === "job_intro" ? result.jobs ?? [] : [],
    scout: kind === "scout" ? result.scout ?? null : null,
  };
}

// 「団体の種類」を表す分類軸の単一の正（Single Source of Truth）。
//
// 経緯: Notion（顧客CRM・会議DB）と Supabase（stakeholders / weekly_reports /
// strategic_todos）で分類軸が5系統バラバラに育ってしまい、系統をまたぐたびに
// 情報が落ちていた（例: 会議DBの`事業者`/`委託会社`/`銀行`をCRMでは`企業`に
// まとめる、など）。2026-07-30に会議DBの既存8分類を「正準」として統一する方針が
// 確定した。移行手順は docs/category-unification-plan.md を参照。
//
// ★重要★ このファイルの配列を編集するときは、対応するDBのCHECK制約を必ず確認する
// こと。DB側が受け付けない値をUI/APIの許可リストに足すと、書き込みが 400 で落ちる。
// どのリストがDB制約に縛られているかは各定義のコメントに書いてある。

/**
 * 正準の8分類。Notion会議DB`種別`の既存8分類がそのまま正準。
 * 新しく「団体の種類」を書き込む場所は、原則これに合わせる。
 */
export const ORG_CATEGORIES = [
  "自治体",
  "事業者",
  "委託会社",
  "銀行",
  "議員",
  "官民連携",
  "社内",
  "その他",
] as const;

export type OrgCategory = (typeof ORG_CATEGORIES)[number];

export function isOrgCategory(v: unknown): v is OrgCategory {
  return typeof v === "string" && (ORG_CATEGORIES as readonly string[]).includes(v);
}

/**
 * 表記ゆれ・旧分類を正準8分類へ寄せる。
 *
 * 「読むときだけ」使うこと。既存データを書き換えるためのものではない
 * （weekly_reports の実データ移行は docs/category-unification-plan.md 側の手順）。
 * 正準にも別名にも当てはまらない値（`全体`/`支店`/`プロモーション`など、団体の
 * 種類ではないもの）は null を返すので、呼び出し側でそのまま扱うか除外する。
 */
const CATEGORY_ALIASES: Record<string, OrgCategory> = {
  // weekly_reports の表記ゆれ
  委託企業: "委託会社",
  // 旧・顧客CRMの4分類からの引き上げ（`企業`は事業者/委託会社/銀行の混在だが、
  // 最頻の`事業者`に寄せる。粒度は復元できないので新規書き込みでは使わないこと）
  企業: "事業者",
  法人: "事業者",
  // 表記ゆれ
  地方公共団体: "自治体",
  自治体様: "自治体",
};

export function normalizeOrgCategory(v: unknown): OrgCategory | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (isOrgCategory(s)) return s;
  return CATEGORY_ALIASES[s] ?? null;
}

// ---------------------------------------------------------------------------
// 各テーブルで使える値（DBのCHECK制約と1:1で対応させる）
// ---------------------------------------------------------------------------

/**
 * stakeholders.category。DB CHECK制約は正準8分類と一致済み
 * （2026-07-30 手順2を実行。自治体/事業者/委託会社/銀行/議員/官民連携/社内/その他）。
 *
 * 注意: 選択肢に `社内` が含まれるため、UI上は「相手先」として社内が選べる。
 * 8分類の統一を優先した結果であり、意図的。
 */
export const STAKEHOLDER_CATEGORIES = ORG_CATEGORIES;

export type StakeholderCategory = OrgCategory;

/**
 * strategic_todos.genre。DB CHECK制約は正準8分類と一致済み
 * （2026-07-30 手順3を実行）。
 *
 * 表示順とアイコン・色は app/actions/page.tsx の GENRE_ORDER / GENRE_STYLE 側で持つ。
 * ここに値を足したら、あちらにも必ず足すこと（足りないと表示が崩れる）。
 */
export const STRATEGIC_TODO_GENRES = ORG_CATEGORIES;

export type StrategicTodoGenre = OrgCategory;

/**
 * weekly_reports.category。
 *
 * 注意2点:
 *  - 表記ゆれ `委託企業` は 2026-07-30 手順1で実データ9行とも `委託会社` へ移行済み。
 *    ただしDBのCHECK制約は移行期のため `委託企業` も暫定で受け付ける状態にある
 *    （未デプロイの本番コード対策）。デプロイ後に手順1-bで締めるまで、この配列に
 *    `委託企業` を書き戻さないこと。
 *  - `全体` `支店` `プロモーション` は「団体の種類」ではなく週報の章立て。
 *    正準8分類に統合してはいけない。
 */
export const WEEKLY_REPORT_CATEGORIES = [
  "全体",
  "支店",
  "自治体",
  "事業者",
  "議員",
  "委託会社",
  "銀行",
  "プロモーション",
] as const;

export type WeeklyReportCategory = (typeof WEEKLY_REPORT_CATEGORIES)[number];

/**
 * 成果物（memory_chunks.metadata.カテゴリ）に使える値。
 * metadata は JSONB なのでDB制約は無く、正準8分類をそのまま使える。
 * `共通` は特定団体向けでない横断資料を指す、この軸だけの追加値。
 */
export const DELIVERABLE_CATEGORIES = [...ORG_CATEGORIES, "共通"] as const;

export type DeliverableCategory = (typeof DELIVERABLE_CATEGORIES)[number];

export function isDeliverableCategory(v: unknown): v is DeliverableCategory {
  return (
    typeof v === "string" &&
    (DELIVERABLE_CATEGORIES as readonly string[]).includes(v)
  );
}

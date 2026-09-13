"use client";

import IngestForm, { type IngestFormConfig } from "@/app/components/IngestForm";

// 成果物の登録。フォーム本体は app/components/IngestForm.tsx（議事録 /meetings と
// 共通）で、このファイルは「成果物バケツ（source_type: "成果物"）へ書き込むための
// 設定」だけを持つ。

// 種別。以前は相手先（社内/社外）で選択肢を分けていたが、実習書・報告書・
// 議事メモ・QA表はほぼ使われず選ぶ手間だけが増えていた（議事録は本来ここではなく
// /meetings で「会議」として登録すべきもの——lib/organizations.ts 参照）。
// 相手先によらず1本の5種類に統一する（API側 app/api/deliverables/route.ts と対で持つ）。
const DOC_TYPES = ["メモ", "実施理由書", "スライド", "提案書", "その他"] as const;

const CONFIG: IngestFormConfig = {
  heading: "成果物を登録",
  description:
    "提案書・スライド・議事メモ・インフォグラフィックを取り込み、提案エージェントの土台にします",
  apiPath: "/api/deliverables",
  docType: { label: "種別", options: DOC_TYPES, initial: "提案書" },
  // 資料名は空でも通す（ファイル名 → 「無題」へフォールバック）。本文の下に置く。
  title: {
    label: "資料名",
    placeholder: "例: 北九州市 法人請求オンラインサービス 導入提案",
    atTop: false,
  },
  date: { label: "日付" },
  fileNote:
    "※インフォグラフィックのスクショはAIが文字を起こします（3.5MBまで）。スキャン画像のPDFは文字を取り出せないことがあります。",
  text: {
    label: "テキスト（メモ・構成案・メール本文など）",
    placeholder: "ここに貼り付け（ファイルと一緒に登録できます）",
    rows: 6,
  },
  emptyChunksError: "ファイルを選ぶか、テキストを貼り付けてください",
  showMissingHint: true,
  success: {
    tail: "提案エージェントで参照されます。",
    links: [
      {
        label: "→ 提案エージェント",
        href: (org) => `/agent?org=${encodeURIComponent(org)}`,
      },
      {
        label: "→ 壁打ち",
        href: (org) => `/refine?org=${encodeURIComponent(org)}`,
      },
    ],
  },
};

export default function DeliverablesPage() {
  return <IngestForm config={CONFIG} />;
}

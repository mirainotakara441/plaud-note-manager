"use client";

import IngestForm, { type IngestFormConfig } from "@/app/components/IngestForm";

// 議事録の登録。フォーム本体は app/components/IngestForm.tsx（成果物 /deliverables と
// 共通）で、このファイルは「会議バケツ（source_type: "会議" ／
// app/api/meetings/route.ts）へ書き込むための設定」だけを持つ。
//
// これまで議事録は「成果物を登録」の種別「メモ」で代用されていたが、それだと
// 振り返りの月次「会議◯件」集計にも、団体別攻略の「会議録から関係を抽出」にも
// 反映されなかった（この2つは source_type=会議 しか見ないため）。PLAUD録音が
// あれば自動で会議バケツに入るが、録音の無い議事メモ（口頭で聞いた話、後で
// 打った要約など）を手で会議バケツへ入れる場所がこれまで無かった——このページ
// がそれを埋める。

const CONFIG: IngestFormConfig = {
  heading: "議事録を登録",
  description:
    "PLAUD録音の無い議事メモ・口頭で聞いた話を、団体別攻略・振り返り・提案エージェントに反映させます",
  apiPath: "/api/meetings",
  // タイトルは必須。日付と並べてフォーム上部に置く。
  title: {
    label: "会議のタイトル",
    placeholder: "例：課題ヒアリング、定例訪問",
    atTop: true,
    requiredError: "会議のタイトルを入力してください",
  },
  date: {
    label: "実施日",
    note: "登録した日ではなく、実際に会議があった日を入れてください（月次の集計はこの日付を使います）",
  },
  text: {
    label: "議事録の本文",
    placeholder: "話した内容・出た課題・次の一手をここに貼り付け（ファイルと一緒に登録できます）",
    rows: 8,
  },
  emptyChunksError: "ファイルを選ぶか、議事録のテキストを貼り付けてください",
  success: {
    tail: "団体別攻略のタイムライン・振り返り・提案エージェントに反映されます。",
    links: [
      {
        label: "→ 団体別攻略",
        href: (org) => `/organizations?org=${encodeURIComponent(org)}`,
      },
      {
        label: "→ 提案エージェント",
        href: (org) => `/agent?org=${encodeURIComponent(org)}`,
      },
    ],
  },
};

export default function MeetingsPage() {
  return <IngestForm config={CONFIG} />;
}

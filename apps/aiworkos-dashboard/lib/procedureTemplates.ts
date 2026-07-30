// 提出文書 壁打ちの章立てテンプレート。API(route.ts)とUI(page.tsx)の両方から参照する共有定義。
// lib/slideTemplates.ts と同じ考え方（テンプレートを1件足すだけでschema・プロンプト・
// UIラベル・バッジ色が追従する）だが、扱うのはスライドではなく「文書の章」。
//
// スライドとの違い:
//   - 1要素 = 1枚ではなく 1章。章によっては本文より「表」が主役になる
//     （スケジュール表・役割分担表・懸念Q&A表）。そのため各章に tableHint を持たせ、
//     表が要る章だけAIに表を作らせる。
//   - この種の文書は「決まっていないことを決めきる」ためのものなので、
//     埋められなかった項目は創作せず「要確認事項」として別立てで出させる（route.ts側）。
//
// 並び順について（2026-07-30 調査の結果）:
//   ローカル(`JOB/お客様向け資料/自治体`, `JOB/法人OSトライアル書類`)を調べたところ、
//   「実施要領書」という名称の現物は1件も存在せず、実務でその役割を担っていたのは
//     - 自治体向け: 「実施理由書」（稟議・首長レク・議会答弁が読み手の"論証型"。現物6件）
//     - 事業者向け: 「委託企業活用スキーム 壁打ち資料」（契約と責任分界が関心の"合意形成型"）
//   の2種類だった。よってこの2つを先頭に置き、初期選択にしている。
//   trial/rollout/pilot/operation は現物が無い一般形だが、要領書として作る場面はあるので残す。

export type ProcedureSection = {
  name: string;
  guidance: string;
  countHint: string;
  // 表が主役になる章にだけ指定する。指定があるとAIに表の作成を促す。
  tableHint?: string;
};

export type ProcedureTemplate = {
  id: string;
  label: string;
  description: string;
  // 面談（壁打ち）でAIが優先して聞くべき急所。文書の種類ごとに急所が違うため
  // テンプレート側に持たせ、route.ts の SYSTEM_PROMPT に差し込む。
  // 例: 実施理由書は「庁内で誰が反対しそうか」、要領書は「役割分担が曖昧でないか」。
  interviewFocus: string;
  sections: ProcedureSection[];
};

const 役割分担表 =
  "表を作ること。列は「作業・項目」「当社（富士フイルムシステムサービス）」「相手方」程度にし、どちらが主担当かが一目で分かるようにする";
const スケジュール表 =
  "表を作ること。列は「時期」「実施内容」「担当」程度にし、着手から完了までの並びが分かるようにする";

export const PROCEDURE_TEMPLATES: ProcedureTemplate[] = [
  {
    id: "reason-municipal",
    label: "自治体向け 実施理由書",
    description: "稟議・首長レク・議会答弁を通すための論証型。現物の実施理由書に合わせた章立て",
    interviewFocus: `- 庁内の意思決定構造: 最終的に誰が決裁するのか。その手前で誰の合意が要るのか。どの部署が反対・慎重になりそうか。
- 根拠に使える数字: 現行の工程数・件数・所要日数・職員の作業時間など、本文に書ける数字が手元にあるか。無いなら誰に聞けば出るか。
- 想定される懸念: 庁内から実際に出そうな質問・反論は何か。これは実施理由書で最も厚く書く章なので、必ず具体的に引き出す。
- 他手段との比較: 既に検討・導入されている手段があるか。それを批判せず補完関係として書くために、何を書き分ける必要があるか。
- 時期の制約: 予算・議会・年度の区切りなど、逆算の起点になる日程があるか。`,
    sections: [
      {
        name: "目的・実施趣旨",
        guidance: "この取り組みで達成したいことを冒頭で宣言する。3〜4点の箇条書きにする",
        countHint: "1章",
      },
      {
        name: "背景・現状",
        guidance:
          "人口減・職員減、紙／郵送／定額小為替を前提とした現行業務など、置かれている環境を事実として示す",
        countHint: "1章",
      },
      {
        name: "現行の業務体制",
        guidance:
          "正職員・会計年度任用職員・委託会社の分業がどうなっているかを整理する。人数が分かる場合は明記する",
        countHint: "1章",
      },
      {
        name: "現状の課題",
        guidance: "自治体側の課題と事業者側（申請する側）の課題を両建てで示す。工程数など定量で表す",
        countHint: "1章",
      },
      {
        name: "今実施する必要性",
        guidance: "なぜ今なのか。期限のある事情（制度変更・無償期間の終了など）を根拠に示す",
        countHint: "1章",
      },
      {
        name: "実施内容",
        guidance: "サービスの仕組み、委託運用時の扱い、トライアルの位置づけを説明する",
        countHint: "1〜2章",
      },
      {
        name: "本サービスを選ぶ理由",
        guidance: "他の手段との比較。競合を批判せず、補完関係・住み分けとして書くこと",
        countHint: "1章",
      },
      {
        name: "期待効果",
        guidance: "定性効果・定量効果・費用対効果・市民への影響を分けて示す",
        countHint: "1〜2章",
      },
      {
        name: "費用・スケジュール",
        guidance: "費用の考え方と、着手から運用開始までの時期・作業",
        countHint: "1章",
        tableHint: スケジュール表,
      },
      {
        name: "想定される懸念と対応",
        guidance:
          "庁内から出る懸念を先回りして潰す章。実施理由書で最も重視される。会話で出た懸念だけを扱い、創作しないこと",
        countHint: "1章",
        tableHint:
          "表を作ること。列は「想定される懸念」「対応・考え方」の2列にし、1行1論点にする",
      },
      {
        name: "先行事例",
        guidance: "他団体の導入状況。数字は会話で確認できたものだけを使い、憶測で書かないこと",
        countHint: "1章",
      },
      {
        name: "効果検証の観点",
        guidance:
          "実施中に何を測るか（オンライン化率・所要日数・職員作業時間・不備率・問い合わせ件数など）",
        countHint: "1章",
      },
    ],
  },
  {
    id: "scheme-vendor",
    label: "事業者・委託企業向け スキーム／役割分担",
    description: "契約関係と責任分界を相手方と合意するための型。委託企業活用スキーム資料に準拠",
    interviewFocus: `- 登場人物: 自治体・委託企業・当社の三者のうち、誰と誰が契約を結ぶ想定か。抜けている関係者はいないか。
- 責任分界: 個人情報の取扱い、交付・不交付の最終判断、システム運用の責任が、それぞれ誰に帰属するのか。
- お金の流れ: 費用負担と手数料が誰から誰へ動くのか。無償・有償の切り替わる点はどこか。
- 確定と想定の切り分け: すでに合意済みの事項と、まだ当社の想定にすぎない事項の境目はどこか。
- 相手方の関心: 委託企業側が最も気にしている論点は何か（責任範囲か、コストか、工数か）。`,
    sections: [
      { name: "背景・目的", guidance: "この整理を行う背景と、何を合意したいのか", countHint: "1章" },
      {
        name: "想定スキームの全体像",
        guidance: "自治体・委託企業・当社の三者の関係と、お金・情報・書面の流れを説明する",
        countHint: "1章",
      },
      {
        name: "役割分担の整理",
        guidance: "誰がどこまでを担うかを項目ごとに割り付ける。この資料の中核",
        countHint: "1章",
        tableHint:
          "表を作ること。列は「項目」「自治体」「委託企業」の3列。行は契約関係・環境／端末・個人情報の取扱い・費用負担・最終判断権限など、会話で出た論点にする",
      },
      {
        name: "主要な論点",
        guidance: "事前承諾・個人情報の取扱い・システム運用・手数料の流れ・最終判断権限など、詰めるべき論点",
        countHint: "1〜2章",
      },
      {
        name: "想定される契約書面",
        guidance: "どんな書面を、誰と誰の間で交わす想定かを整理する",
        countHint: "1章",
        tableHint: "表を作ること。列は「書面」「当事者」「位置づけ」の3列",
      },
      {
        name: "留保事項",
        guidance: "本資料は現時点の想定であり確定条件ではない旨を明示する",
        countHint: "1章",
      },
    ],
  },
  {
    id: "trial",
    label: "無償トライアル実施要領",
    description: "トライアル（お試し導入）の進め方を相手方と合意するための要領書",
    interviewFocus: `- 対象範囲: どの業務・どの部署・どれくらいの件数・いつからいつまでが対象か。逆に「対象外」はどこか。
- 実施体制と役割分担: 相手方の担当は誰か（部署・役職）。当社側は誰か。どちらが主担当の作業が曖昧なままになっていないか。
- スケジュール: 相手方の都合で動かせない日（議会・年度末・繁忙期・システム更改）はあるか。
- 手順の粒度: 現場が実際に手を動かす順番として、抜けている工程はないか。
- 決めきれていない前提: 費用負担・個人情報の取扱い・終了後のデータの扱いなど、後で揉める論点が未確定のまま残っていないか。`,
    sections: [
      {
        name: "目的・背景",
        guidance: "何のためにトライアルを行うのか、どんな背景・課題があるのかを簡潔に示す",
        countHint: "1章",
      },
      {
        name: "対象範囲",
        guidance:
          "対象となる業務・部署・件数・期間など、どこまでをトライアルの範囲とするかを明確にする。範囲外も明示する",
        countHint: "1章",
      },
      {
        name: "実施体制・役割分担",
        guidance: "当社側・相手方側それぞれの担当と、どちらが何を行うかを明確にする",
        countHint: "1章",
        tableHint: 役割分担表,
      },
      {
        name: "実施スケジュール",
        guidance: "準備・開始・実施・振り返りまでの時期と、その時点で必要な作業を並べる",
        countHint: "1章",
        tableHint: スケジュール表,
      },
      {
        name: "実施手順",
        guidance: "現場が実際に手を動かす順番。誰が・何を・どの順で行うかを番号順に書く",
        countHint: "1〜2章",
      },
      {
        name: "留意事項",
        guidance:
          "個人情報・セキュリティの取扱い、費用負担、免責、トライアル終了後のデータの扱いなど、事前に合意しておくべき事項",
        countHint: "1章",
      },
      {
        name: "評価・振り返り",
        guidance: "トライアルの成否を何で判断するか（評価の観点・確認する数字）と、振り返りの進め方",
        countHint: "1章",
      },
      {
        name: "問い合わせ窓口",
        guidance: "困ったときの連絡先と受付時間・連絡方法。不明な情報は創作せず空欄の趣旨で書く",
        countHint: "1章",
      },
    ],
  },
  {
    id: "rollout",
    label: "本格導入・運用開始 実施要領",
    description: "トライアル後の本導入・全面展開の進め方を定める要領書",
    interviewFocus: `- 切替のタイミング: いつから本番運用に切り替えるのか。従来手順との並行期間を設けるのか。
- 適用範囲: どの部署・どの業務まで広げるのか。段階展開なら、その順番と区切り。
- 職員への周知: 誰に、どの手段で、いつ伝えるのか。説明会・マニュアルの用意は誰がするのか。
- 問い合わせと障害時: 一次受けは誰か。エスカレーションの経路は決まっているか。
- 効果測定: 導入後に何を測り、誰に報告するのか。`,
    sections: [
      {
        name: "目的・適用範囲",
        guidance: "本格導入の目的と、適用する業務・部署・対象者の範囲を示す",
        countHint: "1章",
      },
      {
        name: "実施体制・役割分担",
        guidance: "運用開始後の体制。当社側・相手方側の担当と責任範囲を明確にする",
        countHint: "1章",
        tableHint: 役割分担表,
      },
      {
        name: "導入スケジュール",
        guidance: "準備・設定・移行・運用開始・定着確認までの時期と作業を並べる",
        countHint: "1章",
        tableHint: スケジュール表,
      },
      {
        name: "業務フロー・手順",
        guidance: "運用開始後の日常業務の流れ。従来の手順から変わる点を明確にする",
        countHint: "1〜2章",
      },
      {
        name: "職員向け案内・研修",
        guidance: "利用者（職員・事業者）への周知方法、説明会・マニュアルの用意と時期",
        countHint: "1章",
      },
      {
        name: "問い合わせ・障害時対応",
        guidance: "問い合わせの受付経路と一次切り分け、障害時の連絡経路・復旧までの流れ",
        countHint: "1章",
      },
      {
        name: "個人情報・セキュリティ",
        guidance: "取り扱うデータの範囲、保管・削除の扱い、遵守すべき規程",
        countHint: "1章",
      },
      {
        name: "効果測定",
        guidance: "導入効果を何で測るか（対象の数字・測定時期・報告先）",
        countHint: "1章",
      },
    ],
  },
  {
    id: "pilot",
    label: "実証事業（実証実験）実施要領",
    description: "検証したいテーマがある実証事業の進め方を定める要領書",
    interviewFocus: `- 検証したいこと: この実証で確かめたい問いは何か。仮説は何か。
- 評価指標: 何をもって「うまくいった」と判断するのか。測る手段はあるか。
- データの取り方: 誰が、いつ、どうやって記録するのか。手間が現場に寄りすぎていないか。
- 参加主体: 当社・相手方以外に巻き込む事業者・部署はあるか。その合意は取れているか。
- 期間と区切り: 中間確認をどこに置くか。終了後の報告は誰に出すのか。`,
    sections: [
      {
        name: "目的・背景",
        guidance: "実証の目的と、その背景にある課題・環境変化",
        countHint: "1章",
      },
      {
        name: "検証テーマ・検証項目",
        guidance: "この実証で何を確かめるのか。検証項目を具体的に列挙する",
        countHint: "1章",
      },
      {
        name: "対象範囲",
        guidance: "対象業務・対象者・件数・期間。範囲外も明示する",
        countHint: "1章",
      },
      {
        name: "実施体制・役割分担",
        guidance: "参加する各主体（当社・相手方・関係事業者）と、それぞれの役割",
        countHint: "1章",
        tableHint: 役割分担表,
      },
      {
        name: "スケジュール",
        guidance: "準備・実証開始・中間確認・終了・報告までの時期と作業",
        countHint: "1章",
        tableHint: スケジュール表,
      },
      {
        name: "実施方法・手順",
        guidance: "実証の進め方。データの取り方・記録の残し方まで含める",
        countHint: "1〜2章",
      },
      {
        name: "評価指標",
        guidance: "検証項目ごとに、何をもって成功と判断するか",
        countHint: "1章",
      },
      {
        name: "留意事項・問い合わせ窓口",
        guidance: "個人情報・セキュリティの取扱い、費用負担、連絡先",
        countHint: "1章",
      },
    ],
  },
  {
    id: "operation",
    label: "業務運用手順書",
    description: "日常業務の手順を現場向けにまとめる、社内・現場向けの手順書",
    interviewFocus: `- 読み手の習熟度: 誰が読むのか。初めての人でも迷わない粒度が必要か、経験者向けの要点整理でよいか。
- 手順の抜け: 実際の作業で、暗黙になっている手順・前提（権限・アカウント・書類）はないか。
- 例外処理: うまくいかない場合に現場が最初に確認すべきことは何か。どこにエスカレーションするか。
- 承認の位置: 途中に承認・確認が挟まる工程はあるか。誰が承認者か。
- 更新の責任: この手順書を今後だれが直すのか。`,
    sections: [
      { name: "目的・適用範囲", guidance: "この手順書が対象とする業務と利用者", countHint: "1章" },
      {
        name: "前提条件",
        guidance: "作業を始める前に揃っている必要があるもの（権限・アカウント・書類・環境）",
        countHint: "1章",
      },
      {
        name: "作業手順",
        guidance: "実際の操作・作業を番号順に。1手順1行で、迷いようのない粒度にする",
        countHint: "2〜3章",
      },
      {
        name: "例外・エラー時の対応",
        guidance: "うまくいかない場合に何をどう確認し、どこにエスカレーションするか",
        countHint: "1章",
      },
      {
        name: "役割分担",
        guidance: "誰がどこまでを担当するか。承認者がいる場合はその位置づけも書く",
        countHint: "1章",
        tableHint: 役割分担表,
      },
      {
        name: "関連資料・問い合わせ先",
        guidance: "参照すべき資料と、困ったときの連絡先",
        countHint: "1章",
      },
    ],
  },
];

export function findProcedureTemplate(id?: string | null): ProcedureTemplate {
  return PROCEDURE_TEMPLATES.find((t) => t.id === id) ?? PROCEDURE_TEMPLATES[0];
}

export function procedureSectionNames(template: ProcedureTemplate): string[] {
  return template.sections.map((s) => s.name);
}

const BADGE_COLORS = [
  "bg-amber-100 text-amber-700",
  "bg-sky-100 text-sky-700",
  "bg-violet-100 text-violet-700",
  "bg-emerald-100 text-emerald-700",
  "bg-rose-100 text-rose-700",
  "bg-cyan-100 text-cyan-700",
  "bg-orange-100 text-orange-700",
  "bg-lime-100 text-lime-700",
];

export function procedureSectionBadgeClass(
  template: ProcedureTemplate,
  sectionName: string
): string {
  const idx = procedureSectionNames(template).indexOf(sectionName);
  if (idx < 0) return "bg-gray-100 text-gray-700";
  return BADGE_COLORS[idx % BADGE_COLORS.length];
}

// ── 章の型と、文書としての書き出し ─────────────────────────────
// 表は「無い」ことを null ではなく空配列で表す。Anthropicの構造化出力は
// 指定した全プロパティを必須にするため、省略可能なオブジェクトを作れない。
// headers が空なら表なしとして扱う（UI・Markdown化の双方でこの規約に従う）。

export type ProcedureTable = { caption: string; headers: string[]; rows: string[][] };
export type ProcedureItem = {
  section: string;
  title: string;
  body: string[];
  table: ProcedureTable;
};

export function hasTable(table?: ProcedureTable | null): boolean {
  return !!table && Array.isArray(table.headers) && table.headers.filter(Boolean).length > 0;
}

function escapeCell(v: string): string {
  return (v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// 章一式をMarkdownの文書として書き出す。
// 画面の「全文をコピー」と、記憶層へ登録する本文（route.ts の save）で同じ関数を使い、
// 見えているものと登録されるものがずれないようにする。
export function procedureToMarkdown(
  title: string,
  items: ProcedureItem[],
  openItems: string[] = []
): string {
  const lines: string[] = [`# ${title}`, ""];
  items.forEach((item, i) => {
    lines.push(`## ${i + 1}. ${item.title}`);
    lines.push(`（${item.section}）`, "");
    (item.body ?? []).filter(Boolean).forEach((b) => lines.push(`- ${b}`));
    if (hasTable(item.table)) {
      const headers = item.table.headers.filter(Boolean);
      lines.push("");
      if (item.table.caption) lines.push(`**${item.table.caption}**`, "");
      lines.push(`| ${headers.map(escapeCell).join(" | ")} |`);
      lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
      (item.table.rows ?? []).forEach((row) => {
        const cells = headers.map((_, ci) => escapeCell(row?.[ci] ?? ""));
        lines.push(`| ${cells.join(" | ")} |`);
      });
    }
    lines.push("");
  });
  const open = openItems.filter(Boolean);
  if (open.length > 0) {
    lines.push("## 要確認事項（未確定）", "");
    open.forEach((o) => lines.push(`- [ ] ${o}`));
    lines.push("");
  }
  return lines.join("\n");
}

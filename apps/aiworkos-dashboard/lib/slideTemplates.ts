// スライド壁打ちの構成案テンプレート。API(route.ts)とUI(page.tsx)の両方から参照する共有定義。
// テンプレートを増やす場合はここに1件足すだけでよい（schema・プロンプト・UIラベル・
// バッジ色が自動的に追従する）。

export type SlideTemplateSection = {
  name: string;
  guidance: string;
  countHint: string;
};

export type SlideTemplate = {
  id: string;
  label: string;
  description: string;
  sections: SlideTemplateSection[];
};

export const SLIDE_TEMPLATES: SlideTemplate[] = [
  {
    id: "conclusion-evidence-action",
    label: "結論→根拠→アクション",
    description: "意思決定・承認を仰ぐ提案や報告に向く定番の型",
    sections: [
      {
        name: "結論",
        guidance: "最終的に伝えたい主張・お願いしたいこと（意思決定してほしい内容）を最初に明示する",
        countHint: "1〜2枚",
      },
      {
        name: "根拠",
        guidance: "その結論を裏付けるデータ・事実・比較などを積み上げる",
        countHint: "複数枚",
      },
      {
        name: "アクション",
        guidance: "相手に取ってほしい具体的な次の行動・意思決定事項で締める",
        countHint: "1枚程度",
      },
    ],
  },
  {
    id: "problem-solution",
    label: "課題→解決策→効果",
    description: "課題提起から解決策の提示に向く型（新規開拓・提案向け）",
    sections: [
      {
        name: "課題",
        guidance: "相手が直面している、あるいはまだ気づいていない課題・環境変化を明示する",
        countHint: "1〜2枚",
      },
      {
        name: "解決策",
        guidance: "その課題に対する具体的な解決策・アプローチを提示する",
        countHint: "複数枚",
      },
      {
        name: "効果",
        guidance: "解決策によって得られる効果・メリットを具体的に示す",
        countHint: "1〜2枚",
      },
      {
        name: "アクション",
        guidance: "相手に取ってほしい次の行動・意思決定事項で締める",
        countHint: "1枚程度",
      },
    ],
  },
  {
    id: "comparison",
    label: "現状→選択肢比較→推奨",
    description: "複数の選択肢を比較して意思決定を仰ぐ型",
    sections: [
      { name: "現状", guidance: "現在の状況・前提を整理する", countHint: "1枚程度" },
      {
        name: "選択肢",
        guidance: "検討している複数の選択肢を、それぞれの特徴とともに提示する",
        countHint: "複数枚（選択肢ごとに1枚以上）",
      },
      { name: "推奨", guidance: "どの選択肢を推奨するか、その理由とともに示す", countHint: "1枚" },
      {
        name: "アクション",
        guidance: "相手に取ってほしい次の行動・意思決定事項で締める",
        countHint: "1枚程度",
      },
    ],
  },
];

export function findTemplate(id?: string | null): SlideTemplate {
  return SLIDE_TEMPLATES.find((t) => t.id === id) ?? SLIDE_TEMPLATES[0];
}

export function sectionNames(template: SlideTemplate): string[] {
  return template.sections.map((s) => s.name);
}

const BADGE_COLORS = [
  "bg-amber-100 text-amber-700",
  "bg-sky-100 text-sky-700",
  "bg-violet-100 text-violet-700",
  "bg-emerald-100 text-emerald-700",
  "bg-rose-100 text-rose-700",
];

export function sectionBadgeClass(template: SlideTemplate, sectionName: string): string {
  const idx = sectionNames(template).indexOf(sectionName);
  return BADGE_COLORS[idx % BADGE_COLORS.length] ?? "bg-gray-100 text-gray-700";
}

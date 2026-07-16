"use client";

import { useEffect, useMemo, useState } from "react";

// ステークホルダーの2段階選択：カテゴリーを選ぶ → そのカテゴリーの具体名を選ぶ。
// 一覧に無い相手（新しい議員など）は「その他（直接入力）」で追加でき、
// 登録時にマスタへ反映されるので次回から選択肢に出る。

export const CATEGORIES = [
  "自治体",
  "事業者",
  "銀行",
  "議員",
  "委託会社",
  "その他",
] as const;

export type Category = (typeof CATEGORIES)[number];

const CUSTOM = "__custom__";

type Props = {
  category: Category;
  onCategoryChange: (c: Category) => void;
  name: string;
  onNameChange: (n: string) => void;
  disabled?: boolean;
};

export default function StakeholderPicker({
  category,
  onCategoryChange,
  name,
  onNameChange,
  disabled,
}: Props) {
  const [byCategory, setByCategory] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    fetch("/api/stakeholders", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setByCategory(d?.byCategory ?? {}))
      .catch(() => setByCategory({}));
  }, []);

  const names = useMemo(() => byCategory[category] ?? [], [byCategory, category]);

  // 選択中の名前が一覧に無ければ直接入力扱いにする
  useEffect(() => {
    if (name && names.length > 0 && !names.includes(name)) setCustom(true);
  }, [name, names]);

  return (
    <div className="flex flex-col gap-4 sm:flex-row">
      <div className="flex-1">
        <label className="block text-sm font-medium text-gray-600">
          カテゴリー
        </label>
        <select
          value={category}
          onChange={(e) => {
            onCategoryChange(e.target.value as Category);
            onNameChange("");
            setCustom(false);
          }}
          disabled={disabled}
          className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1">
        <label className="block text-sm font-medium text-gray-600">
          {category}名
        </label>
        {!custom ? (
          <select
            value={names.includes(name) ? name : ""}
            onChange={(e) => {
              if (e.target.value === CUSTOM) {
                setCustom(true);
                onNameChange("");
              } else {
                onNameChange(e.target.value);
              }
            }}
            disabled={disabled}
            className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
          >
            <option value="">
              {names.length > 0 ? `${category}を選んでください` : "（候補なし・直接入力へ）"}
            </option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value={CUSTOM}>その他（直接入力）</option>
          </select>
        ) : (
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              disabled={disabled}
              placeholder={category === "議員" ? "例: 辻議員" : "名前を入力"}
              className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => {
                setCustom(false);
                onNameChange("");
              }}
              disabled={disabled}
              className="shrink-0 rounded-lg border border-gray-300 px-3 text-sm text-gray-600 active:bg-gray-50"
            >
              一覧
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// 一覧に無い名前をマスタへ登録する（次回から選択肢に出す）。失敗しても致命的でない。
export async function rememberStakeholder(category: string, name: string) {
  try {
    await fetch("/api/stakeholders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, name }),
    });
  } catch {
    // 記憶できなくても登録処理は続行する
  }
}

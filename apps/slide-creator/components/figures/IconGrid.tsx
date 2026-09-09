"use client";

interface Item {
  emoji: string;
  label: string;
}

interface Props {
  items: Item[];
}

export default function IconGrid({ items }: Props) {
  return (
    <div className="grid grid-cols-3 gap-2 w-full">
      {items.slice(0, 6).map((item, i) => (
        <div
          key={i}
          className="flex flex-col items-center justify-center bg-purple-50 border border-purple-300 rounded-xl p-2 gap-1"
        >
          <span className="text-2xl">{item.emoji}</span>
          <span className="text-xs font-bold text-gray-700 text-center leading-tight">
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}

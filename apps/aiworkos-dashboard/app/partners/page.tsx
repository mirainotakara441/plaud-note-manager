"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CATEGORIES,
  CATEGORY_DESC,
  buildTree,
  careerCoverage,
  matches,
  starredLines,
  type Company,
  type CompanyWithExecutives,
  type Executive,
  type PartnerCategory,
} from "@/lib/partners";

// 協力企業の人脈DB。
//
// 目的は「誰に会えばええか」と「何を言えば刺さるか」を1画面で出すこと。
// 議員リストが名簿を辿る道具なのに対して、こちらは**相手の懐を読む道具**なので、
// 一覧に社名だけを並べても意味がない。会社を開いたら
//   賭けていること → 役員（経歴つき） → 事実 → 要注意
// の順で読めるようにしてある。
//
// ★の行を上に固めて出しているのは、いちばん見てほしいものが
// 長い備考の中に埋もれるのを防ぐため。行政処分・出典の不確かさ・
// 「送る前に一報が要る」といった話が、そこに入っている。

const C_ACCENT = "#0f766e"; // teal-700。議員リスト（indigo）と取り違えないよう別系統にする

type Payload = { companies: Company[]; executives: Executive[] };

export default function PartnersPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<PartnerCategory | null>(null);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/partners")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "取得に失敗しました");
        return d as Payload;
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "取得に失敗しました"));
  }, []);

  const tree = useMemo(
    () => (data ? buildTree(data.companies, data.executives) : []),
    [data]
  );
  const shown = useMemo(
    () => tree.filter((c) => matches(c, query) && (!category || c.category === category)),
    [tree, query, category]
  );
  const counts = useMemo(() => {
    const m = new Map<PartnerCategory, number>();
    for (const c of tree) m.set(c.category, (m.get(c.category) ?? 0) + 1);
    return m;
  }, [tree]);

  const loading = !data && !error;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-2">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">
          🤝 協力企業
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          社長・役員の経歴と、その会社が何に賭けているか。出典を辿れる形で持つ。
        </p>
      </header>

      {error && (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error}
        </div>
      )}

      {loading && (
        <div className="mt-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl border border-gray-200 bg-gray-100"
            />
          ))}
        </div>
      )}

      {data && (
        <>
          {/* 委託会社と事業者は攻め方が逆向き。混ぜて並べない */}
          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={() => setCategory(null)}
              className="rounded-xl border px-3 py-2 text-sm font-semibold transition active:opacity-70"
              style={
                category === null
                  ? { borderColor: C_ACCENT, background: C_ACCENT, color: "#fff" }
                  : { borderColor: "#e5e7eb", background: "#fff", color: "#6b7280" }
              }
            >
              すべて
              <span className="ml-1 font-normal opacity-70">{tree.length}</span>
            </button>
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(category === cat ? null : cat)}
                className="flex-1 rounded-xl border px-3 py-2 text-sm font-semibold transition active:opacity-70"
                style={
                  category === cat
                    ? { borderColor: C_ACCENT, background: C_ACCENT, color: "#fff" }
                    : { borderColor: "#e5e7eb", background: "#fff", color: "#6b7280" }
                }
              >
                {cat}
                <span className="ml-1 font-normal opacity-70">{counts.get(cat) ?? 0}</span>
              </button>
            ))}
          </div>

          {category && (
            <p className="mt-2 text-xs leading-relaxed text-gray-500">
              {CATEGORY_DESC[category]}
            </p>
          )}

          {/* 社名だけでなく役員の氏名・役職・経歴も検索対象。
              「あの元金融庁の人、どこの会社やったっけ」から辿れるようにする */}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="社名・役員名・役職・経歴・理念から探す"
            className="mt-3 w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm outline-none placeholder:text-gray-400 focus:border-teal-500"
          />

          {shown.length === 0 && (
            <p className="mt-8 text-center text-sm text-gray-400">
              該当する会社がありません。
            </p>
          )}

          <div className="mt-4 space-y-3">
            {shown.map((c) => (
              <CompanyCard
                key={c.id}
                company={c}
                open={openId === c.id}
                onToggle={() => setOpenId(openId === c.id ? null : c.id)}
              />
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function CompanyCard({
  company: c,
  open,
  onToggle,
}: {
  company: CompanyWithExecutives;
  open: boolean;
  onToggle: () => void;
}) {
  const cov = careerCoverage(c);
  const stars = starredLines(c.memo);
  const head = c.executives[0];

  return (
    <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-3.5 text-left transition active:bg-gray-50"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span
              className="inline-block rounded-md px-1.5 py-0.5 text-[0.7rem] font-semibold"
              style={{ background: "#ccfbf1", color: C_ACCENT }}
            >
              {c.category}
            </span>
            <h2 className="mt-1.5 text-base font-bold leading-snug text-gray-900">
              {c.name}
            </h2>
            {head && (
              <p className="mt-0.5 truncate text-xs text-gray-500">
                {head.title}　{head.name}
              </p>
            )}
          </div>
          <span className="shrink-0 pt-1 text-xs text-gray-400">{open ? "▲" : "▼"}</span>
        </div>

        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.7rem] text-gray-500">
          {c.listing && <span>{c.listing.split("。")[0]}</span>}
          {c.employees && <span>{c.employees.split("（")[0]}</span>}
          <span>
            役員 {cov.total}名（経歴 {cov.known}名）
          </span>
        </div>

        {/* ★の行は畳まずに出す。長い備考に埋もれると意味がない。
            ただし1行が数百字になることがあるので、閉じている間は3行で切る
            （切らないと、カード1枚で画面が埋まって一覧の用をなさない） */}
        {stars.length > 0 && (
          <ul className="mt-2 space-y-1">
            {stars.slice(0, open ? stars.length : 1).map((s, i) => (
              <li
                key={i}
                className={`rounded-lg bg-amber-50 px-2.5 py-1.5 text-[0.72rem] leading-relaxed text-amber-900${
                  open ? "" : " line-clamp-3"
                }`}
              >
                {s}
              </li>
            ))}
            {!open && stars.length > 1 && (
              <li className="pl-1 text-[0.7rem] text-amber-700">
                ほか {stars.length - 1}件の要注意
              </li>
            )}
          </ul>
        )}
      </button>

      {open && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3">
          {/* ① 何に賭けているか。ここを読まずに提案を作らない */}
          {c.values_summary && (
            <Block title="賭けていること">
              <p className="whitespace-pre-wrap text-[0.8rem] leading-relaxed text-gray-700">
                {c.values_summary}
              </p>
              {c.values_quote && (
                <blockquote className="mt-2 border-l-2 border-teal-300 pl-3 text-[0.75rem] leading-relaxed text-gray-500">
                  {c.values_quote}
                </blockquote>
              )}
              {c.values_source && <Sources raw={c.values_source} />}
            </Block>
          )}

          {/* ② 人。経歴のある人を上に置いてある（sort_order） */}
          {c.executives.length > 0 && (
            <Block title={`役員・事業部長（${c.executives.length}名）`}>
              <ul className="space-y-2.5">
                {c.executives.map((e) => (
                  <li key={e.id} className="rounded-xl bg-gray-50 px-3 py-2.5">
                    <p className="text-[0.72rem] font-semibold text-teal-700">{e.title}</p>
                    <p className="text-sm font-bold text-gray-900">
                      {e.name}
                      {e.name_kana && (
                        <span className="ml-1.5 text-[0.7rem] font-normal text-gray-400">
                          {e.name_kana}
                        </span>
                      )}
                    </p>
                    {e.career ? (
                      <p className="mt-1 whitespace-pre-wrap text-[0.75rem] leading-relaxed text-gray-600">
                        {e.career}
                      </p>
                    ) : (
                      <p className="mt-1 text-[0.72rem] text-gray-400">経歴は非公開</p>
                    )}
                    {e.memo && (
                      <p className="mt-1.5 whitespace-pre-wrap text-[0.72rem] leading-relaxed text-amber-800">
                        {e.memo}
                      </p>
                    )}
                    {e.source_url && <Sources raw={e.source_url} />}
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {/* ③ 事実 */}
          <Block title="会社の中身">
            <dl className="space-y-1.5 text-[0.78rem] leading-relaxed">
              <Row label="事業" value={c.business} />
              <Row label="本社・拠点" value={c.headquarters} />
              <Row label="資本・上場" value={c.listing} />
              <Row label="従業員" value={c.employees} />
              <Row label="売上" value={c.revenue} />
              <Row label="設立" value={c.founded} />
              <Row label="認証" value={c.certifications} />
            </dl>
            {c.website && (
              <a
                href={c.website}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-[0.75rem] font-medium text-teal-700 underline"
              >
                公式サイト
              </a>
            )}
          </Block>

          {/* ④ 備考の全文。★の行は上にも出しているが、ここで文脈ごと読める */}
          {c.memo && (
            <Block title="調べて分かったこと・要注意">
              <p className="whitespace-pre-wrap text-[0.75rem] leading-relaxed text-gray-600">
                {c.memo}
              </p>
            </Block>
          )}

          {c.as_of && (
            <p className="mt-3 text-[0.7rem] text-gray-400">
              調査時点 {c.as_of}。役員は交代するため、訪問前に最新を確認すること。
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <h3 className="mb-1.5 text-[0.72rem] font-bold tracking-wide text-gray-400">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-gray-400">{label}</dt>
      <dd className="min-w-0 flex-1 whitespace-pre-wrap text-gray-700">{value}</dd>
    </div>
  );
}

/**
 * 出典。1つの欄に「／」区切りで複数入っていることがあるので分けて出す。
 * 押せる形にしておかないと、確かめに行かれずに値だけが独り歩きする。
 */
function Sources({ raw }: { raw: string }) {
  const urls = raw
    .split(/[／\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("http"));
  if (urls.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
      {urls.map((u, i) => (
        <a
          key={u}
          href={u}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[0.7rem] text-gray-400 underline active:opacity-70"
        >
          出典{urls.length > 1 ? i + 1 : ""}
        </a>
      ))}
    </div>
  );
}

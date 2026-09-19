"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";

// 法人請求QA 外部公開版（/qa-open）の画面。
// スマホ：1カラム。検索＋カテゴリチップ＋カード（タップで展開）。
// PC（lg以上）：左に目次（カテゴリ・件名の一覧）、右に本文。
// 各QAに「修正案・質問を送る」ボタンがあり、/api/qa-open/feedback へ送る。
// データは page.tsx から渡される（lib/hojinQa/data.public.json。注意欄など社内向けの欄は含まない）。

export type PublicItem = {
  id: string;
  cat: "A" | "B" | "C" | "D";
  num: number;
  title: string;
  constraint: string | null;
  constraintLabel: string | null;
  scene: string;
  said: string | null;
  body: string;
  evidence: string;
  tags: string[];
};

export type PublicData = {
  title: string;
  generatedAt: string;
  total: number;
  counts: Record<string, number>;
  categories: Record<string, { name: string; declared: number }>;
  numbersHeading: string;
  numbers: { item: string; value: string }[];
  numbersNote: string;
  items: PublicItem[];
};

type Cat = PublicItem["cat"];
const CATS: Cat[] = ["A", "B", "C", "D"];
const CAT_SHORT: Record<Cat, string> = {
  A: "職員向けのポイント",
  B: "よくあるご懸念と回答",
  C: "議員向けのポイント",
  D: "議会での問答例",
};
const CAT_COLOR: Record<Cat, string> = {
  A: "bg-sky-100 text-sky-900",
  B: "bg-rose-100 text-rose-900",
  C: "bg-violet-100 text-violet-900",
  D: "bg-emerald-100 text-emerald-900",
};
const CAT_ON: Record<Cat, string> = {
  A: "border-sky-400 bg-sky-100 text-sky-900",
  B: "border-rose-400 bg-rose-100 text-rose-900",
  C: "border-violet-400 bg-violet-100 text-violet-900",
  D: "border-emerald-400 bg-emerald-100 text-emerald-900",
};

const BOLD = /\*\*(.+?)\*\*/g;

function inline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  let k = 0;
  const re = new RegExp(BOLD.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    parts.push(
      <strong key={k++} className="font-semibold">
        {m[1]}
      </strong>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}

function lines(text: string): ReactNode {
  return text.split("\n").map((l, i) => (
    <span key={i} className="block min-h-[1em] whitespace-pre-wrap">
      {inline(l)}
    </span>
  ));
}

/** D群の本文を「議員の問い／職員の答弁例／議員の再質問」に分けて描く */
function renderBody(item: PublicItem): ReactNode {
  if (item.cat !== "D") return <div className="text-[15px] leading-7 text-gray-800">{lines(item.body)}</div>;
  const marks = ["【議員の問い】", "【職員の答弁例】", "【議員の再質問】"];
  const blocks: { label: string; text: string }[] = [];
  let cur: { label: string; text: string } | null = null;
  for (const raw of item.body.split("\n")) {
    const l = raw.replace(/\*\*/g, "").trim();
    const mk = marks.find((x) => l === x);
    if (mk) {
      cur = { label: mk.replace(/[【】]/g, ""), text: "" };
      blocks.push(cur);
      continue;
    }
    if (cur) cur.text += (cur.text ? "\n" : "") + raw.replace(/^\s*　?/, "");
  }
  if (!blocks.length) return <div className="text-[15px] leading-7 text-gray-800">{lines(item.body)}</div>;
  return (
    <div className="space-y-3">
      {blocks.map((b, i) => {
        const giin = b.label.startsWith("議員");
        return (
          <div
            key={i}
            className={`rounded-xl border px-4 py-3 ${
              giin ? "border-emerald-200 bg-emerald-50/60" : "border-gray-200 bg-gray-50"
            }`}
          >
            <p className={`mb-1 text-xs font-semibold ${giin ? "text-emerald-800" : "text-gray-600"}`}>
              {b.label}
            </p>
            <div className="text-[15px] leading-7 text-gray-800">{lines(b.text)}</div>
          </div>
        );
      })}
    </div>
  );
}

function norm(s: string) {
  return s
    .toLowerCase()
    .replace(/[\s　、。・「」『』（）()【】\-—–…]/g, "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

export default function QaOpenClient({ data, visitorName }: { data: PublicData; visitorName: string }) {
  const [q, setQ] = useState("");
  const [cats, setCats] = useState<Set<Cat>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [fb, setFb] = useState<{ item: PublicItem | null } | null>(null);
  const [showNumbers, setShowNumbers] = useState(false);

  const nq = norm(q);
  const filtered = useMemo(() => {
    return data.items.filter((it) => {
      if (cats.size && !cats.has(it.cat)) return false;
      if (!nq) return true;
      const hay = norm([it.id, it.title, it.scene, it.said ?? "", it.body, it.tags.join(" ")].join(" "));
      return hay.includes(nq);
    });
  }, [data.items, cats, nq]);

  // PC では目次クリックで該当カードへスクロール
  useEffect(() => {
    if (!active) return;
    const el = document.getElementById(`qa-${active}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [active]);

  function toggleCat(c: Cat) {
    setCats((s) => {
      const n = new Set(s);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });
  }
  function toggleOpen(id: string) {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const byCat = useMemo(() => {
    const m: Record<Cat, PublicItem[]> = { A: [], B: [], C: [], D: [] };
    for (const it of filtered) m[it.cat].push(it);
    return m;
  }, [filtered]);

  return (
    <div className="min-h-[100dvh] bg-gray-50 text-gray-900">
      {/* ヘッダー（スマホは追従） */}
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur pt-[env(safe-area-inset-top)]">
        <div className="mx-auto max-w-6xl px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-medium tracking-widest text-indigo-600">法人請求オンラインサービス</p>
              <h1 className="truncate text-lg font-bold leading-tight lg:text-xl">想定問答集（公開版）</h1>
            </div>
            <div className="shrink-0 text-right text-[11px] leading-tight text-gray-500">
              <p>{visitorName} 様</p>
              <p>全{data.total}件</p>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="キーワードで探す（例：小為替、費用対効果、委託）"
              className="w-full rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-[15px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            />
            <button
              type="button"
              onClick={() => setFb({ item: null })}
              className="hidden shrink-0 rounded-xl border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-800 hover:bg-indigo-100 lg:block"
            >
              全体へのご意見
            </button>
          </div>
          <div className="-mx-4 mt-2 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {CATS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => toggleCat(c)}
                className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition ${
                  cats.has(c) ? CAT_ON[c] : "border-gray-300 bg-white text-gray-600"
                }`}
              >
                {c}　{CAT_SHORT[c]}
                <span className="ml-1 opacity-60">{data.counts[c] ?? 0}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowNumbers((v) => !v)}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
                showNumbers ? "border-amber-400 bg-amber-100 text-amber-900" : "border-gray-300 bg-white text-gray-600"
              }`}
            >
              主な数字
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-4 lg:flex lg:gap-6">
        {/* PC用 目次 */}
        <aside className="hidden lg:block lg:w-72 lg:shrink-0">
          <div className="sticky top-[9.5rem] max-h-[calc(100dvh-10.5rem)] overflow-y-auto rounded-2xl border border-gray-200 bg-white p-3">
            {CATS.map((c) =>
              byCat[c].length ? (
                <div key={c} className="mb-3">
                  <p className={`mb-1 rounded-md px-2 py-1 text-xs font-semibold ${CAT_COLOR[c]}`}>
                    {c}　{CAT_SHORT[c]}
                  </p>
                  <ul className="space-y-0.5">
                    {byCat[c].map((it) => (
                      <li key={it.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setOpen((s) => new Set(s).add(it.id));
                            setActive(it.id);
                          }}
                          className={`w-full rounded-md px-2 py-1 text-left text-[13px] leading-snug hover:bg-gray-100 ${
                            active === it.id ? "bg-indigo-50 text-indigo-900" : "text-gray-700"
                          }`}
                        >
                          <span className="mr-1 font-mono text-[11px] text-gray-400">{it.id}</span>
                          {it.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null
            )}
          </div>
        </aside>

        {/* 本文 */}
        <main className="min-w-0 flex-1">
          {showNumbers && (
            <section className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <h2 className="text-sm font-bold text-amber-900">{data.numbersHeading}</h2>
              <dl className="mt-2 divide-y divide-amber-200/70 text-[13px]">
                {data.numbers.map((n, i) => (
                  <div key={i} className="grid grid-cols-[7.5rem_1fr] gap-2 py-1.5 sm:grid-cols-[10rem_1fr]">
                    <dt className="font-medium text-amber-900">{inline(n.item)}</dt>
                    <dd className="text-gray-800">{inline(n.value)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {filtered.length === 0 && (
            <p className="rounded-2xl border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
              該当する項目がありません。別の言葉でお試しください。
            </p>
          )}

          <div className="space-y-3">
            {filtered.map((it) => {
              const isOpen = open.has(it.id);
              return (
                <article
                  id={`qa-${it.id}`}
                  key={it.id}
                  className="scroll-mt-[9.5rem] rounded-2xl border border-gray-200 bg-white shadow-sm"
                >
                  <button
                    type="button"
                    onClick={() => toggleOpen(it.id)}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left"
                    aria-expanded={isOpen}
                  >
                    <span className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold ${CAT_COLOR[it.cat]}`}>
                      {it.id}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold leading-snug">{it.title}</span>
                      {it.said && (
                        <span className="mt-1 block text-[13px] leading-snug text-gray-500">{it.said}</span>
                      )}
                      {it.constraintLabel && (
                        <span className="mt-1 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">
                          {it.constraintLabel}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 shrink-0 text-gray-400">{isOpen ? "−" : "＋"}</span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-gray-100 px-4 pb-4 pt-3">
                      <p className="mb-3 text-xs text-gray-500">
                        <span className="font-medium text-gray-600">場面：</span>
                        {inline(it.scene)}
                      </p>
                      {renderBody(it)}
                      {it.evidence && (
                        <details className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-[13px] text-gray-600">
                          <summary className="cursor-pointer font-medium text-gray-700">根拠</summary>
                          <div className="mt-1 leading-6">{lines(it.evidence)}</div>
                        </details>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {it.tags.map((t) => (
                          <span key={t} className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">
                            #{t}
                          </span>
                        ))}
                        <button
                          type="button"
                          onClick={() => setFb({ item: it })}
                          className="ml-auto rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-800 hover:bg-indigo-100"
                        >
                          ✎ 修正案・質問を送る
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>

          <footer className="mt-8 space-y-2 pb-8 text-center text-[11px] text-gray-400">
            <button
              type="button"
              onClick={() => setFb({ item: null })}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-600 lg:hidden"
            >
              全体へのご意見を送る
            </button>
            <p>
              本問答集は説明用の参考資料です。自治体名・個人名は伏せています。
              数値は作成時点のもので、変更されることがあります。
            </p>
          </footer>
        </main>
      </div>

      {fb && <FeedbackModal item={fb.item} onClose={() => setFb(null)} />}
    </div>
  );
}

function FeedbackModal({ item, onClose }: { item: PublicItem | null; onClose: () => void }) {
  const [kind, setKind] = useState<"修正案" | "質問" | "その他">("修正案");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    if (busy) return;
    setErr(null);
    if (msg.trim().length < 2) return setErr("内容を入力してください");
    setBusy(true);
    try {
      const r = await fetch("/api/qa-open/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item?.id ?? null, kind, message: msg }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setErr((d && d.error) || "送信に失敗しました");
        return;
      }
      setDone(true);
    } catch {
      setErr("通信エラーが発生しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold">
              {item ? `${item.id} へのご意見` : "問答集全体へのご意見"}
            </h2>
            {item && <p className="mt-0.5 text-xs text-gray-500">{item.title}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-gray-400 hover:bg-gray-100" aria-label="閉じる">
            ×
          </button>
        </div>

        {done ? (
          <div className="mt-4 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">
            送信しました。ありがとうございます。担当者が確認のうえ、必要に応じてご連絡いたします。
            <div className="mt-3 text-right">
              <button type="button" onClick={onClose} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white">
                閉じる
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-3 flex gap-2">
              {(["修正案", "質問", "その他"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${
                    kind === k ? "border-indigo-400 bg-indigo-100 text-indigo-900" : "border-gray-300 text-gray-600"
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
            <textarea
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              rows={6}
              placeholder={
                item
                  ? "この回答について、修正したほうがよい点、追加すべき観点、疑問点などをご記入ください"
                  : "問答集全体について、ご意見・ご質問をご記入ください"
              }
              className="mt-3 w-full rounded-xl border border-gray-300 px-3 py-2 text-[15px] outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            />
            {err && <p className="mt-2 text-sm text-rose-700">{err}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void send()}
                disabled={busy}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
              >
                {busy ? "送信中…" : "送信する"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

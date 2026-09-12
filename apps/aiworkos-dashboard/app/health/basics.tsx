"use client";

import { useEffect, useMemo, useState } from "react";

// 健康の基礎データ。薬・検査値・方針を置き、聞けば答える。
//
// ■ よく聞かれるものはAIを通さない
//   「薬は？」「HbA1cは？」がいちばん多い。ここをAIに要約させると
//   用量や数値が丸まる余地が残るので、DBの行をそのまま表で出す。
//   AIを使うのは、表に無いことを聞かれたときだけ。
//
// ■ 開いたときは畳んでおく
//   /health は日々の推移を見に来る画面で、基礎データは「変わったときだけ
//   見るもの」。常時開いていると、毎日見たいグラフが下へ押し出される。

type Med = {
  kind: string;
  category: string | null;
  name: string;
  dose: string | null;
  purpose: string | null;
  note: string | null;
  started_on: string | null;
  ended_on: string | null;
  /** その薬が一般にどういうものか。未取得なら null（開いたときに調べる）。 */
  efficacy: string | null;
};
type Lab = {
  measured_on: string;
  item: string;
  value: number | null;
  value_text: string | null;
  unit: string | null;
  category: string | null;
  flag: string | null;
  note: string | null;
};
type Section = { key: string; title: string; body: string };
type Payload = { medications: Med[]; labs: Lab[]; sections: Section[] };

type Tab = "薬" | "検査値" | "そのほか";
const TABS: Tab[] = ["薬", "検査値", "そのほか"];

const C = "#0e7490"; // cyan-700。日々のグラフと違う系統にして、別物だと分かるようにする

/** よく聞かれるものを1タップで。自分で打つより速い。 */
const PRESETS = [
  "いま飲んでいる薬は？",
  "HbA1cの推移は？",
  "眼圧は？",
  "次の受診はいつ？",
  "肝機能の数値は？",
  "サプリは何を飲んでる？",
];

export function HealthBasics() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("薬");

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<{
    answer: string;
    found: boolean;
    sources: string[];
  } | null>(null);
  const [askErr, setAskErr] = useState<string | null>(null);

  /** 効能を開いている薬の名前。1つずつ開く（並べると長くなりすぎる）。 */
  const [openMed, setOpenMed] = useState<string | null>(null);
  /** 調べ終えた効能。DBにも保存するが、画面でも持って再取得を避ける。 */
  const [efficacy, setEfficacy] = useState<Record<string, string>>({});
  const [efficacyBusy, setEfficacyBusy] = useState<string | null>(null);
  const [efficacyErr, setEfficacyErr] = useState<Record<string, string>>({});

  /**
   * 薬の行を押したときの動き。
   * 既に台帳へ保存されていれば即座に開く。無ければその場で調べて保存する。
   * 「クリックすれば分かる」ようにしたいので、別のボタンを押させない。
   */
  async function toggleMed(m: Med) {
    if (openMed === m.name) {
      setOpenMed(null);
      return;
    }
    setOpenMed(m.name);
    if (m.efficacy || efficacy[m.name] || efficacyBusy === m.name) return;

    setEfficacyBusy(m.name);
    setEfficacyErr((p) => ({ ...p, [m.name]: "" }));
    try {
      const res = await fetch("/api/health/profile/efficacy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: m.name, dose: m.dose, category: m.category }),
      });
      const d = await res.json();
      if (!res.ok || d?.error) throw new Error(d?.error ?? "調べられませんでした");
      setEfficacy((p) => ({ ...p, [m.name]: d.efficacy }));
    } catch (e) {
      setEfficacyErr((p) => ({
        ...p,
        [m.name]: e instanceof Error ? e.message : "調べられませんでした",
      }));
    } finally {
      setEfficacyBusy(null);
    }
  }

  // 開くまで取りに行かない。基礎データは毎回見るものではない。
  useEffect(() => {
    if (!open || data) return;
    fetch("/api/health/profile", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "取得に失敗しました");
        return d as Payload;
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "取得に失敗しました"));
  }, [open, data]);

  async function ask(q: string) {
    const text = q.trim();
    if (text === "") return;
    setAsking(true);
    setAskErr(null);
    setAnswer(null);
    try {
      const res = await fetch("/api/health/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      const d = await res.json();
      if (!res.ok || d?.error) throw new Error(d?.error ?? "答えられませんでした");
      setAnswer(d);
    } catch (e) {
      setAskErr(e instanceof Error ? e.message : "答えられませんでした");
    } finally {
      setAsking(false);
    }
  }

  // 検査値は項目ごとに束ねる。HbA1cの推移をひと目で追えるようにするため。
  const labsByItem = useMemo(() => {
    const m = new Map<string, Lab[]>();
    for (const l of data?.labs ?? []) {
      m.set(l.item, [...(m.get(l.item) ?? []), l]);
    }
    // 各項目は古い順（推移として読むため）。項目の並びは最新が新しいもの順。
    for (const list of m.values()) list.sort((a, b) => a.measured_on.localeCompare(b.measured_on));
    return [...m.entries()].sort((a, b) => {
      const la = a[1][a[1].length - 1].measured_on;
      const lb = b[1][b[1].length - 1].measured_on;
      return lb.localeCompare(la);
    });
  }, [data]);

  const medsByKind = useMemo(() => {
    const order = ["継続処方", "頓用・臨時", "サプリ", "完了"];
    const m = new Map<string, Med[]>();
    for (const x of data?.medications ?? []) m.set(x.kind, [...(m.get(x.kind) ?? []), x]);
    return order.filter((k) => m.has(k)).map((k) => [k, m.get(k)!] as const);
  }, [data]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span>
          <span className="text-sm font-bold text-gray-900">🗂 基礎データ</span>
          <span className="mt-0.5 block text-xs text-gray-500">
            薬・検査値・受診予定・管理方針。聞けば答えます
          </span>
        </span>
        <span className="text-gray-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-3">
          {error && (
            <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
          )}

          {/* ── 聞く ────────────────────────────── */}
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
            <div className="flex gap-2">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") ask(question);
                }}
                placeholder="薬は？ 眼圧は？ 次の受診は？"
                className="min-h-[2.5rem] flex-1 rounded-lg border border-gray-300 bg-white px-3 text-sm outline-none placeholder:text-gray-400 focus:border-cyan-500"
              />
              <button
                type="button"
                onClick={() => ask(question)}
                disabled={asking || question.trim() === ""}
                className="rounded-lg px-3 text-sm font-bold text-white transition active:opacity-70 disabled:opacity-40"
                style={{ background: C }}
              >
                {asking ? "…" : "聞く"}
              </button>
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setQuestion(p);
                    ask(p);
                  }}
                  disabled={asking}
                  className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[0.7rem] text-gray-600 transition active:opacity-70 disabled:opacity-40"
                >
                  {p}
                </button>
              ))}
            </div>

            {askErr && <p className="mt-2 text-xs text-rose-700">{askErr}</p>}

            {answer && (
              <div
                className="mt-2 rounded-lg border bg-white p-3"
                style={{ borderColor: answer.found ? "#a5f3fc" : "#fde68a" }}
              >
                <p className="whitespace-pre-wrap text-[0.82rem] leading-relaxed text-gray-800">
                  {answer.answer}
                </p>
                {/* どこを見て答えたかを必ず出す。健康の数字は出どころが辿れないと使えない */}
                {answer.sources.length > 0 && (
                  <p className="mt-1.5 text-[0.68rem] text-gray-400">
                    根拠：{answer.sources.join("／")}
                  </p>
                )}
                {!answer.found && (
                  <p className="mt-1.5 text-[0.68rem] text-amber-700">
                    基礎データに入っていない項目です。診療記録やお薬手帳で確かめてください。
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ── 一覧 ────────────────────────────── */}
          <div className="mt-3 flex gap-1.5">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className="rounded-lg border px-3 py-1.5 text-xs font-semibold transition active:opacity-70"
                style={
                  tab === t
                    ? { borderColor: C, background: C, color: "#fff" }
                    : { borderColor: "#e5e7eb", background: "#fff", color: "#6b7280" }
                }
              >
                {t}
              </button>
            ))}
          </div>

          {!data && !error && (
            <div className="mt-3 space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-gray-100" />
              ))}
            </div>
          )}

          {data && tab === "薬" && (
            <div className="mt-3 space-y-3">
              {medsByKind.map(([kind, list]) => (
                <div key={kind}>
                  <h4 className="mb-1 text-[0.72rem] font-bold text-gray-500">
                    {kind}（{list.length}）
                  </h4>
                  <div className="overflow-hidden rounded-lg border border-gray-200">
                    {list.map((m, i) => {
                      const shown = openMed === m.name;
                      const text = m.efficacy ?? efficacy[m.name] ?? null;
                      return (
                        <div
                          key={m.name + i}
                          className={i > 0 ? "border-t border-gray-100" : ""}
                        >
                          {/* 行そのものを押せるようにする。別のボタンを探させない */}
                          <button
                            type="button"
                            onClick={() => toggleMed(m)}
                            className={`w-full px-2.5 py-1.5 text-left text-[0.78rem] transition active:bg-gray-50 ${
                              kind === "完了" ? "text-gray-400" : "text-gray-800"
                            }`}
                          >
                            <div className="flex flex-wrap items-baseline gap-x-2">
                              {m.category && (
                                <span className="text-[0.68rem] text-gray-400">{m.category}</span>
                              )}
                              <span className="font-bold">{m.name}</span>
                              {m.dose && <span className="text-gray-600">{m.dose}</span>}
                              <span className="ml-auto text-[0.66rem] text-gray-400">
                                {efficacyBusy === m.name ? "調べています…" : shown ? "閉じる" : "効能"}
                              </span>
                            </div>
                            {(m.purpose || m.note || m.ended_on) && (
                              <p className="mt-0.5 text-[0.7rem] leading-relaxed text-gray-500">
                                {m.purpose}
                                {m.ended_on && `（${m.started_on ?? ""}〜${m.ended_on}で終了）`}
                                {m.note && (
                                  <span className={m.note.startsWith("★") ? "text-amber-700" : ""}>
                                    {m.purpose ? " / " : ""}
                                    {m.note}
                                  </span>
                                )}
                              </p>
                            )}
                          </button>

                          {shown && (
                            <div className="border-t border-gray-100 bg-cyan-50/40 px-2.5 py-2">
                              {efficacyBusy === m.name && (
                                <p className="text-[0.72rem] text-gray-500">調べています…</p>
                              )}
                              {efficacyErr[m.name] && (
                                <p className="text-[0.72rem] text-rose-700">
                                  {efficacyErr[m.name]}
                                </p>
                              )}
                              {text && (
                                <p className="whitespace-pre-wrap text-[0.74rem] leading-relaxed text-gray-700">
                                  {text}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {data && tab === "検査値" && (
            <div className="mt-3 space-y-2">
              {labsByItem.map(([item, list]) => (
                <div key={item} className="rounded-lg border border-gray-200 px-2.5 py-1.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[0.78rem] font-bold text-gray-800">{item}</span>
                    {list[list.length - 1].category && (
                      <span className="text-[0.68rem] text-gray-400">
                        {list[list.length - 1].category}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                    {list.map((l, i) => (
                      <span
                        key={i}
                        className={`text-[0.74rem] tabular-nums ${
                          i === list.length - 1 ? "font-bold text-gray-900" : "text-gray-500"
                        }`}
                      >
                        {l.measured_on.slice(2).replaceAll("-", "/")}{" "}
                        {l.value != null ? `${l.value}${l.unit ?? ""}` : l.value_text}
                        {l.flag && (
                          <span className="ml-0.5 text-[0.66rem] text-amber-700">［{l.flag}］</span>
                        )}
                      </span>
                    ))}
                  </div>
                  {list[list.length - 1].note && (
                    <p className="mt-0.5 text-[0.68rem] leading-relaxed text-gray-400">
                      {list[list.length - 1].note}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {data && tab === "そのほか" && (
            <div className="mt-3 space-y-3">
              {data.sections.map((s) => (
                <div key={s.key}>
                  <h4 className="mb-1 text-[0.75rem] font-bold" style={{ color: C }}>
                    {s.title}
                  </h4>
                  <p className="whitespace-pre-wrap rounded-lg bg-gray-50 px-2.5 py-2 text-[0.76rem] leading-relaxed text-gray-700">
                    {s.body}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

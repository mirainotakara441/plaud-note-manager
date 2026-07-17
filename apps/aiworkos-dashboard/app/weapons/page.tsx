"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

// 武器生成。パイプラインの最後：収集 → 登録 → 壁打ちで深める → 施策案の決定 → 【武器を出す】
// /agent から「武器にする →」で遷移すると、打ち手が引き継がれて選択肢に並ぶ。

type Weapon = {
  story: { scene: string; talk: string }[];
  qa: { question: string; answer: string }[];
  slides: { title: string; bullets: string[] }[];
};

type Tab = "story" | "qa" | "slides";

const TAB_LABEL: Record<Tab, string> = {
  story: "想定ストーリー",
  qa: "想定問答",
  slides: "スライド構成案",
};

// 3種類を1リクエストで作るとVercelの60秒上限を超えるため、順番に呼んで順次埋める。
const ORDER: Tab[] = ["story", "qa", "slides"];

function WeaponsInner() {
  const searchParams = useSearchParams();
  const presetOrg = searchParams.get("org") ?? "";

  const [organizations, setOrganizations] = useState<string[]>([]);
  const [organization, setOrganization] = useState(presetOrg);
  // /agent から引き継いだ打ち手の候補
  const [candidates, setCandidates] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [weapon, setWeapon] = useState<Partial<Weapon>>({});
  const [meta, setMeta] = useState<{
    organization: string;
    title: string;
    deliverablesCount: number;
    commonDocsCount: number;
    meetingsCount: number;
  } | null>(null);
  const [tab, setTab] = useState<Tab>("story");
  const [loading, setLoading] = useState(false);
  // いま何を作っているか。順番に埋まるので進捗が見える。
  const [building, setBuilding] = useState<Tab | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  useEffect(() => {
    fetch("/api/organizations", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setOrganizations(Array.isArray(d?.organizations) ? d.organizations : []))
      .catch(() => {});
  }, []);

  // /agent から渡された打ち手を候補に載せる
  useEffect(() => {
    const raw = searchParams.get("actions");
    if (!raw) return;
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) setCandidates(list.filter((x) => typeof x === "string"));
    } catch {
      // 引き継ぎに失敗しても手入力で進められる
    }
  }, [searchParams]);

  const selectedActions = useCallback(() => {
    const picked = candidates.filter((c) => chosen[c]);
    const extra = custom.trim();
    return extra ? [...picked, extra] : picked;
  }, [candidates, chosen, custom]);

  async function generate() {
    const actions = selectedActions();
    if (!organization.trim()) return setError("対象を選んでください");
    if (actions.length === 0) return setError("武器にする打ち手を1つ以上選んでください");
    setError(null);
    setQueued(false);
    setLoading(true);
    setWeapon({});
    setTab("story");

    // 種類ごとに順番に生成する。1つ失敗しても、できたところまでは残す。
    for (const kind of ORDER) {
      setBuilding(kind);
      try {
        const r = await fetch("/api/weapons", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organization: organization.trim(), actions, note, kind }),
        });
        const d = await r.json();
        if (!r.ok) {
          setError(`${TAB_LABEL[kind]}の生成に失敗しました: ${d?.error ?? ""}`);
          break;
        }
        setWeapon((prev) => ({ ...prev, ...d.part }));
        setMeta({
          organization: d.organization,
          title: d.title,
          deliverablesCount: d.deliverablesCount,
          commonDocsCount: d.commonDocsCount,
          meetingsCount: d.meetingsCount,
        });
      } catch {
        setError(`${TAB_LABEL[kind]}の生成中に通信エラーが発生しました`);
        break;
      }
    }
    setBuilding(null);
    setLoading(false);
  }

  // スライドの .pptx 清書は Mac の Claude Code が担う。ここでは注文を積むだけ。
  async function orderPptx() {
    if (!meta || !weapon.slides) return;
    setError(null);
    try {
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "slides",
          params: {
            organization: meta.organization,
            title: meta.title,
            slides: weapon.slides,
          },
        }),
      });
      if (!r.ok) {
        const d = await r.json();
        return setError(d?.error ?? "起票に失敗しました");
      }
      setQueued(true);
    } catch {
      setError("通信エラーが発生しました");
    }
  }

  const actions = selectedActions();

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">武器を出す</h1>
        <p className="mt-1 text-sm text-gray-500">
          決めた打ち手を、現場でそのまま使える想定ストーリー・想定問答・スライド構成案にします
        </p>
      </header>

      <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div>
          <label className="block text-sm font-medium text-gray-600">対象</label>
          <select
            value={organization}
            onChange={(e) => setOrganization(e.target.value)}
            disabled={loading}
            className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
          >
            <option value="">対象を選んでください</option>
            {organizations.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>

        {/* 施策案の決定：どの打ち手でいくかを選ぶ */}
        {candidates.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-gray-600">
              この打ち手でいく（複数選択可）
            </label>
            <div className="mt-2 space-y-2">
              {candidates.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setChosen((p) => ({ ...p, [c]: !p[c] }))}
                  className={`flex w-full items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition ${
                    chosen[c]
                      ? "border-amber-400 bg-amber-50"
                      : "border-gray-200 bg-white active:bg-gray-50"
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs font-bold ${
                      chosen[c]
                        ? "border-amber-500 bg-amber-500 text-white"
                        : "border-gray-300 text-transparent"
                    }`}
                  >
                    ✓
                  </span>
                  <span className="text-sm leading-relaxed text-gray-800">{c}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-600">
            {candidates.length > 0 ? "打ち手を足す（任意）" : "この打ち手でいく"}
          </label>
          <textarea
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            rows={2}
            disabled={loading}
            placeholder="例: 9月に事務センターでデモを実施し、現場に「やりたい」と思わせる"
            className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
          />
          {candidates.length === 0 && (
            <p className="mt-1 text-xs text-gray-400">
              提案エージェントから「武器にする →」で来ると、打ち手が選択肢で並びます。
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-600">補足（任意）</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            disabled={loading}
            placeholder="例: 相手は新任の係長。前任との経緯は知らない前提で"
            className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
          />
        </div>

        <button
          type="button"
          onClick={generate}
          disabled={loading}
          className="w-full rounded-xl bg-amber-600 px-4 py-3 text-base font-semibold text-white transition active:bg-amber-700 disabled:opacity-40"
        >
          {building
            ? `${TAB_LABEL[building]}を作っています...`
            : loading
              ? "土台を読んでいます..."
              : "武器を出す"}
        </button>
        {loading && (
          <div className="flex justify-center gap-2">
            {ORDER.map((k) => (
              <span
                key={k}
                className={`h-1.5 w-12 rounded-full ${
                  weapon[k] ? "bg-amber-500" : building === k ? "animate-pulse bg-amber-300" : "bg-gray-200"
                }`}
              />
            ))}
          </div>
        )}
        {actions.length > 0 && !loading && (
          <p className="text-center text-xs text-gray-400">{actions.length}件の打ち手で作ります</p>
        )}
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
      </div>

      {meta && (
        <section className="mt-6 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold text-gray-900">{meta.organization}の武器</h2>
            {meta.deliverablesCount > 0 && (
              <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">
                成果物 {meta.deliverablesCount}件
              </span>
            )}
            {meta.commonDocsCount > 0 && (
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
                共通資料 {meta.commonDocsCount}件
              </span>
            )}
            {meta.meetingsCount > 0 && (
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700">
                会議 {meta.meetingsCount}件
              </span>
            )}
          </div>

          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            ✅ できた武器から順に、成果物として記憶に登録しています。次の提案・壁打ちの土台になります。
          </p>

          {/* 3種類の武器をタブで切り替える。まだ作れていないものは押せない。 */}
          <div className="flex gap-2">
            {ORDER.map((k) => {
              const n = weapon[k]?.length;
              const ready = n !== undefined;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => ready && setTab(k)}
                  disabled={!ready}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                    tab === k && ready
                      ? "bg-amber-600 text-white"
                      : "border border-gray-200 bg-white text-gray-600 active:bg-gray-50 disabled:opacity-40"
                  }`}
                >
                  {TAB_LABEL[k]}
                  {ready ? ` (${n})` : building === k ? " ..." : ""}
                </button>
              );
            })}
          </div>

          {tab === "story" && weapon.story && (
            <div className="space-y-3">
              {weapon.story.map((s, i) => (
                <div
                  key={i}
                  className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">
                      {i + 1}
                    </span>
                    <p className="text-sm font-semibold text-gray-900">{s.scene}</p>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-gray-700">
                    {s.talk}
                  </p>
                </div>
              ))}
            </div>
          )}

          {tab === "qa" && weapon.qa && (
            <div className="space-y-3">
              {weapon.qa.map((q, i) => (
                <div
                  key={i}
                  className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <p className="text-sm font-semibold leading-relaxed text-gray-900">
                    Q. {q.question}
                  </p>
                  <p className="mt-2 border-l-2 border-amber-300 pl-3 text-sm leading-relaxed whitespace-pre-wrap text-gray-700">
                    {q.answer}
                  </p>
                </div>
              ))}
            </div>
          )}

          {tab === "slides" && weapon.slides && (
            <div className="space-y-3">
              {weapon.slides.map((s, i) => (
                <div
                  key={i}
                  className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-600">
                      {i + 1}枚目
                    </span>
                    <p className="text-sm font-semibold text-gray-900">{s.title}</p>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {s.bullets.map((b, j) => (
                      <li key={j} className="flex gap-2 text-sm leading-relaxed text-gray-700">
                        <span className="text-gray-300">・</span>
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}

              <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <button
                  type="button"
                  onClick={orderPptx}
                  disabled={queued}
                  className="w-full rounded-xl bg-gray-800 px-4 py-2.5 text-base font-semibold text-white transition active:bg-gray-900 disabled:opacity-40"
                >
                  {queued ? "注文しました" : "この構成でpptxを作る（注文）"}
                </button>
                <p className="mt-2 text-xs leading-relaxed text-gray-500">
                  本物のテンプレートを当てた .pptx は Mac の Claude Code が作ります。ここでは注文を積むだけです。
                  次に Mac で「取込ジョブを処理して」と言うと清書されます。
                </p>
                {queued && (
                  <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                    ✅ 注文を積みました。ホームのジョブ一覧で状態を確認できます。
                  </p>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

export default function WeaponsPage() {
  return (
    <Suspense fallback={<main className="p-4 text-sm text-gray-500">読み込み中...</main>}>
      <WeaponsInner />
    </Suspense>
  );
}

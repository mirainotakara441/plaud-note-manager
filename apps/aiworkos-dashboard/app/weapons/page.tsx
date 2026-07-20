"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

// 武器生成。パイプラインの最後：収集 → 登録 → 壁打ちで深める → 施策案の決定 → 【武器を出す】
// /agent から「武器にする →」で遷移すると、打ち手が引き継がれて選択肢に並ぶ。

type Weapon = {
  proposal: { section: string; body: string }[];
  story: { scene: string; talk: string }[];
  qa: { question: string; answer: string }[];
  slides: { title: string; bullets: string[] }[];
};

type Tab = "proposal" | "story" | "qa" | "slides";

const TAB_LABEL: Record<Tab, string> = {
  proposal: "提案書（資料集）",
  story: "提案ストーリー",
  qa: "事前の壁打ち",
  slides: "スライド構成案",
};

// 各武器種の一言説明（武器種ピッカー用）。
const TAB_DESC: Record<Tab, string> = {
  proposal: "決まったひな形の節に沿った提案書本体",
  story: "そのまま話せる提案の流れ",
  qa: "想定される反論と切り返し・判断基準",
  slides: "そのままpptxにする1枚ずつの構成",
};

// 1リクエスト1種類（Vercel60秒上限のため）。選んだ武器種だけをこの順で作る。
const ORDER: Tab[] = ["proposal", "story", "qa", "slides"];

function WeaponsInner() {
  const searchParams = useSearchParams();
  const presetOrg = searchParams.get("org") ?? "";

  // /api/organizations は {name, count} のオブジェクト配列を返す。
  // 以前は string[] と誤解し <option>{o}</option> でオブジェクトを直接レンダーしてクラッシュしていた
  // （Objects are not valid as a React child → ページ全体が「This page couldn't load」）。
  const [organizations, setOrganizations] = useState<{ name: string; count: number }[]>([]);
  const [organization, setOrganization] = useState(presetOrg);
  // /agent から引き継いだ打ち手の候補
  const [candidates, setCandidates] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [weapon, setWeapon] = useState<Partial<Weapon>>({});
  // どの武器種を作るか。提案書・提案ストーリー・事前壁打ちを既定にし、スライドは任意。
  const [pick, setPick] = useState<Record<Tab, boolean>>({
    proposal: true,
    story: true,
    qa: true,
    slides: false,
  });
  const [meta, setMeta] = useState<{
    organization: string;
    title: string;
    deliverablesCount: number;
    commonDocsCount: number;
    meetingsCount: number;
  } | null>(null);
  const [tab, setTab] = useState<Tab>("proposal");
  const [loading, setLoading] = useState(false);
  // いま何を作っているか。順番に埋まるので進捗が見える。
  const [building, setBuilding] = useState<Tab | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 起票（スライドのpptx清書／提案書のNotion登録）の完了状態を種類ごとに持つ
  const [queued, setQueued] = useState<{ slides: boolean; proposal: boolean }>({
    slides: false,
    proposal: false,
  });

  // 提案書の手直し。生成に使った打ち手（weaponIdの再計算に必要）と、
  // 最後に記憶へ保存した内容のスナップショット（未保存の修正があるかの判定に使う）。
  const [weaponActions, setWeaponActions] = useState<string[]>([]);
  const [savedProposalSnapshot, setSavedProposalSnapshot] = useState<string>("");
  const [savingProposal, setSavingProposal] = useState(false);
  const [proposalNotice, setProposalNotice] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/organizations", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setOrganizations(Array.isArray(d?.organizations) ? d.organizations : []))
      .catch(() => {});
  }, []);

  // /agent から渡された打ち手を候補に載せる。
  // 依存は searchParams オブジェクトではなく取り出した文字列にする。searchParams は毎レンダー
  // 新しい参照になるため、これを依存にすると setCandidates → 再レンダー → 再実行の無限ループに
  // なり、モバイルの WebView がクラッシュする（「This page couldn't load」）。
  const actionsParam = searchParams.get("actions");
  useEffect(() => {
    if (!actionsParam) return;
    try {
      const list = JSON.parse(actionsParam);
      if (Array.isArray(list)) {
        setCandidates(list.filter((x): x is string => typeof x === "string"));
      }
    } catch {
      // 引き継ぎに失敗しても手入力で進められる
    }
  }, [actionsParam]);

  const selectedActions = useCallback(() => {
    const picked = candidates.filter((c) => chosen[c]);
    const extra = custom.trim();
    return extra ? [...picked, extra] : picked;
  }, [candidates, chosen, custom]);

  async function generate() {
    const actions = selectedActions();
    if (!organization.trim()) return setError("対象を選んでください");
    if (actions.length === 0) return setError("武器にする打ち手を1つ以上選んでください");
    const kinds = ORDER.filter((k) => pick[k]);
    if (kinds.length === 0) return setError("作る武器種を1つ以上選んでください");
    setError(null);
    setQueued({ slides: false, proposal: false });
    setLoading(true);
    setWeapon({});
    setTab(kinds[0]);
    setWeaponActions(actions);
    setSavedProposalSnapshot("");
    setProposalNotice(null);

    // 選んだ種類だけを順番に生成する。1つ失敗しても、できたところまでは残す。
    for (const kind of kinds) {
      setBuilding(kind);
      try {
        const r = await fetch("/api/weapons", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organization: organization.trim(), actions, note, kind }),
        });
        // 504（時間切れ）は本文がJSONでないことがある。先にr.jsonせず、失敗を切り分ける。
        if (!r.ok) {
          let reason = `HTTP ${r.status}`;
          try {
            const d = await r.json();
            if (d?.error) reason = d.error;
          } catch {
            if (r.status === 504 || r.status === 408) {
              reason = "時間切れです。もう一度お試しください（提案書は特に時間がかかります）";
            }
          }
          setError(`${TAB_LABEL[kind]}の生成に失敗しました: ${reason}`);
          break;
        }
        const d = await r.json();
        setWeapon((prev) => ({ ...prev, ...d.part }));
        // 生成直後の内容をスナップショットにする（サーバー側は生成直後に既に記憶へ保存済みなので、
        // ここではまだ何も修正されていない＝保存済み扱いにする）。
        if (kind === "proposal" && Array.isArray(d.part?.proposal)) {
          setSavedProposalSnapshot(JSON.stringify(d.part.proposal));
        }
        setMeta({
          organization: d.organization,
          title: d.title,
          deliverablesCount: d.deliverablesCount,
          commonDocsCount: d.commonDocsCount,
          meetingsCount: d.meetingsCount,
        });
      } catch {
        setError(
          `${TAB_LABEL[kind]}の生成に時間がかかり、切り替わってしまった可能性があります。もう一度お試しください。`
        );
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
      setQueued((q) => ({ ...q, slides: true }));
    } catch {
      setError("通信エラーが発生しました");
    }
  }

  // 提案書の節を直接編集する（吉井さんが中身を見て、おかしいところをその場で直す）。
  function updateProposalSection(i: number, patch: Partial<{ section: string; body: string }>) {
    setWeapon((prev) => {
      if (!prev.proposal) return prev;
      return {
        ...prev,
        proposal: prev.proposal.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
      };
    });
  }

  // 修正した提案書を記憶(Supabase)へ上書き保存する。生成時と同じ weaponId で上書きされるので、
  // 次の提案・壁打ち・他団体への横展開は「AIが最初に出した文面」ではなく「本人が直した後」を土台にする。
  async function persistProposalEdits(): Promise<boolean> {
    if (!meta || !weapon.proposal || weaponActions.length === 0) return false;
    try {
      const r = await fetch("/api/weapons/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization: meta.organization,
          actions: weaponActions,
          kind: "proposal",
          title: meta.title,
          part: { proposal: weapon.proposal },
        }),
      });
      if (!r.ok) return false;
      setSavedProposalSnapshot(JSON.stringify(weapon.proposal));
      return true;
    } catch {
      return false;
    }
  }

  async function saveProposalEdits() {
    setSavingProposal(true);
    setProposalNotice(null);
    const ok = await persistProposalEdits();
    setProposalNotice(ok ? "修正を記憶に保存しました" : "保存に失敗しました。もう一度お試しください");
    setSavingProposal(false);
  }

  // 提案書のNotion登録も、slidesと同じ「起票→ワーカー実行」方式に乗せる
  // （このアプリのNotionトークンは無効なため、実処理はMacのワーカーが担う）。
  async function orderProposalToNotion() {
    if (!meta || !weapon.proposal) return;
    setError(null);
    // 未保存の修正があれば、Notionへ送る前にまず記憶へ反映しておく（起票内容と記憶を一致させる）。
    if (proposalDirty) {
      const ok = await persistProposalEdits();
      if (!ok) setError("修正の記憶への保存に失敗しました（起票はそのまま続けます）");
    }
    try {
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "proposal",
          params: {
            organization: meta.organization,
            title: meta.title,
            proposal: weapon.proposal,
          },
        }),
      });
      if (!r.ok) {
        const d = await r.json();
        return setError(d?.error ?? "起票に失敗しました");
      }
      setQueued((q) => ({ ...q, proposal: true }));
    } catch {
      setError("通信エラーが発生しました");
    }
  }

  const actions = selectedActions();
  const proposalDirty =
    !!weapon.proposal && JSON.stringify(weapon.proposal) !== savedProposalSnapshot;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">武器を出す</h1>
        <p className="mt-1 text-sm text-gray-500">
          決めた打ち手を、ひな形に沿った提案書（資料集）・提案ストーリー・事前の壁打ち・スライド構成案にします
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
              <option key={o.name} value={o.name}>
                {o.name}（{o.count}）
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

        <div>
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-gray-600">
              作る武器種（ひな形）
            </label>
            <Link
              href="/weapons/template"
              className="text-xs font-medium text-amber-600 active:opacity-70"
            >
              提案書のひな形を編集 →
            </Link>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {ORDER.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setPick((p) => ({ ...p, [k]: !p[k] }))}
                disabled={loading}
                className={`rounded-xl border px-3 py-2 text-left transition disabled:opacity-50 ${
                  pick[k]
                    ? "border-amber-400 bg-amber-50"
                    : "border-gray-200 bg-white active:bg-gray-50"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold ${
                      pick[k]
                        ? "border-amber-500 bg-amber-500 text-white"
                        : "border-gray-300 text-transparent"
                    }`}
                  >
                    ✓
                  </span>
                  <span className="text-sm font-semibold text-gray-800">{TAB_LABEL[k]}</span>
                </span>
                <span className="mt-0.5 block pl-6 text-xs leading-snug text-gray-500">
                  {TAB_DESC[k]}
                </span>
              </button>
            ))}
          </div>
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
            {ORDER.filter((k) => pick[k]).map((k) => (
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

          {/* 作った武器種をタブで切り替える（作成中/作成済のものだけ出す）。 */}
          <div className="flex flex-wrap gap-2">
            {ORDER.filter((k) => weapon[k] !== undefined || building === k).map((k) => {
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

          {tab === "proposal" && weapon.proposal && (
            <div className="space-y-3">
              <p className="text-xs text-gray-400">
                見出し・本文は直接書き換えられます。おかしいところがあれば修正してください。
              </p>
              <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                {weapon.proposal.map((s, i) => (
                  <div
                    key={i}
                    className={`p-4 ${i > 0 ? "border-t border-gray-100" : ""}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">
                        {i + 1}
                      </span>
                      <input
                        type="text"
                        value={s.section}
                        onChange={(e) => updateProposalSection(i, { section: e.target.value })}
                        className="min-w-0 flex-1 rounded-md border border-transparent px-1.5 py-1 text-sm font-bold text-gray-900 transition focus:border-amber-300 focus:bg-amber-50 focus:outline-none"
                      />
                    </div>
                    <textarea
                      value={s.body}
                      onChange={(e) => updateProposalSection(i, { body: e.target.value })}
                      rows={4}
                      className="mt-2 block w-full resize-y rounded-lg border border-transparent px-2 py-1.5 text-sm leading-relaxed text-gray-700 transition focus:border-amber-300 focus:bg-amber-50 focus:outline-none"
                    />
                  </div>
                ))}
              </div>

              <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs leading-relaxed text-gray-500">
                    修正すると記憶（次の提案・壁打ちの土台）が古いままになります。直したら保存してください。
                  </p>
                  <button
                    type="button"
                    onClick={saveProposalEdits}
                    disabled={savingProposal || !proposalDirty}
                    className={`shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition disabled:opacity-40 ${
                      proposalDirty
                        ? "bg-amber-600 text-white active:bg-amber-700"
                        : "border border-gray-200 bg-white text-gray-400"
                    }`}
                  >
                    {savingProposal ? "保存中..." : proposalDirty ? "修正を保存" : "保存済み"}
                  </button>
                </div>
                {proposalNotice && (
                  <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                    {proposalNotice}
                  </p>
                )}
              </div>

              <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <button
                  type="button"
                  onClick={orderProposalToNotion}
                  disabled={queued.proposal}
                  className="w-full rounded-xl bg-gray-800 px-4 py-2.5 text-base font-semibold text-white transition active:bg-gray-900 disabled:opacity-40"
                >
                  {queued.proposal ? "起票しました" : "この提案書をNotionへ起票（注文）"}
                </button>
                <p className="mt-2 text-xs leading-relaxed text-gray-500">
                  Notionへの登録はMacのClaude Codeが行います。ここでは注文を積むだけです。
                  次にMacで「取込ジョブを処理して」と言うとNotionページが作られます（未保存の修正はここで自動保存されます）。
                </p>
                {queued.proposal && (
                  <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                    ✅ 注文を積みました。ホームのジョブ一覧で状態を確認できます。
                  </p>
                )}
              </div>
            </div>
          )}

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
                  disabled={queued.slides}
                  className="w-full rounded-xl bg-gray-800 px-4 py-2.5 text-base font-semibold text-white transition active:bg-gray-900 disabled:opacity-40"
                >
                  {queued.slides ? "注文しました" : "この構成でpptxを作る（注文）"}
                </button>
                <p className="mt-2 text-xs leading-relaxed text-gray-500">
                  本物のテンプレートを当てた .pptx は Mac の Claude Code が作ります。ここでは注文を積むだけです。
                  次に Mac で「取込ジョブを処理して」と言うと清書されます。
                </p>
                {queued.slides && (
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

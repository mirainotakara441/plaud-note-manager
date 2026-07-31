"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ASSEMBLY_TYPES,
  type AssemblyType,
  type HistoryEntry,
  type Legislator,
  type LegislatorNote,
  type LegislatorPayload,
  type PlanEntry,
  type UnmatchedRecord,
} from "@/lib/legislators";

// 議員リスト（人脈DB）。
//
// 吉井さんは「会派→議会」と「議会→会派」のどちらの向きでも辿りたいと言っている
// （データはどちらにも対応できる）ため、軸を切り替えるトグルを置いて
// 2階層のツリーを組み替える方式にした。
//
// 一覧 → 議員を選ぶ → 詳細（予定・履歴・手書きメモ）と画面を切り替える。
// iPhoneでもPCでも同じ縦1カラムで、幅による出し分けはしていない。
//
// 名簿の実体は notion_contacts（Notion「人脈DB」の写し）で、毎時の同期で
// 「Notionに無い行は削除」されるため、この画面から議員は追加できない。
// その旨は画面上にも案内している。
//
// 文字サイズは px 直指定を使わない（app/globals.css で root font-size を
// 画面幅に応じて上げているため、rem / Tailwind のクラスで書く）。

type View = { kind: "list" } | { kind: "detail"; id: string };
type Axis = "faction" | "assembly";

const KIND_STYLE: Record<HistoryEntry["kind"], string> = {
  週報: "bg-cyan-100 text-cyan-800",
  会議: "bg-blue-100 text-blue-800",
  日記: "bg-violet-100 text-violet-800",
  成果物: "bg-purple-100 text-purple-800",
};

function formatDate(date: string | null): string {
  if (!date) return "日付なし";
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return date;
  return `${m[1]}/${Number(m[2])}/${Number(m[3])}`;
}

// ---------------------------------------------------------------------------
// 階層の組み立て
// ---------------------------------------------------------------------------

type Group = { key: string; children: { key: string; members: Legislator[] }[]; total: number };

function assemblyOrder(name: string): number {
  const i = ASSEMBLY_TYPES.indexOf(name as AssemblyType);
  return i === -1 ? ASSEMBLY_TYPES.length : i;
}

function buildGroups(legislators: Legislator[], axis: Axis): Group[] {
  const primaryOf = (l: Legislator) => (axis === "faction" ? l.faction : l.assemblyType);
  const secondaryOf = (l: Legislator) => (axis === "faction" ? l.assemblyType : l.faction);

  const map = new Map<string, Map<string, Legislator[]>>();
  for (const l of legislators) {
    const p = primaryOf(l);
    const s = secondaryOf(l);
    if (!map.has(p)) map.set(p, new Map());
    const inner = map.get(p)!;
    if (!inner.has(s)) inner.set(s, []);
    inner.get(s)!.push(l);
  }

  const groups: Group[] = [...map.entries()].map(([key, inner]) => ({
    key,
    total: [...inner.values()].reduce((n, xs) => n + xs.length, 0),
    children: [...inner.entries()]
      .map(([ck, members]) => ({
        key: ck,
        members: [...members].sort((a, b) => a.name.localeCompare(b.name, "ja")),
      }))
      .sort((a, b) =>
        axis === "faction"
          ? assemblyOrder(a.key) - assemblyOrder(b.key)
          : a.key.localeCompare(b.key, "ja")
      ),
  }));

  return groups.sort((a, b) => {
    if (axis === "assembly") return assemblyOrder(a.key) - assemblyOrder(b.key);
    if (a.total !== b.total) return b.total - a.total;
    return a.key.localeCompare(b.key, "ja");
  });
}

// ---------------------------------------------------------------------------
// 手書きメモ
// ---------------------------------------------------------------------------

// 自動導出（週報・記憶・戦略ToDo）と混ざらないよう、手書きメモは琥珀色で区別する。
function NoteEditor({
  nameKey,
  note,
  onSave,
  onDelete,
}: {
  nameKey: string;
  note: LegislatorNote | null;
  onSave: (nameKey: string, content: string) => Promise<boolean>;
  onDelete: (nameKey: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (savedAt === null) return;
    const timer = setTimeout(() => setSavedAt(null), 3000);
    return () => clearTimeout(timer);
  }, [savedAt]);

  async function handleSave() {
    const content = draft.trim();
    if (content === "") {
      setError("メモが空です。削除する場合は「削除」を押してください。");
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await onSave(nameKey, content);
    setBusy(false);
    if (ok) {
      setEditing(false);
      setSavedAt(Date.now());
    } else {
      setError("保存に失敗しました。通信状況を確認してもう一度お試しください。");
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    const ok = await onDelete(nameKey);
    setBusy(false);
    if (ok) {
      setEditing(false);
      setDraft("");
    } else {
      setError("削除に失敗しました。");
    }
  }

  return (
    <section className="rounded-2xl border border-amber-300 bg-amber-50/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-bold text-amber-900">
          手書きメモ
        </span>
        <span className="text-xs text-amber-800">この議員について自分で書いておくこと</span>
        {savedAt !== null && (
          <span className="ml-auto text-xs font-semibold text-emerald-700">保存しました</span>
        )}
      </div>

      {editing ? (
        <div className="mt-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            maxLength={5000}
            autoFocus
            placeholder="関係性・攻め口・次の一手など"
            className="block w-full resize-y rounded-xl border border-amber-300 bg-white px-3 py-2 text-sm leading-relaxed text-gray-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={busy}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white active:opacity-70 disabled:opacity-50"
            >
              {busy ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={busy}
              className="rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-800 active:opacity-70 disabled:opacity-50"
            >
              取消
            </button>
            {note && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={busy}
                className="ml-auto text-sm font-medium text-red-600 active:opacity-70 disabled:opacity-50"
              >
                削除
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-3">
          {note ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-900">
              {note.content}
            </p>
          ) : (
            <p className="text-sm text-amber-800">まだメモはありません。</p>
          )}
          <button
            type="button"
            onClick={() => {
              setDraft(note?.content ?? "");
              setError(null);
              setEditing(true);
            }}
            className="mt-2 rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-sm font-medium text-amber-800 active:opacity-70"
          >
            {note ? "編集する" : "メモを書く"}
          </button>
          {note && (
            <p className="mt-2 text-xs text-amber-700">
              最終更新 {formatDate(note.updated_at.slice(0, 10))}
            </p>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-sm font-medium text-red-600">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 詳細
// ---------------------------------------------------------------------------

function PlanCard({ plan }: { plan: PlanEntry }) {
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-bold ${
            plan.dueDate ? "bg-rose-100 text-rose-800" : "bg-gray-100 text-gray-600"
          }`}
        >
          {plan.dueDate ? `納期 ${formatDate(plan.dueDate)}` : "納期未設定"}
        </span>
        {plan.status && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
            {plan.status}
          </span>
        )}
        {plan.targetMonth && (
          <span className="text-xs text-gray-500">対象月 {plan.targetMonth}</span>
        )}
      </div>
      <p className="mt-1.5 text-sm font-semibold leading-relaxed text-gray-900">{plan.task}</p>
      {plan.notes && (
        <p className="mt-1 text-sm leading-relaxed text-gray-600">{plan.notes}</p>
      )}
      <p className="mt-1.5 text-xs text-gray-400">突合: {plan.matchReason}</p>
    </li>
  );
}

function HistoryCard({ entry }: { entry: HistoryEntry }) {
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${KIND_STYLE[entry.kind]}`}>
          {entry.kind}
        </span>
        <span className="text-xs font-semibold text-gray-500">{formatDate(entry.date)}</span>
      </div>
      <p className="mt-1.5 text-sm font-semibold leading-relaxed text-gray-900">{entry.title}</p>
      <p className="mt-1 text-sm leading-relaxed text-gray-600">{entry.detail}</p>
      <p className="mt-1.5 text-xs text-gray-400">突合: {entry.matchReason}</p>
    </li>
  );
}

function Detail({
  legislator,
  note,
  onBack,
  onSave,
  onDelete,
}: {
  legislator: Legislator;
  note: LegislatorNote | null;
  onBack: () => void;
  onSave: (nameKey: string, content: string) => Promise<boolean>;
  onDelete: (nameKey: string) => Promise<boolean>;
}) {
  const l = legislator;
  // 本人名で当たった記録と、所属議連の名前で当たった記録は混ぜない
  const ownHistory = l.history.filter((h) => h.scope === "person");
  const groupHistory = l.history.filter((h) => h.scope === "group");
  const ownPlans = l.plans.filter((p) => p.scope === "person");
  const groupPlans = l.plans.filter((p) => p.scope === "group");
  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={onBack}
        className="text-sm font-medium text-indigo-600 active:opacity-70"
      >
        ← 議員一覧へ戻る
      </button>

      <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-bold text-gray-900">{l.name}</h2>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-bold ${
              l.role === "議員" ? "bg-indigo-100 text-indigo-800" : "bg-gray-100 text-gray-600"
            }`}
          >
            {l.role}
          </span>
          {l.status && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
              {l.status}
            </span>
          )}
          {l.flag && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              {l.flag}
            </span>
          )}
        </div>
        {l.title && <p className="mt-1.5 text-sm leading-relaxed text-gray-700">{l.title}</p>}
        <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div className="rounded-xl bg-gray-50 px-3 py-2">
            <dt className="text-xs font-bold text-gray-500">会派</dt>
            <dd className="mt-0.5 font-semibold text-gray-900">{l.faction}</dd>
          </div>
          <div className="rounded-xl bg-gray-50 px-3 py-2">
            <dt className="text-xs font-bold text-gray-500">議会（{l.assemblyType}）</dt>
            <dd className="mt-0.5 font-semibold text-gray-900">{l.assembly}</dd>
          </div>
        </dl>
        {l.memo && (
          <details className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
            <summary className="cursor-pointer text-xs font-bold text-gray-500">
              Notion「人脈DB」のメモを見る
            </summary>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
              {l.memo}
            </p>
          </details>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-bold text-gray-500">
          🗓 これから（予定） {ownPlans.length}件
        </h3>
        {ownPlans.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-300 bg-white px-3 py-4 text-sm text-gray-500">
            対応する予定の記録なし。（戦略ToDoの「議員」ジャンルに、この方の名前で紐づく行はありません）
          </p>
        ) : (
          <ul className="space-y-2">
            {ownPlans.map((p) => (
              <PlanCard key={p.id} plan={p} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-bold text-gray-500">
          🕘 これまで（履歴） {ownHistory.length}件
        </h3>
        {ownHistory.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-300 bg-white px-3 py-4 text-sm text-gray-500">
            対応する記録なし。（週報・会議・日記・成果物に、この方の名前で突合できる記述はありません）
          </p>
        ) : (
          <ul className="space-y-2">
            {ownHistory.map((h) => (
              <HistoryCard key={h.id} entry={h} />
            ))}
          </ul>
        )}
      </section>

      {(groupHistory.length > 0 || groupPlans.length > 0) && (
        <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-sm font-bold text-slate-700">
            🏛 所属議連・勉強会としての記録（参考） {groupHistory.length + groupPlans.length}件
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            本人の名前ではなく、所属している議連・勉強会の名前で拾った記録です。
            この方が主語とは限らないので、参考として分けています。
          </p>
          <ul className="mt-3 space-y-2">
            {groupPlans.map((p) => (
              <PlanCard key={p.id} plan={p} />
            ))}
            {groupHistory.map((h) => (
              <HistoryCard key={h.id} entry={h} />
            ))}
          </ul>
        </section>
      )}

      <NoteEditor nameKey={l.name} note={note} onSave={onSave} onDelete={onDelete} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export default function LegislatorsPage() {
  const [data, setData] = useState<LegislatorPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [axis, setAxis] = useState<Axis>("faction");
  const [view, setView] = useState<View>({ kind: "list" });

  useEffect(() => {
    let alive = true;
    fetch("/api/legislators", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((d: LegislatorPayload) => {
        if (alive) setData(d);
      })
      .catch(() => {
        if (alive) setError("議員リストの取得に失敗しました。");
      });
    return () => {
      alive = false;
    };
  }, []);

  const groups = useMemo(
    () => (data ? buildGroups(data.legislators, axis) : []),
    [data, axis]
  );

  const noteOf = useCallback(
    (name: string): LegislatorNote | null =>
      data?.notes.find((n) => n.name_key === name) ?? null,
    [data]
  );

  const saveNote = useCallback(async (nameKey: string, content: string) => {
    const res = await fetch("/api/legislators/notes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name_key: nameKey, content }),
    }).catch(() => null);
    if (!res || !res.ok) return false;
    const body = (await res.json().catch(() => null)) as { note?: LegislatorNote } | null;
    const note = body?.note;
    if (!note) return false;
    setData((prev) =>
      prev
        ? {
            ...prev,
            notes: [...prev.notes.filter((n) => n.name_key !== nameKey), note],
          }
        : prev
    );
    return true;
  }, []);

  const deleteNote = useCallback(async (nameKey: string) => {
    const res = await fetch(
      `/api/legislators/notes?name=${encodeURIComponent(nameKey)}`,
      { method: "DELETE" }
    ).catch(() => null);
    if (!res || !res.ok) return false;
    setData((prev) =>
      prev ? { ...prev, notes: prev.notes.filter((n) => n.name_key !== nameKey) } : prev
    );
    return true;
  }, []);

  const selected =
    view.kind === "detail" ? data?.legislators.find((l) => l.id === view.id) ?? null : null;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="mb-4">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
      </div>

      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">議員リスト</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-gray-500">
          会派と議会の2階層で議員を辿り、一人ひとりの「これまで（履歴）」と
          「これから（予定）」を1画面で確認します。
        </p>
      </header>

      {error && (
        <p className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {error}
        </p>
      )}

      {!data && !error && (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-2xl border border-gray-200 bg-gray-100" />
          ))}
        </div>
      )}

      {data && selected && (
        <Detail
          legislator={selected}
          note={noteOf(selected.name)}
          onBack={() => setView({ kind: "list" })}
          onSave={saveNote}
          onDelete={deleteNote}
        />
      )}

      {data && !selected && (
        <div className="space-y-6">
          <div>
            <div className="mb-3 inline-flex rounded-xl border border-gray-300 bg-white p-1">
              {(
                [
                  ["faction", "会派で見る"],
                  ["assembly", "議会で見る"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setAxis(key)}
                  className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${
                    axis === key ? "bg-indigo-600 text-white" : "text-gray-600 active:bg-gray-100"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="space-y-4">
              {groups.map((g) => (
                <section key={g.key} className="rounded-2xl border border-gray-200 bg-white shadow-sm">
                  <div className="flex items-baseline justify-between border-b border-gray-100 px-4 py-2.5">
                    <h2 className="text-base font-bold text-gray-900">{g.key}</h2>
                    <span className="text-xs font-semibold text-gray-400">{g.total}名</span>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {g.children.map((c) => (
                      <div key={c.key} className="px-4 py-2.5">
                        <p className="text-xs font-bold text-gray-400">{c.key}</p>
                        <ul className="mt-1.5 space-y-1.5">
                          {c.members.map((l) => {
                            const ownH = l.history.filter((h) => h.scope === "person").length;
                            const ownP = l.plans.filter((p) => p.scope === "person").length;
                            const grp =
                              l.history.length - ownH + (l.plans.length - ownP);
                            return (
                            <li key={l.id}>
                              <button
                                type="button"
                                onClick={() => {
                                  setView({ kind: "detail", id: l.id });
                                  window.scrollTo({ top: 0 });
                                }}
                                className="flex w-full items-center gap-3 rounded-xl border border-gray-200 px-3 py-2 text-left active:bg-gray-50"
                              >
                                <span className="min-w-0 flex-1">
                                  <span className="block text-sm font-bold text-gray-900">
                                    {l.name}
                                    {l.role === "関係者" && (
                                      <span className="ml-1.5 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-500">
                                        関係者
                                      </span>
                                    )}
                                  </span>
                                  {l.title && (
                                    <span className="mt-0.5 block truncate text-xs text-gray-500">
                                      {l.title}
                                    </span>
                                  )}
                                </span>
                                <span className="shrink-0 text-right text-xs font-semibold text-gray-400">
                                  履歴{ownH} / 予定{ownP}
                                  {grp > 0 && (
                                    <span className="block font-normal text-gray-300">
                                      議連{grp}
                                    </span>
                                  )}
                                </span>
                                <span className="shrink-0 text-gray-300" aria-hidden>
                                  →
                                </span>
                              </button>
                            </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
              {groups.length === 0 && (
                <p className="rounded-xl border border-dashed border-gray-300 bg-white px-3 py-4 text-sm text-gray-500">
                  議員として判定できる方がまだいません。
                </p>
              )}
            </div>
          </div>

          <UnmatchedSection unmatched={data.unmatched} />

          <section className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
            <p className="text-sm font-bold text-sky-900">新しい議員を追加するには</p>
            <p className="mt-1 text-sm leading-relaxed text-sky-800">
              名簿はNotion「人脈DB」の写しで、毎時同期しています。この画面からは追加できないので、
              新しい議員はNotion側に追加してください（次の同期でここに出ます）。
            </p>
          </section>

          <details className="rounded-2xl border border-gray-200 bg-white p-4">
            <summary className="cursor-pointer text-sm font-bold text-gray-600">
              このページの作り方（判定条件と突合ルール）
            </summary>
            <div className="mt-3 space-y-2 text-sm leading-relaxed text-gray-600">
              <p>
                <strong className="text-gray-800">議員の判定</strong>：人脈DBのうち、所属に
                「議会／衆議院／参議院」を含む方、または役職に「議員」を含む方。議員事務所の秘書などは
                「関係者」として区別しています。
              </p>
              <p>
                <strong className="text-gray-800">議会の種別</strong>：所属の文字列から
                衆議院／参議院／都・道・府・県議会／市・区・町・村議会を判定し、判定できないものは
                「その他」に置いています。
              </p>
              <p>
                <strong className="text-gray-800">履歴・予定の突合</strong>：週報・戦略ToDoは
                氏名／表記ゆれ／「姓＋敬称」／議連名／所属自治体名の順で照合し、
                別人の名前が書かれている記録は紐付けません。会議・日記・成果物は誤爆を避けるため
                氏名・表記ゆれ・議連名のみで照合しています。各記録に「突合: 〜」として理由を
                表示しているので、違う記録が混ざっていたら教えてください。
              </p>
              <p className="text-gray-500">
                現在の突合状況：週報 {data.counts.weeklyMatched}/{data.counts.weeklyTotal} 件、
                予定 {data.counts.todoMatched}/{data.counts.todoTotal} 件、
                記憶 {data.counts.chunkMatched} 件。
              </p>
            </div>
          </details>
        </div>
      )}
    </main>
  );
}

function UnmatchedSection({ unmatched }: { unmatched: UnmatchedRecord[] }) {
  if (unmatched.length === 0) return null;
  return (
    <details className="rounded-2xl border border-gray-200 bg-white p-4">
      <summary className="cursor-pointer text-sm font-bold text-gray-600">
        どの議員にも紐付かなかった記録 {unmatched.length}件
      </summary>
      <p className="mt-2 text-xs leading-relaxed text-gray-500">
        週報・戦略ToDoに「議員」として書かれているのに、人脈DBの誰とも突合できなかった記録です。
        名簿の抜け（Notionに未登録の議員）を見つける手がかりになります。
      </p>
      <ul className="mt-3 space-y-2">
        {unmatched.map((u) => (
          <li key={u.id} className="rounded-xl border border-gray-200 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-600">
                {u.kind}
              </span>
              <span className="text-xs text-gray-500">{formatDate(u.date)}</span>
            </div>
            <p className="mt-1 text-sm font-semibold text-gray-900">{u.label}</p>
            {u.detail && <p className="mt-0.5 text-sm text-gray-600">{u.detail}</p>}
          </li>
        ))}
      </ul>
    </details>
  );
}

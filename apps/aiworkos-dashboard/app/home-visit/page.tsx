"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartTitle, StatTile } from "@/app/health/charts";
import {
  DISTRICTS,
  DIVISIONS,
  MemberState,
  VisitLog,
  VisitMember,
  ageOf,
  buildStates,
  byNeglected,
  byRoster,
  daysBetween,
  fmtDate,
  fmtDateWithYear,
  mapsRouteUrl,
  mapsSearchUrl,
  todayJst,
} from "@/lib/homeVisit";

// 家庭訪問（ライフOS側の信仰ブロック）。人ベースで見るページ。
// 1人1枚のカードを開くと、その人の訪問履歴と「次いつ行くか」がそこで完結する。
// 仕事の記録ではないので、団体・案件まわりの導線とは意図的につないでいない。

const C_VISIT = "#4a3aa7"; // 家庭訪問の色（ラーメンの橙・ファミリーの紅と混ざらない菫）
const C_MET = "#1baf7a"; // 会えた
const C_MISS = "#9aa0a6"; // 会えなかった
const C_PLAN = "#c77700"; // これからの予定

// 「しばらく会えていない」と見なす日数。3ヶ月。
const STALE_DAYS = 90;

type ApiResponse = { members: VisitMember[]; logs: VisitLog[]; error?: string };

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      {children}
    </section>
  );
}

function Chip({
  label,
  active,
  onClick,
  color = C_VISIT,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`whitespace-nowrap rounded-full px-3 py-1 text-sm font-medium transition active:scale-95 ${
        active ? "text-white" : "bg-white text-gray-600 ring-1 ring-gray-200"
      }`}
      style={active ? { backgroundColor: color } : undefined}
    >
      {label}
    </button>
  );
}

// 住所を地図で開くリンク。番地まで書かれていない住所（「埼玉県」だけ等）は
// 地図に出しても意味が無いので、その時は文字だけ出してリンクにしない。
function MapLinks({ address, compact }: { address: string | null; compact?: boolean }) {
  if (!address) return null;
  const search = mapsSearchUrl(address);
  const route = mapsRouteUrl([address]);

  if (compact) {
    return search ? (
      <a
        href={search}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="shrink-0 text-xs font-bold text-indigo-500 active:opacity-70"
      >
        🗺
      </a>
    ) : null;
  }

  return (
    <div className="rounded-xl bg-gray-50 px-3 py-2">
      <p className="text-sm leading-relaxed text-gray-700">📍 {address}</p>
      {search ? (
        <div className="mt-1.5 flex gap-3">
          <a
            href={search}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-bold text-indigo-600 active:opacity-70"
          >
            🗺 地図で見る
          </a>
          <a
            href={route ?? search}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-bold text-indigo-600 active:opacity-70"
          >
            🚶 ここへの道順
          </a>
        </div>
      ) : (
        <p className="mt-1 text-xs text-gray-400">
          番地が分からないので地図では開けません（メンバー情報を編集から足せます）
        </p>
      )}
    </div>
  );
}

const inputClass =
  "w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400";
const labelClass = "mb-1 block text-xs font-medium text-gray-500";

// 訪問1回分の入力。会えた／会えなかった／これからの予定 の3択で、
// 会えたかどうかは1タップで決まるようにしてある。
function VisitForm({
  memberId,
  editing,
  onSaved,
  onCancel,
}: {
  memberId: number;
  editing?: VisitLog | null;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [date, setDate] = useState(editing?.visit_date ?? todayJst());
  const [met, setMet] = useState<boolean | null>(editing ? editing.met : true);
  const [topics, setTopics] = useState(editing?.topics ?? "");
  const [nextAction, setNextAction] = useState(editing?.next_action ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const planning = met === null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/home-visit/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editing?.id,
          member_id: memberId,
          visit_date: date,
          met,
          topics,
          next_action: nextAction,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `保存に失敗しました（${res.status}）`);
      setTopics("");
      setNextAction("");
      setMet(true);
      setDate(todayJst());
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl bg-gray-50 p-3">
      <div className="flex gap-2">
        <label className="flex-1">
          <span className={labelClass}>日付</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={`${inputClass} bg-white`}
          />
        </label>
      </div>

      <div>
        <span className={labelClass}>結果</span>
        <div className="flex gap-1.5">
          <Chip label="◯ 会えた" active={met === true} onClick={() => setMet(true)} color={C_MET} />
          <Chip label="× 会えず" active={met === false} onClick={() => setMet(false)} color={C_MISS} />
          <Chip label="📅 これから" active={met === null} onClick={() => setMet(null)} color={C_PLAN} />
        </div>
      </div>

      <label className="block">
        <span className={labelClass}>
          {planning ? "話したいこと（メモ）" : "どんな話をしたか（トピックス）"}
        </span>
        <textarea
          value={topics}
          onChange={(e) => setTopics(e.target.value)}
          rows={3}
          placeholder={
            planning ? "例：お子さんの進路のこと" : "例：仕事の悩み、体調のこと、活動の近況"
          }
          className={`${inputClass} bg-white leading-relaxed`}
        />
      </label>

      <label className="block">
        <span className={labelClass}>次にやること（任意）</span>
        <input
          value={nextAction}
          onChange={(e) => setNextAction(e.target.value)}
          placeholder="例：来月もう一度伺う／資料を届ける"
          className={`${inputClass} bg-white`}
        />
      </label>

      {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="flex-1 rounded-xl px-4 py-2.5 text-sm font-bold text-white transition active:scale-[0.99] disabled:opacity-50"
          style={{ backgroundColor: planning ? C_PLAN : C_VISIT }}
        >
          {busy ? "保存中…" : editing ? "この記録を更新する" : planning ? "予定を入れる" : "この訪問を記録する"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2.5 text-sm text-gray-500 active:opacity-70"
          >
            やめる
          </button>
        )}
      </div>
    </div>
  );
}

type MemberDraft = {
  name: string;
  division: string;
  district: string;
  block: string;
  role: string;
  birth_date: string;
  age_manual: string;
  address: string;
  note: string;
  active: boolean;
};

function draftOf(m?: VisitMember): MemberDraft {
  return {
    name: m?.name ?? "",
    division: m?.division ?? "壮年部",
    district: m?.district ?? "",
    block: m?.block ?? "",
    role: m?.role ?? "",
    birth_date: m?.birth_date ?? "",
    age_manual: m?.age_manual != null ? String(m.age_manual) : "",
    address: m?.address ?? "",
    note: m?.note ?? "",
    active: m?.active ?? true,
  };
}

// メンバーの追加・修正。年齢は生年月日が分かっていればそこから毎回計算するので、
// 生年月日を入れた時点で手入力の年齢は使わなくなる。
function MemberForm({
  member,
  blocks,
  onSaved,
  onCancel,
}: {
  member?: VisitMember;
  blocks: string[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<MemberDraft>(() => draftOf(member));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<MemberDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = async () => {
    if (!draft.name.trim()) {
      setError("氏名を入れてください");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/home-visit/member", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: member?.id, ...draft }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `保存に失敗しました（${res.status}）`);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl bg-indigo-50/60 p-3">
      <div className="flex gap-2">
        <label className="flex-1">
          <span className={labelClass}>氏名（必須）</span>
          <input
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="例：山田 太郎"
            className={`${inputClass} bg-white`}
          />
        </label>
        <label className="w-28">
          <span className={labelClass}>部</span>
          <select
            value={draft.division}
            onChange={(e) => set({ division: e.target.value })}
            className={`${inputClass} bg-white`}
          >
            {DIVISIONS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex gap-2">
        <label className="flex-1">
          <span className={labelClass}>地区</span>
          <select
            value={draft.district}
            onChange={(e) => set({ district: e.target.value })}
            className={`${inputClass} bg-white`}
          >
            <option value="">—</option>
            {DISTRICTS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-1">
          <span className={labelClass}>ブロック</span>
          <input
            list="home-visit-blocks"
            value={draft.block}
            onChange={(e) => set({ block: e.target.value })}
            className={`${inputClass} bg-white`}
          />
          <datalist id="home-visit-blocks">
            {blocks.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </label>
      </div>

      <label className="block">
        <span className={labelClass}>役職（任意）</span>
        <input
          value={draft.role}
          onChange={(e) => set({ role: e.target.value })}
          className={`${inputClass} bg-white`}
        />
      </label>

      <div className="flex gap-2">
        <label className="flex-1">
          <span className={labelClass}>生年月日</span>
          <input
            type="date"
            value={draft.birth_date}
            onChange={(e) => set({ birth_date: e.target.value })}
            className={`${inputClass} bg-white`}
          />
        </label>
        <label className="w-28">
          <span className={labelClass}>年齢（生年月日が不明な時だけ）</span>
          <input
            inputMode="numeric"
            value={draft.age_manual}
            onChange={(e) => set({ age_manual: e.target.value })}
            disabled={draft.birth_date !== ""}
            className={`${inputClass} bg-white disabled:bg-gray-100 disabled:text-gray-400`}
          />
        </label>
      </div>

      <label className="block">
        <span className={labelClass}>住所</span>
        <input
          value={draft.address}
          onChange={(e) => set({ address: e.target.value })}
          placeholder="例：千早2-13-16"
          className={`${inputClass} bg-white`}
        />
        <span className="mt-1 block text-[0.625rem] leading-relaxed text-gray-400">
          町名から書けば地図で開けます（豊島区は「要町」「千早」だけでOK）
        </span>
      </label>

      <label className="block">
        <span className={labelClass}>備考（任意）</span>
        <input
          value={draft.note}
          onChange={(e) => set({ note: e.target.value })}
          placeholder="例：日中は不在／訪問不可"
          className={`${inputClass} bg-white`}
        />
      </label>

      {member && (
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={!draft.active}
            onChange={(e) => set({ active: !e.target.checked })}
            className="h-4 w-4"
          />
          休止中にする（一覧から外すが、訪問履歴は残す）
        </label>
      )}

      {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="flex-1 rounded-xl px-4 py-2.5 text-sm font-bold text-white transition active:scale-[0.99] disabled:opacity-50"
          style={{ backgroundColor: C_VISIT }}
        >
          {busy ? "保存中…" : member ? "この内容で更新する" : "このメンバーを追加する"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl px-4 py-2.5 text-sm text-gray-500 active:opacity-70"
        >
          やめる
        </button>
      </div>
    </div>
  );
}

function MetBadge({ met }: { met: boolean | null }) {
  if (met === null) {
    return (
      <span
        className="rounded-full px-2 py-0.5 text-xs font-bold text-white"
        style={{ backgroundColor: C_PLAN }}
      >
        予定
      </span>
    );
  }
  return (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-bold text-white"
      style={{ backgroundColor: met ? C_MET : C_MISS }}
    >
      {met ? "◯ 会えた" : "× 会えず"}
    </span>
  );
}

function LogRow({
  log,
  onChanged,
}: {
  log: VisitLog;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    const res = await fetch(`/api/home-visit/log?id=${log.id}`, { method: "DELETE" });
    setBusy(false);
    setConfirming(false);
    if (res.ok) onChanged();
  };

  if (editing) {
    return (
      <div className="border-t border-gray-100 pt-3">
        <VisitForm
          memberId={log.member_id}
          editing={log}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="border-t border-gray-100 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-gray-900">{fmtDateWithYear(log.visit_date)}</span>
        <MetBadge met={log.met} />
        <span className="ml-auto flex items-center gap-2">
          {confirming ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={remove}
                className="text-xs font-bold text-rose-600 active:opacity-70 disabled:opacity-40"
              >
                本当に消す
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="text-xs text-gray-400 active:opacity-70"
              >
                やめる
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-xs text-indigo-500 active:opacity-70"
              >
                編集
              </button>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="text-xs text-gray-300 active:opacity-70"
              >
                削除
              </button>
            </>
          )}
        </span>
      </div>
      {log.topics && (
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-gray-600">
          {log.topics}
        </p>
      )}
      {log.next_action && (
        <p
          className="mt-1.5 border-l-2 pl-2.5 text-sm leading-relaxed text-gray-700"
          style={{ borderColor: C_PLAN }}
        >
          次：{log.next_action}
        </p>
      )}
    </div>
  );
}

function MemberCard({
  state,
  blocks,
  open,
  onToggle,
  onChanged,
  today,
}: {
  state: MemberState;
  blocks: string[];
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  today: string;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const { member, logs, plans, lastVisit, daysSinceVisit } = state;

  const age = useMemo(() => ageOf(member, new Date()), [member]);
  const stale = daysSinceVisit === null || daysSinceVisit >= STALE_DAYS;
  const nextPlan = plans[0] ?? null;

  const removeMember = async () => {
    setBusy(true);
    const res = await fetch(`/api/home-visit/member?id=${member.id}`, { method: "DELETE" });
    setBusy(false);
    setConfirming(false);
    if (res.ok) onChanged();
  };

  return (
    <article
      id={`member-${member.id}`}
      className={`rounded-2xl border bg-white shadow-sm ${
        member.active ? "border-gray-200" : "border-dashed border-gray-300 opacity-70"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 p-4 text-left active:bg-gray-50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-base font-bold text-gray-900">{member.name}</span>
            <span className="text-sm font-medium text-gray-500">
              {age != null ? `${age}歳` : "年齢不明"}
            </span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
              {member.division}
            </span>
            {!member.active && (
              <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600">
                休止中
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-gray-500">
            {[member.role, member.district, member.block].filter(Boolean).join(" ・ ")}
          </p>
          {member.note && (
            <p className="mt-0.5 truncate text-xs text-amber-700">※ {member.note}</p>
          )}
        </div>

        <div className="shrink-0 text-right">
          {lastVisit ? (
            <>
              <p className="text-xs font-bold text-gray-800">
                {fmtDate(lastVisit.visit_date)} {lastVisit.met ? "◯" : "×"}
              </p>
              <p className={`text-xs ${stale ? "font-bold text-rose-600" : "text-gray-400"}`}>
                {daysSinceVisit === 0 ? "今日" : `${daysSinceVisit}日前`}
              </p>
            </>
          ) : (
            <p className="text-xs font-bold text-rose-600">未訪問</p>
          )}
          {nextPlan && (
            <p className="mt-0.5 text-xs font-bold" style={{ color: C_PLAN }}>
              📅 {fmtDate(nextPlan.visit_date)}
            </p>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3">
          <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span>
              訪問 <span className="font-bold text-gray-900">{state.visitCount}</span>回
            </span>
            <span>
              会えた <span className="font-bold text-gray-900">{state.metCount}</span>回
            </span>
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="ml-auto text-xs text-indigo-500 active:opacity-70"
            >
              {editing ? "編集をやめる" : "メンバー情報を編集"}
            </button>
          </div>

          <MapLinks address={member.address} />

          {editing ? (
            <div className="mt-3 space-y-3">
              <MemberForm
                member={member}
                blocks={blocks}
                onSaved={() => {
                  setEditing(false);
                  onChanged();
                }}
                onCancel={() => setEditing(false)}
              />
              <div className="flex items-center gap-2">
                {confirming ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={removeMember}
                      className="text-xs font-bold text-rose-600 active:opacity-70 disabled:opacity-40"
                    >
                      訪問履歴ごと本当に消す
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(false)}
                      className="text-xs text-gray-400 active:opacity-70"
                    >
                      やめる
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    className="text-xs text-gray-300 active:opacity-70"
                  >
                    このメンバーを名簿から削除
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-3">
              <VisitForm memberId={member.id} onSaved={onChanged} />
            </div>
          )}

          {plans.length > 0 && (
            <div className="mt-3">
              <h4 className="text-xs font-bold" style={{ color: C_PLAN }}>
                これからの予定
              </h4>
              {plans.map((l) => (
                <LogRow key={l.id} log={l} onChanged={onChanged} />
              ))}
            </div>
          )}

          <div className="mt-3">
            <h4 className="text-xs font-bold text-gray-500">
              訪問の記録（{logs.length}件）
            </h4>
            {logs.length === 0 ? (
              <p className="mt-2 rounded-xl bg-gray-50 px-3 py-4 text-center text-xs text-gray-400">
                まだ記録がありません
              </p>
            ) : (
              logs.map((l) => <LogRow key={l.id} log={l} onChanged={onChanged} />)
            )}
          </div>

          <p className="mt-2 text-right text-[0.625rem] text-gray-300">
            {today} 現在
          </p>
        </div>
      )}
    </article>
  );
}

export default function HomeVisitPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [district, setDistrict] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<"neglected" | "roster">("neglected");
  const [showInactive, setShowInactive] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const today = useRef(todayJst()).current;

  const load = useCallback(() => {
    fetch("/api/home-visit", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((d: ApiResponse) => {
        if (d.error) setError(d.error);
        else {
          setError(null);
          setData({ members: d.members ?? [], logs: d.logs ?? [] });
        }
      })
      .catch(() => setError("家庭訪問の記録を取得できませんでした"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const states = useMemo(
    () => (data ? buildStates(data.members, data.logs, today) : []),
    [data, today]
  );

  const blocks = useMemo(
    () => Array.from(new Set(states.map((s) => s.member.block).filter((b): b is string => !!b))),
    [states]
  );

  const stats = useMemo(() => {
    const live = states.filter((s) => s.member.active);
    const ym = today.slice(0, 7);
    const monthLogs = live.flatMap((s) => s.logs.filter((l) => l.visit_date.startsWith(ym)));
    return {
      members: live.length,
      monthVisits: monthLogs.length,
      monthMet: monthLogs.filter((l) => l.met === true).length,
      stale: live.filter((s) => s.daysSinceVisit === null || s.daysSinceVisit >= STALE_DAYS).length,
      neverVisited: live.filter((s) => s.daysSinceVisit === null).length,
    };
  }, [states, today]);

  // これからの予定は全員分を横断して日付順に並べる（今週どこを回るかを1画面で見たい）。
  const upcoming = useMemo(() => {
    const rows = states.flatMap((s) => s.plans.map((l) => ({ log: l, member: s.member })));
    return rows.sort((a, b) => (a.log.visit_date > b.log.visit_date ? 1 : -1));
  }, [states]);

  // 同じ日の予定は1本の経路にまとめて地図へ渡したいので、日付で括る。
  const upcomingByDate = useMemo(() => {
    const map = new Map<string, typeof upcoming>();
    for (const row of upcoming) {
      map.set(row.log.visit_date, [...(map.get(row.log.visit_date) ?? []), row]);
    }
    return Array.from(map.entries());
  }, [upcoming]);

  const shown = useMemo(() => {
    const q = query.trim();
    const filtered = states.filter((s) => {
      const m = s.member;
      if (!m.active && !showInactive) return false;
      if (district && m.district !== district) return false;
      if (division && m.division !== division) return false;
      if (
        q &&
        !m.name.includes(q) &&
        !(m.block ?? "").includes(q) &&
        !(m.role ?? "").includes(q) &&
        !(m.address ?? "").includes(q)
      )
        return false;
      return true;
    });
    return filtered.sort(order === "neglected" ? byNeglected : byRoster);
  }, [states, district, division, query, order, showInactive]);

  const openMember = (id: number) => {
    setOpenId(id);
    // 一覧の下の方にいる人でも、予定から辿ったらその場で開いて見えるようにする。
    // 一覧は80人以上あって移動距離が長く、smoothだと途中で止まるため即時スクロールにする。
    requestAnimationFrame(() => {
      document.getElementById(`member-${id}`)?.scrollIntoView({ block: "center" });
    });
  };

  const loading = !data && !error;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-2">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">🏠 家庭訪問</h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          いつ誰を訪ね、会えたか、どんな話をしたか。人ごとに残して、次に行く先を決める
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
              className="h-20 animate-pulse rounded-2xl border border-gray-200 bg-gray-100"
            />
          ))}
        </div>
      )}

      {data && (
        <>
          <Section>
            <ChartTitle
              color={C_VISIT}
              title="いまの状況"
              hint={`${today.slice(5, 7)}月の集計`}
            />
            <div className="flex gap-2">
              <StatTile label="人数" value={`${stats.members}`} sub="人" color={C_VISIT} />
              <StatTile label="今月" value={`${stats.monthVisits}`} sub="回訪問" />
              <StatTile label="会えた" value={`${stats.monthMet}`} sub="回" color={C_MET} />
              <StatTile
                label="ご無沙汰"
                value={`${stats.stale}`}
                sub={`人／未訪問${stats.neverVisited}`}
                color="#c2417f"
              />
            </div>
          </Section>

          <Section>
            <ChartTitle
              color={C_PLAN}
              title="これからの予定"
              hint={upcoming.length > 0 ? `${upcoming.length}件` : undefined}
            />
            {upcoming.length === 0 ? (
              <p className="rounded-xl bg-gray-50 px-3 py-4 text-center text-xs leading-relaxed text-gray-400">
                予定はまだありません。
                <br />
                下の一覧から人を開いて「📅 これから」で入れられます。
              </p>
            ) : (
              <div className="space-y-3">
                {upcomingByDate.map(([date, rows]) => {
                  const overdue = daysBetween(date, today) > 0;
                  // その日に回る先を、一覧に並んでいる順のまま1本の経路にする
                  const route = mapsRouteUrl(rows.map((r) => r.member.address));
                  return (
                    <div key={date}>
                      <div className="mb-1 flex items-baseline gap-2">
                        <span
                          className="text-xs font-bold"
                          style={{ color: overdue ? "#c2417f" : C_PLAN }}
                        >
                          {fmtDate(date)}
                        </span>
                        <span className="text-[0.625rem] text-gray-400">{rows.length}軒</span>
                        {overdue && (
                          <span className="text-[0.625rem] font-bold text-rose-600">未記録</span>
                        )}
                        {route && (
                          <a
                            href={route}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-auto text-xs font-bold text-indigo-600 active:opacity-70"
                          >
                            🚶 この日の順路
                          </a>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        {rows.map(({ log, member }) => (
                          <div
                            key={log.id}
                            className="flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2"
                          >
                            <button
                              type="button"
                              onClick={() => openMember(member.id)}
                              className="min-w-0 flex-1 text-left active:opacity-70"
                            >
                              <span className="text-sm font-bold text-gray-900">{member.name}</span>
                              {member.address && (
                                <span className="ml-2 text-xs text-gray-500">{member.address}</span>
                              )}
                              {log.topics && (
                                <span className="ml-2 text-xs text-gray-400">{log.topics}</span>
                              )}
                            </button>
                            <MapLinks address={member.address} compact />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          <div className="mt-6 space-y-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="名前・住所・ブロック・役職で絞り込む"
              className={inputClass}
            />
            <div className="flex flex-wrap gap-1.5">
              <Chip label="全地区" active={district === null} onClick={() => setDistrict(null)} />
              {DISTRICTS.map((d) => (
                <Chip
                  key={d}
                  label={d.replace("地区", "")}
                  active={district === d}
                  onClick={() => setDistrict(district === d ? null : d)}
                />
              ))}
              <span className="mx-1 w-px bg-gray-200" />
              {DIVISIONS.map((d) => (
                <Chip
                  key={d}
                  label={d}
                  active={division === d}
                  onClick={() => setDivision(division === d ? null : d)}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip
                label="ご無沙汰順"
                active={order === "neglected"}
                onClick={() => setOrder("neglected")}
              />
              <Chip label="名簿順" active={order === "roster"} onClick={() => setOrder("roster")} />
              <Chip
                label="休止中も表示"
                active={showInactive}
                onClick={() => setShowInactive((v) => !v)}
                color={C_MISS}
              />
              <span className="ml-auto text-xs text-gray-400">{shown.length}人</span>
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {shown.map((s) => (
              <MemberCard
                key={s.member.id}
                state={s}
                blocks={blocks}
                open={openId === s.member.id}
                onToggle={() => setOpenId(openId === s.member.id ? null : s.member.id)}
                onChanged={load}
                today={today}
              />
            ))}
            {shown.length === 0 && (
              <p className="rounded-2xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
                条件に合う人がいません。
              </p>
            )}
          </div>

          <div className="mt-4">
            {adding ? (
              <MemberForm
                blocks={blocks}
                onSaved={() => {
                  setAdding(false);
                  load();
                }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-gray-300 bg-white p-4 text-sm font-bold text-gray-600 shadow-sm transition active:bg-gray-50"
              >
                <span style={{ color: C_VISIT }}>＋</span> メンバーを追加する
              </button>
            )}
          </div>
        </>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホームに戻る
        </Link>
      </div>
    </main>
  );
}

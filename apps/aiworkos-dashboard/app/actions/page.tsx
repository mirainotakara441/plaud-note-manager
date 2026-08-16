"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import NotificationOptIn from "@/app/components/NotificationOptIn";
import { toJstDateString } from "@/lib/date";

// 日々のToDo：2つの由来のToDoを1画面に束ねる。
//   ① daily_actions（/api/actions）… 一行日記の「やってみよう」「本日のポイント」。
//      日付ベース・ジャンルの概念なし。
//   ② strategic_todos（/api/strategic-todos）… NotionのToDo DBと双方向で同期する
//      ジャンル別（社内／自治体／議員／事業者／委託会社）の月次営業ToDo。
//      日付は持たず target_month と created_at がある。
//      この画面での変更はライトスルーで即Notionへ流れる。逆にNotionで直接いじった分は
//      「📄 Notionから取り込み」ボタン（/api/strategic-todos/sync）で引き込む。
//      Notionへの反映に失敗した行には「Notion未反映」バッジを出す（同期状態を偽らない）。
// テーブルは統合せず、このUIレイヤーで束ねる（由来もデータ形も違うため）。
// 表示は「カテゴリー別」「時系列」の2モードを切り替えられる。

type Kind = "action" | "point";
type Item = {
  id: string;
  entry_date: string; // YYYY-MM-DD。いつの日記から来たか
  due_date: string | null; // YYYY-MM-DD / null=納期なし。entry_dateとは別物
  kind: Kind;
  content: string;
  done: boolean;
  source: "diary" | "manual";
  source_id: string | null;
};

// strategic_todos の1行（Notion「ToDo DB」のミラー）
type StrategicStatus = "未着手" | "進行中" | "完了";
type Strategic = {
  id: string;
  notion_page_id: string | null;
  task_name: string;
  genre: string;
  status: StrategicStatus;
  target_month: string | null;
  notes: string | null;
  due_date: string | null; // YYYY-MM-DD / null=納期なし。Notionの`納期`と同期する
  created_at: string;
  updated_at: string;
};

const KIND_META: Record<Kind, { label: string; icon: string; klass: string }> = {
  action: { label: "やってみよう", icon: "🎯", klass: "text-emerald-700 bg-emerald-50" },
  point: { label: "本日のポイント", icon: "📌", klass: "text-amber-700 bg-amber-50" },
};

// ジャンルの並び順と見た目。ここに無いジャンルは末尾にグレーで出す。
// strategic_todos.genre は正準8分類（lib/categories.ts の ORG_CATEGORIES）。
// ここは「表示順」を持つので、正準に値が増えたら必ずここにも足すこと。
const GENRE_ORDER = [
  "社内",
  "自治体",
  "議員",
  "事業者",
  "委託会社",
  "銀行",
  "官民連携",
  "その他",
] as const;
const GENRE_META: Record<string, { icon: string; klass: string }> = {
  社内: { icon: "🏢", klass: "text-slate-700 bg-slate-100" },
  自治体: { icon: "🏛️", klass: "text-indigo-700 bg-indigo-50" },
  議員: { icon: "🎌", klass: "text-rose-700 bg-rose-50" },
  事業者: { icon: "🤝", klass: "text-sky-700 bg-sky-50" },
  委託会社: { icon: "🔧", klass: "text-violet-700 bg-violet-50" },
  銀行: { icon: "🏦", klass: "text-amber-700 bg-amber-50" },
  官民連携: { icon: "🤲", klass: "text-teal-700 bg-teal-50" },
  その他: { icon: "📁", klass: "text-gray-600 bg-gray-100" },
};
function genreMeta(g: string) {
  return GENRE_META[g] ?? { icon: "📁", klass: "text-gray-600 bg-gray-100" };
}
function genreRank(g: string) {
  const i = (GENRE_ORDER as readonly string[]).indexOf(g);
  return i < 0 ? GENRE_ORDER.length : i;
}

type ViewMode = "category" | "timeline";
const VIEW_KEY = "aiworkos:actions:view";

const WD = ["日", "月", "火", "水", "木", "金", "土"];
function pad(x: number) {
  return String(x).padStart(2, "0");
}
function keyOf(dt: Date) {
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
function todayStr() {
  return keyOf(new Date());
}
function fmtDate(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  const wd = WD[new Date(y, m - 1, day).getDay()] ?? "";
  return `${m}/${day}（${wd}）`;
}
// ── 納期（due_date）の判定・表示 ────────────────────────────────────
// 判定は必ずJST基準で行う。端末のタイムゾーン任せにすると、時計が海外に
// 合っている端末で「今日」が1日ずれ、赤／琥珀の警告が嘘になる。
// 今日の日付は lib/date.ts の toJstDateString を流用して求める。
function jstToday(): string {
  return toJstDateString(new Date().toISOString());
}

// YYYY-MM-DD 同士の日数差（to - from）。両方をUTCの0時として解釈するため、
// 夏時間や端末タイムゾーンの影響を受けない。
function diffDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

// 納期バッジの相対表示と色。閾値は次の3段階（JST基準の日数差）:
//   diff <  0 … 期限超過   赤（rose）  「N日超過」
//   diff == 0 … 今日       琥珀（amber）「今日」
//   diff == 1 … 明日       琥珀（amber）「明日」
//   diff >= 2 … それ以降   通常（グレー）「あとN日」
// 完了済みは急かす意味がないので、超過していてもグレーに落として静かにする。
function dueMeta(due: string, done: boolean): { rel: string; klass: string; urgent: boolean } {
  const diff = diffDays(jstToday(), due);
  const rel =
    diff < 0 ? `${-diff}日超過` : diff === 0 ? "今日" : diff === 1 ? "明日" : `あと${diff}日`;
  if (done) {
    return { rel, klass: "border-gray-200 bg-gray-50 text-gray-400", urgent: false };
  }
  if (diff < 0) {
    return { rel, klass: "border-rose-300 bg-rose-50 text-rose-700 font-semibold", urgent: true };
  }
  if (diff <= 1) {
    return { rel, klass: "border-amber-300 bg-amber-50 text-amber-700 font-semibold", urgent: true };
  }
  return { rel, klass: "border-gray-200 bg-white text-gray-500", urgent: false };
}

// 並び順の共通比較関数。
//   ① 納期があるものを、納期の近い順（超過しているものが最上）で先に置く
//   ② 納期がないものは、その後ろに従来どおり登録順（created_at 昇順）で置く
// なぜ「納期あり」を上に固めるのか:
//   納期は吉井さんが自分で「この日までにやる」と宣言した唯一の締切情報で、
//   target_month（月単位）や created_at（登録した順）より意思が強い。
//   期限に追われているものを毎朝いちばん先に目に入れたいので、納期ありを優先する。
//   逆に納期なしを上に混ぜると、超過している行がスクロールの下に埋もれて警告色の
//   意味がなくなる。
function byDueThenCreated(a: Strategic, b: Strategic): number {
  const ad = a.due_date;
  const bd = b.due_date;
  if (ad && bd) {
    if (ad !== bd) return ad < bd ? -1 : 1;
  } else if (ad) return -1;
  else if (bd) return 1;
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

// その日が属する週の月曜日を返す
function weekMonday(d: string): Date {
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(y, m - 1, day);
  const dow = (dt.getDay() + 6) % 7; // 月=0 … 日=6
  dt.setDate(dt.getDate() - dow);
  dt.setHours(0, 0, 0, 0);
  return dt;
}
// 週見出しラベル（今週/先週/N週前 ＋ 範囲）
function weekLabel(mondayKey: string): string {
  const [y, m, d] = mondayKey.split("-").map(Number);
  const mon = new Date(y, m - 1, d);
  const sun = new Date(y, m - 1, d + 6);
  const thisMon = weekMonday(todayStr());
  const diff = Math.round((thisMon.getTime() - mon.getTime()) / (7 * 86400000));
  const range = `${mon.getMonth() + 1}/${mon.getDate()}〜${sun.getMonth() + 1}/${sun.getDate()}`;
  let prefix = "";
  if (diff === 0) prefix = "今週 ";
  else if (diff === 1) prefix = "先週 ";
  else if (diff > 1) prefix = `${diff}週前 `;
  else if (diff < 0) prefix = "来週 ";
  return prefix + range;
}

export default function ActionsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [strategic, setStrategic] = useState<Strategic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);

  // 表示モード（カテゴリー別／時系列）。前回選択を端末に覚えさせる。
  const [view, setView] = useState<ViewMode>("category");
  useEffect(() => {
    const saved = window.localStorage.getItem(VIEW_KEY);
    if (saved === "category" || saved === "timeline") setView(saved);
  }, []);
  function changeView(v: ViewMode) {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // プライベートブラウズ等で書けなくても表示自体は動く
    }
  }

  // 追加フォーム
  const [addDate, setAddDate] = useState(todayStr());
  const [addKind, setAddKind] = useState<Kind>("action");
  const [addText, setAddText] = useState("");
  const [adding, setAdding] = useState(false);

  // 編集中
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  // 戦略ToDoのインライン編集
  const [stEditId, setStEditId] = useState<string | null>(null);
  const [stEditName, setStEditName] = useState("");
  const [stEditNotes, setStEditNotes] = useState("");
  const [stEditGenre, setStEditGenre] = useState<string>("社内");
  const [stSaving, setStSaving] = useState(false);

  // 納期の入力（カレンダーを開いている行のid）。
  // input[type=date] を使うので、iPhoneでもPCでもOS標準のカレンダーが出る。
  const [dueEditId, setDueEditId] = useState<string | null>(null);
  // 日々のToDo（日記由来）側の納期・日付の編集。営業ToDoとは別の行なので状態も分ける。
  const [itemDueEditId, setItemDueEditId] = useState<string | null>(null);
  const [itemDueDraft, setItemDueDraft] = useState("");
  const [itemDateEditId, setItemDateEditId] = useState<string | null>(null);
  // 納期は「入力中の下書き」を別に持つ。入力のたびに保存して入力欄を閉じると、
  // iPhoneではカレンダーごと消えて日付を選べない（下の saveDue のコメント参照）。
  const [dueDraft, setDueDraft] = useState("");

  // 戦略ToDoの新規追加（ジャンルごとにインライン行を開く）
  const [stAddGenre, setStAddGenre] = useState<string | null>(null); // 追加フォームを開いているジャンル
  const [stAddText, setStAddText] = useState("");
  const [stAdding, setStAdding] = useState(false);

  // 日記からの取込
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Notionからの取込
  const [notionSyncing, setNotionSyncing] = useState(false);

  // ライトスルーでNotionへ反映できなかった行のid。
  // 同期できたと嘘をつかないため、該当行に控えめなバッジを出す。
  // 取り込み・再操作で解消したら外す。
  const [notionFailed, setNotionFailed] = useState<Set<string>>(new Set());
  function markNotion(id: string, sync: unknown) {
    setNotionFailed((prev) => {
      const next = new Set(prev);
      if (sync === "failed") next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // 一括完了
  const [bulkBusy, setBulkBusy] = useState(false);

  // daily_actions と strategic_todos を並行で取得する。
  // 戦略ToDo側だけ落ちても日々のToDoは出したいので、失敗は分けて扱う。
  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [aRes, sRes] = await Promise.all([
        fetch("/api/actions", { cache: "no-store" }),
        fetch("/api/strategic-todos", { cache: "no-store" }),
      ]);
      const aData = await aRes.json().catch(() => null);
      if (!aRes.ok) throw new Error(aData?.error ?? "取得に失敗しました");
      setItems(aData?.items ?? []);

      if (sRes.ok) {
        const sData = await sRes.json().catch(() => null);
        setStrategic(sData?.items ?? []);
      } else {
        setStrategic([]);
        setError("戦略ToDo（カテゴリー別）の取得に失敗しました");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  // 戦略ToDoの完了トグル（完了 ⇄ 未着手）。楽観的更新→失敗時はload()で戻す。
  async function toggleStrategic(t: Strategic) {
    const next: StrategicStatus = t.status === "完了" ? "未着手" : "完了";
    setStrategic((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: next } : x)));
    const res = await fetch("/api/strategic-todos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: t.id, status: next }),
    });
    if (!res.ok) {
      load();
      return;
    }
    const data = await res.json().catch(() => null);
    markNotion(t.id, data?.notionSync);
  }

  // 戦略ToDoの「進行中」トグル（未着手 ⇄ 進行中）。完了済みには効かせない。
  async function toggleStrategicProgress(t: Strategic) {
    if (t.status === "完了") return;
    const next: StrategicStatus = t.status === "進行中" ? "未着手" : "進行中";
    setStrategic((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: next } : x)));
    const res = await fetch("/api/strategic-todos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: t.id, status: next }),
    });
    if (!res.ok) {
      load();
      return;
    }
    const data = await res.json().catch(() => null);
    markNotion(t.id, data?.notionSync);
  }

  // 納期の設定／解除。value に YYYY-MM-DD を渡すと設定、null で解除。
  // 楽観的更新→失敗時は元の配列に戻す（他のインライン編集と同じ作法）。
  //
  // ここを input[type=date] の onChange から直接呼んではいけない。iPhoneの
  // 日付ピッカーは、ホイールが動いた時点（空欄なら開いた直後に今日の日付で）
  // change を飛ばしてくる。保存と同時に入力欄を閉じると、その1発目で input が
  // 消え、開いたばかりのカレンダーごと閉じてしまう——押した瞬間に閉じる、という
  // 挙動の正体がこれ。PCは日付を確定するまで change が飛ばないので再現しない。
  // 入力中は dueDraft に溜め、「決定」を押したときだけこの関数を呼ぶこと。
  async function saveDue(t: Strategic, value: string | null) {
    if (t.due_date === value) {
      setDueEditId(null);
      return;
    }
    const prev = strategic;
    setStrategic((p) => p.map((x) => (x.id === t.id ? { ...x, due_date: value } : x)));
    setDueEditId(null);
    try {
      const res = await fetch("/api/strategic-todos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: t.id, due_date: value }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "納期の更新に失敗しました");
      markNotion(t.id, data?.notionSync);
      if (data?.notionSync === "failed") {
        setNotice("納期を保存しましたが、Notion側の「納期」には反映できませんでした");
      }
    } catch (e) {
      setStrategic(prev);
      setError(e instanceof Error ? e.message : "納期の更新に失敗しました");
    }
  }

  function startStrategicEdit(t: Strategic) {
    setStEditId(t.id);
    setStEditName(t.task_name);
    setStEditNotes(t.notes ?? "");
    setStEditGenre(t.genre);
  }

  async function saveStrategicEdit() {
    if (!stEditId || stSaving) return;
    const name = stEditName.trim();
    if (!name) return;
    const id = stEditId;
    const genre = stEditGenre;
    const notes = stEditNotes;
    setStSaving(true);
    const prev = strategic;
    setStrategic((p) =>
      p.map((x) => (x.id === id ? { ...x, task_name: name, genre, notes: notes.trim() || null } : x))
    );
    setStEditId(null);
    try {
      const res = await fetch("/api/strategic-todos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, task_name: name, notes, genre }),
      });
      if (!res.ok) throw new Error("更新に失敗しました");
      const data = await res.json().catch(() => null);
      markNotion(id, data?.notionSync);
    } catch (e) {
      setStrategic(prev);
      setError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setStSaving(false);
    }
  }

  async function removeStrategic(id: string) {
    if (!window.confirm("この営業ToDoを削除します。よろしいですか？")) return;
    const prev = strategic;
    setStrategic((p) => p.filter((x) => x.id !== id));
    const res = await fetch(`/api/strategic-todos?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      setStrategic(prev);
      setError("削除に失敗しました");
      return;
    }
    const data = await res.json().catch(() => null);
    if (data?.notionSync === "failed") {
      setNotice("Supabaseから削除しました。Notion側のページはアーカイブできていません");
    }
    markNotion(id, null); // 行自体が消えるのでバッジも掃除する
  }

  async function addStrategic(genre: string) {
    const text = stAddText.trim();
    if (!text || stAdding) return;
    setStAdding(true);
    try {
      const res = await fetch("/api/strategic-todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_name: text, genre }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "追加に失敗しました");
      setStrategic((p) => [...p, data.item]);
      if (data?.item?.id) markNotion(data.item.id, data?.notionSync);
      if (data?.notionSync === "failed") {
        setNotice("追加しましたが、Notion側にはページを作成できませんでした");
      }
      setStAddText("");
      setStAddGenre(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "追加に失敗しました");
    } finally {
      setStAdding(false);
    }
  }

  async function toggleDone(it: Item) {
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)));
    const res = await fetch("/api/actions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: it.id, done: !it.done }),
    });
    if (!res.ok) load();
  }

  async function saveEdit() {
    if (!editId) return;
    const text = editText.trim();
    if (!text) return;
    const id = editId;
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, content: text } : x)));
    setEditId(null);
    const res = await fetch("/api/actions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, content: text }),
    });
    if (!res.ok) load();
  }

  // 複数件をまとめて完了にする（楽観的更新→PATCH一括、失敗時はload()でロールバック）
  async function completeMany(ids: string[]) {
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    const idSet = new Set(ids);
    setItems((prev) => prev.map((x) => (idSet.has(x.id) ? { ...x, done: true } : x)));
    try {
      const res = await fetch("/api/actions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, done: true }),
      });
      if (!res.ok) throw new Error("一括更新に失敗しました");
    } catch (e) {
      setError(e instanceof Error ? e.message : "一括更新に失敗しました");
      await load();
    } finally {
      setBulkBusy(false);
    }
  }

  function completeAll() {
    const ids = items.filter((x) => !x.done).map((x) => x.id);
    if (ids.length === 0) return;
    if (!window.confirm(`未完${ids.length}件をすべて完了にします。よろしいですか？`)) return;
    completeMany(ids);
  }

  function completeWeek(its: Item[]) {
    const ids = its.map((x) => x.id);
    if (ids.length === 0) return;
    if (!window.confirm(`この週の未完${ids.length}件を完了にします。よろしいですか？`)) return;
    completeMany(ids);
  }

  // 納期ありのToDoを、貼って使える文字列にして書き出す。
  //
  // 画面の外（メール・議事メモ・Notion）へ持ち出すためのもの。
  // 営業ToDoだけでなく日々のToDoに納期を付けたぶんも拾う。
  // 「納期あり」セクションは時系列表示にしか出ないが、書き出しはどちらの表示でも
  // 使えるようヘッダー側に置いている。
  function dueListText(): string {
    const today = jstToday();
    const rows: { due: string; genre: string; text: string }[] = [
      ...strategic
        .filter((t) => t.due_date && t.status !== "完了")
        .map((t) => ({ due: t.due_date!, genre: t.genre || "その他", text: t.task_name })),
      ...items
        .filter((it) => it.due_date && !it.done)
        .map((it) => ({ due: it.due_date!, genre: KIND_META[it.kind].label, text: it.content })),
    ].sort((a, b) => (a.due === b.due ? 0 : a.due < b.due ? -1 : 1));

    const lines = [`【納期ありToDo】${today} 時点・${rows.length}件`, "────────────────"];
    for (const r of rows) {
      const dm = dueMeta(r.due, false);
      const [, m, d] = r.due.split("-");
      lines.push(`■ ${Number(m)}/${Number(d)}（${dm.rel}）［${r.genre}］`);
      lines.push(`　${r.text}`);
    }
    return lines.join("\n");
  }

  async function copyDueList() {
    const text = dueListText();
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`納期ありToDoをコピーしました（${dueExportCount}件）`);
    } catch {
      // iPhoneのSafariなど、クリップボードが使えない場面がある。
      // 黙って失敗すると「押したのに何も起きない」になるので、選択できる形で出す。
      window.prompt("コピーしてください", text);
    }
  }

  // チェック済みをまとめて消す。1件ずつの ✕ は残したまま、後片付け用に足したもの。
  //
  // 対象は「画面に出ている済みの行」だけを id で明示して送る。
  // 「done のものを全部」という条件で消すと、別のタブで完了にした行や
  // 同期で後から入った行まで一緒に消えて、消えたことに気づけない。
  async function removeDone(its: Item[]) {
    if (its.length === 0 || bulkBusy) return;
    if (
      !window.confirm(
        `チェック済みの${its.length}件をまとめて削除します。元に戻せません。よろしいですか？`
      )
    )
      return;

    setBulkBusy(true);
    setError(null);
    setNotice(null);
    const before = items;
    const ids = its.map((x) => x.id);
    const idSet = new Set(ids);
    setItems((prev) => prev.filter((x) => !idSet.has(x.id)));
    try {
      // URLが長くなりすぎないよう小分けにする（idはUUIDで1件36文字）
      let removed = 0;
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const res = await fetch(
          `/api/actions?ids=${chunk.map(encodeURIComponent).join(",")}`,
          { method: "DELETE" }
        );
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "一括削除に失敗しました");
        removed += data?.count ?? chunk.length;
      }
      setNotice(`チェック済み${removed}件を削除しました`);
    } catch (e) {
      setItems(before);
      setError(e instanceof Error ? e.message : "一括削除に失敗しました");
      await load();
    } finally {
      setBulkBusy(false);
    }
  }

  // 削除は元に戻せない。日記由来の行は自動で起票されるので、消したつもりが
  // 別の行だった、という取り違えが起きやすい。内容を出して一度確かめる。
  async function remove(it: Item) {
    if (!window.confirm(`「${it.content}」を削除します。元に戻せません。よろしいですか？`)) return;
    setItems((prev) => prev.filter((x) => x.id !== it.id));
    const res = await fetch(`/api/actions?id=${encodeURIComponent(it.id)}`, { method: "DELETE" });
    if (!res.ok) load();
  }

  // 日付（いつの日記か）と納期（いつまでにやるか）の更新。
  // 納期の入力欄は営業ToDo側と同じ作法で、下書きに溜めて「決定」で保存する
  // （iPhoneの日付ピッカーは開いた直後にchangeを飛ばすので、保存と同時に
  //  入力欄を閉じるとカレンダーごと消える。詳しくは saveDue のコメント）。
  async function saveItemDates(it: Item, patch: { entry_date?: string; due_date?: string | null }) {
    const prev = items;
    setItems((p) => p.map((x) => (x.id === it.id ? { ...x, ...patch } : x)));
    setItemDueEditId(null);
    try {
      const res = await fetch("/api/actions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: it.id, ...patch }),
      });
      if (!res.ok) throw new Error("更新に失敗しました");
    } catch {
      setItems(prev);
      setError("日付の更新に失敗しました");
    }
  }

  async function addItem() {
    const text = addText.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry_date: addDate, kind: addKind, content: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "追加に失敗しました");
      setItems((prev) => [data.item, ...prev]);
      setAddText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "追加に失敗しました");
    } finally {
      setAdding(false);
    }
  }

  async function syncDiary() {
    if (syncing) return;
    setSyncing(true);
    setNotice(null);
    try {
      const res = await fetch("/api/actions/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lookback_days: 30 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取込に失敗しました");
      setNotice(
        data.added > 0
          ? `日記から ${data.added} 件を取り込みました`
          : "新しく取り込む日記はありませんでした"
      );
      if (data.added > 0) await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "取込に失敗しました");
    } finally {
      setSyncing(false);
    }
  }

  // Notion「ToDo DB」からの取り込み（Notion側での変更をサイトへ反映する）。
  // サイト→Notion はライトスルーで即時なので、押す必要があるのは
  // 「Notionで直接いじったとき」だけ。
  async function syncNotion() {
    if (notionSyncing) return;
    setNotionSyncing(true);
    setNotice(null);
    try {
      const res = await fetch("/api/strategic-todos/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取込に失敗しました");
      const parts = [
        `追加 ${data.added ?? 0}件`,
        `更新 ${data.updated ?? 0}件`,
        `削除 ${data.removed ?? 0}件`,
      ];
      if (data.skipped > 0) parts.push(`取込不可 ${data.skipped}件`);
      let msg = `Notionから取り込みました（${parts.join(" ・ ")}）`;
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        msg += ` ※一部失敗: ${data.errors[0]}`;
      }
      setNotice(msg);
      // 取り込み後はNotionと一致しているはずなので、未反映バッジを掃除する
      setNotionFailed(new Set());
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "取込に失敗しました");
    } finally {
      setNotionSyncing(false);
    }
  }

  // 未完＝週単位でグルーピング（新しい週が上）。週内は日付降順→種別。
  const activeWeeks = useMemo(() => {
    const active = items.filter((x) => !x.done);
    const byWeek = new Map<string, Item[]>();
    for (const it of active) {
      const wk = keyOf(weekMonday(it.entry_date));
      if (!byWeek.has(wk)) byWeek.set(wk, []);
      byWeek.get(wk)!.push(it);
    }
    for (const arr of byWeek.values()) {
      arr.sort((a, b) =>
        a.entry_date !== b.entry_date
          ? a.entry_date < b.entry_date
            ? 1
            : -1
          : a.kind < b.kind
            ? -1
            : a.kind > b.kind
              ? 1
              : 0
      );
    }
    return Array.from(byWeek.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [items]);

  // ── カテゴリーモード：戦略ToDoをジャンルごとに束ねる（未完→完了の順）
  // ジャンル内の並びは「完了は常に最下段」を保ったまま、未完了同士を
  // byDueThenCreated（納期の近い順→納期なしは登録順）で並べる。
  // ジャンルという括りは崩さずに、その中で締切が迫っているものだけを上げたい
  // ＝「1点突破」する相手をジャンルごとに1件目で見つけられる形にするため。
  const genreGroups = useMemo(() => {
    const byGenre = new Map<string, Strategic[]>();
    for (const t of strategic) {
      if (!byGenre.has(t.genre)) byGenre.set(t.genre, []);
      byGenre.get(t.genre)!.push(t);
    }
    for (const arr of byGenre.values()) {
      arr.sort((a, b) => {
        const ad = a.status === "完了" ? 1 : 0;
        const bd = b.status === "完了" ? 1 : 0;
        if (ad !== bd) return ad - bd;
        return byDueThenCreated(a, b);
      });
    }
    return Array.from(byGenre.entries()).sort((a, b) => {
      const r = genreRank(a[0]) - genreRank(b[0]);
      return r !== 0 ? r : a[0] < b[0] ? -1 : 1;
    });
  }, [strategic]);

  const strategicOpen = useMemo(
    () => strategic.filter((t) => t.status !== "完了").length,
    [strategic]
  );

  // 納期の警告件数（未完了のみ）。over=超過、soon=今日/明日。
  // 閾値は dueMeta の色分けと必ず同じにする（バッジは赤なのに件数に出ない、を防ぐ）。
  const dueAlert = useMemo(() => {
    const today = jstToday();
    let over = 0;
    let soon = 0;
    for (const t of strategic) {
      if (!t.due_date || t.status === "完了") continue;
      const d = diffDays(today, t.due_date);
      if (d < 0) over += 1;
      else if (d <= 1) soon += 1;
    }
    return { over, soon };
  }, [strategic]);

  // ── 時系列モード：両方を1本の時間軸に混ぜて新しい順。
  // daily_actions は entry_date、strategic_todos は created_at（JSTのローカル日付）を軸にする。
  type Row =
    | { key: string; date: string; type: "action"; item: Item }
    | { key: string; date: string; type: "strategic"; todo: Strategic };

  // 納期が入っている未完了の営業ToDoは、時系列の並びに混ぜずに専用セクションへ
  // 切り出して最上部に置く。
  //
  // なぜ混ぜないのか（この判断の理由）:
  //   既存の時系列は created_at / entry_date の「降順（新しいものが上）」で、
  //   過去に向かって読む“記録の軸”になっている。一方 納期は「昇順（近いものが上）」で
  //   未来に向かって読む“締切の軸”で、向きが正反対。これを1本のリストに混ぜると、
  //   同じ縦方向のスクロールが上と下で違う意味になり、どちらも読めなくなる。
  //   （created_at は「いつ登録したか」でしかなく、行動の優先度をまったく表さない。）
  //   そこで軸ごとにセクションを分け、「これから」の納期を先に、「これまで」の記録を
  //   後に置く。フィードフォワードの順序＝未来への問いを先に見る形に合わせた。
  // 完了済みは締切として急かす意味がないので、このセクションには入れず通常の時系列に残す。
  const dueRows = useMemo(
    () =>
      strategic
        .filter((t) => t.due_date && t.status !== "完了")
        .sort(byDueThenCreated),
    [strategic]
  );

  const timelineGroups = useMemo(() => {
    // 納期セクションに出した行は時系列側では省く（同じToDoを二重に出さないため）。
    const inDueSection = new Set(dueRows.map((t) => t.id));
    const rows: Row[] = [];
    for (const it of items) {
      rows.push({ key: `a-${it.id}`, date: it.entry_date, type: "action", item: it });
    }
    for (const t of strategic) {
      if (inDueSection.has(t.id)) continue;
      const d = new Date(t.created_at);
      const date = Number.isNaN(d.getTime()) ? (t.target_month ?? "") : keyOf(d);
      rows.push({ key: `s-${t.id}`, date, type: "strategic", todo: t });
    }
    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      // 同じ日付なら 戦略ToDo → 日記由来 の順
      if (a.type !== b.type) return a.type === "strategic" ? -1 : 1;
      return 0;
    });
    const byDate = new Map<string, Row[]>();
    for (const r of rows) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date)!.push(r);
    }
    return Array.from(byDate.entries());
  }, [items, strategic, dueRows]);

  // 書き出しの対象件数（ボタンの表示に使う）。納期があって未完のものだけ。
  const dueExportCount = useMemo(
    () =>
      strategic.filter((t) => t.due_date && t.status !== "完了").length +
      items.filter((it) => it.due_date && !it.done).length,
    [strategic, items]
  );

  const doneItems = useMemo(
    () => items.filter((x) => x.done).sort((a, b) => (a.entry_date < b.entry_date ? 1 : -1)),
    [items]
  );
  const remaining = items.length - doneItems.length;

  // 当日分の進捗（ヘッダー直下の進捗バー・達成表示に使用）
  const todayItems = useMemo(() => items.filter((x) => x.entry_date === todayStr()), [items]);
  const todayDoneCount = todayItems.filter((x) => x.done).length;
  const todayTotal = todayItems.length;
  const todayAllDone = todayTotal > 0 && todayDoneCount === todayTotal;
  const todayPct = todayTotal > 0 ? Math.round((todayDoneCount / todayTotal) * 100) : 0;

  function renderItem(it: Item) {
    const meta = KIND_META[it.kind];
    const editing = editId === it.id;
    return (
      <div
        key={it.id}
        className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm transition-shadow duration-200"
      >
        <button
          type="button"
          onClick={() => toggleDone(it)}
          aria-label={it.done ? "未完に戻す" : "完了にする"}
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-all duration-200 ease-out active:scale-90 ${
            it.done
              ? "border-emerald-600 bg-emerald-600 text-white"
              : "border-gray-300 text-transparent active:border-emerald-400"
          }`}
        >
          ✓
        </button>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[0.6875rem] font-semibold ${meta.klass}`}>
              {meta.icon} {meta.label}
            </span>

            {/* 日付＝いつの日記か。押すと差し替えられる（取込先の日を間違えた時用） */}
            {itemDateEditId === it.id ? (
              <input
                type="date"
                autoFocus
                defaultValue={it.entry_date}
                onChange={(e) => {
                  if (e.target.value) saveItemDates(it, { entry_date: e.target.value });
                  setItemDateEditId(null);
                }}
                onBlur={() => setItemDateEditId(null)}
                aria-label="日付"
                className="rounded border border-gray-300 px-1 py-0.5 text-[0.6875rem] text-gray-700"
              />
            ) : (
              <button
                type="button"
                onClick={() => setItemDateEditId(it.id)}
                title="日付を変える"
                className="rounded text-[0.6875rem] text-gray-400 underline decoration-dotted underline-offset-2 active:bg-gray-100"
              >
                {fmtDate(it.entry_date)}
              </button>
            )}

            {/* 納期。営業ToDoと同じ見た目・同じ作法にそろえる */}
            {itemDueEditId === it.id ? (
              <span className="inline-flex items-center gap-1">
                <input
                  type="date"
                  autoFocus
                  value={itemDueDraft}
                  onChange={(e) => setItemDueDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setItemDueEditId(null);
                    if (e.key === "Enter") saveItemDates(it, { due_date: itemDueDraft || null });
                  }}
                  aria-label="納期"
                  className="rounded-lg border border-emerald-400 px-1.5 py-0.5 text-[0.8125rem] text-gray-700"
                />
                {itemDueDraft !== (it.due_date ?? "") ? (
                  <button
                    type="button"
                    onClick={() => saveItemDates(it, { due_date: itemDueDraft || null })}
                    className="rounded-full bg-emerald-600 px-2 py-0.5 text-[0.6875rem] font-semibold text-white"
                  >
                    決定
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setItemDueEditId(null)}
                    className="rounded-full px-1.5 py-0.5 text-[0.6875rem] font-medium text-gray-400"
                  >
                    閉じる
                  </button>
                )}
                {it.due_date && (
                  <button
                    type="button"
                    onClick={() => saveItemDates(it, { due_date: null })}
                    className="rounded-full border border-gray-300 px-1.5 py-0.5 text-[0.6875rem] font-medium text-gray-500"
                  >
                    クリア
                  </button>
                )}
              </span>
            ) : (
              (() => {
                const dm = it.due_date ? dueMeta(it.due_date, it.done) : null;
                return (
                  <button
                    type="button"
                    onClick={() => {
                      setItemDueDraft(it.due_date ?? "");
                      setItemDueEditId(it.id);
                    }}
                    title={it.due_date ? "納期を変更・解除する" : "納期を設定する"}
                    className={`rounded-full border px-1.5 py-0.5 text-[0.6875rem] transition active:scale-95 ${
                      dm ? dm.klass : "border-dashed border-gray-300 text-gray-400"
                    }`}
                  >
                    {it.due_date && dm ? `📅 ${fmtDate(it.due_date)} ${dm.rel}` : "📅 納期"}
                  </button>
                );
              })()
            )}
          </div>
          {editing ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={editText}
                autoFocus
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveEdit();
                  if (e.key === "Escape") setEditId(null);
                }}
                className="min-w-0 flex-1 rounded-lg border border-emerald-400 px-2 py-1 text-sm"
              />
              <button
                type="button"
                onClick={saveEdit}
                className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1 text-sm font-medium text-white"
              >
                保存
              </button>
            </div>
          ) : (
            <p
              onClick={() => {
                setEditId(it.id);
                setEditText(it.content);
              }}
              className={`cursor-text text-sm leading-relaxed transition-colors duration-200 ${
                it.done ? "text-gray-400 line-through" : "text-gray-800"
              }`}
            >
              {it.content}
            </p>
          )}
        </div>

        {!editing && (
          <button
            type="button"
            onClick={() => remove(it)}
            aria-label="削除"
            className="mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-gray-300 transition active:bg-gray-100 active:text-rose-500"
          >
            ✕
          </button>
        )}
      </div>
    );
  }

  // 戦略ToDo（strategic_todos）1件のカード。日々のToDoと同じデザイン言語で、
  // ジャンルバッジ・対象月・メモを足したもの。
  function renderStrategic(t: Strategic, opts?: { showGenre?: boolean }) {
    const done = t.status === "完了";
    const gm = genreMeta(t.genre);
    const editing = stEditId === t.id;
    return (
      <div
        key={t.id}
        className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm transition-shadow duration-200"
      >
        <button
          type="button"
          onClick={() => toggleStrategic(t)}
          aria-label={done ? "未着手に戻す" : "完了にする"}
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-all duration-200 ease-out active:scale-90 ${
            done
              ? "border-emerald-600 bg-emerald-600 text-white"
              : "border-gray-300 text-transparent active:border-emerald-400"
          }`}
        >
          ✓
        </button>

        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex flex-col gap-2">
              <input
                type="text"
                value={stEditName}
                autoFocus
                onChange={(e) => setStEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveStrategicEdit();
                  if (e.key === "Escape") setStEditId(null);
                }}
                className="min-w-0 flex-1 rounded-lg border border-emerald-400 px-2 py-1 text-sm"
              />
              <select
                value={stEditGenre}
                onChange={(e) => setStEditGenre(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-emerald-400 px-2 py-1 text-sm"
              >
                {GENRE_ORDER.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={stEditNotes}
                onChange={(e) => setStEditNotes(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveStrategicEdit();
                  if (e.key === "Escape") setStEditId(null);
                }}
                placeholder="備考（任意）"
                className="min-w-0 flex-1 rounded-lg border border-emerald-400 px-2 py-1 text-sm"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveStrategicEdit}
                  disabled={stSaving || !stEditName.trim()}
                  className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => setStEditId(null)}
                  className="shrink-0 rounded-lg border border-gray-300 px-3 py-1 text-sm font-medium text-gray-500"
                >
                  キャンセル
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                {opts?.showGenre !== false && (
                  <span className={`rounded px-1.5 py-0.5 text-[0.6875rem] font-semibold ${gm.klass}`}>
                    {gm.icon} {t.genre}
                  </span>
                )}
                {t.notion_page_id && (
                  <span
                    title="Notion「ToDo DB」と同期（この画面での変更はNotionにも反映されます）"
                    className="text-[0.6875rem] text-gray-300"
                  >
                    📄
                  </span>
                )}
                {notionFailed.has(t.id) && (
                  <span
                    title="Supabaseには保存済みですが、Notionへの反映に失敗しています。もう一度操作するか、Notion側を直接ご確認ください。"
                    className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[0.6875rem] font-medium text-amber-700"
                  >
                    Notion未反映
                  </span>
                )}
                {t.target_month && (
                  <span className="text-[0.6875rem] text-gray-400">{t.target_month}</span>
                )}

                {/* 納期。ボタンを押すとOS標準のカレンダー（input[type=date]）が開く。
                    設定済みなら「📅 8/5（水） あと3日」のように相対表示も添える。 */}
                {dueEditId === t.id ? (
                  <span className="inline-flex items-center gap-1">
                    <input
                      type="date"
                      autoFocus
                      value={dueDraft}
                      onChange={(e) => setDueDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setDueEditId(null);
                        if (e.key === "Enter") saveDue(t, dueDraft || null);
                      }}
                      aria-label="納期"
                      className="rounded-lg border border-emerald-400 px-1.5 py-0.5 text-[0.8125rem] text-gray-700"
                    />
                    {/* 中身を変えたときだけ「決定」に変わる。押すまで保存されない */}
                    {dueDraft !== (t.due_date ?? "") ? (
                      <button
                        type="button"
                        onClick={() => saveDue(t, dueDraft || null)}
                        className="rounded-full bg-emerald-600 px-2 py-0.5 text-[0.6875rem] font-semibold text-white transition active:bg-emerald-700"
                      >
                        決定
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDueEditId(null)}
                        className="rounded-full px-1.5 py-0.5 text-[0.6875rem] font-medium text-gray-400 transition active:bg-gray-100"
                      >
                        閉じる
                      </button>
                    )}
                    {t.due_date && (
                      <button
                        type="button"
                        onClick={() => saveDue(t, null)}
                        className="rounded-full border border-gray-300 px-1.5 py-0.5 text-[0.6875rem] font-medium text-gray-500 transition active:bg-gray-100"
                      >
                        クリア
                      </button>
                    )}
                  </span>
                ) : (
                  (() => {
                    const dm = t.due_date ? dueMeta(t.due_date, done) : null;
                    return (
                      <button
                        type="button"
                        onClick={() => {
                          setDueDraft(t.due_date ?? "");
                          setDueEditId(t.id);
                        }}
                        title={t.due_date ? "納期を変更・解除する" : "納期を設定する"}
                        className={`rounded-full border px-1.5 py-0.5 text-[0.6875rem] transition active:scale-95 ${
                          dm ? dm.klass : "border-dashed border-gray-300 text-gray-400"
                        }`}
                      >
                        {t.due_date && dm
                          ? `📅 ${fmtDate(t.due_date)} ${dm.rel}`
                          : "📅 納期"}
                      </button>
                    );
                  })()
                )}

                {!done && (
                  <button
                    type="button"
                    onClick={() => toggleStrategicProgress(t)}
                    className={`rounded-full border px-1.5 py-0.5 text-[0.6875rem] font-medium transition active:scale-95 ${
                      t.status === "進行中"
                        ? "border-amber-300 bg-amber-50 text-amber-700"
                        : "border-gray-200 text-gray-400"
                    }`}
                  >
                    {t.status === "進行中" ? "進行中" : "未着手"}
                  </button>
                )}
              </div>
              <p
                onClick={() => startStrategicEdit(t)}
                className={`cursor-text text-sm leading-relaxed transition-colors duration-200 ${
                  done ? "text-gray-400 line-through" : "text-gray-800"
                }`}
              >
                {t.task_name}
              </p>
              {t.notes && (
                <p className="mt-1 text-[0.6875rem] leading-relaxed text-gray-400">{t.notes}</p>
              )}
            </>
          )}
        </div>

        {!editing && (
          <button
            type="button"
            onClick={() => removeStrategic(t.id)}
            aria-label="削除"
            className="mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-gray-300 transition active:bg-gray-100 active:text-rose-500"
          >
            ✕
          </button>
        )}
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pb-20 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="mb-4 flex items-center gap-2">
        <Link
          href="/"
          className="rounded-lg px-2 py-1 text-sm font-medium text-gray-500 transition active:bg-gray-100"
        >
          ← ホーム
        </Link>
      </div>

      <header className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">日々のToDo</h1>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={syncDiary}
              disabled={syncing}
              className="shrink-0 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-700 transition active:bg-emerald-100 disabled:opacity-50"
            >
              {syncing ? "取込中…" : "📓 日記から取込"}
            </button>
            <button
              type="button"
              onClick={syncNotion}
              disabled={notionSyncing}
              className="shrink-0 rounded-lg border border-sky-300 bg-sky-50 px-3 py-1.5 text-sm font-semibold text-sky-700 transition active:bg-sky-100 disabled:opacity-50"
            >
              {notionSyncing ? "取込中…" : "📄 Notionから取り込み"}
            </button>
            {remaining > 0 && (
              <button
                type="button"
                onClick={completeAll}
                disabled={bulkBusy}
                className="shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-600 transition active:bg-gray-100 disabled:opacity-50"
              >
                {bulkBusy ? "処理中…" : `✓ 未完${remaining}件をすべて完了に`}
              </button>
            )}
            {/* 納期ありの書き出し。どちらの表示でも押せるようここに置く。 */}
            {dueExportCount > 0 && (
              <button
                type="button"
                onClick={copyDueList}
                className="shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-600 transition active:bg-gray-100"
              >
                📋 納期あり{dueExportCount}件をコピー
              </button>
            )}
            {/* チェック済みの後片付け。時系列表示でも押せるよう、済み一覧とは別にここにも置く。 */}
            {doneItems.length > 0 && (
              <button
                type="button"
                onClick={() => removeDone(doneItems)}
                disabled={bulkBusy}
                className="shrink-0 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm font-semibold text-rose-600 transition active:bg-rose-50 disabled:opacity-50"
              >
                {bulkBusy ? "処理中…" : `🗑 済み${doneItems.length}件をまとめて消す`}
              </button>
            )}
          </div>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          ジャンル別の営業ToDoと、一行日記の「やってみよう」「本日のポイント」を1画面に。
        </p>
        {notice && (
          <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>
        )}
      </header>

      {/* 表示モード切替：カテゴリー別 ⇄ 時系列 */}
      <div className="mb-5 flex overflow-hidden rounded-xl border border-gray-300 bg-white">
        {(
          [
            { key: "category", label: "🗂 カテゴリー別" },
            { key: "timeline", label: "🕒 時系列" },
          ] as { key: ViewMode; label: string }[]
        ).map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => changeView(m.key)}
            aria-pressed={view === m.key}
            className={`flex-1 px-3 py-2 text-sm font-semibold transition ${
              view === m.key ? "bg-emerald-600 text-white" : "bg-white text-gray-500"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* 当日分の進捗バー・達成表示 */}
      <section className="mb-5">
        {todayTotal === 0 ? (
          <p className="rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-400 shadow-sm">
            今日のToDoはまだありません
          </p>
        ) : todayAllDone ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 shadow-sm transition-colors duration-300">
            <p className="text-sm font-semibold text-emerald-700">
              ✓ 今日のやることは全部完了！
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
            <div className="mb-1.5 flex items-center justify-between text-sm">
              <span className="font-semibold text-gray-700">今日のToDo</span>
              <span className="text-gray-500">
                完了 <b className="text-gray-800">{todayDoneCount}</b> / 全{todayTotal}件
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-300 ease-out"
                style={{ width: `${todayPct}%` }}
              />
            </div>
          </div>
        )}
      </section>

      <NotificationOptIn />

      {/* 追加フォーム */}
      <section className="mb-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={addDate}
            onChange={(e) => setAddDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700"
          />
          <div className="flex overflow-hidden rounded-lg border border-gray-300">
            {(["action", "point"] as Kind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setAddKind(k)}
                className={`px-3 py-1.5 text-sm font-medium transition ${
                  addKind === k ? "bg-emerald-600 text-white" : "bg-white text-gray-500"
                }`}
              >
                {KIND_META[k].icon} {KIND_META[k].label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addItem();
            }}
            placeholder="やること・ポイントを入力してEnter"
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={addItem}
            disabled={adding || !addText.trim()}
            className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition active:bg-emerald-700 disabled:opacity-40"
          >
            追加
          </button>
        </div>
      </section>

      <div className="mb-3 px-1 text-sm text-gray-500">
        営業ToDo 未完 <b className="text-gray-800">{strategicOpen}</b> 件 ・ 日々のToDo 未完{" "}
        <b className="text-gray-800">{remaining}</b> 件 ・ 済み{" "}
        <b className="text-gray-800">{doneItems.length}</b> 件
        {dueAlert.over > 0 && (
          <span className="ml-2 rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 font-semibold text-rose-700">
            納期超過 {dueAlert.over}件
          </span>
        )}
        {dueAlert.soon > 0 && (
          <span className="ml-2 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-semibold text-amber-700">
            今日・明日 {dueAlert.soon}件
          </span>
        )}
      </div>

      {loading && <p className="py-10 text-center text-sm text-gray-400">読み込み中…</p>}
      {error && <p className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>}
      {!loading && activeWeeks.length === 0 && strategic.length === 0 && (
        <p className="py-10 text-center text-sm text-gray-400">
          未完はありません。上のフォームから追加、または「日記から取込」できます。
        </p>
      )}

      {/* ───── カテゴリー別モード ───── */}
      {!loading && view === "category" && (
        <>
          {/* ジャンル別の営業ToDo（strategic_todos） */}
          <div className="space-y-6">
            {genreGroups.map(([genre, todos]) => {
              const gm = genreMeta(genre);
              const open = todos.filter((t) => t.status !== "完了").length;
              return (
                <section key={genre}>
                  <h2 className="mb-2 flex items-center gap-2 px-1 text-sm font-bold text-gray-700">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${gm.klass}`}>{gm.icon}</span>
                    {genre}
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[0.6875rem] font-medium text-gray-500">
                      残{open} / 全{todos.length}
                    </span>
                  </h2>
                  <div className="space-y-2">
                    {todos.map((t) => renderStrategic(t, { showGenre: false }))}
                  </div>
                  <div className="mt-2">
                    {stAddGenre === genre ? (
                      <div className="flex gap-2 rounded-lg border border-gray-200 bg-white p-2">
                        <input
                          type="text"
                          value={stAddText}
                          autoFocus
                          onChange={(e) => setStAddText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") addStrategic(genre);
                            if (e.key === "Escape") setStAddGenre(null);
                          }}
                          placeholder="営業ToDoを入力してEnter"
                          className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => addStrategic(genre)}
                          disabled={stAdding || !stAddText.trim()}
                          className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white transition active:bg-emerald-700 disabled:opacity-40"
                        >
                          追加
                        </button>
                        <button
                          type="button"
                          onClick={() => setStAddGenre(null)}
                          className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-500"
                        >
                          キャンセル
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setStAddGenre(genre);
                          setStAddText("");
                        }}
                        className="rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-sm font-medium text-emerald-600 transition active:bg-emerald-50"
                      >
                        ＋ 追加
                      </button>
                    )}
                  </div>
                </section>
              );
            })}
          </div>

          {/* 日記由来の日々のToDoは別枠でまとめる */}
          <section className="mt-8">
            <h2 className="mb-2 flex items-center gap-2 px-1 text-sm font-bold text-gray-700">
              <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">📓</span>
              日々の気づき
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[0.6875rem] font-medium text-gray-500">
                残{remaining}
              </span>
            </h2>
            {activeWeeks.length === 0 ? (
              <p className="px-1 py-4 text-sm text-gray-400">未完はありません。</p>
            ) : (
              <div className="space-y-5">
                {activeWeeks.map(([wk, its]) => (
                  <div key={wk}>
                    <h3 className="mb-2 flex items-center gap-2 px-1 text-[0.8125rem] font-bold text-gray-500">
                      {weekLabel(wk)}
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[0.6875rem] font-medium text-gray-500">
                        {its.length}
                      </span>
                      <button
                        type="button"
                        onClick={() => completeWeek(its)}
                        disabled={bulkBusy}
                        className="ml-auto shrink-0 rounded-full border border-gray-200 px-2 py-0.5 text-[0.6875rem] font-medium text-gray-400 transition active:bg-gray-100 active:text-emerald-700 disabled:opacity-50"
                      >
                        この週をすべて完了
                      </button>
                    </h3>
                    <div className="space-y-2">{its.map(renderItem)}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 済み一覧（日々のToDo・折りたたみ） */}
          {doneItems.length > 0 && (
            <section className="mt-8">
              {/* 見出しの折りたたみと「まとめて消す」は別のボタン。
                  入れ子にすると押し分けられないので横に並べる。 */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDoneOpen((v) => !v)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-2 text-sm font-bold text-gray-500 transition active:bg-gray-50"
                >
                  <span>{doneOpen ? "▼" : "▶"}</span>
                  ✓ 済み（日々のToDo）
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[0.6875rem] font-medium text-gray-500">
                    {doneItems.length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => removeDone(doneItems)}
                  disabled={bulkBusy}
                  className="shrink-0 rounded-lg border border-rose-200 px-2.5 py-1.5 text-[0.75rem] font-medium text-rose-600 transition active:scale-95 active:bg-rose-50 disabled:opacity-40"
                >
                  {bulkBusy ? "処理中…" : `🗑 ${doneItems.length}件をまとめて消す`}
                </button>
              </div>
              {doneOpen && (
                <div className="mt-2 space-y-2 opacity-80">{doneItems.map(renderItem)}</div>
              )}
            </section>
          )}
        </>
      )}

      {/* ───── 時系列モード ───── */}
      {!loading && view === "timeline" && (
        <div className="space-y-6">
          {/* 納期セクション（締切の軸・近い順）。下の日付セクションは記録の軸・新しい順。 */}
          {dueRows.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-2 px-1 text-sm font-bold text-gray-700">
                <span className="rounded bg-rose-50 px-1.5 py-0.5 text-xs text-rose-700">📅</span>
                納期あり（近い順）
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[0.6875rem] font-medium text-gray-500">
                  {dueRows.length}
                </span>
              </h2>
              <div className="space-y-2">
                {dueRows.map((t) => (
                  <div key={`d-${t.id}`}>{renderStrategic(t)}</div>
                ))}
              </div>
            </section>
          )}

          {timelineGroups.map(([date, rows]) => (
            <section key={date}>
              <h2 className="mb-2 flex items-center gap-2 px-1 text-sm font-bold text-gray-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
                {date ? fmtDate(date) : "日付なし"}
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[0.6875rem] font-medium text-gray-500">
                  {rows.length}
                </span>
              </h2>
              <div className="space-y-2">
                {rows.map((r) =>
                  r.type === "strategic" ? (
                    <div key={r.key}>{renderStrategic(r.todo)}</div>
                  ) : (
                    <div key={r.key}>{renderItem(r.item)}</div>
                  )
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホーム
        </Link>
      </div>
    </main>
  );
}

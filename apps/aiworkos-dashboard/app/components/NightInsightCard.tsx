"use client";

import { useCallback, useEffect, useState } from "react";

// ホームの「今朝の示唆」。中身は /api/night-advisor（夜間参謀が前の晩に書いたもの）。
//
// ■ 上の「今朝の気づき」とは別物だと、見た瞬間に分かるようにする
//   あちらは機械的な判定で出した**事実**（日記が3日空いています）。
//   こちらはAIが中身を読んで書いた**仮説**。信頼度が違うものを同じ見た目で並べると、
//   どちらも同じ重みで読まれてしまい、外したときに両方の信用が落ちる。
//   だから枠線・色・「仮説」ラベルで明確に分ける。
//
// ■ 判断の3ボタンが本体
//   採用／見送り／的外れ。これを押してもらえないと、翌晩の参謀は自分が当たったのかを
//   知りようがなく、同じことを言い続ける。ボタンは1クリックで終わらせる。
//   「的外れ」のときだけ理由を聞く（そこだけは、次に効く情報だから）。
//
// ■ まだ insights 表が無い環境では何も出さない
//   available:false が返るので、カードごと消える。導入前でもホームは壊れない。

type Evidence = { source_type: string; title: string; event_date: string };

type Insight = {
  id: string;
  generated_on: string;
  kind: string;
  title: string;
  body: string;
  evidence: Evidence[];
  related_orgs: string[];
  verdict: string | null;
  verdict_note: string | null;
};

type Result = {
  day: string | null;
  stale?: boolean;
  insights: Insight[];
  available: boolean;
};

const KIND: Record<string, { chip: string; label: string }> = {
  改善: { chip: "bg-sky-100 text-sky-700", label: "改善" },
  横断: { chip: "bg-violet-100 text-violet-700", label: "横断" },
  // 異議だけ強い色にする。毎晩1件の必須枠で、いちばん読まれるべきもの。
  異議: { chip: "bg-rose-100 text-rose-700", label: "異議" },
  問い: { chip: "bg-amber-100 text-amber-700", label: "問い" },
  継続: { chip: "bg-gray-200 text-gray-600", label: "継続" },
};

const VERDICT_LABEL: Record<string, string> = {
  adopted: "採用",
  deferred: "見送り",
  off_target: "的外れ",
};

function shortDay(day: string): string {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function InsightRow({
  i,
  busy,
  onVerdict,
}: {
  i: Insight;
  busy: boolean;
  onVerdict: (id: string, verdict: string | null, note?: string) => void;
}) {
  const [openEvidence, setOpenEvidence] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const kind = KIND[i.kind] ?? { chip: "bg-gray-100 text-gray-600", label: i.kind };

  return (
    <li className="rounded-xl border border-indigo-100 bg-white p-3">
      <div className="flex items-start gap-2">
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${kind.chip}`}>
          {kind.label}
        </span>
        <p className="text-sm font-bold text-gray-900">{i.title}</p>
      </div>

      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{i.body}</p>

      {i.related_orgs?.length > 0 && (
        <p className="mt-2 text-xs text-gray-500">関係: {i.related_orgs.join("・")}</p>
      )}

      {/* 「問い」は本来、答えを考える先が要る。相談窓口へ問いごと持って飛べるようにする。
          （夜間参謀は材料から判断できなかったから問いにした——その先を人が頭の中だけで
          考えるより、記憶を引きながら一緒に考えた方が早い） */}
      {i.kind === "問い" && (
        <a
          href={`/ask?q=${encodeURIComponent(`${i.title}\n${i.body}`)}`}
          className="mt-2 inline-block rounded-lg border border-fuchsia-300 bg-fuchsia-50 px-3 py-1 text-xs font-bold text-fuchsia-700 active:opacity-70"
        >
          🧠 相談窓口でこの問いを考える
        </a>
      )}

      {i.evidence?.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setOpenEvidence((v) => !v)}
            className="text-xs font-medium text-indigo-600 underline active:opacity-70"
          >
            {openEvidence ? "根拠を隠す" : `根拠${i.evidence.length}件を見る`}
          </button>
          {openEvidence && (
            <ul className="mt-1 space-y-1">
              {i.evidence.map((e, n) => (
                <li key={n} className="text-xs text-gray-500">
                  ・[{e.source_type}] {e.event_date && `${e.event_date} `}
                  {e.title}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 判断。押されないと翌晩の参謀が何も学べないので、ここは軽くする。 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {i.verdict ? (
          <>
            <span className="rounded-lg bg-gray-100 px-2 py-1 text-xs font-bold text-gray-600">
              {VERDICT_LABEL[i.verdict] ?? i.verdict}
              {i.verdict_note ? `：${i.verdict_note}` : ""}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => onVerdict(i.id, null)}
              className="text-xs text-gray-400 underline active:opacity-70 disabled:opacity-40"
            >
              取り消す
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onVerdict(i.id, "adopted")}
              className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 active:opacity-70 disabled:opacity-40"
            >
              採用
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onVerdict(i.id, "deferred")}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1 text-xs font-bold text-gray-600 active:opacity-70 disabled:opacity-40"
            >
              見送り
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setNoteOpen((v) => !v)}
              className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-1 text-xs font-bold text-rose-700 active:opacity-70 disabled:opacity-40"
            >
              的外れ
            </button>
          </>
        )}
      </div>

      {/* 的外れのときだけ理由を聞く。ここが翌晩のプロンプトに入る。 */}
      {noteOpen && !i.verdict && (
        <div className="mt-2 flex gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="なぜ的外れか（同じ筋を二度と出さないために使います）"
            className="flex-1 rounded-lg border border-gray-300 px-2 py-1 text-xs"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onVerdict(i.id, "off_target", note.trim());
              setNoteOpen(false);
              setNote("");
            }}
            className="rounded-lg bg-rose-600 px-3 py-1 text-xs font-bold text-white active:opacity-70 disabled:opacity-40"
          >
            記録
          </button>
        </div>
      )}
    </li>
  );
}

export default function NightInsightCard() {
  const [data, setData] = useState<Result | null>(null);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/night-advisor", { cache: "no-store" });
      if (!r.ok) {
        setData({ day: null, insights: [], available: false });
        return;
      }
      setData((await r.json()) as Result);
    } catch {
      setData({ day: null, insights: [], available: false });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function verdict(id: string, v: string | null, note?: string) {
    setBusyId(id);
    try {
      await fetch("/api/night-advisor", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, verdict: v, note: note || null }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  // 読み込み中・未導入・示唆ゼロのときは何も出さない。
  // 「示唆はありません」を毎朝出すと、カード自体を読まなくなる。
  if (!data || !data.available || data.insights.length === 0) return null;

  const top = data.insights[0];
  const rest = data.insights.slice(1);
  const undecided = data.insights.filter((i) => !i.verdict).length;

  return (
    <section
      id="night-insight-card"
      className="mb-6 scroll-mt-16 rounded-2xl border-2 border-dashed border-indigo-200 bg-indigo-50/40 p-4"
    >
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-gray-900">🌙 今朝の示唆</p>
        <p className="text-xs font-bold text-gray-400">
          {data.day && shortDay(data.day)}の夜
          {undecided > 0 && ` ／ 未判断${undecided}`}
        </p>
      </div>
      {/* 事実ではなく仮説であることを、毎回はっきり書く。 */}
      <p className="mb-3 text-xs text-indigo-700">
        夜間参謀が日記・会議・週報・健康を横断で読んで書いた<strong>仮説</strong>です。
        上の「今朝の気づき」が事実なのに対し、こちらは踏み込んで言っています。
        {data.stale && <span className="ml-1 text-amber-700">※前の晩は動いていません</span>}
      </p>

      <ul className="space-y-3">
        {[top, ...(open ? rest : [])].map((i) => (
          <InsightRow key={i.id} i={i} busy={busyId === i.id} onVerdict={verdict} />
        ))}
      </ul>

      {rest.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-3 w-full rounded-xl border border-indigo-200 bg-white py-2 text-sm font-bold text-indigo-700 transition active:bg-indigo-50"
        >
          {open ? "閉じる" : `残り${rest.length}件を見る`}
        </button>
      )}
    </section>
  );
}

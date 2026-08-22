"use client";

import { useEffect, useState } from "react";

// 紙面の右カラム。毎朝6時のX監視3本を1枚にまとめて置く。
//
// 記事一覧とは別に読む（この中身は待たせない）。Xはログインの壁があって
// 取れない朝が普通にあるので、「取れなかった」を空欄で誤魔化さず、
// カードごとに理由を書く。空欄にすると、壊れていても静かに毎朝空のままになる。

type Item = {
  section: string;
  sort_order: number;
  label: string;
  metric: number | null;
  summary: string | null;
  original: string | null;
  url: string | null;
  note: string | null;
};

type Digest = {
  digestDate: string | null;
  collectedAt: string | null;
  statuses: Record<string, string>;
  note: string | null;
  keywords: Item[];
  manus: Item[];
  takano: Item[];
  error?: string;
};

/** 取得できなかった理由の言い方。0件と混ぜない。 */
const STATUS_TEXT: Record<string, string> = {
  blocked: "ログインが必要で見られませんでした",
  error: "取得に失敗しました",
  partial: "一部だけ取得できました",
};

function stateLine(status: string | undefined, emptyText: string): string | null {
  if (!status) return "まだ取得していません";
  if (status === "ok") return emptyText;
  return STATUS_TEXT[status] ?? emptyText;
}

/** 収集した時刻を日本時間の「8/22 06:12」に。 */
function jstStamp(iso: string): string {
  const t = new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString();
  return `${Number(t.slice(5, 7))}/${Number(t.slice(8, 10))} ${t.slice(11, 16)}`;
}

export default function XDigest() {
  const [d, setD] = useState<Digest | null>(null);
  const [failed, setFailed] = useState(false);
  const [allKeywords, setAllKeywords] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/news/x-digest", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((j) => alive && setD(j))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const stamp = d?.collectedAt ? jstStamp(d.collectedAt) : "未取得";
  const keywords = d ? (allKeywords ? d.keywords : d.keywords.slice(0, 3)) : [];
  const manus = d?.manus ?? [];
  const takano = d?.takano ?? [];

  return (
    <div className="nw-sticky">
      <div className="nw-aside-head">
        <h2>X 監視ダイジェスト</h2>
        <span>{failed ? "取得できず" : `毎朝 6:00 ／ ${stamp}`}</span>
      </div>

      {/* --- キーワード急上昇 --- */}
      <div className="nw-card">
        <div className="nw-card-head">
          <span className="nw-card-title">キーワード急上昇</span>
          <span className="nw-card-note">{stamp}</span>
        </div>
        {keywords.length > 0 ? (
          <>
            {keywords.map((k) => (
              <div key={k.sort_order} className="nw-card-row">
                <div className="nw-kw">
                  {k.url ? (
                    <a
                      className="nw-kw-name"
                      href={k.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {k.label}
                    </a>
                  ) : (
                    <span className="nw-kw-name">{k.label}</span>
                  )}
                  {k.metric !== null && (
                    <span className="nw-kw-metric">♥ {k.metric.toLocaleString("ja-JP")}</span>
                  )}
                </div>
                <p className="nw-card-body">{k.summary}</p>
              </div>
            ))}
            {d && d.keywords.length > 3 && (
              <button
                type="button"
                className="nw-card-foot"
                style={{ width: "100%", border: "none", background: "none", cursor: "pointer", color: "var(--text-link)" }}
                onClick={() => setAllKeywords((v) => !v)}
              >
                {allKeywords ? "上位3件だけ表示 ←" : `上位${d.keywords.length}件をすべて見る →`}
              </button>
            )}
          </>
        ) : (
          <div className="nw-card-row">
            <p className="nw-card-body">
              {failed
                ? "取得に失敗しました"
                : stateLine(d?.statuses.keyword, "直近24時間で目立った投稿はありませんでした")}
            </p>
          </div>
        )}
      </div>

      {/* --- Manus公式 --- */}
      <div className="nw-card">
        <div className="nw-card-head">
          <span className="nw-card-title">@ManusAI_JP 公式</span>
          {manus.length > 0 ? (
            <span className="nw-card-badge">新着 {manus.length}件</span>
          ) : (
            <span className="nw-card-note">新着なし</span>
          )}
        </div>
        {manus.length > 0 ? (
          manus.map((m) => (
            <div key={m.sort_order} className="nw-card-row">
              <p className="nw-card-lead">
                {m.url ? (
                  <a href={m.url} target="_blank" rel="noopener noreferrer">
                    {m.label}
                  </a>
                ) : (
                  m.label
                )}
              </p>
              {m.original && <p className="nw-quote">{m.original}</p>}
              {m.summary && (
                <p className="nw-card-body" style={{ marginTop: "0.375rem" }}>
                  {m.original ? `訳：${m.summary}` : m.summary}
                </p>
              )}
            </div>
          ))
        ) : (
          <div className="nw-card-row">
            <p className="nw-card-body">
              {failed
                ? "取得に失敗しました"
                : stateLine(d?.statuses.manus, "直近24時間で新しい投稿はありませんでした")}
            </p>
          </div>
        )}
      </div>

      {/* --- 高野秀敏氏 --- */}
      <div className="nw-card">
        <div className="nw-card-head">
          <span className="nw-card-title">高野秀敏氏（@keyplayers）</span>
          <span className="nw-card-note">X ／ FB ／ LinkedIn</span>
        </div>
        {takano.length > 0 ? (
          takano.map((t) => (
            <div key={t.sort_order} className="nw-card-row">
              <p className="nw-card-lead">
                {t.url ? (
                  <a href={t.url} target="_blank" rel="noopener noreferrer">
                    {t.label}
                  </a>
                ) : (
                  t.label
                )}
              </p>
              {t.original && <p className="nw-quote">{t.original}</p>}
              {t.summary && (
                <p className="nw-card-body" style={{ marginTop: "0.375rem" }}>
                  {t.summary}
                </p>
              )}
              {t.note && (
                <p className="nw-card-note" style={{ marginTop: "0.375rem" }}>
                  {t.note}
                </p>
              )}
            </div>
          ))
        ) : (
          <div className="nw-card-row">
            <p className="nw-card-body">
              {failed
                ? "取得に失敗しました"
                : stateLine(d?.statuses.takano, "直近24時間で新しい投稿はありませんでした")}
            </p>
          </div>
        )}
      </div>

      {d?.note && <p className="nw-card-note">{d.note}</p>}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import "../news.css";
import "./creators.css";

// AI発信者ウォッチの全員ぶん。/news の右カラムのカードから「全員ぶんを見る →」で来る。
//
// 毎朝6時にXアカウント（x_creator_accounts が正）を読んだ結果を、その日1枚で見る。
//   上段：日付ナビ・収集時刻・何名取れたか
//   中段：今日の動向／今日いちばんの話題／今日の学び／勝ち投稿の書き方（総括4つ）
//   下段：発信者ごとの投稿（本文そのまま・要旨・反応・型・真似どころ）
//   末尾：監視しているアカウントの表
//
// 過去の日も見られる（?date=YYYY-MM-DD）。「あの日の勝ち投稿はどう書かれていたか」を
// 後から読み返すため。X監視ダイジェストが最新1回だけなのとは違う。
//
// 取れなかった発信者は「本日は見られませんでした」と書く。空欄にすると、
// 壊れていても静かに毎朝空のままになる（XDigest.tsx と同じ考え方）。

type Post = {
  handle: string;
  sortOrder: number;
  postedAt: string | null;
  body: string;
  summary: string | null;
  url: string | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  pattern: string | null;
  whyItWorks: string | null;
};

type Account = {
  handle: string;
  displayName: string;
  url: string;
  category: string;
  focus: string | null;
  followers: number | null;
  active: boolean;
};

type Creators = {
  digestDate: string | null;
  collectedAt: string | null;
  statuses: Record<string, string>;
  headline: string | null;
  trend: string | null;
  lesson: string | null;
  winPattern: string | null;
  note: string | null;
  accounts: Account[];
  posts: Post[];
  dates: string[];
  error?: string;
};

/** 取得できなかった理由の言い方。0件と混ぜない。 */
const STATUS_TEXT: Record<string, string> = {
  blocked: "本日は見られませんでした（ログインが必要）",
  error: "本日は取得に失敗しました",
  partial: "一部だけ取得できました",
};

/** カテゴリーの色。news.css のトークンを当てる（大カテゴリーの配色と同じ系統）。 */
const CATEGORY_COLOR: Record<string, string> = {
  速報: "var(--cat-ai)",
  検証: "var(--cat-sales)",
  図解: "var(--cat-gov)",
  ビジネス活用: "var(--cat-os)",
  "経営者・VC": "var(--cat-lobby)",
  "政治・行政": "var(--ff-red-500)",
};

const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

function dateLabel(day: string): string {
  const [y, m, d] = day.split("-");
  const wd = WEEKDAY[new Date(`${day}T00:00:00Z`).getUTCDay()];
  return `${y}年${Number(m)}月${Number(d)}日（${wd}）`;
}

/** 収集した時刻を日本時間の「8/22 06:12」に。 */
function jstStamp(iso: string): string {
  const t = new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString();
  return `${Number(t.slice(5, 7))}/${Number(t.slice(8, 10))} ${t.slice(11, 16)}`;
}

function num(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("ja-JP");
}

export default function CreatorsPage() {
  const [d, setD] = useState<Creators | null>(null);
  const [failed, setFailed] = useState(false);
  // 見ている日。null なら最新。URLの ?date= から入れるのは初回だけ
  const [date, setDate] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // 取得失敗時に「もう一度読み込む」で再実行できるよう、reloadKeyで発火させる
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("date");
      if (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) setDate(q);
    } catch {
      // URL が読めなくても最新を出す
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setD(null);
    setFailed(false);
    fetch(`/api/news/creators${date ? `?date=${date}` : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((j) => alive && setD(j))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [ready, date, reloadKey]);

  // 日付を変えたら URL も合わせる（コピーして人に渡せるように）。履歴は積まない
  const go = useCallback((day: string) => {
    setDate(day);
    try {
      window.history.replaceState(null, "", `/news/creators?date=${day}`);
    } catch {
      // 失敗しても表示は変わる
    }
  }, []);

  const dates = d?.dates ?? [];
  const current = d?.digestDate ?? date;
  const idx = current ? dates.indexOf(current) : -1;
  // dates は降順。「前の日」は添字が増える方、「次の日」は減る方
  const prev = idx >= 0 && idx + 1 < dates.length ? dates[idx + 1] : null;
  const next = idx > 0 ? dates[idx - 1] : null;

  const accounts = d?.accounts ?? [];
  const active = accounts.filter((a) => a.active);
  const statuses = d?.statuses ?? {};
  const okCount = active.filter((a) => statuses[a.handle] === "ok").length;
  const partialCount = active.filter((a) => statuses[a.handle] === "partial").length;
  const missCount = active.filter(
    (a) => statuses[a.handle] === "blocked" || statuses[a.handle] === "error"
  ).length;

  // 発信者ごとに束ねる。並びはアカウント表の順（active が先、追加順）。
  // その日に投稿があるのに accounts に無い handle（後で外した人）も末尾に出す
  const groups = useMemo(() => {
    const byHandle = new Map<string, Post[]>();
    for (const p of d?.posts ?? []) {
      const arr = byHandle.get(p.handle) ?? [];
      arr.push(p);
      byHandle.set(p.handle, arr);
    }
    const ordered: { account: Account; posts: Post[] }[] = [];
    for (const a of accounts) {
      const posts = byHandle.get(a.handle) ?? [];
      // 今は外した人は、その日の投稿があるときだけ出す
      if (!a.active && posts.length === 0) continue;
      ordered.push({ account: a, posts });
      byHandle.delete(a.handle);
    }
    for (const [handle, posts] of byHandle) {
      ordered.push({
        account: {
          handle,
          displayName: `@${handle}`,
          url: `https://x.com/${handle}`,
          category: "",
          focus: null,
          followers: null,
          active: false,
        },
        posts,
      });
    }
    return ordered;
  }, [d, accounts]);

  const totalPosts = d?.posts.length ?? 0;

  return (
    <div className="nw">
      <div className="nw-accent" />

      <header className="nw-header">
        <div className="nw-shell nw-masthead">
          <div className="nw-brand">
            {/* 取得失敗時でも行き止まりにしない。戻り先は紙面（/news） */}
            <Link href="/news" className="nw-home">
              ← DX NEWS
            </Link>
            <h1 className="nw-logo">
              AI発信者ウォッチ<span>.</span>
            </h1>
            <span className="nw-tagline">
              毎朝6:00 自動収集 ／ {active.length > 0 ? `${active.length}名を監視` : "Xの発信者"}
            </span>
          </div>
          <div className="nw-meta">
            <Link href="/" className="nw-home">
              ホーム
            </Link>
          </div>
        </div>
      </header>

      <main className="nw-shell" style={{ paddingBottom: "4rem" }}>
        {/* ---------- 日付ナビ ---------- */}
        <div className="nw-cr-nav">
          <div>
            <div className="nw-cr-nav-date">
              {current ? dateLabel(current) : failed ? "取得できず" : d ? "まだ取得していません" : "読み込み中"}
            </div>
            <span className="nw-cr-nav-sub">
              {d?.collectedAt ? `収集 ${jstStamp(d.collectedAt)}` : "収集 未取得"}
              {d?.digestDate && active.length > 0 && (
                <>
                  {" ／ "}
                  {active.length}名中 {okCount}名取得
                  {partialCount > 0 && `、${partialCount}名は一部だけ`}
                  {missCount > 0 && `、${missCount}名は見られず`}
                </>
              )}
              {d?.digestDate && ` ／ 投稿 ${totalPosts}件`}
            </span>
          </div>
          <div className="nw-cr-nav-btns">
            <button
              type="button"
              className="nw-cr-nav-btn"
              disabled={!prev}
              onClick={() => prev && go(prev)}
            >
              ← 前の日
            </button>
            <button
              type="button"
              className="nw-cr-nav-btn"
              disabled={!next}
              onClick={() => next && go(next)}
            >
              次の日 →
            </button>
          </div>
        </div>

        {failed ? (
          <div className="nw-empty">
            取得に失敗しました
            <br />
            <button type="button" className="nw-retry" onClick={() => setReloadKey((k) => k + 1)}>
              もう一度読み込む
            </button>
          </div>
        ) : !d ? (
          <div style={{ paddingTop: "1rem" }}>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="nw-skel" />
            ))}
          </div>
        ) : !d.digestDate ? (
          <p className="nw-empty">
            {date
              ? `${dateLabel(date)} は収集していません。`
              : "まだ一度も収集していません。毎朝6時に取り込まれます。"}
            {dates.length > 0 && (
              <>
                <br />
                <button type="button" className="nw-retry" onClick={() => go(dates[0])}>
                  最新（{dateLabel(dates[0])}）を見る
                </button>
              </>
            )}
          </p>
        ) : (
          <>
            {/* ---------- 総括4ブロック ---------- */}
            <section className="nw-cr-summary" aria-label="今日の総括">
              <div className="nw-cr-block is-wide">
                <div className="nw-cr-block-head">今日の動向</div>
                <p className={`nw-cr-block-body${d.headline ? "" : " is-empty"}`}>
                  {d.headline ?? "（総括なし）"}
                </p>
              </div>
              <div className="nw-cr-block">
                <div className="nw-cr-block-head">今日いちばんの話題</div>
                <p className={`nw-cr-block-body${d.trend ? "" : " is-empty"}`}>
                  {d.trend ?? "（記載なし）"}
                </p>
              </div>
              <div className="nw-cr-block">
                <div className="nw-cr-block-head">今日の学び</div>
                <p className={`nw-cr-block-body${d.lesson ? "" : " is-empty"}`}>
                  {d.lesson ?? "（記載なし）"}
                </p>
              </div>
              <div className="nw-cr-block is-wide">
                <div className="nw-cr-block-head">勝ち投稿の書き方</div>
                <p className={`nw-cr-block-body${d.winPattern ? "" : " is-empty"}`}>
                  {d.winPattern ?? "（記載なし）"}
                </p>
              </div>
            </section>
            {d.note && <p className="nw-card-note">{d.note}</p>}

            {/* ---------- 投稿一覧 ---------- */}
            <h2 className="nw-cr-sechead">
              <b>投稿一覧</b>
              <span>発信者ごと ／ {totalPosts}件</span>
            </h2>
            {groups.map(({ account: a, posts }) => {
              const st = statuses[a.handle];
              return (
                <section key={a.handle} className="nw-cr-group" aria-label={a.displayName}>
                  <div className="nw-cr-group-head">
                    <span className="nw-cr-group-name">{a.displayName}</span>
                    <a
                      className="nw-cr-group-handle"
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      @{a.handle}
                    </a>
                    {a.category && (
                      <span
                        className="nw-cr-cat"
                        style={{ background: CATEGORY_COLOR[a.category] ?? "var(--cat-other)" }}
                      >
                        {a.category}
                      </span>
                    )}
                    {!a.active && <span className="nw-card-note">（監視対象外）</span>}
                    {a.focus && <span className="nw-cr-group-focus">{a.focus}</span>}
                  </div>
                  {posts.length > 0 ? (
                    posts.map((p) => (
                      <article key={p.sortOrder} className="nw-cr-post">
                        <div className="nw-cr-post-meta">
                          {p.postedAt && <span>{p.postedAt}</span>}
                          {p.likes !== null && <span>♥ {num(p.likes)}</span>}
                          {p.reposts !== null && <span>🔁 {num(p.reposts)}</span>}
                          {p.replies !== null && <span>💬 {num(p.replies)}</span>}
                          {p.pattern && <span className="nw-cr-pattern">{p.pattern}</span>}
                          {p.url && (
                            <a href={p.url} target="_blank" rel="noopener noreferrer">
                              投稿を開く
                            </a>
                          )}
                        </div>
                        <p className="nw-cr-post-body">{p.body}</p>
                        {p.summary && <p className="nw-cr-post-summary">{p.summary}</p>}
                        {p.whyItWorks && <p className="nw-cr-post-why">{p.whyItWorks}</p>}
                      </article>
                    ))
                  ) : (
                    <p className="nw-cr-group-empty">
                      {!st
                        ? "まだ取得していません"
                        : st === "ok"
                          ? "直近24時間の投稿はありませんでした"
                          : (STATUS_TEXT[st] ?? "本日は見られませんでした")}
                    </p>
                  )}
                </section>
              );
            })}
          </>
        )}

        {/* ---------- 監視しているアカウント ---------- */}
        {accounts.length > 0 && (
          <>
            <h2 className="nw-cr-sechead">
              <b>監視しているアカウント</b>
              <span>{active.length}名</span>
            </h2>
            <div className="nw-cr-table-wrap">
              <table className="nw-cr-table">
                <thead>
                  <tr>
                    <th>表示名</th>
                    <th>@handle</th>
                    <th>カテゴリー</th>
                    <th>主な発信</th>
                    <th style={{ textAlign: "right" }}>フォロワー</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.handle} className={a.active ? undefined : "is-inactive"}>
                      <td>
                        {a.displayName}
                        {!a.active && "（停止中）"}
                      </td>
                      <td>
                        <a href={a.url} target="_blank" rel="noopener noreferrer">
                          @{a.handle}
                        </a>
                      </td>
                      <td>{a.category}</td>
                      <td>{a.focus ?? ""}</td>
                      <td className="is-num">{a.followers === null ? "—" : num(a.followers)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <p className="nw-foot">
          <Link href="/news">DX NEWS へ戻る</Link>
          {" ／ "}
          <Link href="/">ホームへ戻る</Link>
        </p>
      </main>
    </div>
  );
}

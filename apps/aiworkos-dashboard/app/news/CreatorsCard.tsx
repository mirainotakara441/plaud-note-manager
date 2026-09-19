"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

// 右カラムの「AI発信者ウォッチ」カード。X監視ダイジェストの3枚の下に置く。
//
// 毎朝6時に16名のXアカウントを読んだ結果のうち、紙面に載せるのは
// 「今日の動向」「今日の学び」「いいね上位5件」だけ。全員ぶんは /news/creators。
// fetch は /api/news/creators を別途叩く（X監視ダイジェストと待ち合わせない。
// 片方が遅くても、もう片方は先に出す）。
//
// 取れなかった朝の言い方は XDigest.tsx の stateLine と同じ。空欄で誤魔化さない。

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
  blocked: "ログインが必要で見られませんでした",
  error: "取得に失敗しました",
  partial: "一部だけ取得できました",
};

/** 全員ぶんの statuses を1つの状態にまとめる。1人でも ok なら ok 扱い。 */
function overallStatus(statuses: Record<string, string>): string | undefined {
  const vals = Object.values(statuses);
  if (vals.length === 0) return undefined;
  if (vals.some((v) => v === "ok")) return "ok";
  if (vals.some((v) => v === "partial")) return "partial";
  if (vals.every((v) => v === "blocked")) return "blocked";
  return "error";
}

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

const TOP_N = 5;

export default function CreatorsCard() {
  const [d, setD] = useState<Creators | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/news/creators", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((j) => alive && setD(j))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const stamp = d?.collectedAt ? jstStamp(d.collectedAt) : "未取得";
  const nameOf = new Map((d?.accounts ?? []).map((a) => [a.handle, a.displayName]));
  const activeCount = (d?.accounts ?? []).filter((a) => a.active).length;
  const okCount = Object.values(d?.statuses ?? {}).filter((v) => v === "ok").length;

  // いいね数上位5件。数が取れていない投稿（null）は順位に入れない
  const top = (d?.posts ?? [])
    .filter((p) => p.likes !== null)
    .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
    .slice(0, TOP_N);

  return (
    <div className="nw-card">
      <div className="nw-card-head">
        <span className="nw-card-title">
          AI発信者ウォッチ{activeCount > 0 ? `（${activeCount}名）` : ""}
        </span>
        <span className="nw-card-note">
          {stamp}
          {d?.digestDate && activeCount > 0 ? ` ／ ${okCount}名取得` : ""}
        </span>
      </div>

      {d?.digestDate ? (
        <>
          {d.headline && (
            <div className="nw-card-row">
              <p className="nw-card-lead">{d.headline}</p>
            </div>
          )}
          {d.lesson && (
            <div className="nw-card-row">
              <p className="nw-card-note" style={{ marginBottom: "0.25rem" }}>
                今日の学び
              </p>
              <p className="nw-card-body">{d.lesson}</p>
            </div>
          )}
          {top.length > 0 ? (
            top.map((p) => (
              <div key={`${p.handle}-${p.sortOrder}`} className="nw-card-row">
                <div className="nw-kw">
                  {p.url ? (
                    <a className="nw-kw-name" href={p.url} target="_blank" rel="noopener noreferrer">
                      {nameOf.get(p.handle) ?? `@${p.handle}`}
                    </a>
                  ) : (
                    <span className="nw-kw-name">{nameOf.get(p.handle) ?? `@${p.handle}`}</span>
                  )}
                  {p.likes !== null && (
                    <span className="nw-kw-metric">♥ {p.likes.toLocaleString("ja-JP")}</span>
                  )}
                </div>
                <p className="nw-card-body">{p.summary ?? p.body}</p>
              </div>
            ))
          ) : (
            <div className="nw-card-row">
              <p className="nw-card-body">
                {stateLine(overallStatus(d.statuses), "直近24時間で目立った投稿はありませんでした")}
              </p>
            </div>
          )}
          <Link href="/news/creators" className="nw-card-foot">
            全員ぶんを見る →
          </Link>
        </>
      ) : (
        <>
          <div className="nw-card-row">
            <p className="nw-card-body">
              {failed ? "取得に失敗しました" : stateLine(undefined, "")}
            </p>
          </div>
          {!failed && d && (
            <Link href="/news/creators" className="nw-card-foot">
              監視しているアカウント →
            </Link>
          )}
        </>
      )}
    </div>
  );
}

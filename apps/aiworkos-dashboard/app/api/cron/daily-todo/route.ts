import { NextRequest, NextResponse } from "next/server";
import webpush from "web-push";

// 毎朝、Vercel Cronから叩かれるエンドポイント。
//   ①一行日記から「やってみよう/本日のポイント」を自動取込（/actionsの手動ボタンと同じRPC）
//   ②未完のToDo件数を数える
//   ③購読している端末へPush通知を送る（何も変化が無ければ通知しない＝無音）
//
// Vercel Cronのリクエストには合言葉認証のcookieが無いため、proxy.tsでこのパスは
// 認証をバイパスしている。代わりにここで CRON_SECRET を照合して保護する
// （Vercelは CRON_SECRET 環境変数がある場合、Cron実行時に自動で
//   Authorization: Bearer $CRON_SECRET ヘッダーを付ける）。

export const dynamic = "force-dynamic";

function creds() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return { url, anon };
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET未設定" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  const c = creds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  // ①日記からの自動取込
  let added = 0;
  try {
    const res = await fetch(`${c.url}/rest/v1/rpc/import_diary_actions`, {
      method: "POST",
      headers: { apikey: c.anon, Authorization: `Bearer ${c.anon}`, "Content-Type": "application/json" },
      body: JSON.stringify({ lookback_days: 30 }),
    });
    if (res.ok) {
      const n = await res.json();
      added = typeof n === "number" ? n : 0;
    }
  } catch {
    // 取込に失敗しても、通知（未完件数のお知らせ）は続行する
  }

  // ②未完件数（HEADリクエスト＋Prefer:count=exactで、行本体を取らずに件数だけ得る）
  let remaining = 0;
  try {
    const res = await fetch(`${c.url}/rest/v1/daily_actions?select=id&done=eq.false`, {
      method: "HEAD",
      headers: { apikey: c.anon, Authorization: `Bearer ${c.anon}`, Prefer: "count=exact" },
    });
    const range = res.headers.get("content-range"); // 例: "0-9/23"
    remaining = range ? Number(range.split("/")[1] ?? 0) : 0;
  } catch {
    // 件数が取れなくても通知自体は試みる（0件表示にはしない＝下のガードで送信自体をスキップ）
  }

  // 新規取込も無く、未完も無ければ、静かに終わる（毎朝「0件です」を送って邪魔しない）
  if (added === 0 && remaining === 0) {
    return NextResponse.json({ added, remaining, sent: 0, removed: 0, skipped: true });
  }

  // ③Push送信
  const vapidPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  let sent = 0;
  let removed = 0;
  // 診断用: 送信に失敗した場合の要旨を残す（原因切り分けのため。本番安定後は削ってよい）。
  const errors: string[] = [];
  if (!vapidPublic || !vapidPrivate) {
    errors.push("VAPIDキーが未設定です");
  } else {
    webpush.setVapidDetails("mailto:mirainotakara441@gmail.com", vapidPublic, vapidPrivate);
    try {
      const subsRes = await fetch(`${c.url}/rest/v1/push_subscriptions?select=endpoint,p256dh,auth`, {
        headers: { apikey: c.anon, Authorization: `Bearer ${c.anon}` },
      });
      const subs: { endpoint: string; p256dh: string; auth: string }[] = subsRes.ok
        ? await subsRes.json()
        : [];
      if (!subsRes.ok) errors.push(`購読取得失敗 HTTP ${subsRes.status}`);
      const body =
        added > 0
          ? `日記から${added}件を取り込みました。未完は${remaining}件です`
          : `未完のToDoが${remaining}件あります`;
      const payload = JSON.stringify({ title: "日々のToDo", body, url: "/actions" });

      for (const s of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload
          );
          sent++;
        } catch (e) {
          const status = (e as { statusCode?: number })?.statusCode;
          const body = (e as { body?: string })?.body;
          const msg = (e as { message?: string })?.message;
          console.error("push送信失敗", { endpoint: s.endpoint.slice(0, 60), status, body, msg });
          errors.push(`push失敗(${status ?? "?"}): ${body || msg || String(e)}`.slice(0, 200));
          if (status === 404 || status === 410) {
            // 購読が端末側で失効している。掃除する。
            await fetch(
              `${c.url}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`,
              { method: "DELETE", headers: { apikey: c.anon, Authorization: `Bearer ${c.anon}` } }
            );
            removed++;
          }
        }
      }
    } catch (e) {
      console.error("push送信処理全体でエラー", e);
      errors.push(`全体エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return NextResponse.json({ added, remaining, sent, removed, errors });
}

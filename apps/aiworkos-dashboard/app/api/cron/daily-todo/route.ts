import { NextRequest, NextResponse } from "next/server";
import webpush from "web-push";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";
import {
  WATCHED_JOBS,
  WATCHED_SERVICES,
  DIARY_STALE_THRESHOLD_DAYS,
  HEALTH_STALE_THRESHOLD_DAYS,
} from "@/lib/advisor/watchlist";

// 毎朝、Vercel Cronから叩かれるエンドポイント。
//   ①一行日記から「やってみよう/本日のポイント」を自動取込（/actionsの手動ボタンと同じRPC）
//   ②未完のToDo件数を数える
//   ③日記の途絶検知（memory_chunks(source_type=日記)のmax(event_date)が3日以上前なら通知に含める）
//   ④自動化の途絶検知（定期実行ジョブの心拍と、健康データの新しさ）
//   ⑤購読している端末へPush通知を送る（何も変化が無ければ通知しない＝無音）
//
// ③は2026-07-26追加。/diary ページ＋断絶解消前は「Notion一行日記DB→Supabase」の
// 転記が完全アドホックで、対象0件のまま①②が無言で終わり、断絶に何日も気づけなかった
// （2026-07-20を最後に196件で止まっていたのに気づいたのは実測調査時）。
// 未完ToDoが0件でも、日記が滞っている場合はそれ単体で通知する。
//
// ④は2026-08-01追加。日報録のlaunchdジョブが通信断でexit 1のまま止まっても
// 誰にも知らされず、実測調査で初めて気づいた（③と同じ失敗の再演）。
// 「データが増えていない」だけでは休日と故障を見分けられないため、
// ジョブ側が成功のたびに job_heartbeats へ打刻し、ここはその途絶を見る。
// 健康データは複数の経路（HealthPlanet/カロミル/iPhone）から毎日入るので
// データそのものの新しさで判定してよい。
//
// Vercel Cronのリクエストには合言葉認証のcookieが無いため、proxy.tsでこのパスは
// 認証をバイパスしている。代わりにここで CRON_SECRET を照合して保護する
// （Vercelは CRON_SECRET 環境変数がある場合、Cron実行時に自動で
//   Authorization: Bearer $CRON_SECRET ヘッダーを付ける）。

export const dynamic = "force-dynamic";

// 監視対象と閾値は lib/advisor/watchlist.ts に集約した（2026-08-03）。
// ホームの「今朝の気づき」(/api/advisor) も同じ定義を読む。ここと2か所に
// 書いていると片方だけ直したときに言い分が食い違い、どちらが正しいのか
// 分からなくなる。
//
// 打刻は各ジョブの成功時のみ。日報録は自前で打ち、それ以外は
// ~/.local/bin/with-heartbeat.sh が包んで打つ（本体には手を入れていない）。
// job_heartbeats に行が無いジョブは「まだ一度も成功していない」だけなので
// 警告しない（動いていたものが止まった時だけ鳴らす）。
//
// service_health 側は notify=true のものだけ通知に含める。eight（人脈DBの取込）は
// 月1回の手動運用なので毎朝鳴らすと邪魔になり、通知そのものを無視するようになる。
// 代わりにホームのカードには7日で出す。
const NOTIFIED_SERVICES = WATCHED_SERVICES.filter((s) => s.notify);

// JST基準の「今日」を YYYY-MM-DD で返す（Vercel Cronの実行環境はUTCのため）。
function jstTodayStr(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// 日付文字列同士の差分日数（両方ともUTC正午基準で解釈し、タイムゾーンのずれで
// 1日ぶれることを避ける）。
function daysBetween(laterDateStr: string, earlierDateStr: string): number {
  const later = new Date(`${laterDateStr}T00:00:00Z`).getTime();
  const earlier = new Date(`${earlierDateStr}T00:00:00Z`).getTime();
  return Math.round((later - earlier) / (24 * 60 * 60 * 1000));
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET未設定" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  const anon = anonCreds();
  const service = serviceCreds();
  if (!anon || !service) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  // ①日記からの自動取込（RPCは書き込みを伴うので service role）
  let added = 0;
  try {
    const res = await fetch(`${service.url}/rest/v1/rpc/import_diary_actions`, {
      method: "POST",
      headers: restHeaders(service.key),
      body: JSON.stringify({ lookback_days: 30 }),
    });
    if (res.ok) {
      const n = await res.json();
      added = typeof n === "number" ? n : 0;
    }
  } catch (err) {
    // 取込に失敗しても、通知（未完件数のお知らせ）は続行する
    console.error("cron/daily-todo: import_diary_actions失敗", err);
  }

  // ②未完件数（HEADリクエスト＋Prefer:count=exactで、行本体を取らずに件数だけ得る。読み取りなのでanon）
  let remaining = 0;
  try {
    const res = await fetch(`${anon.url}/rest/v1/daily_actions?select=id&done=eq.false`, {
      method: "HEAD",
      headers: restHeaders(anon.key, { Prefer: "count=exact" }),
    });
    const range = res.headers.get("content-range"); // 例: "0-9/23"
    remaining = range ? Number(range.split("/")[1] ?? 0) : 0;
  } catch (err) {
    // 件数が取れなくても通知自体は試みる（0件表示にはしない＝下のガードで送信自体をスキップ）
    console.error("cron/daily-todo: 未完件数の取得失敗", err);
  }

  // ③日記の途絶検知（source_type=日記のmax(event_date)。書き込みではないが、
  // 他の項目と同じくservice roleで統一する）
  let diaryStaleDays: number | null = null;
  try {
    const res = await fetch(
      `${service.url}/rest/v1/memory_chunks?select=event_date&source_type=eq.${encodeURIComponent(
        "日記"
      )}&event_date=not.is.null&order=event_date.desc&limit=1`,
      { headers: restHeaders(service.key), cache: "no-store" }
    );
    if (res.ok) {
      const rows: { event_date: string | null }[] = await res.json();
      const latest = rows[0]?.event_date ?? null;
      if (latest) {
        diaryStaleDays = daysBetween(jstTodayStr(), latest);
      }
    }
  } catch (err) {
    console.error("cron/daily-todo: 日記の最終登録日取得失敗", err);
  }
  const diaryStale = diaryStaleDays !== null && diaryStaleDays >= DIARY_STALE_THRESHOLD_DAYS;

  // ④自動化の途絶検知。文言はそのまま通知本文に足すので、異常な項目だけを入れる。
  const staleAlerts: string[] = [];

  // ④-1 ジョブの心拍。行が無い＝一度も成功していない（打刻前の初回だけ起きる）
  // ので、その場合は警告しない。動いていたものが止まった時だけ鳴らす。
  try {
    const res = await fetch(
      `${service.url}/rest/v1/job_heartbeats?select=job,last_ok_at`,
      { headers: restHeaders(service.key), cache: "no-store" }
    );
    if (res.ok) {
      const rows: { job: string; last_ok_at: string }[] = await res.json();
      const beats = new Map(rows.map((r) => [r.job, r.last_ok_at]));
      for (const w of WATCHED_JOBS) {
        const last = beats.get(w.job);
        if (!last) continue;
        const hours = (Date.now() - new Date(last).getTime()) / (60 * 60 * 1000);
        if (hours >= w.staleHours) {
          staleAlerts.push(`${w.label}が${Math.floor(hours / 24)}日止まっています`);
        }
      }
    }
  } catch (err) {
    console.error("cron/daily-todo: ジョブ心拍の取得失敗", err);
  }

  // ④-2 Claudeスケジュールタスクの自己申告（service_health）。
  // last_ok_at は「最後に成功した時刻」。失敗した回は各タスクが更新しない作法なので、
  // 途絶＝実行されていないか、失敗し続けているかのどちらか。
  try {
    const res = await fetch(
      `${service.url}/rest/v1/service_health?select=service,last_ok_at`,
      { headers: restHeaders(service.key), cache: "no-store" }
    );
    if (res.ok) {
      const rows: { service: string; last_ok_at: string | null }[] = await res.json();
      const health = new Map(rows.map((r) => [r.service, r.last_ok_at]));
      for (const w of NOTIFIED_SERVICES) {
        const last = health.get(w.service);
        if (!last) continue;
        const days = Math.floor(
          (Date.now() - new Date(last).getTime()) / (24 * 60 * 60 * 1000)
        );
        if (days >= w.staleDays) {
          staleAlerts.push(`${w.label}が${days}日止まっています`);
        }
      }
    }
  } catch (err) {
    console.error("cron/daily-todo: service_healthの取得失敗", err);
  }

  // ④-3 健康データの新しさ
  let healthStaleDays: number | null = null;
  try {
    const res = await fetch(
      `${service.url}/rest/v1/health_metrics?select=day&order=day.desc&limit=1`,
      { headers: restHeaders(service.key), cache: "no-store" }
    );
    if (res.ok) {
      const rows: { day: string | null }[] = await res.json();
      const latest = rows[0]?.day ?? null;
      if (latest) healthStaleDays = daysBetween(jstTodayStr(), latest);
    }
  } catch (err) {
    console.error("cron/daily-todo: 健康データの最終日取得失敗", err);
  }
  if (healthStaleDays !== null && healthStaleDays >= HEALTH_STALE_THRESHOLD_DAYS) {
    staleAlerts.push(`健康データが${healthStaleDays}日ぶん未取込です`);
  }

  // 新規取込も無く、未完も無く、日記も自動化も滞っていなければ、静かに終わる
  // （毎朝「0件です」を送って邪魔しない）
  if (added === 0 && remaining === 0 && !diaryStale && staleAlerts.length === 0) {
    return NextResponse.json({
      added,
      remaining,
      sent: 0,
      removed: 0,
      skipped: true,
      diaryStaleDays,
      healthStaleDays,
      staleAlerts,
    });
  }

  // ④Push送信
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
      const subsRes = await fetch(`${anon.url}/rest/v1/push_subscriptions?select=endpoint,p256dh,auth`, {
        headers: restHeaders(anon.key),
      });
      const subs: { endpoint: string; p256dh: string; auth: string }[] = subsRes.ok
        ? await subsRes.json()
        : [];
      if (!subsRes.ok) errors.push(`購読取得失敗 HTTP ${subsRes.status}`);
      let body: string;
      if (added > 0) {
        body = `日記から${added}件を取り込みました。未完は${remaining}件です`;
      } else if (remaining > 0) {
        body = `未完のToDoが${remaining}件あります`;
      } else {
        body = "今日は特にありません";
      }
      if (diaryStale) {
        body += `。日記が${diaryStaleDays}日ぶん未登録です`;
      }
      for (const a of staleAlerts) {
        body += `。${a}`;
      }
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
            // 購読が端末側で失効している。掃除する（削除は service role）。
            await fetch(
              `${service.url}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`,
              { method: "DELETE", headers: restHeaders(service.key) }
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

  return NextResponse.json({
    added,
    remaining,
    sent,
    removed,
    errors,
    diaryStaleDays,
    healthStaleDays,
    staleAlerts,
  });
}

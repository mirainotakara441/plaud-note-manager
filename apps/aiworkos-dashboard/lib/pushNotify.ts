import webpush from "web-push";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";

// 登録済みの全端末（push_subscriptions）へプッシュ通知を送る。
// app/api/cron/daily-todo/route.ts の④Push送信と同じ手順を関数にしたもの。
// 失効した購読（404/410）は掃除する。VAPID 未設定なら何もしない（失敗にしない）。

export async function sendPushToAll(payload: {
  title: string;
  body: string;
  url?: string;
}): Promise<{ sent: number; removed: number; skipped?: string }> {
  const vapidPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const anon = anonCreds();
  const service = serviceCreds();
  if (!vapidPublic || !vapidPrivate) return { sent: 0, removed: 0, skipped: "VAPID未設定" };
  if (!anon || !service) return { sent: 0, removed: 0, skipped: "Supabase未設定" };

  webpush.setVapidDetails("mailto:mirainotakara441@gmail.com", vapidPublic, vapidPrivate);
  const subsRes = await fetch(`${anon.url}/rest/v1/push_subscriptions?select=endpoint,p256dh,auth`, {
    headers: restHeaders(anon.key),
    cache: "no-store",
  });
  const subs: { endpoint: string; p256dh: string; auth: string }[] = subsRes.ok
    ? await subsRes.json()
    : [];
  const body = JSON.stringify({ title: payload.title, body: payload.body, url: payload.url ?? "/" });
  let sent = 0;
  let removed = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body
      );
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number })?.statusCode;
      console.error("push送信失敗", { endpoint: s.endpoint.slice(0, 60), status });
      if (status === 404 || status === 410) {
        await fetch(
          `${service.url}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`,
          { method: "DELETE", headers: restHeaders(service.key) }
        ).catch(() => {});
        removed++;
      }
    }
  }
  return { sent, removed };
}

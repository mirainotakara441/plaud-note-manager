"use client";

import { useEffect, useState } from "react";

// 日々のToDoの朝の通知（Web Push）を有効化・解除するトグル。
// サービスワーカー(/sw.js)を登録し、許可を取ってから購読情報を /api/push/subscribe へ送る。
// 実際の送信は Vercel Cron（/api/cron/daily-todo）が毎朝行う。

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
  return output;
}

type Status = "unsupported" | "checking" | "off" | "on" | "denied";

export default function NotificationOptIn() {
  const [status, setStatus] = useState<Status>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !VAPID_PUBLIC_KEY
    ) {
      setStatus("unsupported");
      return;
    }
    navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (Notification.permission === "denied") setStatus("denied");
        else setStatus(sub ? "on" : "off");
      })
      .catch(() => setStatus("unsupported"));
  }, []);

  async function enable() {
    if (!VAPID_PUBLIC_KEY || busy) return;
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("denied");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) throw new Error("登録に失敗しました");
      setStatus("on");
    } catch (e) {
      setError(e instanceof Error ? e.message : "通知の登録に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setStatus("off");
    } catch (e) {
      setError(e instanceof Error ? e.message : "解除に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  if (status === "unsupported" || status === "checking") return null;

  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-800">
            {status === "on"
              ? "🔔 朝の通知：有効"
              : status === "denied"
                ? "🔕 通知がブロックされています"
                : "🔕 朝の通知：無効"}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-gray-500">
            {status === "denied"
              ? "端末（ブラウザ）の通知設定でこのサイトを許可してください"
              : "毎朝、日記からの自動取込結果と未完のToDo件数を通知します"}
          </p>
        </div>
        {status !== "denied" && (
          <button
            type="button"
            onClick={status === "on" ? disable : enable}
            disabled={busy}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold transition disabled:opacity-40 ${
              status === "on"
                ? "border border-gray-200 bg-white text-gray-500 active:bg-gray-50"
                : "bg-emerald-600 text-white active:bg-emerald-700"
            }`}
          >
            {busy ? "処理中…" : status === "on" ? "無効にする" : "有効にする"}
          </button>
        )}
      </div>
      {error && (
        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
      )}
    </div>
  );
}

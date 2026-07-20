// 日々のToDoの朝の通知（Web Push）を受け取るための最小限のService Worker。
// push: サーバーから届いたプッシュを画面通知として表示する。
// notificationclick: 通知をタップしたら /actions を開く（既に開いていればそのタブにフォーカス）。

self.addEventListener("push", (event) => {
  let data = { title: "AIワークOS", body: "" };
  try {
    if (event.data) data = event.data.json();
  } catch {
    if (event.data) data = { title: "AIワークOS", body: event.data.text() };
  }
  const title = data.title || "AIワークOS";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/actions" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/actions";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(url) && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

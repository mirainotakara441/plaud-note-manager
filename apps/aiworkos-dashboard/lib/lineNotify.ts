// LINE Messaging API で吉井さん本人へテキストを1通pushする最小ヘルパー。
//
// Web Push（lib/pushNotify.ts）だけだと、購読した端末のブラウザ通知を
// 見逃したときに気づけない。納期リマインドのような「絶対落とせない」通知は
// 毎日必ず開くLINEにも並行して流す。
//
// 環境変数（LINE_CHANNEL_ACCESS_TOKEN / LINE_USER_ID）が未設定なら
// {ok:false, skipped} を返して静かにスキップする。pushNotify.ts の
// VAPID未設定時と同じ思想: 片方の経路が未構成でも全体を失敗にしない。

export async function sendLineToYoshii(
  text: string
): Promise<{ ok: boolean; skipped?: string }> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  const userId = process.env.LINE_USER_ID?.trim();
  if (!token || !userId) return { ok: false, skipped: "LINE未設定" };

  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("LINE push送信失敗", res.status, detail.slice(0, 200));
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    // ネットワーク断などでLINEに届かなくても、呼び出し元のWeb Push送信は
    // 生かしたいので例外を外へ投げない。
    console.error("LINE push送信失敗", e);
    return { ok: false };
  }
}

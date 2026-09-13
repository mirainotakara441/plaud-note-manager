// Next.js サーバー起動時に1回だけ走るフック（Next 15+ で標準）。
//
// ■ なぜあるか: Node の名前解決を IPv4 優先にする（2026-09-12）
//
// 【障害】夜間参謀・提案の夜間仕込み・/ask で、Anthropic API への呼び出しが
//   「Connection error.」で断続的に落ちた。再試行しても落ちる時間帯があり、
//   最小の16トークン呼び出しでも3連続で失敗した。
//
// 【切り分け】curl は同じ瞬間に api.anthropic.com へ到達できていた。
//   Node の https で family を固定して比較したところ、
//     IPv4: 401（到達。キー無しなので正しい応答）
//     IPv6: EHOSTUNREACH（経路そのものが無い）
//   ＝この環境（自宅ルーター）は AAAA レコードを引けるのに IPv6 の経路が通って
//   いない。curl は素早く IPv4 へフォールバックするが、Node は解決順のまま
//   IPv6 を掴んで落ちることがある。「4回成功して5回目に落ちる」ように見えたのは、
//   接続プールの張り直しのたびに IPv6 を引くかどうかの運だった。
//
// 【対処】プロセス全体の名前解決を IPv4 優先へ。IPv6 が正しく通る環境でも
//   実害はない（遅延がわずかに変わりうる程度）。Vercel 上でも無害。
//   launchd から起こす場合も、このファイルは Next の起動経路に入っているので効く。
//
// ルーターの IPv6 設定が直ったとしても、これを外す必要はない。
// 外部APIに依存する無人ジョブ（毎晩の夜間参謀）が「環境の運」で落ちる構造の方が問題。

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const dns = await import("node:dns");
    dns.setDefaultResultOrder("ipv4first");
  }
}

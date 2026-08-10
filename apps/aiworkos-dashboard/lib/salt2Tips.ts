// SALT2 AIサマーブートキャンプ Slack「#0404_お役立ち情報」（運営からのTips投稿）の
// 読み取り専用ダイジェスト（/bootcamp/tips）の共通部品。
//
// 出典は salt2_qa_log。毎日21:30 JSTに自動同期される側とこの画面は完全に分業していて、
// ここは溜まった行を読んで並べるだけ（書き込みは持たない）。
//
// このファイルは /bootcamp/tips ページ（クライアント）から読むので、
// next/server などサーバー専用のものは import しない。

export type Salt2Tip = {
  message_ts: string;
  text: string;
  permalink: string;
  posted_at: string; // ISO timestamptz
};

// 曜日の並びはJSのgetDay()と同じ添字（0=日）。カレンダー表記に合わせて漢字1文字。
const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

// 「2026-08-08T16:06:00+09:00」→「8月8日（土）16:06」。
// salt2.ts の fmtPostedAt は年月日だけ（一覧カードの隅に小さく出す用途）なので、
// Slackの投稿順を読み解くこの画面では曜日と時刻まで持つ別関数にしている
// （用途が違うぶん使い回すと片方の変更がもう片方に効いてしまうため、あえて分けた）。
export function fmtPostedAt(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  // JSTはタイムゾーンDBを引かなくても常にUTC+9で固定なので、オフセット固定加算で足りる。
  const jst = new Date(t + 9 * 60 * 60 * 1000);
  const month = jst.getUTCMonth() + 1;
  const date = jst.getUTCDate();
  const weekday = WEEKDAY_JA[jst.getUTCDay()];
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${month}月${date}日（${weekday}）${hh}:${mm}`;
}

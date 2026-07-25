// UTCタイムスタンプをJST（UTC+9）の日付文字列(YYYY-MM-DD)に変換する。
// Supabaseのcreated_at等はUTCタイムスタンプとして返るため、単純に
// `.slice(0, 10)` すると日本時間の00:00〜08:59に作成されたレコードが
// 前日の日付として扱われてしまう（2026-07-25 アーキテクチャレビュー P2対応）。
export function toJstDateString(utcIso: string): string {
  const d = new Date(utcIso);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

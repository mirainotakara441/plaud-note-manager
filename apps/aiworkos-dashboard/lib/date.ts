// UTCタイムスタンプをJST（UTC+9）の日付文字列(YYYY-MM-DD)に変換する。
// Supabaseのcreated_at等はUTCタイムスタンプとして返るため、単純に
// `.slice(0, 10)` すると日本時間の00:00〜08:59に作成されたレコードが
// 前日の日付として扱われてしまう（2026-07-25 アーキテクチャレビュー P2対応）。
export function toJstDateString(utcIso: string): string {
  const d = new Date(utcIso);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// "YYYY-MM-DD" が実在する暦日かどうかを判定する。
// 正規表現の形式チェックだけでは 2026-02-30 のような存在しない日付を通してしまい、
// new Date() に渡すと自動繰り上がり（3/2 扱い）で気づかれずに保存されてしまう。
export function isValidCalendarDate(dateStr: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return false;
  const [, y, mo, d] = m;
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() + 1 === Number(mo) &&
    date.getUTCDate() === Number(d)
  );
}

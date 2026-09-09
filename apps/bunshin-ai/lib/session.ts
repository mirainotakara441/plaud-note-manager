// 合言葉と利用者名の扱い。AIワークOS本体（aiworkos-dashboard）とは
// 別アプリ・別Vercelプロジェクト・別合言葉で運用する。
//
// このアプリはメンバーに配る前提なので、AIワークOS本体の合言葉（APP_PASSPHRASE）
// は一切使わない。ここが漏れても本体側には届かない。
//
// cookie は3つ：
//   bunshin_auth  … 合言葉を通した証明（httpOnly / 90日）
//   bunshin_name  … 誰が使っているか（相談ログに残す。httpOnly / 90日）
//   bunshin_admin … 吉井さん専用。/admin（相談ログ一覧）を開けるかどうか

export const AUTH_COOKIE = "bunshin_auth";
export const NAME_COOKIE = "bunshin_name";
export const ADMIN_COOKIE = "bunshin_admin";

// 90日。本体（1年）より短くしているのは、配る相手が増える前提のため。
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 90;

export function memberPassphrase(): string | null {
  const v = process.env.BUNSHIN_PASSPHRASE?.trim();
  return v && v !== "" ? v : null;
}

export function adminPassphrase(): string | null {
  const v = process.env.BUNSHIN_ADMIN_PASSPHRASE?.trim();
  return v && v !== "" ? v : null;
}

// 毎朝の参謀（ホームの「今朝の気づき」）で使う共通の型。
//
// この仕組みの役割は「溜まったデータを突き合わせて、聞かれる前におかしいと言う」こと。
// 予定を読み上げる役でも、数字を並べる役でもない。各ダッシュボードは
// 「見に行けば分かる」が、見に行かなければ分からない。参謀はその逆をやる。
//
// 書き方の作法（/api/health/status と同じ。ここが崩れると信用されなくなる）:
//   ・事実だけ書く。日付と数字で言い切れることに限る。
//   ・原因は断定しない。「連携が切れた」と「設定を変えた」はデータから区別できない。
//     2026-08-03の歩数の件は、原因を断定していたら真逆の結論（書き出し設定を疑う）に
//     なっていた。実際は取り込みは動いていて、保存する値の畳み方が違っていた。
//   ・判定できないものは判定しない。閾値を置けない指標は黙って通す。

export type Severity = "alert" | "warn" | "info";

/** 気づきの分野。カード上でまとめる単位でもある。 */
export type Area = "目標" | "取り込み" | "記録" | "辞書";

export type Finding = {
  /** 安定した識別子。同じ気づきは毎朝同じidになるようにする（後で既読管理を足せる）。 */
  id: string;
  area: Area;
  severity: Severity;
  /** 何が起きているかを一行で。原因ではなく状態を書く。 */
  title: string;
  /** 根拠になる事実。日付・件数・経過日数など、確かめられるものだけ。 */
  facts: string[];
  /** 確かめに行く先。無い場合もある（画面が無い話は無理に張らない）。 */
  href?: string;
  hrefLabel?: string;
};

/** 検知器に渡す文脈。今日の日付はJST基準で1回だけ決めて全検知器で共有する。 */
export type Ctx = {
  /** Supabase 接続情報（service role）。 */
  creds: { url: string; key: string };
  /** JSTの今日（YYYY-MM-DD）。 */
  today: string;
  /** 実行時刻。経過時間の計算に使う。 */
  now: Date;
};

export type Detector = {
  /** 失敗したときに「どの検知器が落ちたか」を出すための名前。 */
  name: string;
  run: (ctx: Ctx) => Promise<Finding[]>;
};

const SEVERITY_RANK: Record<Severity, number> = { alert: 0, warn: 1, info: 2 };

/**
 * 重い順に並べる。同じ深刻度なら分野の順（目標→取り込み→記録→辞書）。
 * 「目標」を先頭に置くのは、判断軸①「健康は全ての土台」に直結する話を
 * 運用の細かい話より下に埋めないため。
 */
const AREA_RANK: Record<Area, number> = { 目標: 0, 取り込み: 1, 記録: 2, 辞書: 3 };

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      AREA_RANK[a.area] - AREA_RANK[b.area] ||
      a.id.localeCompare(b.id)
  );
}

// ---- 日付・経過の計算 ----------------------------------------------------
// サーバー（Vercel）はUTCで動くため、素の new Date() の日付は日本時間の
// 00:00〜08:59 が前日になる。日付はJSTで出してから比較する。

export function jstToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 日付文字列同士の差（日）。両方ともUTC 00:00 として解釈するのでTZでぶれない。 */
export function daysBetween(later: string, earlier: string): number {
  const l = new Date(`${later}T00:00:00Z`).getTime();
  const e = new Date(`${earlier}T00:00:00Z`).getTime();
  return Math.round((l - e) / 86400000);
}

/** タイムスタンプから今までの経過時間（時間単位、切り捨て）。 */
export function hoursSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 3600000);
}

/** YYYY-MM-DD を「7/19」のように短く。事実の羅列を読みやすくするためだけ。 */
export function shortDate(day: string): string {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
}

/** n日前のJST日付（YYYY-MM-DD）。 */
export function daysAgo(today: string, n: number): string {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

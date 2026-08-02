// 家庭訪問（ライフOS側の信仰ブロック）の共通部品。
// 1人＝1枚のカード、1回の訪問＝1行。仕事の記録ではないので、
// 団体・案件まわり（organizations / weekly_reports 等）とは一切つながない。
//
// 訪問の状態は home_visit_logs.met の3値で表す：
//   null … これからの予定（まだ行っていない）
//   true … 会えた
//   false… 会えなかった（留守・不在）
//
// このファイルは /home-visit ページ（クライアント）からも読むので、
// next/server などサーバー専用のものは import しない（起票の認証は lib/homeVisitAuth.ts）。

export type VisitMember = {
  id: number;
  name: string;
  division: string;
  district: string | null;
  block: string | null;
  role: string | null;
  birth_date: string | null; // YYYY-MM-DD
  age_manual: number | null; // 生年月日が分からない人だけ手入力
  note: string | null;
  active: boolean;
  sort_order: number;
};

export type VisitLog = {
  id: number;
  member_id: number;
  visit_date: string; // YYYY-MM-DD
  met: boolean | null;
  topics: string | null;
  next_action: string | null;
};

// 名簿にある部。ここが実質の正の一覧（DBにCHECK制約は付けていない）。
export const DIVISIONS = ["壮年部", "男子部"] as const;

// 地区の並び。城西支部の名簿の並びに合わせる。
export const DISTRICTS = ["要希望地区", "旭日地区", "平和地区"] as const;

// 年齢は生年月日から都度計算する（登録時の値を持つと毎年ズレるため）。
// 生年月日が分からない人は age_manual をそのまま使う。どちらも無ければ null。
export function ageOf(member: Pick<VisitMember, "birth_date" | "age_manual">, today: Date): number | null {
  if (!member.birth_date) return member.age_manual ?? null;
  const [y, m, d] = member.birth_date.split("-").map(Number);
  if (!y || !m || !d) return member.age_manual ?? null;
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

// JSTの今日。ブラウザのタイムゾーンが何であれ日本時間で数える。
export function todayJst(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + (now.getTimezoneOffset() + 540) * 60 * 1000);
  const m = `${jst.getMonth() + 1}`.padStart(2, "0");
  const d = `${jst.getDate()}`.padStart(2, "0");
  return `${jst.getFullYear()}-${m}-${d}`;
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

const WD = ["日", "月", "火", "水", "木", "金", "土"];

export function fmtDate(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return d;
  const wd = WD[new Date(y, m - 1, day).getDay()] ?? "";
  return `${m}/${day}（${wd}）`;
}

export function fmtDateWithYear(d: string): string {
  const [y] = d.split("-");
  return `${y}年 ${fmtDate(d)}`;
}

// 1人分の状態。カードの見出しと並び替えの両方がこれを使う。
export type MemberState = {
  member: VisitMember;
  logs: VisitLog[]; // 実施済み（新しい順）
  plans: VisitLog[]; // これからの予定（近い順）
  lastVisit: VisitLog | null; // 直近の実施（会えた・会えなかった問わず）
  lastMet: VisitLog | null; // 直近で会えた訪問
  daysSinceVisit: number | null; // 未訪問なら null
  metCount: number;
  visitCount: number;
};

// 予定と実施を分けて1人分にまとめる。
// 「met が null かつ日付が今日以降」＝これからの予定。
// 過ぎてもmetが空のままの行は、記録し忘れとして予定側に残す（消えると気づけないため）。
export function buildStates(
  members: VisitMember[],
  logs: VisitLog[],
  today: string
): MemberState[] {
  const byMember = new Map<number, VisitLog[]>();
  for (const l of logs) {
    byMember.set(l.member_id, [...(byMember.get(l.member_id) ?? []), l]);
  }

  return members.map((member) => {
    const all = byMember.get(member.id) ?? [];
    const done = all
      .filter((l) => l.met !== null)
      .sort((a, b) => (a.visit_date < b.visit_date ? 1 : -1));
    const plans = all
      .filter((l) => l.met === null)
      .sort((a, b) => (a.visit_date > b.visit_date ? 1 : -1));

    const lastVisit = done[0] ?? null;
    return {
      member,
      logs: done,
      plans,
      lastVisit,
      lastMet: done.find((l) => l.met === true) ?? null,
      daysSinceVisit: lastVisit ? daysBetween(lastVisit.visit_date, today) : null,
      metCount: done.filter((l) => l.met === true).length,
      visitCount: done.length,
    };
  });
}

// 「しばらく行けていない人」を上に出すための並び順。
// 未訪問の人が最優先、次に間隔が空いている人。同点は名簿順。
export function byNeglected(a: MemberState, b: MemberState): number {
  const av = a.daysSinceVisit ?? Number.MAX_SAFE_INTEGER;
  const bv = b.daysSinceVisit ?? Number.MAX_SAFE_INTEGER;
  if (av !== bv) return bv - av;
  return a.member.sort_order - b.member.sort_order;
}

export function byRoster(a: MemberState, b: MemberState): number {
  return a.member.sort_order - b.member.sort_order;
}

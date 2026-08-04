// SALT2 AIサマーブートキャンプ2026 の受講生名簿（人脈DB）の共通部品。
//
// 使い道は「誰と繋がるべきか」を探すこと。肩書きよりも
// 「AI活用で何をしているか」「何を学びたいか」「趣味」から人を引けることを優先する
// （共通点が見つかれば声をかけられる、というのがこの画面の目的）。
//
// 出典は Slack salt2-summer-bootcamp の #0402_自己紹介。
// 名簿全体は136名、うち自己紹介を投稿した56名が今の中身。
// 未投稿者は slack_display をキーに後から upsert で足せる（DB側で一意）。
//
// タグは2階建て。
//   industry_tags / stance_tags / hobby_tags … Notionの「SALT2人脈DB」と同じ
//     正準セット（22種・22種・19種）。絞り込み（ファセット）はこの3系統だけを使う。
//     Notion・一覧表・SPAで見え方が食い違わないよう、語彙をNotionに合わせている。
//   tags / hobbies … Slackの自己紹介から起こした生の語（109種）。
//     ファセットには出さないが、「LayerX」「半導体」のような細かい語で
//     引けることに価値があるので、フリーワード検索の対象には残す。
//
// このファイルは /salt2 ページ（クライアント）から読むので、
// next/server などサーバー専用のものは import しない。

export type Salt2Member = {
  id: number;
  name: string;
  kana: string | null;
  slack_display: string;
  email: string | null;
  company: string | null;
  role: string | null;
  career: string | null;
  ai_usage: string | null;
  goal: string | null;
  hobbies: string[]; // 生の趣味（検索用。絞り込みは hobby_tags を使う）
  personal: string | null;
  note: string | null;
  track: string | null;
  tags: string[]; // 生タグ（検索用。絞り込みには出さない）
  industry_tags: string[];
  stance_tags: string[];
  hobby_tags: string[];
  raw_intro: string | null; // Slackの自己紹介の原文
  posted_at: string | null;
};

// 自己紹介にトラックが書かれていない人はこの値が入っている（DBの実データ）。
// 絞り込みチップでは最後に回す。
export const TRACK_UNKNOWN = "不明";

// ── 検索のための正規化 ────────────────────────────────────────────
//
// 「かな検索も効くように」の実体はここ。名前が漢字でも kana 列があるので、
// 検索対象とクエリの両方を同じ形に均せば、ひらがな・カタカナのどちらで打っても当たる。
//   - カタカナ → ひらがな（「タカハシ」でも「たかはし」でも当たる）
//   - 全角英数 → 半角、英字は小文字（「ＡＩ」「AI」「ai」を同一視）
//   - 長音・中黒・空白・記号は落とす（「デジタルマーケティング」と「デジタル・マーケ」を近づける）
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・･ー\-‐−–—_/,、。．.()（）「」【】]/g, "");
}

// 1人分の検索対象を1本につなぐ。氏名・かな・会社・職種・経歴・AI活用・
// 学びたいこと・趣味・タグ・メモ・その人となり・自己紹介の原文 を横断で引けるようにする。
// 正準タグだけでなく生タグ（tags/hobbies）と原文も入れるのが肝で、
// 「LayerX」「半導体」のようなファセットに無い語はここでしか当たらない。
export function haystack(m: Salt2Member): string {
  return normalize(
    [
      m.name,
      m.kana,
      m.slack_display,
      m.company,
      m.role,
      m.career,
      m.ai_usage,
      m.goal,
      m.personal,
      m.note,
      m.track,
      m.raw_intro,
      ...m.hobbies,
      ...m.tags,
      ...m.industry_tags,
      ...m.stance_tags,
      ...m.hobby_tags,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

// 空白区切りの複数語はAND。「AI 営業」で両方を含む人だけに絞れる。
export function matchesQuery(hay: string, query: string): boolean {
  const terms = query.trim().split(/\s+/).map(normalize).filter(Boolean);
  if (terms.length === 0) return true;
  return terms.every((t) => hay.includes(t));
}

// ── ファセット ────────────────────────────────────────────────────

export type Facet = { value: string; count: number };

// 多い順、同数なら名前順。タグは109種類あるので画面側で上位だけ出す。
function tally(values: string[]): Facet[] {
  const map = new Map<string, number>();
  for (const v of values) {
    const key = v.trim();
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.value.localeCompare(b.value, "ja")));
}

// 絞り込みに使うのは正準タグの3系統だけ（生タグ tags はファセットに出さない）。
export function industryFacets(members: Salt2Member[]): Facet[] {
  return tally(members.flatMap((m) => m.industry_tags));
}

export function stanceFacets(members: Salt2Member[]): Facet[] {
  return tally(members.flatMap((m) => m.stance_tags));
}

export function hobbyFacets(members: Salt2Member[]): Facet[] {
  return tally(members.flatMap((m) => m.hobby_tags));
}

export function companyFacets(members: Salt2Member[]): Facet[] {
  return tally(members.map((m) => m.company ?? ""));
}

// トラックは「不明」を必ず末尾へ（未記入は絞り込みの主役ではないため）。
export function trackFacets(members: Salt2Member[]): Facet[] {
  const all = tally(members.map((m) => m.track ?? ""));
  const known = all.filter((f) => f.value !== TRACK_UNKNOWN);
  const unknown = all.filter((f) => f.value === TRACK_UNKNOWN);
  return [...known, ...unknown];
}

// ── 絞り込み ──────────────────────────────────────────────────────

// 絞り込みの効き方は「群の中はOR、群をまたぐとAND」。
//   業界で2つ選ぶ → どちらかの業界の人（業界は22種あり、2つ両方持つ人はまず居ない）
//   業界＋立場を選ぶ → 両方に当てはまる人
// 「HR・人材」かつ「起業・独立志望」のような掛け合わせが、声をかける先を絞る本命。
export type Filters = {
  query: string;
  industries: string[];
  stances: string[];
  hobbies: string[]; // hobby_tags（正準セット19種）に対する絞り込み
  companies: string[];
  tracks: string[];
};

export const EMPTY_FILTERS: Filters = {
  query: "",
  industries: [],
  stances: [],
  hobbies: [],
  companies: [],
  tracks: [],
};

function matchesGroup(selected: string[], values: string[]): boolean {
  return selected.length === 0 || selected.some((s) => values.includes(s));
}

export function filterMembers(members: Salt2Member[], f: Filters): Salt2Member[] {
  return members.filter((m) => {
    if (!matchesGroup(f.industries, m.industry_tags)) return false;
    if (!matchesGroup(f.stances, m.stance_tags)) return false;
    if (!matchesGroup(f.hobbies, m.hobby_tags)) return false;
    if (f.companies.length > 0 && !f.companies.includes(m.company ?? "")) return false;
    if (f.tracks.length > 0 && !f.tracks.includes(m.track ?? "")) return false;
    if (f.query.trim() && !matchesQuery(haystack(m), f.query)) return false;
    return true;
  });
}

// ある枠のチップを並べる母集団。
// その枠自身の選択だけ外して数える（他の枠の絞り込みは効かせる）。
//
// これをやらないと、業界で1つ選んだ瞬間に業界の候補が
// 「その人たちが持っている業界」だけに縮んでしまい、
// 「HR・人材 か Fintech・金融」のような同枠の複数選択が押せなくなる。
// 数字も「いま押したら何人になるか」を表すようになる。
export function facetBase(
  members: Salt2Member[],
  f: Filters,
  group: "industries" | "stances" | "hobbies" | "companies" | "tracks"
): Salt2Member[] {
  return filterMembers(members, { ...f, [group]: [] });
}

export function hasAnyFilter(f: Filters): boolean {
  return (
    f.query.trim() !== "" ||
    f.industries.length > 0 ||
    f.stances.length > 0 ||
    f.hobbies.length > 0 ||
    f.companies.length > 0 ||
    f.tracks.length > 0
  );
}

// チップの多重選択トグル。押した値が入っていれば外し、無ければ足す。
export function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

// ── 表示ヘルパー ──────────────────────────────────────────────────

// 一覧のカードに出す1行。肩書きより「何をしている人か」が先に読めるようにする。
export function summaryLine(m: Salt2Member): string {
  return [m.company, m.role].filter(Boolean).join(" ／ ");
}

// 投稿日は「いつ自己紹介が出たか」でしかないので、詳細の隅に小さく出す用。
export function fmtPostedAt(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

// 名簿全体の人数。自己紹介を投稿した人だけがDBにいるので、
// 「136名中56名ぶん」であることを画面で明示するために持っておく。
export const ROSTER_TOTAL = 136;

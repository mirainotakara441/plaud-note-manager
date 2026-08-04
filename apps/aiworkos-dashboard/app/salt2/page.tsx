"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChartTitle } from "@/app/health/charts";
import {
  EMPTY_FILTERS,
  Facet,
  Filters,
  ROSTER_TOTAL,
  Salt2Member,
  companyFacets,
  facetBase,
  filterMembers,
  fmtPostedAt,
  hasAnyFilter,
  hobbyFacets,
  industryFacets,
  stanceFacets,
  summaryLine,
  toggle,
  trackFacets,
} from "@/lib/salt2";

// SALT2人脈DB。ブートキャンプの受講生を「誰と繋がるべきか」で引くための画面。
//
// 肩書きで並べても声はかけられない。共通点があって初めて話しかけられるので、
// 「AI活用で何をしているか」「何を学びたいか」「趣味」を一覧の時点で見せ、
// 検索もその3つを横断で拾う。名前・会社しか出さないカードにはしない。
//
// 絞り込みは「業界 / 立場・関心 / 趣味」の3系統。値はNotionの「SALT2人脈DB」と
// 同じ正準セット（22種・22種・19種）で、Notion・一覧表・この画面で見え方を揃えている。
// Slack原文から起こした生タグ（109種）はチップには出さないが、フリーワード検索では
// 効くようにしてある（「LayerX」「半導体」のような細かい語で引けるのが価値のため）。
//
// データは56行と小さいので /api/salt2 で全件を受け取り、絞り込みは全てこの中で行う
// （家庭訪問と同じ流儀。打つたびに問い合わせないぶん取り消しが速い）。

const C_SALT = "#2a78d6"; // SALT2の色（家庭訪問の菫・ラーメンの橙と混ざらない青）
const C_AI = "#1baf7a"; // AI活用
const C_GOAL = "#c77700"; // 学びたいこと
const C_INDUSTRY = "#4a3aa7"; // 業界
const C_STANCE = "#2a78d6"; // 立場・関心
const C_HOBBY = "#c2417f"; // 趣味

type ApiResponse = { members: Salt2Member[]; error?: string };

// 3系統のどれを触っているかを1語で表す。カードのチップと絞り込みで同じものを使う。
type TagGroup = "industries" | "stances" | "hobbies";

const GROUP_COLOR: Record<TagGroup, string> = {
  industries: C_INDUSTRY,
  stances: C_STANCE,
  hobbies: C_HOBBY,
};

function tagsOf(m: Salt2Member, group: TagGroup): string[] {
  if (group === "industries") return m.industry_tags;
  if (group === "stances") return m.stance_tags;
  return m.hobby_tags;
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      {children}
    </section>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
  color = C_SALT,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`whitespace-nowrap rounded-full px-3 py-1 text-sm font-medium transition active:scale-95 ${
        active ? "text-white" : "bg-white text-gray-600 ring-1 ring-gray-200"
      }`}
      style={active ? { backgroundColor: color } : undefined}
    >
      {label}
      {count != null && (
        <span className={`ml-1 text-xs ${active ? "text-white/75" : "text-gray-400"}`}>
          {count}
        </span>
      )}
    </button>
  );
}

// 見出し付きの本文。中身が空の人がいるので、空なら行ごと出さない。
function Field({
  label,
  color,
  value,
}: {
  label: string;
  color?: string;
  value: string | null | undefined;
}) {
  if (!value?.trim()) return null;
  return (
    <div>
      <p className="flex items-center gap-1 text-xs font-medium text-gray-500">
        {color && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        )}
        {label}
      </p>
      <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{value}</p>
    </div>
  );
}

// 一覧のカードに出す短い1行。長い経歴は畳んで、開いた時に全文を出す。
function clip(text: string | null | undefined, len: number): string | null {
  const t = text?.trim();
  if (!t) return null;
  return t.length > len ? `${t.slice(0, len)}…` : t;
}

// Slackの自己紹介の原文。要約フィールドだけだと本人の言い回しが消えるので、
// 声をかける前にここを読めるようにしておく。長いので既定は畳んでおく。
function RawIntro({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl bg-gray-50 p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left active:opacity-70"
      >
        <span className="text-xs font-bold text-gray-600">
          📝 自己紹介の原文（Slack #0402_自己紹介）
        </span>
        <span className="ml-auto text-xs text-gray-400">{open ? "畳む" : "開く"}</span>
      </button>
      {open && (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{text}</p>
      )}
    </div>
  );
}

function MemberCard({
  member,
  open,
  onToggle,
  filters,
  onTag,
}: {
  member: Salt2Member;
  open: boolean;
  onToggle: () => void;
  filters: Filters;
  onTag: (group: TagGroup, value: string) => void;
}) {
  const sub = summaryLine(member);
  const posted = fmtPostedAt(member.posted_at);
  const groups: TagGroup[] = ["industries", "stances", "hobbies"];
  const chips = groups.flatMap((g) => tagsOf(member, g).map((value) => ({ group: g, value })));

  return (
    <article className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 p-4 text-left active:bg-gray-50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-base font-bold text-gray-900">{member.name}</span>
            {member.kana && <span className="text-xs text-gray-400">{member.kana}</span>}
            {member.track && member.track !== "不明" && (
              <span
                className="rounded-full px-2 py-0.5 text-xs font-bold text-white"
                style={{ backgroundColor: C_SALT }}
              >
                {member.track}
              </span>
            )}
          </div>
          {sub && <p className="mt-0.5 text-sm text-gray-600">{sub}</p>}

          {/* 閉じている時こそ、声をかける材料（AI活用・学びたいこと・趣味）を見せる */}
          {!open && (
            <div className="mt-1.5 space-y-0.5">
              {clip(member.ai_usage, 46) && (
                <p className="text-xs leading-relaxed" style={{ color: C_AI }}>
                  🤖 {clip(member.ai_usage, 46)}
                </p>
              )}
              {clip(member.goal, 46) && (
                <p className="text-xs leading-relaxed" style={{ color: C_GOAL }}>
                  🎯 {clip(member.goal, 46)}
                </p>
              )}
              {member.hobbies.length > 0 && (
                <p className="text-xs leading-relaxed" style={{ color: C_HOBBY }}>
                  ⛳ {member.hobbies.join("・")}
                </p>
              )}
            </div>
          )}

          {chips.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {chips.map(({ group, value }) => {
                const active = filters[group].includes(value);
                return (
                  <span
                    key={`${group}:${value}`}
                    className={`rounded-full px-2 py-0.5 text-[0.625rem] ${
                      active ? "font-bold text-white" : "bg-gray-100 text-gray-600"
                    }`}
                    style={active ? { backgroundColor: GROUP_COLOR[group] } : undefined}
                  >
                    {value}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <span className="shrink-0 text-lg text-gray-300" aria-hidden>
          {open ? "−" : "＋"}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-gray-100 px-4 py-3">
          <Field label="経歴" value={member.career} />
          <Field label="AI活用・関心" color={C_AI} value={member.ai_usage} />
          <Field label="学びたいこと・ゴール" color={C_GOAL} value={member.goal} />
          {member.hobbies.length > 0 && (
            <Field label="趣味" color={C_HOBBY} value={member.hobbies.join("・")} />
          )}
          <Field label="人となり" value={member.personal} />
          <Field label="メモ" value={member.note} />

          {member.raw_intro && <RawIntro text={member.raw_intro} />}

          {chips.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500">タグで似た人を探す</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {chips.map(({ group, value }) => (
                  <Chip
                    key={`${group}:${value}`}
                    label={value}
                    active={filters[group].includes(value)}
                    onClick={() => onTag(group, value)}
                    color={GROUP_COLOR[group]}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-500">
            <p>Slack表示名：{member.slack_display}</p>
            {member.email && <p className="mt-0.5">{member.email}</p>}
            {posted && <p className="mt-0.5 text-gray-400">自己紹介の投稿：{posted}</p>}
          </div>
        </div>
      )}
    </article>
  );
}

// 候補が多いファセット（会社54種）は、既定で上位だけ出して残りは畳む。
// 正準タグの3系統は22/22/19種なので畳まずに全部出す（previewCount に総数を渡す）。
function FacetChips({
  facets,
  selected,
  onToggle,
  color,
  previewCount,
  moreLabel,
}: {
  facets: Facet[];
  selected: string[];
  onToggle: (value: string) => void;
  color?: string;
  previewCount: number;
  moreLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // 選んだものは畳んだ後も必ず見えるようにする（消えると外せなくなるため）
  const shown = expanded
    ? facets
    : facets.filter((f, i) => i < previewCount || selected.includes(f.value));
  const rest = facets.length - shown.length;

  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((f) => (
        <Chip
          key={f.value}
          label={f.value}
          count={f.count}
          active={selected.includes(f.value)}
          onClick={() => onToggle(f.value)}
          color={color}
        />
      ))}
      {rest > 0 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="whitespace-nowrap rounded-full px-3 py-1 text-sm text-gray-500 underline active:opacity-70"
        >
          {moreLabel}（あと{rest}）
        </button>
      )}
      {expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="whitespace-nowrap rounded-full px-3 py-1 text-sm text-gray-500 underline active:opacity-70"
        >
          畳む
        </button>
      )}
    </div>
  );
}

const inputClass =
  "w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400";

export default function Salt2Page() {
  const [members, setMembers] = useState<Salt2Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/salt2", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((d: ApiResponse) => {
        if (!alive) return;
        if (d.error) setError(d.error);
        else {
          setError(null);
          setMembers(
            (d.members ?? []).map((m) => ({
              ...m,
              hobbies: m.hobbies ?? [],
              tags: m.tags ?? [],
              industry_tags: m.industry_tags ?? [],
              stance_tags: m.stance_tags ?? [],
              hobby_tags: m.hobby_tags ?? [],
            }))
          );
        }
      })
      .catch(() => {
        if (alive) setError("SALT2の名簿を取得できませんでした");
      });
    return () => {
      alive = false;
    };
  }, []);

  const all = members ?? [];
  const shown = useMemo(() => filterMembers(all, filters), [all, filters]);

  // チップの候補と件数は「その枠自身の選択を外した状態」で数える（lib の facetBase）。
  // 同じ枠で「HR・人材 か Fintech・金融」と足していけるようにするため。
  // 数字は「いま押したら何人になるか」を表す。
  const facets = useMemo(
    () => ({
      industries: industryFacets(facetBase(all, filters, "industries")),
      stances: stanceFacets(facetBase(all, filters, "stances")),
      hobbies: hobbyFacets(facetBase(all, filters, "hobbies")),
      companies: companyFacets(facetBase(all, filters, "companies")),
      tracks: trackFacets(facetBase(all, filters, "tracks")),
    }),
    [all, filters]
  );

  const setQuery = (query: string) => setFilters((f) => ({ ...f, query }));
  const toggleTag = (group: TagGroup, value: string) =>
    setFilters((f) => ({ ...f, [group]: toggle(f[group], value) }));
  const toggleCompany = (v: string) =>
    setFilters((f) => ({ ...f, companies: toggle(f.companies, v) }));
  const toggleTrack = (v: string) => setFilters((f) => ({ ...f, tracks: toggle(f.tracks, v) }));

  const loading = !members && !error;
  const filtered = hasAnyFilter(filters);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="mb-2">
        <Link href="/" className="text-sm font-medium text-indigo-600 active:opacity-70">
          ← ホーム
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">🎓 SALT2人脈DB</h1>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">
          AIサマーブートキャンプ2026の受講生を、業界・立場・趣味から引く。
          共通点を見つけて、声をかける先を決める
        </p>
      </header>

      {error && (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error}
        </div>
      )}

      {loading && (
        <div className="mt-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl border border-gray-200 bg-gray-100"
            />
          ))}
        </div>
      )}

      {members && (
        <>
          <Section>
            <ChartTitle
              color={C_SALT}
              title="探す"
              hint={`自己紹介の投稿は${all.length}名（名簿全体${ROSTER_TOTAL}名）`}
            />
            <input
              value={filters.query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="氏名・かな・会社・職種・経歴・AI活用・趣味・自己紹介の原文を横断"
              className={inputClass}
            />
            <p className="mt-1 text-[0.625rem] leading-relaxed text-gray-400">
              下のタグに無い語（社名・製品名・業界用語）も、自己紹介の原文から拾えます
            </p>

            <div className="mt-3">
              <p className="mb-1 text-xs font-medium text-gray-500">業界</p>
              <FacetChips
                facets={facets.industries}
                selected={filters.industries}
                onToggle={(v) => toggleTag("industries", v)}
                color={C_INDUSTRY}
                previewCount={facets.industries.length}
                moreLabel="業界"
              />
            </div>

            <div className="mt-3">
              <p className="mb-1 text-xs font-medium text-gray-500">立場・関心</p>
              <FacetChips
                facets={facets.stances}
                selected={filters.stances}
                onToggle={(v) => toggleTag("stances", v)}
                color={C_STANCE}
                previewCount={facets.stances.length}
                moreLabel="立場・関心"
              />
            </div>

            <div className="mt-3">
              <p className="mb-1 text-xs font-medium text-gray-500">趣味</p>
              <FacetChips
                facets={facets.hobbies}
                selected={filters.hobbies}
                onToggle={(v) => toggleTag("hobbies", v)}
                color={C_HOBBY}
                previewCount={facets.hobbies.length}
                moreLabel="趣味"
              />
            </div>

            {facets.tracks.length > 1 && (
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium text-gray-500">トラック</p>
                <FacetChips
                  facets={facets.tracks}
                  selected={filters.tracks}
                  onToggle={toggleTrack}
                  previewCount={facets.tracks.length}
                  moreLabel="トラック"
                />
              </div>
            )}

            <div className="mt-3">
              <p className="mb-1 text-xs font-medium text-gray-500">会社</p>
              <FacetChips
                facets={facets.companies}
                selected={filters.companies}
                onToggle={toggleCompany}
                previewCount={8}
                moreLabel="会社をもっと見る"
              />
            </div>

            <p className="mt-2 text-[0.625rem] leading-relaxed text-gray-400">
              同じ枠で複数選ぶと「どれか」、枠をまたいで選ぶと「すべて」に当てはまる人が残ります
            </p>

            <div className="mt-2 flex items-center gap-2">
              <p className="text-sm font-bold text-gray-900">
                {all.length}名中 <span style={{ color: C_SALT }}>{shown.length}</span>名
              </p>
              {filtered && (
                <button
                  type="button"
                  onClick={() => setFilters(EMPTY_FILTERS)}
                  className="ml-auto rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-600 active:opacity-70"
                >
                  絞り込みを外す
                </button>
              )}
            </div>
          </Section>

          <div className="mt-4 space-y-2">
            {shown.map((m) => (
              <MemberCard
                key={m.id}
                member={m}
                open={openId === m.id}
                onToggle={() => setOpenId(openId === m.id ? null : m.id)}
                filters={filters}
                onTag={toggleTag}
              />
            ))}
            {shown.length === 0 && (
              <p className="rounded-2xl border border-gray-200 bg-white p-6 text-center text-sm leading-relaxed text-gray-500">
                条件に合う人がいません。
                <br />
                <span className="text-xs text-gray-400">
                  タグを1つ外すか、検索語を短くしてみてください。
                </span>
              </p>
            )}
          </div>

          <p className="mt-4 rounded-xl bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-400">
            出典：Slack「SALT2 AIサマーブートキャンプ2026」#0402_自己紹介。
            自己紹介を投稿した{all.length}名ぶん。タグはNotionの「SALT2人脈DB」と同じ正準セット。
            未投稿の方は取得でき次第この名簿に足していきます。
          </p>
        </>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="text-sm text-indigo-500 active:opacity-70">
          ← ホームに戻る
        </Link>
      </div>
    </main>
  );
}

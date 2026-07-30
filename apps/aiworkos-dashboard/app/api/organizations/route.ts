import { NextResponse } from "next/server";
import { anonCreds, serviceCreds, restHeaders } from "@/lib/supabase";
import { ORG_CATEGORIES, type OrgCategory } from "@/lib/categories";
import {
  compareOrgByContact,
  fetchMeetingOrgCategories,
  fetchStakeholders,
  resolveOrgCategory,
  stakeholderCategoryMap,
  weeklyCategoryMap,
  type OrgCategorySource,
} from "@/lib/organizations";

// 団体別攻略の団体セレクタ用の一覧。
//
// 既定では Edge Function org-history の返す団体（＝会議データがある団体）だけを返す。
// ただしそれだと、週報にしか登場しない団体がセレクタに出てこない。
// ?include=weekly を付けた場合に限り weekly_reports の organization も拾って名前でマージする
// （/agent や /weapons は会議履歴を前提に組み立てるため、既定の挙動は変えない）。
// count は会議件数、weeklyCount は週報の週数。どちらの記録があるかは画面側で表示し分ける。
//
// さらに各団体には category（正準8分類のどれか）と categorySource（判定根拠）を付ける。
// /organizations の「大ジャンル → 団体」2段階セレクタがこれでグルーピングする。
// 判定ルールと優先順は lib/organizations.ts の resolveOrgCategory のコメントを参照。
// 並び順は接点の多さ（会議件数＋週報週数）の降順＝lib/organizations.ts の
// compareOrgByContact。ジャンルを絞ったときも同じ順序がそのまま使える。

export const dynamic = "force-dynamic";

type OrganizationEntry = {
  name: string;
  count: number;
  weeklyCount: number;
  category: OrgCategory;
  categorySource: OrgCategorySource;
};

async function fetchMeetingOrganizations(
  url: string,
  key: string
): Promise<{ name: string; count: number }[]> {
  const res = await fetch(`${url}/functions/v1/org-history`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`org-history 一覧エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data?.organizations) ? data.organizations : [];
}

// 週報にしか出てこない団体も拾う。ここが落ちても会議由来の一覧は出したいので、
// 失敗時は空配列を返して握りつぶす。
// (organization, category) を行のまま返し、週数の集計とジャンル判定の両方に使い回す
// （同じ団体が週をまたいで別カテゴリーで書かれることがあるので、行を潰さずに渡して
// weeklyCategoryMap 側で最頻値を採らせる）。
async function fetchWeeklyRows(
  url: string,
  key: string
): Promise<{ organization: string; category: unknown }[]> {
  try {
    const res = await fetch(
      `${url}/rest/v1/weekly_reports?select=organization,category&organization=not.is.null`,
      { headers: restHeaders(key), cache: "no-store" }
    );
    if (!res.ok) return [];
    const rows: unknown = await res.json();
    if (!Array.isArray(rows)) return [];
    const out: { organization: string; category: unknown }[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const name = (row as { organization?: unknown }).organization;
      if (typeof name !== "string" || name.trim() === "") continue;
      out.push({
        organization: name.trim(),
        category: (row as { category?: unknown }).category,
      });
    }
    return out;
  } catch (error) {
    console.error("週報カテゴリー取得エラー（無視して続行）:", error);
    return [];
  }
}

export async function GET(request: Request) {
  const anon = anonCreds();
  if (!anon) {
    return NextResponse.json(
      { error: "サーバー設定エラー: 環境変数が設定されていません" },
      { status: 500 }
    );
  }
  // memory_chunks は anon で読めないため service キーが必要。未設定なら会議由来の
  // ジャンル判定だけを諦めて、マスタ・週報にフォールバックする（500にはしない）。
  const service = serviceCreds();

  const includeWeekly =
    new URL(request.url).searchParams.get("include") === "weekly";

  try {
    const [meetingOrgs, weeklyRows, meetingCategories, stakeholders] =
      await Promise.all([
        fetchMeetingOrganizations(anon.url, anon.key),
        includeWeekly
          ? fetchWeeklyRows(anon.url, anon.key)
          : Promise.resolve<{ organization: string; category: unknown }[]>([]),
        service
          ? fetchMeetingOrgCategories(service.url, service.key, ORG_CATEGORIES)
          : Promise.resolve(new Map<string, OrgCategory>()),
        fetchStakeholders(anon.url, anon.key),
      ]);

    // 週報の週数を団体ごとに数える（1行=1週分の記録）
    const weeklyCounts = new Map<string, number>();
    for (const r of weeklyRows) {
      weeklyCounts.set(r.organization, (weeklyCounts.get(r.organization) ?? 0) + 1);
    }

    const sources = {
      meeting: meetingCategories,
      master: stakeholderCategoryMap(stakeholders, ORG_CATEGORIES),
      weekly: weeklyCategoryMap(weeklyRows, ORG_CATEGORIES),
    };

    const merged = new Map<string, OrganizationEntry>();
    const put = (name: string, count: number, weeklyCount: number) => {
      const resolved = resolveOrgCategory(name, sources);
      merged.set(name, {
        name,
        count,
        weeklyCount,
        category: resolved.category,
        categorySource: resolved.source,
      });
    };

    for (const o of meetingOrgs) {
      if (typeof o?.name !== "string" || o.name.trim() === "") continue;
      const name = o.name.trim();
      put(name, typeof o.count === "number" ? o.count : 0, 0);
    }
    for (const [name, count] of weeklyCounts) {
      const existing = merged.get(name);
      if (existing) {
        existing.weeklyCount = count;
      } else {
        put(name, 0, count);
      }
    }

    const organizations = [...merged.values()].sort(compareOrgByContact);
    return NextResponse.json({ organizations });
  } catch (error) {
    console.error("自治体一覧プロキシエラー:", error);
    return NextResponse.json(
      { error: "自治体一覧サービスに接続できませんでした" },
      { status: 502 }
    );
  }
}

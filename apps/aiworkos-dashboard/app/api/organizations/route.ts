import { NextResponse } from "next/server";
import { anonCreds, restHeaders } from "@/lib/supabase";

// 団体別攻略の団体セレクタ用の一覧。
//
// 既定では Edge Function org-history の返す団体（＝会議データがある団体）だけを返す。
// ただしそれだと、週報にしか登場しない団体がセレクタに出てこない。
// ?include=weekly を付けた場合に限り weekly_reports の organization も拾って名前でマージする
// （/agent や /weapons は会議履歴を前提に組み立てるため、既定の挙動は変えない）。
// count は会議件数、weeklyCount は週報の週数。どちらの記録があるかは画面側で表示し分ける。

export const dynamic = "force-dynamic";

type OrganizationEntry = { name: string; count: number; weeklyCount: number };

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
async function fetchWeeklyOrganizations(
  url: string,
  key: string
): Promise<{ name: string; count: number }[]> {
  try {
    const res = await fetch(
      `${url}/rest/v1/weekly_reports?select=organization&organization=not.is.null`,
      { headers: restHeaders(key), cache: "no-store" }
    );
    if (!res.ok) return [];
    const rows: unknown = await res.json();
    if (!Array.isArray(rows)) return [];
    const counts = new Map<string, number>();
    for (const row of rows) {
      const name =
        row && typeof row === "object"
          ? (row as { organization?: unknown }).organization
          : null;
      if (typeof name !== "string") continue;
      const trimmed = name.trim();
      if (trimmed === "") continue;
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count }));
  } catch (error) {
    console.error("週報由来の団体一覧取得エラー（無視して続行）:", error);
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

  const includeWeekly =
    new URL(request.url).searchParams.get("include") === "weekly";

  try {
    const [meetingOrgs, weeklyOrgs] = await Promise.all([
      fetchMeetingOrganizations(anon.url, anon.key),
      includeWeekly
        ? fetchWeeklyOrganizations(anon.url, anon.key)
        : Promise.resolve([]),
    ]);

    const merged = new Map<string, OrganizationEntry>();
    for (const o of meetingOrgs) {
      if (typeof o?.name !== "string" || o.name.trim() === "") continue;
      const name = o.name.trim();
      merged.set(name, {
        name,
        count: typeof o.count === "number" ? o.count : 0,
        weeklyCount: 0,
      });
    }
    for (const o of weeklyOrgs) {
      const existing = merged.get(o.name);
      if (existing) {
        existing.weeklyCount = o.count;
      } else {
        merged.set(o.name, { name: o.name, count: 0, weeklyCount: o.count });
      }
    }

    const organizations = [...merged.values()].sort(
      (a, b) =>
        b.count - a.count ||
        b.weeklyCount - a.weeklyCount ||
        a.name.localeCompare(b.name, "ja")
    );
    return NextResponse.json({ organizations });
  } catch (error) {
    console.error("自治体一覧プロキシエラー:", error);
    return NextResponse.json(
      { error: "自治体一覧サービスに接続できませんでした" },
      { status: 502 }
    );
  }
}

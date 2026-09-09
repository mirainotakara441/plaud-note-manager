import { NextResponse } from "next/server";
import { anonCreds, restHeaders } from "@/lib/supabase";

// 協力企業の人脈DB（/partners）の読み取りAPI。
//
// 会社は数十社、役員はその数倍どまりなので、2テーブルとも全件を1回で返し、
// 検索と絞り込みはブラウザ側で行う（/glossary と同じ流儀）。
// 打つたびに問い合わせないぶん、検索語の出し入れが速い。
//
// 読み取りのみ。partner_companies / partner_executives は RLS で
// anon に SELECT だけを許可してあり、書き込み口はこのAPIに置いていない
// （役員情報は出典を確かめてから入れるもので、画面から気軽に足すものではない）。

export const dynamic = "force-dynamic";

const COMPANY_COLUMNS = [
  "id",
  "name",
  "name_kana",
  "category",
  "website",
  "headquarters",
  "founded",
  "listing",
  "employees",
  "revenue",
  "business",
  "certifications",
  "values_summary",
  "values_quote",
  "values_source",
  "memo",
  "as_of",
].join(",");

const EXECUTIVE_COLUMNS = [
  "id",
  "company_id",
  "name",
  "name_kana",
  "title",
  "career",
  "source_url",
  "sort_order",
  "memo",
  "as_of",
].join(",");

async function fetchAll(url: string, key: string, path: string, label: string) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: restHeaders(key),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `${label}の取得に失敗しました（${res.status}）${detail.slice(0, 120)}`
    );
  }
  return res.json();
}

export async function GET() {
  const c = anonCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  try {
    // 会社と役員を同時に取る。片方が遅いぶんだけ待つ形にする。
    const [companies, executives] = await Promise.all([
      fetchAll(
        c.url,
        c.key,
        `partner_companies?select=${COMPANY_COLUMNS}&order=name.asc`,
        "協力企業"
      ),
      fetchAll(
        c.url,
        c.key,
        `partner_executives?select=${EXECUTIVE_COLUMNS}&order=sort_order.asc`,
        "役員"
      ),
    ]);
    return NextResponse.json({ companies, executives });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "取得に失敗しました" },
      { status: 502 }
    );
  }
}

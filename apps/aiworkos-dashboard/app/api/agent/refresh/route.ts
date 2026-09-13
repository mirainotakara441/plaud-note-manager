import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { isLlmConfigured } from "@/lib/llm";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";
import { jstToday, daysAgo } from "@/lib/advisor/types";
import { COMMON_ORG, runDeepForOrg } from "@/lib/proposal/engine";

// 提案の夜間仕込み。会議が動いた団体の提案を、夜のうちに deep（tool use調査つき）で
// 考え直してキャッシュに積んでおく。
//
// ■ なぜ要るか（総点検の指摘(H)「再考の契機が入力差分しか無い」への答え）
//   従来、提案が再生成されるのは「会議・成果物が増えて署名が変わった時」に
//   吉井さんがページを開いた瞬間だけだった。つまり会議のあった夜も提案は古いまま
//   眠っていて、翌朝ページを開いた人が60秒制限の浅い生成を待つことになる。
//   ここで夜のうちに深い版を仕込んでおけば、昼の /agent はキャッシュを即返しする
//   だけで、中身だけが深くなる。
//
// ■ 対象の選び方
//   1. 直近7日に会議録が入った団体（動きがあった＝考え直す価値がある）
//   2. キャッシュが45日より古い団体（動きが無くても提案が腐る。TTLの代わり）
//   のうち、**手直し版（edited=true）は自動では触らない**。夜中に吉井さんの
//   訂正入りの文面を黙って書き換えるのは、たとえ引き継ぎプロンプトがあっても
//   やりすぎ。手直し版の更新は、本人が /agent で明示的に再生成した時だけ。
//
// ■ 件数の上限
//   1晩に既定2件（最大3）。deep は1件2〜4分・実コストもかかる。全団体を毎晩
//   舐め直す必要はなく、「動いた所から順に」が回っていれば提案は腐らない。
//
// ■ どこから叩くか
//   yakan-sanbo.sh（毎晩23:00・ローカル）が夜間参謀の後に叩く。
//   60秒制限のある Vercel 上では動かせない（1件で超える）。

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const COOKIE_NAME = "aiworkos_auth";
const STALE_DAYS = 45;
const RECENT_MEETING_DAYS = 7;

async function authorized(req: NextRequest): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret && req.headers.get("authorization") === `Bearer ${cronSecret}`) {
    return true;
  }
  const passphrase = process.env.APP_PASSPHRASE;
  if (passphrase && passphrase.trim() !== "") {
    const cookie = req.cookies.get(COOKIE_NAME)?.value ?? "";
    if (constantTimeEqual(cookie, await cookieValueFor(passphrase))) return true;
  }
  return false;
}

type CacheRow = {
  organization: string;
  edited: boolean;
  updated_at: string;
};

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  if (!isLlmConfigured()) {
    return NextResponse.json({ error: "AIの設定がありません" }, { status: 500 });
  }
  const c = serviceCreds();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!c || !anonKey) {
    return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const limit =
    Number.isInteger(body?.limit) && body.limit >= 1 && body.limit <= 3 ? body.limit : 2;

  const today = jstToday(new Date());
  const since = daysAgo(today, RECENT_MEETING_DAYS);
  const staleCut = daysAgo(today, STALE_DAYS);

  try {
    // 1. 直近に会議が動いた団体（団体ごとの最新会議日）
    const meetRes = await fetch(
      `${c.url}/rest/v1/memory_chunks?select=organization,event_date` +
        `&source_type=eq.${encodeURIComponent("会議")}` +
        `&event_date=gte.${since}&organization=not.is.null&limit=500`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!meetRes.ok) throw new Error(`会議の取得に失敗（${meetRes.status}）`);
    const meetRows = (await meetRes.json()) as {
      organization: string;
      event_date: string | null;
    }[];
    const latestMeeting = new Map<string, string>();
    for (const r of meetRows) {
      const org = r.organization?.trim();
      if (!org || org === COMMON_ORG) continue;
      const d = r.event_date ?? "";
      if (!latestMeeting.has(org) || d > latestMeeting.get(org)!) latestMeeting.set(org, d);
    }

    // 2. 既存キャッシュの状態
    const cacheRes = await fetch(
      `${c.url}/rest/v1/proposal_cache?select=organization,edited,updated_at`,
      { headers: restHeaders(c.key), cache: "no-store" }
    );
    if (!cacheRes.ok) throw new Error(`proposal_cacheの取得に失敗（${cacheRes.status}）`);
    const caches = new Map(
      ((await cacheRes.json()) as CacheRow[]).map((r) => [r.organization, r])
    );

    // 3. 候補を選ぶ
    type Candidate = { organization: string; reason: string; sortKey: string };
    const candidates: Candidate[] = [];
    const skippedEdited: string[] = [];

    for (const [org, meetDay] of latestMeeting) {
      const cache = caches.get(org);
      if (cache?.edited) {
        skippedEdited.push(org);
        continue;
      }
      if (!cache) {
        candidates.push({ organization: org, reason: "会議あり・提案未作成", sortKey: meetDay });
      } else if (cache.updated_at.slice(0, 10) < meetDay) {
        candidates.push({
          organization: org,
          reason: `会議(${meetDay})が提案(${cache.updated_at.slice(0, 10)})より新しい`,
          sortKey: meetDay,
        });
      }
    }
    // TTL: 動きが無くても45日で考え直す（古い提案が半年そのまま、を止める）
    for (const [org, cache] of caches) {
      if (cache.edited || latestMeeting.has(org) || org === COMMON_ORG) continue;
      if (cache.updated_at.slice(0, 10) < staleCut) {
        candidates.push({
          organization: org,
          reason: `${STALE_DAYS}日以上更新なし（${cache.updated_at.slice(0, 10)}）`,
          sortKey: cache.updated_at.slice(0, 10),
        });
      }
    }

    candidates.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    const picked = candidates.slice(0, limit);

    // 4. 直列で deep 生成（並列にすると1晩のAPI負荷とメモリが跳ねる。急ぐ理由が無い）
    const results: { organization: string; reason: string; ok: boolean; researchSteps?: number; error?: string; ms: number }[] = [];
    for (const cand of picked) {
      const t0 = Date.now();
      try {
        const r = await runDeepForOrg(c, anonKey, cand.organization);
        results.push({
          organization: cand.organization,
          reason: cand.reason,
          ok: true,
          researchSteps: r.researchSteps,
          ms: Date.now() - t0,
        });
      } catch (err) {
        // 1件の失敗で残りを止めない（advisor と同じ考え方）
        results.push({
          organization: cand.organization,
          reason: cand.reason,
          ok: false,
          error: String(err instanceof Error ? err.message : err).slice(0, 200),
          ms: Date.now() - t0,
        });
      }
    }

    return NextResponse.json({
      today,
      candidates: candidates.map((x) => ({ organization: x.organization, reason: x.reason })),
      skippedEdited,
      picked: picked.length,
      results,
    });
  } catch (err) {
    console.error("提案の夜間仕込み:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "夜間仕込みに失敗しました" },
      { status: 500 }
    );
  }
}

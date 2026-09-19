import { NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { keysForRows, pickStation } from "@/lib/stationGeo.mjs";

// 駅の座標を返す（/ramen の地図用）。
//
// 訪問した店（ramen_logs.area）と百名店（tabelog_hyakumeiten.station）に出てくる
// 駅のうち、station_geo にまだ無いものはここで HeartRails Express API から引いて
// 表に足してから返す。新しい店を記録しても地図に穴が空かないようにするため。
//
// 外部APIを叩くのは「無い駅」だけで、1回の呼び出しで引くのは MAX_LOOKUPS まで
// （初回に130駅を一気に引いて何十秒も待たせない。足りなければ次に開いた時に続きを引く）。
// 引けなかった駅は返さない（座標の無い店は地図に出さず、件数だけ注記する）。

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_LOOKUPS = 40;
const HEARTRAILS = "https://express.heartrails.com/api/json?method=getStations&name=";

type GeoRow = { station: string; lat: number; lng: number; line: string | null; prefecture: string | null };

async function lookup(key: string, hint: string | null): Promise<GeoRow | null> {
  try {
    const res = await fetch(HEARTRAILS + encodeURIComponent(key), {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    // 同名駅が全国にあるので、食べログの店URLの地域（大阪／福岡…）をヒントに選ぶ
    const picked = pickStation(json?.response?.station ?? [], hint);
    if (!picked) return null;
    return { station: key, ...picked };
  } catch {
    return null;
  }
}

export async function GET() {
  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });
  const h = restHeaders(c.key);

  const [ramen, hyaku, have] = await Promise.all([
    fetch(`${c.url}/rest/v1/ramen_logs?select=area,tabelog_shop_url&is_ramen=eq.true&limit=1000`, { headers: h, cache: "no-store" }),
    fetch(`${c.url}/rest/v1/tabelog_hyakumeiten?select=station&limit=1000`, { headers: h, cache: "no-store" }),
    fetch(`${c.url}/rest/v1/station_geo?select=station,lat,lng,line,prefecture&limit=1000`, { headers: h, cache: "no-store" }),
  ]);
  if (!ramen.ok || !hyaku.ok || !have.ok) {
    return NextResponse.json({ error: "取得失敗" }, { status: 502 });
  }
  const ramenRows: { area: string | null; tabelog_shop_url: string | null }[] = await ramen.json();
  const hyakuRows: { station: string | null }[] = await hyaku.json();
  const rows: GeoRow[] = await have.json();
  const known = new Set(rows.map((r) => r.station));

  // 無い駅を引く（上限つき）。同時に投げすぎないよう4本ずつ。
  const missing = keysForRows(ramenRows, hyakuRows).filter((k) => !known.has(k.station));
  const toFetch = missing.slice(0, MAX_LOOKUPS);
  const found: GeoRow[] = [];
  for (let i = 0; i < toFetch.length; i += 4) {
    const batch = await Promise.all(toFetch.slice(i, i + 4).map((k) => lookup(k.station, k.hint)));
    for (const g of batch) if (g) found.push(g);
  }
  if (found.length > 0) {
    // 表に足す。失敗しても今回の応答には含めて返す（次回また引き直すだけ）
    await fetch(`${c.url}/rest/v1/station_geo?on_conflict=station`, {
      method: "POST",
      headers: restHeaders(c.key, { Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(found.map((g) => ({ ...g, source: "heartrails" }))),
    }).catch((err) => console.error("station_geo: 保存に失敗", err));
  }

  return NextResponse.json({
    items: [...rows, ...found],
    // 地図側の注記用。引けなかった駅（駅でない地名など）と、上限で今回は引かなかった数
    unresolved: toFetch.filter((k) => !found.some((g) => g.station === k.station)).length,
    deferred: Math.max(0, missing.length - toFetch.length),
  });
}

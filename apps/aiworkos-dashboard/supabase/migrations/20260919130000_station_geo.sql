-- =====================================================================
-- 駅の座標（2026-09-19）
-- =====================================================================
-- /ramen の地図で、訪問した店と百名店を最寄り駅の位置に置くための表。
-- 店そのものの緯度経度はどこにも持っていない（食べログの店ページを読みに行けば
-- 取れるが、160枚ぶんの取得になるので避けた）。駅単位で置くのが正直な粒度。
--
-- 座標は HeartRails Express API（駅名 → 路線・緯度経度）から引く。国土地理院の
-- 住所検索は駅名に弱い（中野坂上駅で北海道の地名が返る）ので使わない。
-- 無い駅は /api/ramen/stations が開いた時にその場で引いて足す（自己修復）。
--
-- station は表記ゆれを落とした鍵（末尾の「駅」と「（メトロ）」等の括弧を外し、
-- ヶ/ケ を ヶ に寄せる。lib/stationGeo.mjs の stationKey）。
--
-- rollback: DROP TABLE public.station_geo;
CREATE TABLE IF NOT EXISTS public.station_geo (
  station     text PRIMARY KEY,           -- 正規化した駅名（例: 池袋 / 地下鉄成増 / 早稲田）
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  line        text,                       -- 引いた候補の路線（参考）
  prefecture  text,                       -- 引いた候補の都道府県（参考）
  source      text NOT NULL DEFAULT 'heartrails',
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.station_geo IS
  '駅名→座標。/ramen の地図用。無い駅は API が HeartRails から引いて足す';

ALTER TABLE public.station_geo ENABLE ROW LEVEL SECURITY;
CREATE POLICY "station_geo anon read" ON public.station_geo
  AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);

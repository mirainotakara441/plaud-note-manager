"use client";

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";

// /ramen の地図。訪問した店と百名店の未訪問を、最寄り駅の位置に置く。
//
// 店そのものの座標は持っていないので、粒度は「駅」。同じ駅の店は1つの丸にまとめ、
// 丸の大きさは杯数。吹き出しに店名を並べる。
//
// Leaflet は window 前提なので、描く時（useEffect）に読み込む。
// タイルは OpenStreetMap（帰属表示は必須なので消さない）。

export type MapPoint = {
  key: string; // 駅名
  lat: number;
  lng: number;
  kind: "visited" | "todo"; // 訪問した駅 ／ 百名店の未訪問だけがある駅
  count: number; // 訪問なら杯数、未訪問なら店数
  shops: { name: string; sub?: string; url?: string | null }[];
};

const C_BOWL = "#eb6834";
const C_TODO = "#4f46e5";
// 生活圏の中心（池袋）。ここから遠い点（出張先）は初期表示の範囲に入れない
const HOME = { lat: 35.7295, lng: 139.7109 };
const NEAR_DEG = 0.6;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export default function RamenMap({ points }: { points: MapPoint[] }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || points.length === 0) return;
    let disposed = false;
    let map: import("leaflet").Map | null = null;

    (async () => {
      const L = (await import("leaflet")).default;
      if (disposed) return;
      map = L.map(el, { scrollWheelZoom: false, attributionControl: true });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);

      const maxCount = Math.max(1, ...points.filter((p) => p.kind === "visited").map((p) => p.count));
      for (const p of points) {
        const visited = p.kind === "visited";
        // 半径は杯数の平方根に比例（面積が杯数に比例して見えるように）
        const r = visited ? 6 + 14 * Math.sqrt(p.count / maxCount) : 5;
        const marker = L.circleMarker([p.lat, p.lng], {
          radius: r,
          color: visited ? C_BOWL : C_TODO,
          weight: visited ? 1.5 : 1.5,
          fillColor: visited ? C_BOWL : "#ffffff",
          fillOpacity: visited ? 0.7 : 0.9,
        }).addTo(map);
        const head = visited
          ? `<b>${escapeHtml(p.key)}</b> ${p.count}杯`
          : `<b>${escapeHtml(p.key)}</b> 百名店・まだ${p.count}店`;
        const list = p.shops
          .slice(0, 12)
          .map((s) => {
            const name = escapeHtml(s.name);
            const sub = s.sub ? ` <span style="color:#888">${escapeHtml(s.sub)}</span>` : "";
            return s.url
              ? `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">${name}</a>${sub}</li>`
              : `<li>${name}${sub}</li>`;
          })
          .join("");
        const more = p.shops.length > 12 ? `<li>…ほか${p.shops.length - 12}店</li>` : "";
        marker.bindPopup(
          `<div style="font-size:12px;line-height:1.5">${head}<ul style="margin:4px 0 0;padding-left:16px">${list}${more}</ul></div>`
        );
      }

      // 初期表示は生活圏の訪問点に合わせる（出張先まで入れると日本全図になる）
      const near = points.filter(
        (p) => p.kind === "visited" && Math.abs(p.lat - HOME.lat) < NEAR_DEG && Math.abs(p.lng - HOME.lng) < NEAR_DEG
      );
      const base = near.length > 0 ? near : points.filter((p) => p.kind === "visited");
      if (base.length > 0) {
        map.fitBounds(
          L.latLngBounds(base.map((p) => [p.lat, p.lng] as [number, number])),
          { padding: [24, 24], maxZoom: 13 }
        );
      } else {
        map.setView([HOME.lat, HOME.lng], 11);
      }
    })();

    return () => {
      disposed = true;
      map?.remove();
    };
  }, [points]);

  return (
    <div
      ref={ref}
      data-testid="ramen-map"
      className="h-80 w-full overflow-hidden rounded-xl bg-gray-100 ring-1 ring-gray-200"
      aria-label="訪問した店と百名店の地図"
    />
  );
}

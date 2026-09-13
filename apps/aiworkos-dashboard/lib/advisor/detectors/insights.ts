// 夜間参謀の示唆に、判断が付かないまま溜まっていないかを見る検知器。
//
// ■ なぜ要るか
//   夜間参謀（insights）は、採用/見送り/的外れ の判断が押されて初めて学べる。
//   判断が無いと翌晩も同じ筋を出し続け、そのうちカードごと読まれなくなる——
//   weekly_focus が1週で死んだのと同じ形の失敗を、示唆でも踏むことになる。
//   「判断が溜まっている」は日付と件数で言い切れる事実なので、
//   ルールベースの参謀（この層）が言うのが筋。仮説層（夜間参謀自身）に
//   「僕の示唆を読んで」と言わせると、お手盛りになって信用を失う。
//
// ■ 閾値
//   2日待つ。前の晩の分に翌朝判断が付かないのは普通の忙しさの範囲で、
//   毎朝せっつくと通知そのものを無視する癖がつく（watchlist.ts の教訓）。
//   2日放置が3件以上溜まったときだけ、静かに1件で言う。

import type { Detector, Finding } from "../types";
import { daysAgo, shortDate } from "../types";
import { restHeaders } from "@/lib/supabase";

export const insightsDetector: Detector = {
  name: "insights",
  async run(ctx): Promise<Finding[]> {
    const cutoff = daysAgo(ctx.today, 2);
    const res = await fetch(
      `${ctx.creds.url}/rest/v1/insights?select=generated_on` +
        `&verdict=is.null&generated_on=lte.${cutoff}&order=generated_on.asc&limit=100`,
      { headers: restHeaders(ctx.creds.key), cache: "no-store" }
    );
    // テーブル未作成（導入前）は「異常なし」でよい。落とすと failed 表示になり、
    // 導入していないだけの環境で毎朝「検知が動かなかった」と出てしまう。
    if (!res.ok) return [];
    const rows = (await res.json()) as { generated_on: string }[];
    if (rows.length < 3) return [];

    const oldest = rows[0].generated_on;
    return [
      {
        id: "insights-unjudged",
        area: "記録",
        severity: "info",
        title: `夜間参謀の示唆 ${rows.length}件に判断が付いていません`,
        facts: [
          `最も古いものは ${shortDate(oldest)} の晩の分`,
          "判断（採用/見送り/的外れ）が無いと、翌晩の参謀は同じ話を繰り返します",
        ],
        href: "/#night-insight-card",
        hrefLabel: "示唆を見る",
      },
    ];
  },
};

// 「次に攻める相手」の定義。ホーム（/api/next-targets）と連携ダッシュボード
// （/api/status）の両方がここを読む。
//
// 分けて書いていたせいで実際に事故った：2026-08-10、ホームのカードだけ
// 「対象外」の除外を掛け忘れ、吉井さんが対象外にしたはずのゆうちょ銀行・
// 十八親和銀行・福岡銀行が毎朝ホームの先頭に並んでいた。/status では正しく
// 消えていたので、画面によって言うことが違う状態になっていた。
//
// 「誰を攻めるか」は、このOSでいちばん間違えてはいけない判断。定義は1か所に置く。

import { anonCreds, restHeaders } from "@/lib/supabase";

/** Notion「顧客CRM」の写し1行。 */
export type CrmOrg = {
  notion_page_id: string;
  name: string;
  status: string | null;
};

/**
 * 突合キー。法人格の表記ゆれ（「アトラス情報サービス」と「〜株式会社」）を吸収する。
 * 会議記録・週報から来る名前と、顧客CRMの正式名称は一致しないことが多い。
 */
export function orgKey(name: string): string {
  return name
    .replace(/(株式会社|有限会社|合同会社|一般社団法人|一般財団法人|公益財団法人|公益社団法人)/g, "")
    .replace(/（株）|\(株\)|（有）|\(有\)/g, "")
    .replace(/[\s　]/g, "")
    .toLowerCase();
}

/** 顧客CRMの索引（キー→行）。取れなければ空を返す（呼び出し側は一覧自体は出す）。 */
export async function fetchCrmIndex(): Promise<Map<string, CrmOrg>> {
  const map = new Map<string, CrmOrg>();
  const c = anonCreds();
  if (!c) return map;
  try {
    const res = await fetch(
      `${c.url}/rest/v1/notion_organizations?select=notion_page_id,name,status&limit=2000`,
      { headers: restHeaders(c.key), cache: "no-store", signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return map;
    const rows = await res.json();
    if (!Array.isArray(rows)) return map;
    for (const r of rows as CrmOrg[]) {
      const name = typeof r?.name === "string" ? r.name.trim() : "";
      if (!name || typeof r?.notion_page_id !== "string") continue;
      const k = orgKey(name);
      // 表記ゆれで同じキーに複数当たったら、正確な名前の行を優先する。
      if (!map.has(k) || map.get(k)!.name.length > name.length) {
        map.set(k, { notion_page_id: r.notion_page_id, name, status: r.status ?? null });
      }
    }
    return map;
  } catch {
    return map;
  }
}

/**
 * 「対象外」にした団体か。
 *
 * dashboard_stats は会議記録と週報からも団体を組み立てるため、顧客CRM側で
 * 対象外にしても会議側の枝から一覧に残る。除外はここを通して判定すること。
 */
export function isExcluded(name: string, crm: Map<string, CrmOrg>): boolean {
  return crm.get(orgKey(name))?.status === "対象外";
}

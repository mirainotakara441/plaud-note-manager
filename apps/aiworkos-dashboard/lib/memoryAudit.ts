// 記憶（memory_chunks）の健康診断。読むだけで、直さない。
//
// ■ なぜ要るか
// この記憶層は「1件の文書が複数のチャンク行に分かれて入る」形だが、
// **chunk_index に相当する列が無い**。何番目のチャンクかは
//   ・title の末尾（｜1/16 や ｜text1）
//   ・metadata.位置（"1/16" や "text1" や "slide3"）
//   ・source_id の末尾
// のどれかに、書き込む側ごとにバラバラな書式で入っている。
// そのため「チャンク数」と「文書数」を取り違える事故が起きやすい
// （実際 org-history が1会議26チャンクを26会議と数えていた）。
// ここはその取り違えが今どれだけ起きているかを、事実として並べる。
//
// ■ やらないこと
// 修正・名寄せ・削除・再Embedding・migration はしない。
// 表記揺れも「候補」として出すだけで、機械的に統合しない
// （「横浜市」と「横浜市・相模原市」は別物かもしれない）。

import { documentKey, hasChunkSuffix, stripChunkSuffix } from "./organizations";

/** 監査に使う列。content と embedding は重いので取らない。 */
export const AUDIT_SELECT = "source_type,source_id,organization,title,event_date,metadata";

export type AuditRow = {
  source_type: string;
  source_id: string | null;
  organization: string | null;
  title: string;
  event_date: string | null;
  metadata: Record<string, unknown> | null;
};

/** 事実として確定している不整合。 */
export type Confirmed = {
  key: string;
  label: string;
  count: number;
  detail: string;
  /** 代表例。何が起きているか目で見て分かるように。 */
  samples: string[];
};

/** 人の判断が要る「候補」。ここから先は勝手に決めない。 */
export type Candidate = {
  key: string;
  label: string;
  count: number;
  detail: string;
  samples: string[];
};

export type AuditResult = {
  total: number;
  /** 取得上限に当たったか。当たっていたら数字は「以上」の意味になる。 */
  truncated: boolean;
  bySourceType: Array<{
    source_type: string;
    chunks: number;
    docs: number;
    org_null: number;
    pos_missing: number;
  }>;
  confirmed: Confirmed[];
  candidates: Candidate[];
  heavyDocs: Array<{ doc: string; source_type: string; date: string | null; chunks: number }>;
};

function meta(r: AuditRow, key: string): string | null {
  const v = r.metadata?.[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * 文書としての識別子。
 *
 * 2026-08-28に本番の集計側（lib/organizations.ts の documentKey）を直したので、
 * 監査もそこを読む。監査だけ別の束ね方を持つと、画面に出す「文書数」と
 * 実際の集計がずれ、どちらが本当か分からなくなる。
 */
function docKey(r: AuditRow): string {
  return documentKey(r);
}

/**
 * source_id から末尾のチャンク番号を外し、「同じ文書を指す素性」に寄せる。
 *
 * ★`#2` 形式（plaud:xxx#2、weapon:…:story#3）を外し忘れると、同じ文書の
 *   チャンクどうしが「別系統」に見えて二重登録として誤検知する
 *   （2026-08-28、実装中に109件の誤検知を出した）。
 */
function sourceBase(sid: string): string {
  return sid
    .replace(/#\d+$/, "")
    .replace(/[:|](?:\d+|(?:text|slide|p)\d+)$/, "");
}

function count<T>(rows: T[], f: (r: T) => boolean): number {
  return rows.filter(f).length;
}

export function auditMemory(rows: AuditRow[], limit: number): AuditResult {
  const truncated = rows.length >= limit;

  // ── source_type 別 ────────────────────────────────────
  const types = [...new Set(rows.map((r) => r.source_type))];
  const bySourceType = types
    .map((t) => {
      const rs = rows.filter((r) => r.source_type === t);
      return {
        source_type: t,
        chunks: rs.length,
        docs: new Set(rs.map(docKey)).size,
        org_null: count(rs, (r) => !r.organization || r.organization.trim() === ""),
        pos_missing: count(rs, (r) => meta(r, "位置") === null),
      };
    })
    .sort((a, b) => b.chunks - a.chunks);

  const confirmed: Confirmed[] = [];
  const candidates: Candidate[] = [];

  // ── 確定①：source_id が無い ──────────────────────────
  const noSid = rows.filter((r) => !r.source_id || r.source_id.trim() === "");
  if (noSid.length > 0) {
    confirmed.push({
      key: "source_id_missing",
      label: "source_id が空",
      count: noSid.length,
      detail: "source_id はupsertの鍵。空だと同じものを入れ直すたびに増える",
      samples: noSid.slice(0, 3).map((r) => `${r.source_type}｜${r.title.slice(0, 40)}`),
    });
  }

  // ── 確定②：同じ source_id が複数行 ───────────────────
  const sidCount = new Map<string, number>();
  for (const r of rows) {
    if (!r.source_id) continue;
    sidCount.set(r.source_id, (sidCount.get(r.source_id) ?? 0) + 1);
  }
  const dupSid = [...sidCount.entries()].filter(([, n]) => n > 1);
  if (dupSid.length > 0) {
    confirmed.push({
      key: "source_id_duplicated",
      label: "同じ source_id が複数行ある",
      count: dupSid.length,
      detail: "upsertの鍵が重複している。片方だけ更新され、もう片方が古いまま残る",
      samples: dupSid.slice(0, 3).map(([sid, n]) => `${sid.slice(0, 50)}（${n}行）`),
    });
  }

  // ── 確定③：チャンク接尾辞を落とし切れなかったタイトル ──
  //
  // stripChunkSuffix は既知の形式を繰り返し落とすが、積み過ぎ（5段以上）や
  // 全部消えて空になる場合は途中で止めて元を返す。その取りこぼしだけを拾う。
  //
  // ★「数字で終わるタイトル」を疑ってはいけない。日付で終わる正当なタイトル
  //   （…｜武器｜想定ストーリー｜2026-07-17）まで拾ってしまい、実際121件の
  //   誤検知を出した（2026-08-28、実装中に発覚）。落とし切れたかどうかだけを見る。
  const stillChunked = rows.filter((r) => hasChunkSuffix(stripChunkSuffix(r.title)));
  if (stillChunked.length > 0) {
    confirmed.push({
      key: "title_suffix_unstrippable",
      label: "チャンク接尾辞を落とし切れていない",
      count: stillChunked.length,
      detail:
        "接尾辞が想定より深く積まれている可能性がある。実データを見て確認すること" +
        "（推測で広く消す正規表現にはしない）",
      samples: stillChunked.slice(0, 3).map((r) => r.title.slice(0, 50)),
    });
  }

  // ── 確定④：同じ文書なのに source_id の素性が割れている ────
  const bases = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.source_id) continue;
    const k = docKey(r);
    if (!bases.has(k)) bases.set(k, new Set());
    bases.get(k)!.add(sourceBase(r.source_id));
  }
  const split = [...bases.entries()].filter(([, s]) => s.size > 1);
  if (split.length > 0) {
    confirmed.push({
      key: "doc_split_across_sources",
      label: "同じ資料名＋日付が複数の source_id 系統に分かれている",
      count: split.length,
      detail: "同じ文書を別々の経路で入れた可能性。どちらが正か機械では決められない",
      samples: split.slice(0, 3).map(([k, s]) => `${k.slice(0, 40)}（${s.size}系統）`),
    });
  }

  // ── 候補①：organization が空 ─────────────────────────
  const orgNull = count(rows, (r) => !r.organization || r.organization.trim() === "");
  if (orgNull > 0) {
    candidates.push({
      key: "organization_null",
      label: "organization が空",
      count: orgNull,
      detail:
        "団体別の画面は organization の完全一致で引くため、空の行はどの団体からも見えない。" +
        "日記・振り返りのように元々団体に紐づかないものも含むので、全部が異常ではない",
      samples: [...new Set(rows.filter((r) => !r.organization).map((r) => r.source_type))].slice(0, 6),
    });
  }

  // ── 候補②：1つの organization 欄に複数団体が入っている ──
  const multiOrg = [
    ...new Set(
      rows
        .map((r) => r.organization)
        .filter((o): o is string => !!o && /[・,、/／]/.test(o))
    ),
  ];
  if (multiOrg.length > 0) {
    candidates.push({
      key: "organization_multi",
      label: "1つの organization 欄に複数の団体名が入っている",
      count: multiOrg.length,
      detail:
        "団体別の画面は完全一致で引くので、この行はどの団体を選んでも出てこない。" +
        "分割すべきか、そもそも1件の会議だったのかは中身を見ないと決められない",
      samples: multiOrg.slice(0, 5),
    });
  }

  // ── 候補③：表記揺れ（前方一致するペア）──────────────
  // 機械的に統合しない。「横浜市」と「横浜市・相模原市」は別物かもしれない。
  const orgCount = new Map<string, number>();
  for (const r of rows) {
    const o = r.organization?.trim();
    if (!o) continue;
    orgCount.set(o, (orgCount.get(o) ?? 0) + 1);
  }
  const names = [...orgCount.keys()];
  const pairs: string[] = [];
  for (const a of names) {
    for (const b of names) {
      if (a === b || b.length <= a.length) continue;
      if (b.startsWith(a)) pairs.push(`${a}（${orgCount.get(a)}）⊂ ${b}（${orgCount.get(b)}）`);
    }
  }
  if (pairs.length > 0) {
    candidates.push({
      key: "organization_variants",
      label: "表記揺れの候補（片方がもう片方で始まる）",
      count: pairs.length,
      detail: "同じ団体かどうかは人が見て決める。ここでは統合していない",
      samples: pairs.slice(0, 5),
    });
  }

  // ── 候補④：資料名の粒度がバラバラ ────────────────────
  // 「無題」のように、別々の文書が1つの資料名に潰れているもの。
  const byShiryo = new Map<string, { chunks: number; dates: Set<string>; titles: Set<string> }>();
  for (const r of rows) {
    const name = meta(r, "資料名");
    if (!name) continue;
    if (!byShiryo.has(name)) {
      byShiryo.set(name, { chunks: 0, dates: new Set(), titles: new Set() });
    }
    const e = byShiryo.get(name)!;
    e.chunks += 1;
    if (r.event_date) e.dates.add(r.event_date);
    e.titles.add(stripChunkSuffix(r.title));
  }
  const coarse = [...byShiryo.entries()].filter(([, v]) => v.dates.size > 1);
  if (coarse.length > 0) {
    candidates.push({
      key: "shiryo_too_coarse",
      label: "1つの資料名が複数の日付にまたがっている",
      count: coarse.length,
      detail:
        "資料名を文書の識別に使う処理（groupDeliverables）では、別の日の別資料が" +
        "1つにまとまってしまう。「無題」で登録されたものが主な原因",
      samples: coarse
        .sort((a, b) => b[1].chunks - a[1].chunks)
        .slice(0, 4)
        .map(([n, v]) => `${n}（${v.chunks}chunk・${v.dates.size}日付）`),
    });
  }

  // ── チャンクが極端に多い文書 ─────────────────────────
  const docChunks = new Map<string, { source_type: string; date: string | null; n: number }>();
  for (const r of rows) {
    const k = docKey(r);
    const e = docChunks.get(k);
    if (e) e.n += 1;
    else docChunks.set(k, { source_type: r.source_type, date: r.event_date, n: 1 });
  }
  const heavyDocs = [...docChunks.entries()]
    .map(([doc, v]) => ({ doc, source_type: v.source_type, date: v.date, chunks: v.n }))
    .sort((a, b) => b.chunks - a.chunks)
    .slice(0, 8);

  return {
    total: rows.length,
    truncated,
    bySourceType,
    confirmed,
    candidates,
    heavyDocs,
  };
}

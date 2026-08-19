import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";
import {
  notionToken,
  fetchNotionCrm,
  type OrgRow,
  type ContactRow,
} from "@/lib/notionContacts";

// Notion「顧客CRM」「人脈DB」→ Supabase notion_organizations / notion_contacts の同期。
// Vercel Cron から定期的に叩かれる。Notionが正で、Supabase側は毎回まるごと洗い直す写し。
//
// 差分同期にしていない理由:
//   対象は団体60件＋人物110件程度で、全件取得しても Notion API 2〜3往復・数秒で終わる。
//   last_edited_time による差分は「Notion側で消された行」の検出を別途必要とし、
//   取りこぼすと写しに幽霊行が残る。規模が小さいうちは全件のほうが確実。
//
// 消えた行の始末（mark and sweep）:
//   1. この実行の時刻 runStamp を決める
//   2. Notionに生きている全行を synced_at = runStamp で upsert する
//   3. synced_at <> runStamp の行を削除する（＝今回Notionに居なかった行）
//   notion_page_id の not.in リストを組むより安全。170件ぶんのIDをURLに並べると
//   長さ上限に当たるし、件数が増えたときに黙って壊れる。
//
// ★安全弁★ Notionから0件しか返ってこなかった場合は削除を実行しない。
//   APIの一時障害やトークン失効で空応答になったとき、sweepが写しを全消しするのを防ぐ。
//   「同期が失敗したら写しが空になる」のは一番タチの悪い壊れ方なので、必ず残すこと。
//   orgsとcontactsは別々のNotionクエリで取得しているため片方だけ失敗しうる。
//   両方0件なら全体を中断、片方だけ0件ならそのテーブルのupsert/sweepだけをスキップする。

export const dynamic = "force-dynamic";

const COOKIE_NAME = "aiworkos_auth";
const CHUNK = 200;

// Vercel Cron（CRON_SECRET）と、ブラウザからの手動実行（合言葉cookie）の両方を許す。
// 手動実行を許すのは、Notionを直したあと次のcronを待たずに反映させたい場面があるため。
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

type Creds = { url: string; key: string };

async function upsertAll(
  c: Creds,
  table: string,
  rows: (OrgRow | ContactRow)[],
  runStamp: string
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => ({ ...r, synced_at: runStamp }));
    const res = await fetch(`${c.url}/rest/v1/${table}?on_conflict=notion_page_id`, {
      method: "POST",
      headers: restHeaders(c.key, {
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify(chunk),
      cache: "no-store",
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`${table} upsert ${res.status}: ${t.slice(0, 300)}`);
    }
  }
}

// 今回の実行で触らなかった行（＝Notion側で消された行）を落とす。削除件数を返す。
async function sweep(c: Creds, table: string, runStamp: string): Promise<number> {
  const res = await fetch(
    `${c.url}/rest/v1/${table}?synced_at=neq.${encodeURIComponent(runStamp)}`,
    {
      method: "DELETE",
      headers: restHeaders(c.key, { Prefer: "return=representation" }),
      cache: "no-store",
    }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${table} sweep ${res.status}: ${t.slice(0, 300)}`);
  }
  const deleted = await res.json().catch(() => []);
  return Array.isArray(deleted) ? deleted.length : 0;
}

async function run(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const token = await notionToken();
  if (!token) {
    return NextResponse.json(
      { error: "Notionトークンが取得できません（NOTION_TOKEN / app_config）" },
      { status: 500 }
    );
  }

  const runStamp = new Date().toISOString();

  try {
    const { orgs, contacts, orgSkipped, contactSkipped } = await fetchNotionCrm(token);

    // 安全弁（上記コメント参照）。取得0件は「Notionが空」より「取得に失敗した」の
    // 可能性がはるかに高いので、写しには一切手を付けずに失敗として返す。
    const orgsFailed = orgs.length === 0;
    const contactsFailed = contacts.length === 0;

    if (orgsFailed && contactsFailed) {
      return NextResponse.json(
        {
          error:
            "Notionから0件しか取得できなかったため中断しました（写しは変更していません）",
          orgSkipped,
          contactSkipped,
        },
        { status: 502 }
      );
    }

    let orgDeleted = 0;
    let contactDeleted = 0;

    if (!orgsFailed) {
      await upsertAll(c, "notion_organizations", orgs, runStamp);
      orgDeleted = await sweep(c, "notion_organizations", runStamp);
    }
    if (!contactsFailed) {
      await upsertAll(c, "notion_contacts", contacts, runStamp);
      contactDeleted = await sweep(c, "notion_contacts", runStamp);
    }

    return NextResponse.json({
      ok: true,
      syncedAt: runStamp,
      organizations: {
        upserted: orgs.length,
        deleted: orgDeleted,
        skipped: orgSkipped,
        failed: orgsFailed,
      },
      contacts: {
        upserted: contacts.length,
        deleted: contactDeleted,
        skipped: contactSkipped,
        failed: contactsFailed,
      },
    });
  } catch (err) {
    console.error("cron/notion-sync: 同期失敗", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return run(req);
}

// 手動の「今すぐ同期」ボタンから叩けるようにPOSTも受ける（処理は同じ）。
export async function POST(req: NextRequest) {
  return run(req);
}

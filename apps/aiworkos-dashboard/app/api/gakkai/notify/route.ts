import { NextRequest, NextResponse } from "next/server";
import { serviceCreds, restHeaders } from "@/lib/supabase";
import { cookieValueFor, constantTimeEqual } from "@/lib/auth";
import { sendPushToAll } from "@/lib/pushNotify";
import { sendLineToYoshii } from "@/lib/lineNotify";

// 学会書類の納期リマインド。毎朝 JST 8:00 に Vercel Cron から叩かれる。
//
// 書類の取込は Mac 上のローカル定期タスク（毎朝8:00）だが、リマインドまで
// Mac 任せにすると「Macが閉じていた朝」に納期通知が丸ごと落ちる。
// 納期は落とせないので、通知だけは Vercel 側で独立に飛ばす。
//
// 3段階リマインド（JSTの今日を基準に、完了以外かつ deadline がある行を判定）:
//   d3: 納期の3日前が今日 / d1: 前日が今日 / d0: 当日
// 送信済みの段階は notified（例: {"d3":"2026-09-20"}）に記録し、同じ段階は
// 二度と送らない（同日に2回叩かれても冪等）。日付を入れているのは値の
// true/false より「いつ送ったか」が後から追えるほうが調査しやすいため。
//
// 送信は2経路: Web Push（既存の全端末購読）と LINE。LINE が未設定でも
// 失敗にせずスキップする（lib/lineNotify.ts 参照）。
//
// 認証は cron/notion-sync と同じ2本立て:
//   - Vercel Cron: Authorization: Bearer $CRON_SECRET（Vercelが自動付与）
//   - ブラウザからの手動実行: 合言葉cookie（取込直後に次の朝を待たず試したい場面用）
// proxy.ts の PUBLIC_PATHS にこのパスを追加してあるが、上記のどちらかを
// 通らない限り実行できない。

export const dynamic = "force-dynamic";

const COOKIE_NAME = "aiworkos_auth";
const TABLE = "gakkai_documents";

// 判定する段階。ラベルは通知文言の先頭に使う。
const STAGES = [
  { key: "d3", daysBefore: 3, label: "提出期限まであと3日" },
  { key: "d1", daysBefore: 1, label: "提出期限は明日" },
  { key: "d0", daysBefore: 0, label: "提出期限は今日" },
] as const;

type Row = {
  id: string;
  file_name: string | null;
  deadline: string | null;
  deadline_label: string | null;
  notified: Record<string, string> | null;
};

// JST基準の「今日」を YYYY-MM-DD で返す（Vercelの実行環境はUTCのため）。
// cron/daily-todo と同じ計算。
function jstTodayStr(): string {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// 日付文字列同士の差分日数（両方UTC 0時基準で解釈し、タイムゾーンのずれで
// 1日ぶれることを避ける）。deadline - today なので、当日=0・前日=1。
function daysUntil(deadlineStr: string, todayStr: string): number {
  const deadline = new Date(`${deadlineStr}T00:00:00Z`).getTime();
  const today = new Date(`${todayStr}T00:00:00Z`).getTime();
  return Math.round((deadline - today) / (24 * 60 * 60 * 1000));
}

// Vercel Cron（CRON_SECRET）と、ブラウザからの手動実行（合言葉cookie）の両方を許す。
// cron/notion-sync の authorized() と同じ判定。
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

async function run(req: NextRequest): Promise<NextResponse> {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  const c = serviceCreds();
  if (!c) return NextResponse.json({ error: "Supabase未設定" }, { status: 500 });

  const today = jstTodayStr();

  // 完了以外かつ deadline がある行だけ取る。段階判定は行数が少ないので
  // アプリ側で行う（deadlineの or 条件をPostgRESTのURLに組むより読みやすい）。
  const params = new URLSearchParams();
  params.set("select", "id,file_name,deadline,deadline_label,notified");
  params.set("status", "neq.完了");
  params.set("deadline", "not.is.null");
  const res = await fetch(`${c.url}/rest/v1/${TABLE}?${params.toString()}`, {
    headers: restHeaders(c.key),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `取得失敗 ${res.status}`, detail: detail.slice(0, 200) },
      { status: 502 }
    );
  }
  const rows: Row[] = await res.json();

  let sent = 0; // リマインドを送った書類の数
  let pushSent = 0; // Web Push の配達数（端末数ぶん）
  let lineSent = 0;
  let lineSkipped: string | null = null;
  const errors: string[] = [];

  for (const row of rows) {
    if (!row.deadline) continue;
    const diff = daysUntil(row.deadline, today);
    const stage = STAGES.find((s) => s.daysBefore === diff);
    if (!stage) continue;

    // 送信済みの段階はスキップ（冪等性の要）。
    const notified: Record<string, string> =
      row.notified && typeof row.notified === "object" ? row.notified : {};
    if (notified[stage.key]) continue;

    // deadline_label が空の書類（取込時に納期の中身まで読めなかったもの）でも
    // ファイル名だけで何の話か分かるようにする。
    const label = row.deadline_label?.trim() || "提出物";
    const fileName = row.file_name?.trim() || "書類名不明";
    const text = `【学会】${stage.label}: ${label}（${fileName}）`;

    // (a) Web Push（既存の全端末購読へ）
    try {
      const push = await sendPushToAll({ title: "学会書類", body: text, url: "/gakkai" });
      pushSent += push.sent;
    } catch (e) {
      console.error("gakkai/notify: Web Push送信失敗", e);
      errors.push(`push失敗(${row.id.slice(0, 8)})`);
    }

    // (b) LINE。未設定なら skipped が返るだけで失敗にはならない。
    const line = await sendLineToYoshii(text);
    if (line.ok) lineSent++;
    if (line.skipped) lineSkipped = line.skipped;

    // 送信を試みたら、成否によらず notified に段階を刻む。
    // 「片方の経路だけ成功」した後に未送信扱いへ戻すと、次の実行で成功した側が
    // 二重送信になる。リマインドは3段階あるので、1段階の取りこぼしより
    // 二重送信のほうを避ける。
    const patchBody: Record<string, unknown> = {
      notified: { ...notified, [stage.key]: today },
      updated_at: new Date().toISOString(),
    };
    if (line.ok) patchBody.line_notified_at = new Date().toISOString();
    const patchRes = await fetch(
      `${c.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(row.id)}`,
      {
        method: "PATCH",
        headers: restHeaders(c.key),
        body: JSON.stringify(patchBody),
        cache: "no-store",
      }
    );
    if (!patchRes.ok) {
      console.error("gakkai/notify: notified更新失敗", row.id, patchRes.status);
      errors.push(`notified更新失敗(${row.id.slice(0, 8)})`);
    }

    sent++;
  }

  return NextResponse.json({
    today,
    checked: rows.length,
    sent,
    pushSent,
    lineSent,
    lineSkipped,
    errors,
  });
}

export async function POST(req: NextRequest) {
  return run(req);
}

// Vercel Cron はパスを HTTP GET で叩く仕様のため、POST だけだと cron が 405 で
// 落ちる。同じ処理を GET でも受ける（認証は run() 内で必ず通る）。
export async function GET(req: NextRequest) {
  return run(req);
}

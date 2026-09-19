# 承認キュー API スケッチ（v1・未実装）

設計本体: `docs/approval-queue-design.md` ／ テーブル: `supabase/migrations/DRAFT_approval_queue.sql`

すべて `app/api/approval/` 配下（cron だけ `app/api/cron/approval-post`）。
JSON の形は既存ルートに合わせる: 成功は素のオブジェクト、失敗は `{ "error": "日本語の理由" }` と HTTP ステータス。
秘密の値は一切書かない（`<CRON_SECRET>` 等はプレースホルダ）。

## 認証（全ルート共通）

どちらか一方が通れば OK。`lib/approval/auth.ts` の `authorized(req)` に1本化する（中身は `app/api/cron/notion-sync/route.ts` の関数と同じ）。

| 経路 | ヘッダ / cookie | 使う側 |
|---|---|---|
| `Authorization: Bearer <CRON_SECRET>` | ヘッダ | Claude Code スキル（`approval-enqueue.sh`）、launchd、Vercel Cron |
| `aiworkos_auth=<cookieValueFor(APP_PASSPHRASE)>` | cookie | iPhone / Mac のブラウザ（カード） |

`/api/approval/*` は `proxy.ts` の合言葉ゲートの内側（cookie 無しなら 401）。**ただし Bearer で来る `POST /api/approval` と `/api/cron/approval-post` は `PUBLIC_PATHS` に足す**（ルート側で Bearer を照合するので無認証では通らない。`/api/cron/notion-sync` と同じ）。

---

## `GET /api/approval`

判断待ちと直近3日の履歴。カードが開くたびに叩く（`cache: "no-store"`）。

```
GET /api/approval?days=3
```

```json
{
  "available": true,
  "posting_enabled": false,
  "pending": [
    {
      "id": "6c1f…",
      "kind": "x_post",
      "status": "pending",
      "title": "🧠 まだ議事録、手で要約してますか？",
      "body": "🧠 まだ議事録、手で要約してますか？\n\nClaude の新機能で…\n\n#営業DX #生成AI #営業AI実践室",
      "body_json": {
        "account": "sales_ai_lab",
        "thread": null,
        "media": [],
        "quote_tweet_id": null,
        "has_url": false,
        "weighted_len": 238
      },
      "source": "x-sales-ai-lab-morning-draft",
      "source_ref": "x_digest:2026-09-19",
      "scheduled_for": null,
      "cost_usd": 0.015,
      "created_at": "2026-09-19T22:02:11.412Z"
    }
  ],
  "recent": [
    {
      "id": "b2a0…",
      "kind": "x_post",
      "status": "posted",
      "title": "…",
      "external_id": "1968…",
      "post_result": { "url": "https://x.com/sales_ai_lab/status/1968…" },
      "cost_usd": 0.015,
      "posted_at": "2026-09-18T22:40:03.000Z"
    },
    {
      "id": "9d3e…",
      "kind": "x_post",
      "status": "failed",
      "title": "…",
      "post_result": { "error": "403 … Read-only application cannot POST" },
      "created_at": "2026-09-17T22:01:50.000Z"
    }
  ],
  "month": { "posted": 3, "cost_usd": 0.045, "cap_usd": 3.0 }
}
```

- `available:false` … 表が無い環境（導入前）。カードは何も出さない（`NightInsightCard` と同じ）
- `posting_enabled` … `APPROVAL_POSTING_ENABLED === "true"`。false のときカードは「承認」ボタンの文言を「承認（投稿は停止中）」にする
- `month` … 今月（JST）の x_post 投稿本数と合計コスト。上限に近いとカードで警告

---

## `POST /api/approval`（積む）

スキルから。Bearer 必須（cookie でも通るが、画面からの手入力は v1 では作らない）。

```
POST /api/approval
Authorization: Bearer <CRON_SECRET>
Content-Type: application/json
```

```json
{
  "kind": "x_post",
  "source": "x-sales-ai-lab-morning-draft",
  "source_ref": "x_digest:2026-09-19",
  "title": null,
  "body": "🧠 まだ議事録、手で要約してますか？\n\n…\n\n#営業DX #生成AI #営業AI実践室",
  "body_json": { "account": "sales_ai_lab" },
  "scheduled_for": null,
  "notify": false
}
```

サーバ側でやること（順に）:
1. `kind` / `source` / `body` の必須検査。`title` が無ければ本文の先頭1行（40字まで）
2. `kind=x_post` なら `lib/x.ts` で加重文字数 `weighted_len` と `has_url` を計算し `body_json` に足す。`weighted_len > 280` は **400**（積ませない。280超のまま人に見せると「直してから承認」が常態化する）
3. `cost_usd = estimateCostUsd(body) × (thread?.length ?? 1)`
4. `source + source_ref` が `pending` / `approved` に既にあれば **409**（二重起票）
5. INSERT（`status: "pending"`）＋ `approval_queue_events` に `created`（actor: `skill:<source>`）
6. `notify:true` なら `sendPushToAll({ title: "承認待ち", body: title })`

```json
{
  "id": "6c1f…",
  "status": "pending",
  "weighted_len": 238,
  "has_url": false,
  "cost_usd": 0.015,
  "url": "https://aiworkos-dashboard.vercel.app/#approval-card"
}
```

失敗例:

```json
{ "error": "本文が加重280を超えています（実測 296）。削ってから積んでください" }   // 400
{ "error": "同じ元ネタ（x_digest:2026-09-19）が承認待ちにあります", "id": "6c1f…" }  // 409
{ "error": "認証が必要です" }                                                      // 401
```

スレッドの場合:

```json
{
  "kind": "x_post",
  "source": "…",
  "body": "1本目の本文",
  "body_json": {
    "account": "sales_ai_lab",
    "thread": ["1本目の本文", "2本目の本文", "3本目の本文"]
  }
}
```

`thread` があるときは `body` は `thread[0]` と一致していること（違えば 400）。加重文字数は**1本ごと**に検査。`cost_usd` は本数倍。

---

## `POST /api/approval/[id]/approve`

カードから。cookie 認証（Bearer でも通るが、**フック側で `curl … /approve` を拒否する**ので、エージェントからは押せない）。

```json
{ "post": true, "actor": "iphone-card" }
```

- `post`（既定 true）… `kind=x_post` かつ `scheduled_for` が null なら、その場で `lib/approval/post.ts` を呼ぶ
- `status` が `pending` でなければ **409**（`{ "error": "この行は pending ではありません", "status": "posted" }`）

応答（x_post・投稿まで成功）:

```json
{
  "id": "6c1f…",
  "status": "posted",
  "external_id": "1968…",
  "url": "https://x.com/sales_ai_lab/status/1968…",
  "cost_usd": 0.015
}
```

応答（x_post・投稿は停止中／予約あり／fb_post／note_draft）:

```json
{ "id": "6c1f…", "status": "approved", "posted": false, "reason": "posting_disabled" }
```

`reason` は `posting_disabled` / `scheduled` / `manual_kind` / `worker_kind` のどれか。

応答（x_post・投稿失敗）:

```json
{ "id": "6c1f…", "status": "failed", "error": "403 … Read-only application cannot POST" }   // 502
```

月の上限に当たったとき:

```json
{ "id": "6c1f…", "status": "failed", "error": "今月のX投稿が上限 $3.00 に達しています（累計 $2.99 + 見積 $0.20）" }   // 402
```

`lib/approval/post.ts` の中身（approve と cron で共用）:
1. `UPDATE … SET post_lock='posting' WHERE id=… AND status='approved' AND post_lock IS NULL` を `Prefer: return=representation` で叩き、0行なら中断（`ramen/post-x` の claim と同じ）
2. 月間コスト検査（§9）
3. `uploadMedia`（あれば）→ `postTweet`（スレッドは順に `reply.in_reply_to_tweet_id`）
4. 成功: `status='posted', posted_at, external_id, post_result, cost_usd（確定）, post_lock=NULL`、events に `posted`（`detail.text` に実際に送った本文）
5. 書き戻し失敗: `post_lock='post_failed_needs_review'` のまま残す（二重投稿防止）
6. 投稿失敗: `status='failed', post_result.error, post_lock=NULL`、events に `failed`、Push

---

## `POST /api/approval/[id]/reject`

```json
{ "note": "Manusの話は方針で出さないと決めた", "actor": "iphone-card" }
```

```json
{ "id": "6c1f…", "status": "rejected" }
```

`note` は任意。`pending` 以外は 409。events に `rejected`（`note` はここにも）。

---

## `POST /api/approval/[id]/edit`

```json
{
  "body": "🧠 まだ議事録、手で要約してますか？（直した本文）",
  "body_json": { "thread": null },
  "actor": "iphone-card"
}
```

- `pending` か `approved` のみ。`approved` なら **`pending` に戻す**（承認のやり直し）
- 加重文字数・`has_url`・`cost_usd` を再計算。280 超は 400
- events に `edited`（`detail: { before: { body }, after: { body } }`）

```json
{ "id": "6c1f…", "status": "pending", "weighted_len": 231, "has_url": false, "cost_usd": 0.015 }
```

---

## `POST /api/approval/[id]/mark-posted`

fb_post / note_draft / email / calendar を人が外に出したあと。

```json
{ "external_id": "https://www.facebook.com/…/posts/…", "actor": "iphone-card" }
```

```json
{ "id": "…", "status": "posted" }
```

`approved` のみ。`external_id` は任意（無ければ `post_result: { "manual": true }` を入れて CHECK を満たす）。
「コピーして手動投稿」ボタンは別途 `POST /api/approval/[id]/copied`（events に `copied` を1行足すだけ。失敗しても UI は止めない）。

---

## `POST /api/approval/[id]/retry`

`failed → approved`（＋ `post:true` なら即投稿）。人が押す。events に `retried`。

---

## `POST /api/cron/approval-post`

Vercel Cron（`vercel.json` に `{ "path": "/api/cron/approval-post", "schedule": "0 22 * * *" }` を足す ＝ JST 7:00）。launchd から毎時叩いてもよい。

```
POST /api/cron/approval-post
Authorization: Bearer <CRON_SECRET>
```

対象: `status='approved' AND kind='x_post' AND post_lock IS NULL AND (scheduled_for IS NULL OR scheduled_for <= now())`。
1回の実行で最大 **5件**（暴走の上限。残りは次回）。`APPROVAL_POSTING_ENABLED` が true でなければ何もしない。

```json
{
  "posting_enabled": true,
  "picked": 2,
  "posted": [ { "id": "…", "external_id": "…", "cost_usd": 0.015 } ],
  "failed": [ { "id": "…", "error": "…" } ],
  "skipped_cap": 0,
  "ms": 2310
}
```

終わりに `job_heartbeats` の `approval-post` を打つ（`record_job_heartbeats` RPC）。`WATCHED_JOBS` に `staleHours: 48` で追加。

---

## Mac ワーカー（note_draft）

API ではなく PostgREST 直接（service role、`~/.config/aiworkos/nippo.env` を流用）。`integration-worker` の `jobs.py` に `approval` サブコマンドを足す想定。

```
GET  <SUPABASE_URL>/rest/v1/approval_queue?select=id,title,body,body_json&kind=eq.note_draft&status=eq.approved&post_lock=is.null&order=approved_at
PATCH <SUPABASE_URL>/rest/v1/approval_queue?id=eq.<id>&status=eq.approved&post_lock=is.null   body: {"post_lock":"posting"}
   … Playwright で note.com の下書き保存 …
PATCH <SUPABASE_URL>/rest/v1/approval_queue?id=eq.<id>   body: {"status":"posted","posted_at":"…","post_result":{"note_draft_url":"https://note.com/…/n/…","published":false},"post_lock":null}
POST  <SUPABASE_URL>/rest/v1/approval_queue_events   body: {"queue_id":"<id>","event":"posted","actor":"worker:note","detail":{"note_draft_url":"…"}}
```

`posted` の意味は「note の下書きに置いた」。公開は人が note の画面で押す（`post_result.published:false` で区別）。

---

## curl ヘルパー `~/.local/bin/approval-enqueue.sh`（仕様）

```
approval-enqueue.sh <kind> <source> <本文ファイル> [--title "…"] [--ref "表:ID"] [--json <body_json.json>] [--at "<ISO8601>"] [--line] [--notify]
```

```bash
# 環境: ~/.config/aiworkos/approval.env（2行。値はここに書かない）
#   AIWORKOS_URL=https://aiworkos-dashboard.vercel.app
#   CRON_SECRET=…
set -euo pipefail
ENV_FILE="$HOME/.config/aiworkos/approval.env"
[ -r "$ENV_FILE" ] || { echo "approval.env が読めない" >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a

# 引数 → JSON は python3 で組む（本文に引用符・改行があるので jq/手組みは避ける）
PAYLOAD=$(python3 - "$@" <<'PY'
import json, sys
kind, source, path = sys.argv[1:4]
opts = sys.argv[4:]
def opt(name):
    return opts[opts.index(name)+1] if name in opts else None
body = open(path, encoding="utf-8").read().rstrip("\n")
body_json = json.load(open(opt("--json"))) if opt("--json") else {}
print(json.dumps({
  "kind": kind, "source": source, "body": body,
  "title": opt("--title"), "source_ref": opt("--ref"),
  "body_json": body_json, "scheduled_for": opt("--at"),
  "notify": "--notify" in opts,
}, ensure_ascii=False))
PY
)

RESP=$(curl -s --max-time 30 -w '\n%{http_code}' -X POST \
  -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
  --data-binary "$PAYLOAD" "$AIWORKOS_URL/api/approval")
CODE=$(printf '%s' "$RESP" | tail -1)
BODY=$(printf '%s' "$RESP" | sed '$d')
echo "$BODY"
[ "$CODE" = "200" ] || exit 1

# --line のときだけ LINE へ（既存の send-line.sh をそのまま使う）
if printf '%s\n' "$@" | grep -qx -- '--line'; then
  TITLE=$(printf '%s' "$BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("title",""))')
  MSG=$(mktemp); printf '承認待ち1件：%s\n%s/#approval-card\n' "$TITLE" "$AIWORKOS_URL" > "$MSG"
  bash "$HOME/.config/salt2-line/send-line.sh" "$MSG" >/dev/null || true
  rm -f "$MSG"
fi
```

使い方（`x-sales-ai-lab-morning-draft` の §5 に足す1行）:

```bash
/Users/YOSHII/.local/bin/with-heartbeat.sh approval-enqueue \
  /Users/YOSHII/.local/bin/approval-enqueue.sh x_post x-sales-ai-lab-morning-draft /tmp/x-draft.txt \
  --ref "x_digest:$(date +%F)" --json /tmp/x-draft.json --line
```

`/tmp/x-draft.json` は `{"account":"sales_ai_lab"}`。応答の `id` / `weighted_len` / `cost_usd` をチャットに貼る。
400（280超）で落ちたら**スクリプト側で削らず**、スキルが本文を直して積み直す（数える規則はサーバの1か所）。

---

## PreToolUse フック `~/.local/bin/deny-direct-post.py`（仕様）

stdin: Claude Code のフック入力 JSON（`tool_name`, `tool_input.command`）。

拒否パターン（正規表現・大文字小文字無視）:
- `api\.x\.com/2/tweets|api\.twitter\.com`
- `/api/ramen/post-x|/api/approval/[^/]+/(approve|retry)|/api/cron/approval-post`
- `graph\.facebook\.com`

当たれば stdout に:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "外への投稿・承認は approval_queue 経由。積むのは approval-enqueue.sh、承認は吉井さんが画面で押す"
  }
}
```

当たらなければ何も出さず exit 0（既存の `log-mcp-calls.py` と同じ無害な既定）。
`~/.claude/settings.json` への追加は `update-config` スキルで行う（設定ファイルは手で直接編集しない）。

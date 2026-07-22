# 引き継ぎ書：アーキテクチャレビュー修正（2026-07-25 Fableレビュー起点）

実行担当：Sonnet想定（全タスクSonnetで可。判断に迷ったら手を止めて吉井さんに確認する）。
このドキュメントだけで作業できるよう書いてある。前提コンテキストはメモ `aiworkos-architecture-review` にもあり。

## 対象

- リポジトリ: `/Users/YOSHII/Claude/Code/apps/aiworkos-dashboard`（GitHub: mirainotakara441/plaud-note-manager、mainブランチ直コミット運用）
- Supabase project: `zuadqnarsoykplkafyxv`（MCPの `apply_migration` / `execute_sql` を使用）
- 本番: https://aiworkos-dashboard.vercel.app （mainへpushで自動デプロイ）

## 共通ルール（厳守）

1. コミットは対象ファイルだけを明示的に `git add`（このリポジトリは複数セッションが触る。`git add -A` 禁止）
2. 動作確認は `npm run build` → `.claude/launch.json`（`~/aiworkos-backups/.claude/launch.json`）の preview で行う。テスト中に `next dev` へ書き換えたら**必ず `next start -p 3033` に戻す**
3. `app/` `lib/` 以外の未追跡ディレクトリ（`../archive-site/` 等）には絶対に触らない
4. DB変更は必ず `apply_migration`（名前はsnake_case）。実行後 `get_advisors(security)` で該当警告が消えたことを確認
5. 各タスク完了ごとに動作確認してからコミット。全部まとめて1コミットにしない

---

## Task 1：合言葉ゲートのフェイルクローズ化（15分）

**問題**: `proxy.ts:13-14, 40-44` — `APP_PASSPHRASE` が未設定/空だと `NextResponse.next()` で全ページ・全APIが素通しになる（フェイルオープン）。

**修正**: 未設定/空のときは通さない。
- APIパス（`/api/`始まり）→ 503 JSON `{ error: "サーバー設定エラー: 認証が構成されていません" }`
- ページ → 同メッセージの簡素なテキスト応答（500系）。`/login` へ飛ばしても合言葉検証ができないため意味がない
- `PUBLIC_PATHS`（`/login`, `/api/login`, `/api/cron/daily-todo`, manifest等）は現状維持。`/api/cron/daily-todo` はルート内で `CRON_SECRET` を検証しているので影響なし

**確認**: ローカルで `APP_PASSPHRASE` を外して起動 → 全ルートが閉じること。戻して起動 → 通常動作。

---

## Task 2：書き込み経路を service role に一本化し、anonの書き込み権限を全廃（本命・60〜90分）

**問題**: anonキー保持者は Vercel の合言葉ゲートを迂回して Supabase PostgREST（`https://zuadqnarsoykplkafyxv.supabase.co/rest/v1/...`）へ直接書き込める。書き込み全開放（`using(true)`）のテーブルが8つ。

**方針**: Next.jsサーバー側の PostgREST 呼び出しを `SUPABASE_SERVICE_ROLE_KEY` に切り替え、anonのINSERT/UPDATE/DELETE系ポリシーを全部落とす。anonはSELECTのみ残す（読み取り経路の互換を保つため）。

### 2-1. 事前準備

- Supabaseダッシュボード（Settings > API）から service role キーを取得し、**Vercelの環境変数**に `SUPABASE_SERVICE_ROLE_KEY` として追加（クライアント公開しない。`NEXT_PUBLIC_`を付けないこと）。ローカル `.env.local` にも追加
- **Vercelは環境変数追加後にRedeployしないと反映されない**（過去の実績あり。忘れずに）

### 2-2. 共通ヘルパーの新設（P2の重複解消を先取り）

`lib/supabase.ts` を新設し、各ルートにコピペされている `creds()` / `headers()` を置き換える：

```ts
// 読み取り: anonキー（従来通り）
export function anonCreds() { ... }
// 書き込み・RPC: service roleキー。未設定なら明示エラー
export function serviceCreds() { ... }
```

対象（`creds()`/`headers()`のコピペがあるファイル）: `app/api/actions/route.ts`, `app/api/actions/sync/route.ts`, `app/api/nippo/route.ts`, `app/api/weekly-report/route.ts`, `app/api/weapons/template/route.ts`, `app/api/push/subscribe/route.ts`, `app/api/jobs/route.ts`（＋refineの独自版 `restUrl`/`restHeaders`）

### 2-3. service role に切り替えるルート

**PostgRESTへの書き込み・RPCをするルートだけ**が対象。Edge Function（`functions/v1/...`）呼び出しは anonキーのままでよい（verify_jwt用のJWTとして機能しているため）。`grep -rn "rest/v1" app/` で対象を確認すること。

| ルート | 切替対象の操作 |
|---|---|
| `app/api/actions/route.ts` | daily_actions のCRUD全部 |
| `app/api/actions/sync/route.ts` | RPC `import_diary_actions` |
| `app/api/refine/route.ts` | refine_sessions / refine_messages の書き込み |
| `app/api/weapons/template/route.ts` | weapon_proposal_sections のDELETE/INSERT |
| `app/api/jobs/route.ts` | integration_jobs のINSERT（GETは読みなのでanon可） |
| `app/api/push/subscribe/route.ts` | push_subscriptions のupsert/DELETE |
| `app/api/stakeholders/route.ts` | stakeholders のINSERT（GETはanon可） |
| `app/api/weekly-report/route.ts` | PATCH（GETはanon可） |
| `app/api/cron/daily-todo/route.ts` | RPC・push_subscriptions の読み/削除 |
| `app/api/status/route.ts` | RPC `dashboard_stats` |

### 2-4. Macワーカーの切替

`~/.claude/skills/integration-worker/jobs.py` は anonキーで `integration_jobs` を更新している。`.env.local` の `SUPABASE_SERVICE_ROLE_KEY` を読むように変更する（`SUPABASE_ANON_KEY` へのフォールバックは残さない。ポリシーを落とした後は動かないため）。

**影響なしを確認済みの経路（触らない）**: モバイル週報のPART3（Supabase MCP経由）／`backup.sh`（Edge Function経由）／`ingest-health`（Function内でservice role使用）。

### 2-5. RLSポリシー変更（マイグレーション `drop_anon_write_policies`）

実行前に `select tablename, policyname, cmd from pg_policies where 'anon' = any(string_to_array(trim(both '{}' from roles::text), ','));` で現況を確認してから：

```sql
-- ALL型（読み書き両方含む）→ SELECTのみに置換
drop policy "anon all daily_actions" on public.daily_actions;
create policy "anon read daily_actions" on public.daily_actions for select to anon using (true);

drop policy "anon all push_subscriptions" on public.push_subscriptions;
create policy "anon read push_subscriptions" on public.push_subscriptions for select to anon using (true);

drop policy "anon all refine_messages" on public.refine_messages;
create policy "anon read refine_messages" on public.refine_messages for select to anon using (true);

drop policy "anon all refine_sessions" on public.refine_sessions;
create policy "anon read refine_sessions" on public.refine_sessions for select to anon using (true);

drop policy "anon all weapon_proposal_sections" on public.weapon_proposal_sections;
create policy "anon read weapon_proposal_sections" on public.weapon_proposal_sections for select to anon using (true);

-- 書き込み専用ポリシー → 単純DROP（SELECTポリシーは別に存在するので読みは残る）
drop policy "anon insert integration_jobs" on public.integration_jobs;
drop policy "anon update integration_jobs" on public.integration_jobs;
drop policy "anon insert stakeholders" on public.stakeholders;
drop policy "weekly_reports anon update" on public.weekly_reports;
```

※ integration_jobs / stakeholders / weekly_reports に anon SELECT ポリシーが存在することをDROP前に確認。無ければ作る。

### 2-6. 動作確認チェックリスト（全部やる）

コード切替→デプロイ→ポリシー変更の順（逆にすると本番が一時的に壊れる）。確認は本番またはローカル＋本番DB：

- [ ] `/actions` ToDoの追加・完了・削除
- [ ] `/weekly-report` 編集→保存→リロードで維持
- [ ] `/weapons/template` ひな形編集・保存
- [ ] `/refine` 壁打ち開始→返信→保存
- [ ] ホームの取込パネルからジョブ起票（`/api/jobs` POST）
- [ ] Macで `python3 jobs.py list` → テストジョブを `claim` → `done`
- [ ] `/status` が表示される（dashboard_stats）
- [ ] Push購読の登録/解除
- [ ] cron: `curl -H "Authorization: Bearer $CRON_SECRET" https://.../api/cron/daily-todo`
- [ ] **裏口が閉じたことの確認**: anonキーで `curl -X PATCH "https://zuadqnarsoykplkafyxv.supabase.co/rest/v1/weekly_reports?id=eq.<適当なid>" -H "apikey: <anon>" -H "Authorization: Bearer <anon>" -d '{"summary":"x"}'` → 0行更新（またはエラー）になること

---

## Task 3：SECURITY DEFINER関数の anon EXECUTE 剥奪（Task 2完了後）

マイグレーション `revoke_anon_function_execute`：

```sql
revoke execute on function public.import_diary_actions(integer) from anon, authenticated;
revoke execute on function public.trg_hb_jobs() from anon, authenticated;
revoke execute on function public.trg_hb_news() from anon, authenticated;
revoke execute on function public.trg_hb_notion() from anon, authenticated;
revoke execute on function public.dashboard_stats() from anon, authenticated;
```

**前提**: Task 2で `/api/status` と `/api/cron/daily-todo` と `/api/actions/sync` が service role に切替済みであること（でないと壊れる）。実行後、`/status` とcronとToDo同期を再確認。トリガー関数3つ（`trg_hb_*`）はテーブルのトリガーとしては動き続ける（トリガー実行はEXECUTE権限不要）。

---

## Task 4：`weapons/template` PUT の原子化

**問題**: `app/api/weapons/template/route.ts:64-88` が全DELETE→INSERTで、INSERT失敗時にひな形が消える。

**修正**: DB関数に置き換えて1トランザクション化（マイグレーション `replace_weapon_template_fn`）：

```sql
create or replace function public.replace_weapon_template(p_sections jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  delete from weapon_proposal_sections;
  insert into weapon_proposal_sections (position, section, body)
  select (elem->>'position')::int, elem->>'section', elem->>'body'
  from jsonb_array_elements(p_sections) elem;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.replace_weapon_template(jsonb) from anon, authenticated;
```

※ 列名は実テーブルに合わせて調整（`select column_name from information_schema.columns where table_name='weapon_proposal_sections'` で確認してから書くこと）。ルート側は service role で `POST /rest/v1/rpc/replace_weapon_template`。確認：ひな形編集→保存→リロード、わざと不正データで保存→既存ひな形が残ること。

---

## Task 5：DB衛生（1マイグレーション `db_hygiene_batch` にまとめる）

```sql
alter function public.set_updated_at() set search_path = public;
drop index if exists public.idx_daily_work_log_date;  -- daily_work_log_date_idx と重複。片方だけ残す
drop policy if exists "daily_work_log_anon_select" on public.daily_work_log;  -- "daily_work_log anon read" と重複
create index if not exists learning_logs_user_id_idx on public.learning_logs(user_id);
create index if not exists health_metrics_user_id_idx on public.health_metrics(user_id);
```

- `pg_net` のスキーマ移動は pg_cron のジョブ定義が `net.http_post` 等を参照している可能性があるため、**`select jobname, command from cron.job;` で全ジョブを確認してから**判断。参照があればスキップして可（優先度低）
- `learning_logs` の4ポリシーは `auth.uid()` を `(select auth.uid())` に書き換え（`pg_policies` から現定義を取得して alter ではなく drop/create で）
- `memory_chunks_embedding_idx` の未使用警告は**対応不要**（442件規模ではseq scanが正当）

完了後 `get_advisors` の security / performance 両方を再実行して差分を報告。

---

## Task 6（P2・時間があれば。無理に今回やらない）

1. **login強化**: `app/api/login/route.ts:33-36` の合言葉比較を `crypto.timingSafeEqual` に。cookie値を `SHA-256(passphrase)` から `HMAC-SHA256(passphrase, AUTH_COOKIE_SECRET)`（新env）に変更（proxy.ts:51-55 も同時修正。デプロイ後、全端末で再ログインが1回必要になる旨を吉井さんに伝える）
2. **Edge Functionの着信認証**: `health-notion-sync` / `fetch-dx-news` / `fetch-invoice-news` / `fetch-news-multi`（verify_jwt=false・認証なし）に `ingest-health` と同じ簡易トークン方式を追加。pg_cronからの呼び出しヘッダーも同時に更新すること
3. **エラー可視化**: `catch { return [] }` で無音になっている箇所と cron の握り潰しに、`service_health` テーブルへの記録か `console.error` を追加
4. **重複集約の続き**: `sha256Hex`（proxy.ts / login）、`windowChunks`（refine / weapons）、`METRICS_QUERY`＋`fetchLatestMetrics`（agent / weapons）を lib へ

## やらないこと（今回のスコープ外）

- Edge Function経由の読み取り面（search-memory等はanonキーJWTで呼べる）の完全封鎖 — P2の2で扱う
- 新機能の追加（別途機能提案リストあり）

## 完了報告に含めること

各タスクの実施結果／チェックリストの消化状況／`get_advisors` のビフォーアフター（残った警告と理由）／コミットハッシュ一覧。

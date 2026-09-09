<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# キャリアOS 開発ルール（必読）

姉妹アプリ **AIワークOS**（`../aiworkos-dashboard`）の作りを踏襲している。
書き方に迷ったら、まず向こうの同種のファイルを読むこと。

## 1. UIを触ったら、pushする前に必ずブラウザで1回開く

AIワークOS で 2026-07-18 に踏んだ教訓をそのまま引き継ぐ。
API を curl で検証しただけでブラウザを開かず本番に出し、レスポンス形状の思い違いで
画面がクラッシュした（本人が実機で発見）。**tsc・build が通ることと、ページが表示できることは別物。**

- ページを追加・変更したら、`npm run build` → `npx next start -p 3041` → ブラウザで該当ページを開き、
  console エラーが無いことまで確認してから commit する。
- クエリパラメータ付きの導線（`/jobs?status=interested` 等）は、**パラメータ付きのURLで**開くこと。
- API と UI の間の型（レスポンス形状）を変えたら、そのAPIを使う全ページを grep して合わせる。

## 2. このアプリ固有の注意

### 秘匿性
転職活動という、現職に知られると実害のある情報を扱う。守りを削らないこと。
- `proxy.ts` の合言葉認証（フェイルクローズ）を無効化しない。
- `app/layout.tsx` の `robots: { index: false }` と `public/robots.txt` を消さない。
- 会社アドレス（`@fujifilm.com`）は一切扱わない。取込対象は個人Gmailの「転職」ラベルのみ。

### Supabase
- テーブルは全部 `career_` 接頭辞。AIワークOS と**同じプロジェクト**（`zuadqnarsoykplkafyxv`）に同居している。
  `memory_chunks` や `weekly_reports` など向こうのテーブルを壊さないこと。
- `career_*` は RLS 有効・anon ポリシー無し。読み書きとも **service role キー**を使うサーバー側 route.ts 経由。
  `SUPABASE_SERVICE_ROLE_KEY` に `NEXT_PUBLIC_` を絶対に付けない。

### 取込（ingest）の不変条件
- **冪等性**: `career_emails.gmail_message_id` が一意キー。同じメールを二度処理しないこと。
  再実行しても求人が二重に増えない状態を常に保つ。
- **1通 : N求人**: doda X の求人紹介メールは1通に3〜5社入っている。1通=1求人と決め打たない。
- **名寄せ**: `career_jobs.dedup_key` は正規化した「企業名|ポジション名」。
  全角英数の正規化を外すと「株式会社ＵＡＣＪ」と「株式会社UACJ」が別物になる。
- **ノイズ**: HRプロ・biz-study・Wantedly・PIVOT 等は人事担当者向けメルマガであって求人ではない。
  `kind='noise'` に落とすこと。ここが緩むと求人一覧がメルマガで埋まる。

### 適合スコア
- 判断軸は `career_criteria` テーブルが正。コードにハードコードしない（重みはUIから変えられる）。
- `lib/profile.ts` の `CANDIDATE_PROFILE` は全求人の採点に効く1枚。
  事実と違う記述を混ぜると採点がまとめて歪むので、変更は慎重に。

### モデル
- 取込時の抽出・一次採点: `claude-sonnet-5`（量が出るため）
- `/fit` の深掘り再採点: `claude-opus-5`（数は出ないが質が要る）
- どちらも `CAREER_EXTRACT_MODEL` / `CAREER_FIT_MODEL` で差し替え可能。
- `temperature` / `top_p` / `budget_tokens` は現行モデルでは 400 になる。使わない。
  構造化出力は `output_config: { format: { type: "json_schema", schema } }` を使う。

## 3. Vercel
- 別プロジェクト・別URL（AIワークOS とは分離）。
- Hobby プランの cron は1日1回まで。`vercel.json` の `/api/cron/ingest` は 22:00 UTC（＝JST 7:00）。
- cron 経路は `proxy.ts` の PUBLIC_PATHS を通るので、ルート側で `CRON_SECRET` を必ず照合すること。

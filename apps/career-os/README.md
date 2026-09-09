# キャリアOS（career-os）

転職メールを案件データベースに変え、**自分の判断軸で採点する**アプリ。
AIワークOS（`../aiworkos-dashboard`）の作りを踏襲した姉妹アプリで、URLもVercelプロジェクトも別。

doda X などが「年収と知名度」で並べるのに対して、ここは吉井さん自身の判断軸
——健康・家族との時間・命の時間を懸けるに値するか——で並べ替える。そこが存在理由。

---

## 画面

| パス | 役割 |
|---|---|
| `/` | 作戦盤。新着・未返信スカウト・本命候補・最終取込 |
| `/jobs` | 求人カード一覧。適合スコア順、フィルタ、気になる／見送り |
| `/scouts` | スカウト受信箱。**返信漏れを潰すのが目的**。経過日数と再送回数を出す |
| `/fit` | 適合診断。判断軸の重み調整と、Opus 5 による深掘り再採点 |

---

## 構成

```
Gmail「転職」ラベル(Label_82)
   │  Gmail REST API（読み取り専用スコープ）
   ▼
/api/cron/ingest（Vercel Cron 毎日 JST 7:00）または /api/ingest（手動）
   │  lib/gmail.ts → lib/extract.ts（Sonnet 5 で分類・抽出）
   ▼
Supabase career_*（AIワークOS と同じプロジェクトに同居）
   │  lib/fit.ts（判断軸に照らして採点）
   ▼
画面（Next.js App Router / 合言葉認証の内側）
```

- **Next.js 16 App Router / Tailwind v4 / TypeScript**
- **Supabase PostgREST を fetch で直叩き**（`supabase-js` は使わない）
- **Anthropic SDK** — 抽出は `claude-sonnet-5`、深掘り採点は `claude-opus-5`
- **合言葉認証**（`proxy.ts`）＋ `noindex`。転職活動の内容なので守りは削らないこと

---

## セットアップ

### 1. 依存とローカル起動

```bash
cd /Users/YOSHII/Claude/Code/apps/career-os && npm install && npm run dev
```

`http://localhost:3040` で開く。

### 2. 合言葉を決める

`.env.local` の `APP_PASSPHRASE` が**空だと全ページ・全APIが閉じる**（設定漏れに気づけるようフェイルクローズにしてある）。
好きな合言葉を入れる。Supabase と Anthropic のキーは AIワークOS から引き継ぎ済み。

### 3. Gmail API をつなぐ

[docs/gmail-setup.md](docs/gmail-setup.md) の手順どおりに Google Cloud 側を設定し、
リフレッシュトークンを取る。

```bash
cd /Users/YOSHII/Claude/Code/apps/career-os && npm run gmail:token
```

### 4. Vercel に出す

別プロジェクトとして作る（AIワークOS とは分ける）。

```bash
npx vercel link
```

- Root Directory は `apps/career-os` を指定する
- プロジェクト名は `career-os`
- 環境変数は `.env.local` と同じものを Vercel にも登録する
  （`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `ANTHROPIC_API_KEY` /
  `APP_PASSPHRASE` / `AUTH_COOKIE_SECRET` / `GMAIL_*` / `CRON_SECRET`）
- `vercel.json` の cron が毎日 22:00 UTC（JST 7:00）に `/api/cron/ingest` を叩く

> Hobby プランの cron は1日1回まで。これを超えるとビルドは通るのにデプロイが落ちる。

---

## 運用

- **毎朝7時**に自動で前日ぶんの転職メールが取り込まれ、新着求人が採点される。
- Macを開いていなくても動く（Vercel Cron なので）。
- 遡り取込は `/api/ingest` に `{"newerThanDays": 365, "maxResults": 300}` を投げる。
  3,174通あるので、一気にやらず段階的に。
- 取込の実行履歴は `career_ingest_runs` に残る。ホームに最終取込日時が出る。

---

## 開発時の約束

`AGENTS.md` を読むこと。要点だけ:

- **UIを触ったら push 前にブラウザで開く。** tsc が通ることと画面が出ることは別物。
- **取込は冪等に。** 再実行しても求人が二重に増えないこと。
- **1通 : N求人。** doda X の求人紹介メールは1通に3〜5社入っている。
- **service role キーをブラウザに出さない。** `NEXT_PUBLIC_` を付けない。

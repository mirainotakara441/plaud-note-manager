# 自治体カルテ（政令市20＋特別区23）設計メモ　2026-09-19

作成：Fable 5.1（設計のみ）。収集・実装はOpusのサブエージェントへ引き継ぐ前提で、
この1枚だけ読めば着手できるように書いてある。

## 0. 目的（1行）

法人請求オンラインサービスを提案する場面で、**その自治体自身の言葉（DX計画の文言・KPI）**と
**議会で既に出た声（オンライン／キャッシュレス／郵送請求の質問と答弁）**を、
自治体名を選ぶだけで1分で引き出せる状態にする。

対象は閉じた集合43団体：政令指定都市20市＋東京特別区23区。
判定は `lib/municipalities.ts` の `ORDINANCE_DESIGNATED_CITIES` / `TOKYO_SPECIAL_WARDS` が唯一の正（既存）。

## 1. どこに置くか（結論）

| 置き場所 | 役割 | 理由 |
|---|---|---|
| 新ページ `/municipalities`（自治体カルテ） | 43団体の**固定一覧**＋団体ごとの詳細 | 団体別攻略は接点（会議・週報）のある団体しか出ない。43のうち接点ゼロの自治体が大半なので、一覧は別に持つ必要がある |
| 団体別攻略 `/organizations` に新タブ「計画・議会」 | 選んだ団体が43のどれかなら、同じ詳細コンポーネントを埋め込む | 「相手を選んだら経緯・人脈・戦略・武器まで降りていける」という2026-08-07の相手軸の原則を守る。ページを渡り歩かせない |
| ホームのカード | 「⚔️ 提案する」グループ、団体別攻略の直後 | 提案の材料庫なので「提案する」に属する |
| 記憶層 `memory_chunks` への写し | 抜粋と質問要旨を `organization=自治体名` で登録 | 提案エージェント・武器・横断検索が**何も変えずに**自治体の言葉を引けるようになる（QA表→記憶層と同じ二重書き） |

採らなかった案：
- 団体別攻略のタブだけ → 一覧が作れない。「特別区で計画にキャッシュレスと書いている区はどこか」が答えられない
- 記憶層だけ → 件数・期間・KPIの横比較ができない。構造化が要る
- 議員リスト `/legislators` の下 → 議員は「人」軸。DX計画は「団体」軸。混ぜると議員リストの「会派×議会」の階層が崩れる

## 2. データモデル（Supabase・4テーブル＋写し）

正はSupabaseの構造化テーブル。`memory_chunks` は写し（検索用）。

```sql
-- 43団体のマスタ（手で育てる。Notion顧客CRMとは notion_page_id で緩く結ぶ）
create table municipalities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,                -- 「豊島区」「横浜市」
  kind text not null check (kind in ('政令市','特別区')),
  prefecture text not null,
  population integer,                       -- 住基人口（時点は population_as_of）
  population_as_of date,
  mayor text,
  dx_department text,                       -- 計画の主管課
  minutes_system text,                      -- 'kaigiroku' | 'voiweb' | 'dbsr' | 'discuss' | 'other'
  minutes_url text,                         -- 会議録検索の入口
  council_video_url text,                   -- 議会中継の入口
  adoption_status text default '未導入'      -- 法人請求OSの導入状況
    check (adoption_status in ('未導入','検討中','トライアル','導入')),
  postal_center text,                       -- 郵送請求の集約センター有無・委託先（分かれば）
  notion_page_id text,                      -- notion_organizations への緩い参照
  memo text,
  updated_at timestamptz not null default now()
);

-- 計画文書（1団体に複数。DX推進計画・情報化計画・総合計画のDX章・行革プラン）
create table municipality_plans (
  id uuid primary key default gen_random_uuid(),
  municipality text not null references municipalities(name),
  title text not null,
  plan_type text not null,                  -- 'DX推進計画' | '情報化計画' | '総合計画' | '行革・BPR' | 'その他'
  period_from smallint, period_to smallint, -- 年度
  url text,                                 -- 公開URL（PDF直リンク優先）
  storage_path text,                        -- Supabase Storage に保存した原本PDF
  summary text,                             -- 300字。提案に関係ある章だけ
  fetched_at timestamptz not null default now(),
  next_revision_year smallint               -- 改定予定年度（参謀の検知に使う）
);

-- 計画からのキーフレーズ抜粋（提案文にそのまま貼れる単位）
create table municipality_plan_excerpts (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references municipality_plans(id) on delete cascade,
  municipality text not null,
  keyword text not null,                    -- §3 のキーワード体系のどれか
  excerpt text not null,                    -- 原文そのまま（改変しない）
  page_no smallint,
  kpi_name text, kpi_target text, kpi_year smallint,  -- KPIなら分解して持つ
  usage_hint text,                          -- 「この一文は提案書の○○で使う」1行
  created_at timestamptz not null default now()
);

-- 議会質問の履歴（1件＝1発言）
create table council_questions (
  id uuid primary key default gen_random_uuid(),
  municipality text not null references municipalities(name),
  asked_on date not null,
  session text,                             -- 「令和7年第4回定例会」
  meeting text,                             -- 「本会議」「総務委員会」
  legislator_name text not null,
  party text,
  legislator_id uuid references legislators(id),   -- 既存名簿にいれば結ぶ
  question_summary text not null,
  answer_summary text,
  answered_by text,                         -- 「区民部長」
  keywords text[] not null default '{}',
  relevance text not null default '近接'    -- '直球'（郵送請求・小為替・法人）|'近接'（証明書オンライン・キャッシュレス）|'参考'（窓口DX一般）
    check (relevance in ('直球','近接','参考')),
  figures text,                             -- 答弁で出た数字（「郵送22,111枚・法人98%」）
  minutes_url text,
  video_url text, video_from text, video_to text,   -- 該当箇所（豊島区の13:15〜16:50方式）
  raw_excerpt text,                         -- 原文抜粋（調査/政令市_一般質問_抜粋集 と同じ粒度）
  source text not null default 'script',    -- 'script' | 'manual'
  fetched_at timestamptz not null default now()
);
```

写し：`memory_chunks` に `source_type='自治体計画'` と `'議会質問'` を追加する。
**`memory_chunks_source_type_check` にCHECK制約があるので、値の追加はDDLが要る**（過去に月次報告で同じ罠）。
`apply_migration` は権限で通らないため、SQLを吉井さんに渡して手で流す（category-unification と同じ）。

## 3. キーワード体系（抜粋の付け札。増やすときはここに足す）

| 層 | キーワード | 提案での使い道 |
|---|---|---|
| 直球 | 郵送請求／定額小為替／職務上請求／第三者請求／法人 | 「貴区の計画・議会で既に課題認識がある」と言える |
| 近接 | オンライン申請・電子申請／キャッシュレス／証明書交付／手数料／電子納付 | 計画の目標に本サービスを接続する（「オンライン化率◯%の残りは誰か」） |
| 文脈 | 書かない窓口／行かない窓口／フロントヤード改革／BPR／窓口DX／コンビニ交付／押印廃止 | 区民価値への言い換え（職員負担→区民対応時間）に使う |
| KPI | オンライン化率／デジタル完結率／キャッシュレス比率／来庁者数削減 | 数字で語る。目標年度と現在値をセットで持つ |

抜粋は**原文のまま**持つ。要約は `usage_hint` に分ける（QA表の設計と同じ：崩す対象と受け止める対象を分ける）。

## 4. 議会質問の収集範囲（現状→拡張）

| 項目 | 現状（2026-09-13調査） | 拡張 |
|---|---|---|
| 対象 | 政令市20市 | ＋特別区23区（新規） |
| 会派 | 自民・公明のみ | 全会派（relevance で層分け。会派は列に残す） |
| 期間 | 2023-01〜 | 2020-01〜（コロナ期の「行かない窓口」で急増したため） |
| 置き場 | Markdown（`~/Desktop/JOB/議員説明会/調査/`） | `council_questions` ＋ 記憶層の写し。Markdownは原本として残す |

既存資産（そのまま流し込める）：
- `政令市_自民公明_一般質問事例_20260913.md`（20市踏破・URLつき）
- `政令市_一般質問_抜粋集_20260913.md`（原文抜粋 120KB）
- `浜松市_新潟市_議員発言_原文抜粋_20260916.md`
- 検索スクリプト `調査/scripts/`（kaigiroku.net／voiweb／dbsr の3系統。手順は memory `reference_kaigiroku_search_routes`）
- 豊島区 2025-11-18 辻薫議員（memory `project_toshima_gikai_shitsumon`。映像13:15〜16:50・98%が法人）

特別区の会議録システムは系統が未調査。**Phase 1の最初に23区ぶんの入口URLと系統を表にする**（ここが分かれば残りはスクリプト）。
豊島区は kensakusystem.jp（討論・中継）。

## 5. 画面

### 一覧（`/municipalities`）
- 上部チップ：政令市／特別区／すべて
- 列：自治体｜人口｜導入状況｜DX計画（名称・期間）｜計画内キーワード（直球●／近接●／文脈●の件数）｜議会質問（直球／近接 件数・最新日）｜接点（会議・週報件数＝既存 `/api/organizations` 由来）｜最終更新
- 並び替え：既定は「議会質問の直球件数 → 計画の直球件数 → 人口」。**攻めやすい順に上から並ぶ**

### 詳細（一覧クリック／団体別攻略の「計画・議会」タブ）
1. 基本情報：人口・首長・主管課・導入状況・会議録／中継の入口・顧客CRMへのリンク
2. DX計画：文書一覧 → 抜粋カード（キーワード札・ページ・**コピーボタン**）。KPIは表で
3. 議会質問：時系列。議員名は `/legislators` へ、会議録URL、映像の該当箇所、答弁の数字
4. 数字メモ：答弁・計画から拾った実数（郵送件数・法人比率・キャッシュレス率）
5. 攻略の入口：自動生成の3行（「計画に◯◯／△△議員が□□と質問／答弁は◇◇」）＋「武器を出す」「提案エージェント」へ organization を埋めて遷移
6. 手書きメモ（`organization_notes` を流用。section を増やすならCHECK制約も更新）

## 6. フェーズと担当

| Phase | 内容 | 担当 | 目安 |
|---|---|---|---|
| 0 | この設計・DDL・43団体マスタの骨格・キーワード体系・特別区23区の会議録入口表 | Fable 5.1 | 今日 |
| 1 | DX計画の収集（43団体、URL・PDF保存・抜粋・KPI）→ CSV/JSON | Opus サブエージェント並列（政令市／特別区で2班、さらに5団体ずつ） | 半日 |
| 2 | 議会質問の拡張（特別区23新規・政令市を全会派・2020〜）→ `council_questions` | Opus＋既存スクリプト。**Web検索やエージェント委任は届かない**。検索APIを直接叩く | 1日 |
| 3 | ページ・タブ・API・記憶層への二重書き | Opus（本番変更の型：実データ確認→Shadow→テスト→本番→Golden→rollback） | 半日 |
| 4 | 参謀の検知器（計画の改定年度到来／定例会後の新着質問）＋ 定例会ごとの再収集ルーティン（3・6・9・12月） | Sonnet | 後日 |

## 7. 守ること

- **議員ルートは地ならしが先**（memory `project_giin_route_jinarashi`）。質問履歴は「他自治体の事例」として担当課に渡す素材であり、議員に質問を頼む道具ではない。画面の文言もそう書く
- 抜粋・答弁は**原文を改変しない**。要約と原文を別の列に持つ
- 数字には**時点**を必ずつける（人口・KPI現在値・郵送件数）
- 収集は無人前提（質問しない・固定スクリプト）。1団体が取れなくても他は出し、取れなかった団体名を画面に出す（参謀と同じ作法）
- 公開版QA（`/qa-open`）に自治体名を新たに書く場合は `build-hojin-qa-public.mjs` の MASK に追加

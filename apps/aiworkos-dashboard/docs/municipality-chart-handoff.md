# 自治体カルテ 引き継ぎ（Phase 0 完了 → Phase 1〜3 を Opus へ）　2026-09-19

読む順番：① `docs/municipality-chart-design.md`（設計） → ② この引き継ぎ → ③ `supabase/migrations/DRAFT_municipality_chart*.sql`

## Phase 0 でやったこと（Fable 5.1）

| 成果物 | 場所 | 状態 |
|---|---|---|
| 設計メモ | `docs/municipality-chart-design.md` | 確定（置き場所は吉井さん承認済み：新ページ＋団体別攻略タブ＋記憶層の写し） |
| DDL 下書き | `supabase/migrations/DRAFT_municipality_chart.sql` | **未適用**。本番変更の型で流す。apply_migration は権限で通らないので SQL Editor で手動 |
| マスタの種（43団体） | `supabase/migrations/DRAFT_municipality_chart_seed.sql` | **未適用**。research_priority と会議録入口を埋めてある。人口は空（時点つきで Phase 1 が入れる） |
| 特別区23区の会議録入口表 | この文書の §3 | 入口URLは fetch で開いて確認済み。API の叩き方は Phase 2 で実測 |

## 1. 調査の優先順（吉井さん決定 2026-09-19）

**アプローチ済みを先に、未アプローチはその後。** 判定は 2026-09-19 の実データ（会議・週報・CRM）。

| 優先 | 政令市 | 特別区 |
|---|---|---|
| 1（先） | 熊本・広島・横浜・大阪・札幌・相模原・堺・北九州・京都・名古屋・福岡・浜松・さいたま（13） | 新宿・豊島・墨田・練馬・品川（5） |
| 2（後） | 仙台・千葉・川崎・新潟・静岡・神戸・岡山（7） | 上記以外の18区 |

seed の `research_priority` 列がこの表と一致している。

## 2. Phase 1：DX計画の収集（Opus サブエージェント並列）

**1エージェント＝5団体**、優先1の18団体から。各団体でやること：

1. 「〇〇市 DX推進計画」「〇〇区 デジタル化推進計画」「情報化計画」「行政手続オンライン化」で検索し、**現行の計画**を特定（改定前の旧版と混同しない。期間を必ず取る）
2. PDF の公開URLを控え、原本を `~/Desktop/JOB/自治体カルテ/plans/{団体名}/` に保存
3. 設計メモ §3 のキーワード体系で抜粋を作る。**原文をそのまま**、ページ番号つき。1団体10〜20件が目安。KPI は名称・目標値・目標年度に分解
4. `usage_hint`（提案書のどこで使うか）を1行
5. 出力は JSON 1ファイル/団体：`{ municipality, plans:[{title, plan_type, period_from, period_to, url, storage_path, summary, next_revision_year, excerpts:[{keyword, layer, excerpt, page_no, kpi_name, kpi_target, kpi_year, usage_hint}]}], population, population_as_of, mayor, dx_department, postal_center }`
6. 取れなかった団体は「取れなかった」と書く。推測で埋めない

投入は Python で `municipality_plans` → `municipality_plan_excerpts` の順に upsert。その後 `memory_chunks` に `source_type='自治体計画'`, `organization=団体名`, `title='{計画名} p.{page}'`, `content=抜粋 + usage_hint` で写しを登録（埋め込みは既存の登録経路を使う。QA表→記憶層の `register_qa.py --write` が手本）。

## 3. Phase 2：議会質問の拡張

### 既存資産（先にこれを council_questions へ流し込む）
- `~/Desktop/JOB/議員説明会/調査/政令市_自民公明_一般質問事例_20260913.md`（20市・URLつき）
- `~/Desktop/JOB/議員説明会/調査/政令市_一般質問_抜粋集_20260913.md`（原文抜粋）
- `~/Desktop/JOB/議員説明会/調査/浜松市_新潟市_議員発言_原文抜粋_20260916.md`
- 豊島区 2025-11-18 辻薫議員（memory `project_toshima_gikai_shitsumon`：映像 13:15〜16:50、郵送22,111枚・法人98%）
- 検索スクリプト：`~/Desktop/JOB/議員説明会/調査/scripts/`（`srch.py`=kaigiroku、`gij*.py`=voiweb、`dbsr.py`=dbsr）

### 検索語（固定）
定額小為替／小為替／郵送請求／職務上請求／第三者請求／証明書 オンライン申請／証明書 キャッシュレス／電子申請 証明／行かない窓口／書かない窓口

### 期間・会派
2020-01-01〜。**全会派**（relevance 列で 直球／近接／参考 に層分け。会派は列に残す）

### 系統別の叩き方
- kaigiroku：`POST https://ssp.kaigiroku.net/dnp/search/minute_searches/search`（tenant_id は seed の minutes_api_hint）。本文は `minutes/get_minute`
- voiweb（.exe 版）：`cgi/voiweb.exe?ACT=100&FBKEY1=<cp932 URLエンコード>` を GET。本文 ACT=200→203
- voiweb（.asp 版：台東区・港区）：`g08v_search.asp` / `g07v_search.asp`。**パラメータは未実測**。最初に1回手で開いて確認
- dbsr：トップの `_token` を cookie つきで取って POST。千葉は http
- other（中央・品川・中野は個別。港・大田・世田谷・足立・江戸川は VOICES/Web の .asp 命名で voiweb 流用の見込み）：最初に1回手で開いて実測

### 特別区23区の会議録入口（2026-09-19 fetch 確認）

| 区 | 系統 | 会議録検索 | 手がかり | 中継 |
|---|---|---|---|---|
| 千代田区 | dbsr | https://www.city.chiyoda.tokyo.dbsr.jp/ | 入口は gikai-chiyoda-tokyo.jp | kensakusystem.jp/chiyoda-vod |
| 中央区 | other | https://www.kugikai.city.chuo.lg.jp/kaigiroku/index.html | 自庁 cgi。直接 fetch は 500 | chuo-city.stream.jfit.co.jp |
| 港区 | other（voiweb相当？） | https://gikai2.city.minato.tokyo.jp/voices/g07v_search.asp | 台東区と同じ .asp 命名 | 同ホスト g07_broadcasting.asp |
| 新宿区 | kaigiroku | https://ssp.kaigiroku.net/tenant/shinjuku/pg/index.html | tenant=shinjuku id=211 | smart.discussvision.net/…/shinjuku |
| 文京区 | dbsr | https://www.city.bunkyo.tokyo.dbsr.jp/ | — | bunkyo-city.stream.jfit.co.jp |
| 台東区 | voiweb（asp版） | https://taito.gijiroku.com/voices/g08v_search.asp | .exe ではなく .asp | kensakusystem.jp/taito-vod |
| 墨田区 | kaigiroku | https://ssp.kaigiroku.net/tenant/sumida/SpTop.html | tenant=sumida id=396 | smart.discussvision.net/…/sumida |
| 江東区 | dbsr | https://www.city.koto.tokyo.dbsr.jp/ | 録画検索は koto-city.gijiroku.com | koto-city.stream.jfit.co.jp |
| 北区 | kaigiroku | https://ssp.kaigiroku.net/tenant/kita/ | tenant=kita id=395 | city.kita.lg.jp（録画ページ） |
| 荒川区 | kaigiroku | https://ssp.kaigiroku.net/tenant/arakawa/ | tenant=arakawa id=577 | YouTube公式 |
| 板橋区 | voiweb | https://itabashi.gijiroku.com/voices/g07v_search.asp | .exe 版もあり（voices/cgi/voiweb.exe） | itabashi.gijiroku.com/g07_broadcasting.asp |
| 練馬区 | kaigiroku | https://ssp.kaigiroku.net/tenant/nerima/ | tenant=nerima id=367 | smart.discussvision.net/…/nerima |
| 足立区 | other（voiweb相当の .asp） | https://www.gikai-adachi.jp/voices/g07v_search.asp | 自庁ドメイン。外部ベンダー不検出 | gikai-adachi.jp/g07_Video_Search.asp |
| 葛飾区 | kensakusystem | https://www.kensakusystem.jp/katsushika/sapphire.html | cgi-bin3/See.exe?Code=… | smart.discussvision.net/…/katsushika |
| 江戸川区 | other（voiweb相当の .asp） | https://www.gikai.city.edogawa.tokyo.jp/voices/g07v_search.asp | 自庁ドメイン。Shift-JIS | gikai.city.edogawa.tokyo.jp/g07_Video_Search.asp |
| 品川区 | other（自前 Laravel） | https://kaigiroku.city.shinagawa.tokyo.jp/index.php/ | ssp.kaigiroku.net とは別物 | gikaichukei.city.shinagawa.tokyo.jp |
| 目黒区 | kensakusystem | https://www.kensakusystem.jp/meguro/ | cgi-bin3/See.exe?Code=… | smart.discussvision.net/…/meguro |
| 大田区 | other（VOICES/Web の .asp） | https://www.gikai-ota-tokyo.jp/ota/ | g08v_search.asp。杉並区と同エンジン | 区議会 YouTube |
| 世田谷区 | other（VOICES/Web、voiweb.exe あり） | https://kugi.city.setagaya.tokyo.jp/voices/ | CGI/voiweb.exe | setagaya-city.stream.jfit.co.jp |
| 渋谷区 | kaigiroku | https://ssp.kaigiroku.net/tenant/shibuya/SpTop.html | tenant=shibuya id=394 | smart.discussvision.net/…/shibuya |
| 中野区 | other（独自・静的＋Google検索） | https://kugikai-nakano.jp/search.html | 機械検索は難しい。手作業候補 | smart.discussvision.net/…/nakano |
| 杉並区 | voiweb（asp版） | https://suginami.gijiroku.com/voices/ | voices/voices/g08v_search.asp | suginami.gijiroku.com/voices/g07_Video_Search.asp |
| 豊島区 | kensakusystem | https://www.kensakusystem.jp/toshima/ | cgi-bin3/Search2.exe?Code=…&sTarget=2 | kensakusystem.jp/toshima-vod |

**系統の内訳（23区）**

| 系統 | 区数 | 区 | 叩き方 |
|---|---|---|---|
| kaigiroku | 6 | 新宿・墨田・北・荒川・練馬・渋谷 | 既存 `srch.py` に tenant_id を足すだけ |
| dbsr | 3 | 千代田・文京・江東 | 既存 `dbsr.py`（host を足す） |
| voiweb（gijiroku.com） | 3 | 台東・板橋・杉並 | 板橋は .exe あり。台東・杉並は .asp 版でパラメータ未実測 |
| kensakusystem | 3 | 目黒・豊島・葛飾 | See.exe / Search2.exe の Code= が必要。豊島で1回実測してから横展開 |
| other | 8 | 港・大田・世田谷・足立・江戸川（VOICES/Web の .asp 命名、voiweb 流用の見込み）／中央・品川・中野（独自。手で1回開いてから判断） | 個別 |

**Phase 2 の着手順（特別区）**：① kaigiroku 6区と kensakusystem 3区（豊島は既知）は既存スクリプト＋tenant_id でそのまま → ② dbsr 3区 → ③ voiweb .exe/.asp 系 → ④ 中央・品川・中野は手で1回開いてから判断。

## 4. Phase 3：画面・API・写し（本番変更の型で）

- `app/municipalities/page.tsx`（一覧＋詳細）、`app/api/municipalities/route.ts`（一覧：マスタ＋件数集計＋既存 `/api/organizations` の接点件数）、`app/api/municipalities/[name]/route.ts`（詳細）
- 詳細は `components/MunicipalityChart.tsx` に切り出し、`/organizations` の新タブ「計画・議会」（`TabKey` に `chart` を追加、`section: null`）から同じものを描く。43団体以外を選んだときはタブを出さない（`municipalitySubcategory()` が 政令市/特別区 のときだけ）
- ホーム `app/page.tsx` の「⚔️ 提案する」に `/municipalities` を団体別攻略の直後に追加
- 抜粋カードにコピーボタン。「武器を出す」「提案エージェント」へ `organization` を埋めて遷移
- 手書きメモは `organization_notes` を流用（section を増やすなら CHECK 制約も更新）
- push 後は Vercel のビルドログのルート表で `/municipalities` が出ていることまで確認（HTML の grep も HTTP ステータスも証拠にならない）

## 5. Phase 4（後日）
- 参謀の検知器：`lib/advisor/detectors/municipalities.ts`（計画の `next_revision_year` 到来／定例会後に新着質問ゼロの団体）。閾値は `watchlist.ts`
- 定例会ごと（3・6・9・12月）の再収集ルーティン。無人前提（質問しない・固定スクリプト）。心拍つき

## 6. 守ること（設計メモ §7 の再掲）
議員ルートは地ならしが先。原文は改変しない。数字には時点。取れなかった団体名は隠さず画面に出す。

# Edge Function の置き場

本番 Supabase（project: `zuadqnarsoykplkafyxv`）にデプロイされている Edge Function の**ソースの正**はここ。

## なぜこのファイルがあるか

2026-09-12 の総点検まで、**デプロイ済み14本のうち10本がここに無かった**。
Supabase のダッシュボード上にしか実体が無い状態で、次の2つができなくなっていた。

- 事故ったときに前の version へ戻す判断ができない（差分が読めないため）
- 何が変わったのかレビューできない

`docs/memory-2-history.md` §6 の rollback 原則は「Edge は前 version へ戻す」だが、
**ソースが Git に無い関数ではその原則自体が実行できない**。
同日、全14本をここへ収容して解消した。以後これを崩さないこと。

## ルール

1. **ダッシュボードで直接編集しない。** ここを直してからデプロイする
2. 新しい関数を足したら、必ずこのディレクトリにも置く
3. 共有ロジックは `_shared/` に1本だけ置く（`identity.mjs` / `chunkTitle.mjs`）。
   同じ規則を2箇所に書かない——片方だけ育って食い違った実害が既に出ている
4. 記憶層に触る関数（`store-memory` / `search-memory` / `purge-memory` / `org-history` / `reembed-memory`）を
   変更するときは `production-change-protocol` スキルの関門を必ず通す

## 一覧（2026-09-12 時点・14本）

| slug | ver | verify_jwt | 役割 |
|---|---|---|---|
| `store-memory` | v4 | true | **書き込みの唯一の関所**。埋め込み生成 → 同一性4列を導出 → upsert |
| `search-memory` | v5 | true | **RAG の唯一の読み口**。埋め込み → `match_memory_chunks_v2` → 旧9列へ projection |
| `org-history` | v5 | true | 団体の会議履歴。一覧モードと履歴モード |
| `purge-memory` | v3 | true | `source_id` 前方一致の削除。8文字未満の prefix は拒否 |
| `proposal-cache` | v4 | true | 提案エージェントの永続キャッシュ。`edited=true` は吉井さんの手直し版。**消すと手直しが失われる** |
| `reembed-memory` | v1 | true | 本文を直した後の埋め込み貼り直し。行の増減はしない |
| `embed` | v3 | true | テキスト → gte-small ベクトル（384次元） |
| `backup` | v4 | true | 全テーブルの週次バックアップ。対象表は OpenAPI から動的取得 |
| `ingest-health` | v6 | **false** | Health Auto Export の受け口。独自トークンで認証。指標ごとに合計/平均を選ぶ |
| `health-notion-sync` | v2 | **false** | 日次サマリを Notion 健康ログDBへ冪等 upsert。pg_cron から呼ばれる |
| `health-dashboard-data` | v1 | true | `/health` 用。`health_range_summary` を範囲で返す |
| `fetch-dx-news` | v3 | **false** | 「自治体DX」の Google ニュース RSS 収集 |
| `fetch-invoice-news` | v3 | **false** | 「法人請求オンラインサービス」の RSS 収集 |
| `fetch-news-multi` | v3 | **false** | `news_themes` の有効テーマを回して RSS 収集 |

`verify_jwt: false` の4本は pg_cron や外部からの無認証呼び出しを受けるため。
代わりに各関数が独自トークンや固定の取得先で自衛している。

# 分類軸の統一（正準8分類）移行手順書

作成: 2026-07-30 / 状態: **手順1〜6 完了。残りは手順1-b（デプロイ後）のみ**

実行記録（2026-07-30、手順4〜6は 2026-07-31）:

| 手順 | 状態 | 備考 |
|---|---|---|
| 手順1 weekly_reports | ✅ 完了 | 実データ9行を `委託企業`→`委託会社`。合計57で不変。**制約は移行期版**（`委託企業` も暫定で許容） |
| 手順1-b 制約の締め | ⬜ **未実行** | Vercelデプロイ後に実施。それまで `委託企業` を送る本番コードが生きている |
| 手順2 stakeholders | ✅ 完了 | 正準8分類へ拡張。`社内` も含めた（8分類統一を優先。UI上「相手先」に社内が出る） |
| 手順3 strategic_todos | ✅ 完了 | 正準8分類へ拡張 |
| 手順4 `dashboard_stats()` RPC | ✅ 完了(7/31) | `org_status` の stakeholders 側にあった `category in ('自治体','事業者','銀行','議員')` を撤廃。委託会社/官民連携/社内/その他 の団体が、会議記録が無いと `/status`「次に攻める団体」から消えていた。あわせて `app/status/page.tsx` の `ADD_CATEGORIES` を `STAKEHOLDER_CATEGORIES`（8分類）に統一 |
| 手順5 団体名の名寄せ | ✅ 完了(7/31) | 手順4で団体マスタを全件拾うようにした結果、Notion同期で入った正式名（「株式会社エイジェック」）と会議記憶の略称（「エイジェック」）が2行に割れて見えた。`app/api/status/route.ts` の `mergeDuplicateOrgs` で法人格違いを畳む。**代表名は会議数が多い表記を採用**（`提案→`/`壁打ち→` は `?org=` を下流へ渡し、下流は `memory_chunks.organization` の完全一致で引くため、記憶を持つ表記でないと空振りする）。語順違いは畳まない（手順6でデータ側を修正） |
| 手順6 パーソルの語順ゆれ | ✅ 完了(7/31) | 会議記憶1行の `organization` を正式名へ修正。`その他` が0件になった。詳細と戻しSQLは下記 |
| コード追随 | ✅ 完了 | `lib/categories.ts` / `app/actions/page.tsx`（GENRE_ORDER・GENRE_META）/ `app/weekly-report/page.tsx` / `app/api/weekly-report/route.ts` / `app/page.tsx` / `weekly-report-dashboard` スキル。`tsc --noEmit` exit 0、`/weekly-report` の描画も確認済み |
| Notion 顧客CRM | ✅ 完了 | `種別` に8分類を追加し60件を再分類（事業者21/自治体17/銀行12/委託会社6/官民連携3/議員1）。`企業` は0件になったが選択肢としては残置 |

> **注記**: DDL（`apply_migration`）はパーミッションでブロックされる。SQLを吉井さんに渡して
> Supabase SQL Editor で手動実行してもらう運用。SQL文を含むこのファイルの編集も
> 同様にブロックされることがあるため、手順1-b のSQLは本文の該当箇所を参照のこと。
> （2026-07-31 の手順4は `apply_migration` が通った。以後ブロックされるとは限らない）

### 手順6: 「パーソル…デザイン」の語順ゆれをデータ側で修正（2026-07-31 実施済み）

同じ会社が、語順違いのため名寄せできず別の団体として2行に出ていた。

| 表記 | 出どころ | 会議 | 分類 |
|---|---|---|---|
| パーソル**プロセスビジネス**デザイン | 会議記憶（memory_chunks） | 1件（2026-02-06） | その他（マスタ未登録のため） |
| パーソル**ビジネスプロセス**デザイン株式会社 | stakeholders マスタ（Notion同期） | 0件 | 委託会社 |

前者はPLAUD音声起こし由来の誤記。正式名は後者（旧「パーソルプロセス＆テクノロジー」から
2024年に社名変更）。`mergeDuplicateOrgs` は法人格の有無しか吸収せず、語順違いを機械的に
同一視すると別会社を統合しかねないため、**コードではなくデータを直した**。

```sql
-- 実行済み（対象1行）
update memory_chunks
set organization = 'パーソルビジネスプロセスデザイン株式会社'
where id = 'eb6933cc-7b08-44e5-9e11-1a766f8bbc33'
  and organization = 'パーソルプロセスビジネスデザイン';

-- 戻す場合
update memory_chunks
set organization = 'パーソルプロセスビジネスデザイン'
where id = 'eb6933cc-7b08-44e5-9e11-1a766f8bbc33';
```

これで `org_status` は72行→71行、`その他` カテゴリーは0件になった。

> 同種の語順ゆれが今後も出る前提で、**名寄せをコードで広げようとしないこと**。
> 表記ゆれはデータ側（会議記憶の `organization`）を正式名に寄せて潰すのが正。

## 1. 何が問題か

「団体の種類」を表す分類軸が、Notion と Supabase にまたがって **5系統** バラバラに育った。
系統をまたぐたびに情報が落ちる（＝粒度が下がって二度と戻せない）状態だった。

| どこ | 現状の分類 | 数 |
|---|---|---|
| Notion 顧客CRM `種別` | 自治体 / **企業** / 官民連携 / その他 | 4 |
| Notion 会議DB `種別` | 自治体 / 事業者 / 委託会社 / 銀行 / 議員 / 官民連携 / 社内 / その他 | 8 |
| Supabase `stakeholders.category` | 自治体 / 事業者 / 銀行 / 議員 / 委託会社 / その他 | 6 |
| Supabase `weekly_reports.category` | 全体 / 支店 / 自治体 / 事業者 / 議員 / **委託企業** / 銀行 / プロモーション | 8 |
| Supabase `strategic_todos.genre` | 社内 / 自治体 / 議員 / 事業者 / 委託会社 | 5 |

最悪だったのが顧客CRMの4分類で、`事業者`/`委託会社`/`銀行` が全部 `企業` に潰れ、`議員` が
`その他` に潰れていた。これを **ルールとして明文化してしまっていた** のが
`~/.claude/skills/plaud-meeting-daily-sync/SKILL.md`（旧73行目）。ここは是正済み。

## 2. 決定事項

**正準の8分類 ＝ `自治体` / `事業者` / `委託会社` / `銀行` / `議員` / `官民連携` / `社内` / `その他`**
（会議DBの既存8分類をそのまま正準とする）

補足ルール:

- ノンバンク（アイフル・アコム・楽天カード等）は **`事業者`**。`銀行` ではない。
- `委託企業` は `委託会社` の表記ゆれ。**正準は `委託会社`**。
- `全体` / `支店` / `プロモーション`（weekly_reports）は **団体の種類ではなく週報の章立て**。
  正準8分類に混ぜてはいけない。移行後もそのまま残す。
- `共通`（成果物）は特定団体に紐づかない横断資料を指す、成果物軸だけの追加値。残す。

コード側の単一の正は **`lib/categories.ts`**。分類語を新しくハードコードしないこと。

## 3. 実行済み（コード側・DB非依存）

| 対象 | 内容 |
|---|---|
| `~/.claude/skills/plaud-meeting-daily-sync/SKILL.md` | CRM新規作成時、会議DBの`種別`を**1:1でそのまま**書く。「まとめる/寄せる」記述を削除 |
| `lib/categories.ts`（新規） | 正準8分類・DB制約付き各リスト・`normalizeOrgCategory()` を集約 |
| `app/api/deliverables/route.ts` | 許可リストを4分類→正準8＋`共通`に拡張（**バグ修正**、下記4章） |
| `app/api/stakeholders/route.ts` / `app/components/StakeholderPicker.tsx` / `app/api/strategic-todos/route.ts` | 値は変えず `lib/categories.ts` 参照に一本化（再発防止） |
| `~/.claude/skills/deliverable-to-supabase/SKILL.md` | category を正準8＋`共通`に更新 |

## 4. ついでに直したバグ（DB非依存なので実施済み）

`/deliverables`（成果物登録）は UI（`StakeholderPicker`）が **6分類**（自治体/事業者/銀行/議員/
委託会社/その他）を選ばせるのに、`app/api/deliverables/route.ts` の許可リストが **4分類**
（自治体/議員/事業者/その他）しか無かった。結果、**`銀行` と `委託会社` を選んで登録すると
黙って `自治体` に化けていた**（バリデーションエラーも出ない）。

保存先は `memory_chunks.metadata.カテゴリ`（JSONB・**CHECK制約なし**）なので、許可リストの
拡張は純粋な上位互換であり、DB変更を伴わない。よってこの1点だけ先に直した。

> 既存データへの影響: 過去に `銀行`/`委託会社` のつもりで登録した成果物は `自治体` として
> 保存されている可能性がある。件数調査と手直しは別タスク（下記7章）。

## 5. 未実行のDB移行（★ここから先はまだ流していない★）

> **前提**: 実行前に必ずバックアップを取ること。3手順とも `begin; ... commit;` で囲み、
> 途中で失敗したら `rollback;`。**Supabase MCP の `execute_sql` ではなく
> `apply_migration` を使う**（DDLのため）。

> **⚠️ 2026-07-30 追記：デプロイ差の考慮が抜けていた**
>
> 当初の手順1は「制約を `委託会社` だけにする」設計だったが、これは
> **コード修正が同時にデプロイされること** を暗黙の前提にしていた。実際には修正は
> ワーキングツリーにあるだけで Vercel 未デプロイのため、制約だけ先に締めると
> **本番の週報登録（まだ `委託企業` を送る）が即座に壊れる**。
>
> よって手順1は「移行期は両方受け付ける」に変更し、デプロイ後に締める手順1-bを追加した。
>
> なお 2026-07-30 時点で手順1は **パーミッションで未実行**（本番DBのDDLのため要承認）。

### 手順1: `weekly_reports.category` の `委託企業` → `委託会社`（最重要・唯一のデータ変更）

現状（2026-07-30 時点の実データ、全57行）:

| category | 件数 |
|---|---|
| 自治体 | 23 |
| 議員 | 9 |
| **委託企業** | **9** |
| 全体 | 7 |
| 事業者 | 4 |
| 支店 | 3 |
| プロモーション | 2 |

CHECK制約が `委託企業` しか受け付けないため、**制約を外す → データ更新 → 新制約を張る**
の順でないと通らない。1トランザクションで実施する。

```sql
-- ▼未実行▼ weekly_reports: 委託企業 → 委託会社
begin;

alter table public.weekly_reports
  drop constraint weekly_reports_category_check;

update public.weekly_reports
   set category = '委託会社'
 where category = '委託企業';
-- 期待: UPDATE 9

alter table public.weekly_reports
  add constraint weekly_reports_category_check
  check (category = any (array[
    '全体','支店','自治体','事業者','議員','委託会社','銀行','プロモーション'
  ]));

commit;
```

検証（実行前後で比較）:

```sql
select category, count(*) from public.weekly_reports group by category order by 2 desc;
-- 実行後: 委託企業 0件 / 委託会社 9件、他は不変（合計57）
```

ロールバック:

```sql
begin;
alter table public.weekly_reports drop constraint weekly_reports_category_check;
update public.weekly_reports set category = '委託企業' where category = '委託会社';
alter table public.weekly_reports
  add constraint weekly_reports_category_check
  check (category = any (array[
    '全体','支店','自治体','事業者','議員','委託企業','銀行','プロモーション'
  ]));
commit;
```

**手順1と同時に（同じデプロイで）直すコード** — 先に流すと週報登録が壊れるので必ずセットで:

- `lib/categories.ts` → `WEEKLY_REPORT_CATEGORIES` の `委託企業` を `委託会社` へ
- `app/weekly-report/page.tsx`（カテゴリー一覧の `"委託企業"`）
- `app/api/weekly-report/route.ts`（冒頭コメント）
- `app/page.tsx`（カード説明文）
- `~/.claude/skills/weekly-report-dashboard/SKILL.md`（`【委託会社】→委託企業` の読み替えを
  `委託会社` に直す。表・説明文・実績メモも同様）

### 手順2: `stakeholders.category` に `官民連携` `社内` を追加

正準8分類との差分は2値。**データ変更は不要**（追加のみ）。

```sql
-- ▼未実行▼ stakeholders: 正準8分類へ拡張
begin;
alter table public.stakeholders drop constraint stakeholders_category_check;
alter table public.stakeholders
  add constraint stakeholders_category_check
  check (category = any (array[
    '自治体','事業者','委託会社','銀行','議員','官民連携','社内','その他'
  ]));
commit;
```

同時に直すコード: `lib/categories.ts` の `STAKEHOLDER_CATEGORIES` を `ORG_CATEGORIES` に置換
（`StakeholderPicker` / `/api/stakeholders` は参照しているだけなので自動追随）。

> 注意: `StakeholderPicker` の選択肢が8個に増える。`社内` を相手先として選べることになるので、
> UI上の意味が変になるなら `官民連携` だけ足す判断もありうる。**吉井さんに要確認。**

### 手順3: `strategic_todos.genre` に `銀行` `官民連携` `その他` を追加

正準8分類との差分は3値。**データ変更は不要**（追加のみ）。

```sql
-- ▼未実行▼ strategic_todos: 正準8分類へ拡張
begin;
alter table public.strategic_todos drop constraint strategic_todos_genre_check;
alter table public.strategic_todos
  add constraint strategic_todos_genre_check
  check (genre = any (array[
    '自治体','事業者','委託会社','銀行','議員','官民連携','社内','その他'
  ]));
commit;
```

同時に直すコード:

- `lib/categories.ts` の `STRATEGIC_TODO_GENRES` を `ORG_CATEGORIES` に置換
- `app/actions/page.tsx` の `GENRE_ORDER` と `GENRE_STYLE`（新3値のアイコン・色を追加。
  **足りないと表示が崩れる**）
- Notion「ToDo DB」側のセレクト選択肢にも同じ3値を追加（ミラー元のため。Notion作業は別担当）

## 6. 推奨する実行順序

1. **手順1**（weekly_reports）を単独で実施 — 唯一のデータ変更で、影響も検証も一番はっきりしている
2. 1週間運用して週報登録・ダッシュボード表示に異常が無いことを確認
3. **手順2・手順3** をまとめて実施（追加のみなので低リスク。UI追随だけ忘れないこと）

Notion側（顧客CRM `種別` への8分類追加）は別担当。**CRMが8分類になるまでは、
`plaud-meeting-daily-sync` がCRMへ新規行を作るときに `事業者` 等を書こうとして
Notion側で弾かれる可能性がある**。CRMの選択肢追加を先に完了させること。

## 6.5 許可リスト不整合の横断監査（2026-07-30）

`/deliverables` で見つかったバグは「**UI が送れる値 > API が許可する値**」という型だった。
同じ型が他にも無いか全ルートを突き合わせた結果。

| 箇所 | UI が出す値 | API/DB が許す値 | 判定 |
|---|---|---|---|
| `/deliverables` カテゴリー | 8＋共通 | 4 → **8＋共通** | ✅ 修正済み（黙って`自治体`に化けていた） |
| `/search` source_type | 日記/会議/学び/**成果物**/**学会** | 日記/会議/学び → **7種** | ✅ 修正済み（**下記**） |
| 営業ToDo `genre` | 5 → **8**（GENRE_ORDER拡張時） | 5（`lib/notionTodos.ts`）→ **8** | ✅ 修正済み（拡張と同時に発生しかけた） |
| `/deliverables` docType | 6 | 6 | 一致 |
| `/status` ADD_CATEGORIES | 4 | 8 | 意図的な絞り込み（「次に攻める団体」に委託会社等を出さない）。放置 |
| `/search` 人物・テーマ | ハードコード6人・8テーマ | Notion学びDBの選択肢と一致 | **ドリフト注意**（下記） |

### `/search` の source_type フィルタが効いていなかった（実害あり）

`app/api/search/route.ts` の `VALID_SOURCE_TYPES` が `["日記","会議","学び"]` の3つだけで、
リストに無い値が来ると **`source_type` をpayloadに載せずに黙って進む**（エラーを返さない）。
結果、検索UIが出していた `成果物`(246件・最大のバケツ) と `学会`(10件) の絞り込みが
**一度も効いておらず、全件から検索されていた**。ユーザー側からは「絞ったのに関係ない結果が出る」
としか見えず気づきにくい。`memory_chunks.source_type` のCHECK制約と同じ7種に拡張して修正。

> 検証状況: `tsc --noEmit` exit 0。ローカル開発サーバの認証ゲートに阻まれ、
> HTTP経由でのend-to-end実行までは未確認。

### 残存するドリフト риск（未対応・要判断）

- `app/search/page.tsx` の `PERSON_FILTERS`(6人) / `THEME_FILTERS`(8テーマ) は Notion
  「学び・ナレッジDB」の選択肢をハードコードで写したもの。現時点では一致しているが、
  同DBの`人物`は「読む人が増えるたび追加」する運用（`plaud-learning-to-notion` スキル）なので、
  **人を増やすたびに検索フィルタが古くなる**。APIは person/theme を素通しするため、
  登録はできるが検索UIから絞れない状態になる。Notionから選択肢を取得するか、
  `memory_chunks.metadata` から distinct を引いて動的生成するのが本筋。

## 7. 積み残し（別タスク）

- ~~`/deliverables` 経由で `銀行`/`委託会社` が `自治体` に化けた既存 `memory_chunks` の
  件数調査と手直し（4章）。~~ **→ 2026-07-30 調査完了・該当ゼロ。対応不要。**
  `source_type='成果物'` を全件確認したところ、`カテゴリ='自治体'` の55件は
  豊島区(43)・北九州市(6)・熊本市(6) で全て実際に自治体だった。銀行・委託会社を
  登録した実績がまだ無く、バグは存在したが一度も踏まれていなかった。
  （内訳: 共通133 / 自治体55 / その他7 / 議員3 / カテゴリ未設定48〈横浜市33・北九州市15〉）
- `diary-register` / `app/api/diary` の `TAGS`（自治体・事業者・振り返り・アイデア・ツール活用・
  家族・健康・その他）は **日記のタグであって団体の種類ではない**。今回の統一対象外とした。
  ただし `自治体`/`事業者` の2語だけ正準と重なっており、将来混同の種になる。
- `app/api/status/route.ts` の `NEWS_CATEGORY_ORDER`、`app/slide-refine/page.tsx` の
  目的リストなども別軸。統一対象外。

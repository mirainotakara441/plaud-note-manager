-- 一行日記の「原文」を残すテーブル（2026-09-12）。
--
-- ■ なぜ memory_chunks に入れないのか
-- memory_chunks に原文を入れると、**フィルタ無しのRAG検索が原文と要約の両方を拾う**。
-- 提案エージェントの関連メモ（match_count 8）・壁打ちの関連メモ（6）・/search の
-- 「すべて」はいずれも source_type を指定しないので、同じ日の内容が二重に入る。
-- source_type を新設しても同じこと（CHECK制約の変更も要る）。だから外に置く。
--
-- ■ ここに入るもの
-- 吉井さんが貼り付けた、その日ぶんの原文。**要約前**の文章。
-- ただし誤字辞書（transcription_dictionary）は通した後の状態になる。
-- 入口の correctTranscription が1回かかるため、そこは変えていない。
--
-- ■ 検証を通ったものだけ入る
-- 1日ぶんの原文はClaudeに切り出させているので、**貼り付け原文の部分文字列か**を
-- lib/diaryRaw.mjs の verifyRawSpan がコードで確かめる。落ちた日は保存しない。
-- 「原文」と名乗る別物が残るのは、原文を残さないより悪い。
--
-- ■ 一意性
-- notion_url をキーにする。同じ日に2つの日記を書いた実例があるため
-- （2026-07-02 は2エントリ）、event_date では一意にできない。
--
-- ■ 権限
-- RLS 有効・ポリシー0。memory_chunks と同じで service_role だけが触れる。
--
-- ■ 戻し方
--   drop table public.diary_raw;
-- 既存のどの経路もこのテーブルを読んでいないので、消しても他は動く。

create table if not exists public.diary_raw (
  id          uuid primary key default gen_random_uuid(),
  event_date  date        not null,
  notion_url  text        not null unique,
  raw         text        not null,
  created_at  timestamptz not null default now()
);

create index if not exists diary_raw_event_date_idx on public.diary_raw (event_date);

alter table public.diary_raw enable row level security;

comment on table public.diary_raw is
  '一行日記の原文（要約前）。memory_chunks には入れない——フィルタ無しRAG検索が要約と二重に拾うため。verifyRawSpan の検証を通ったものだけが入る。';

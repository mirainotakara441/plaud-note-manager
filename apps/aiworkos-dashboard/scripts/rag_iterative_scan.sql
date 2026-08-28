-- RAG検索の取りこぼしを直す（第7.7弾）。
--
-- ■ 何が起きていたか
-- memory_chunks_embedding_idx は hnsw（近似検索）で、hnsw.ef_search=40 /
-- iterative_scan=off。**候補40件を先に取ってから絞り込む**ため、
-- source_type や organization で絞ると要求件数に遠く届かなかった。
--
--   実在5行以上の団体×種別 31組のうち、25組が取りこぼし
--   欠落チャンク総数 218／充足率 54%
--   例：新宿区×成果物 実在23行 → 要求20に対して3件
--       豊島区×会議   実在10行 → 要求20に対して3件
--   フィルタ付きでは match_count=5 ですら 2/6 しか満たせていなかった
--
-- 並び順そのものは壊れていない。索引なしの exact search と突き合わせた
-- 60条件すべてで、返ってきた行は exact の上位prefixと完全一致していた。
-- つまり「順序は正しいが途中で打ち切られる」状態。だから直しても
-- 既存の並びは崩れず、下位の欠落行が足されるだけ。
--
-- ■ なぜ iterative_scan で、ef_search を上げないのか
-- どちらも recall は全条件100%になるが、latency の性質が正反対。
--
--                    フィルタなし p50   両方フィルタ p50
--   現状 ef40/off        0.8ms(100%)      0.5ms(recall 34%)
--   ef120/off           10.8ms            0.9ms(100%)
--   strict_order         0.9ms            5.0ms(100%)
--
-- ef を上げると、**壊れていないフィルタなし検索が13倍**になる（/search の
-- 既定経路）。iterative_scan は候補が足りないときだけ探索を継続するので、
-- 足りている検索にはコストがかからない。
--
-- relaxed_order ではなく strict_order を選ぶのは、並び順の厳密性を
-- 保証させるため。recall も latency も両者ほぼ同じだった。
--
-- ■ なぜグローバル設定でなく関数の SET 句なのか
-- ALTER DATABASE / ALTER ROLE で入れると、この先どんな vector 検索を
-- 足しても一律に効いてしまう。関数の SET 句なら RAG の RPC 2本の中だけに
-- 閉じ、他へ波及しない。関数を出れば元の値に戻ることも実測で確認済み。
--
-- ■ ★踏んだ罠：先に vector を読ませないと権限エラーで落ちる
--   ERROR: 42501: permission denied to set parameter "hnsw.ef_search"
-- 拡張のGUCが未ロードのセッションでは仮置き扱いになり、非スーパーユーザーは
-- 設定できない。**ALTER の前に vector 演算子を1回使う。**
--
-- ■ 規模の前提
-- hnsw.max_scan_tuples=20000 に対して実データは1459行。探索は必ず完走できる。
-- 20000行に近づいたら、この前提が崩れるので再測定すること。
--
-- ■ 変えていないもの
-- 関数の本文・ランキング・match_count の意味・返却列・権限。SET句を足しただけ。
-- search_path の SET 句は残る（proconfig に追記される形）。
--
-- ■ 戻し方
--   ALTER FUNCTION public.match_memory_chunks(vector, integer, text, text)
--     RESET hnsw.iterative_scan;
--   ALTER FUNCTION public.match_memory_chunks_v2(vector, integer, text, text)
--     RESET hnsw.iterative_scan;
-- **RESET ALL は使わないこと。** search_path の SET 句まで消えて関数が壊れる。

-- ★これが無いと ALTER が権限エラーで落ちる
SELECT ('[1,0]'::vector <=> '[0,1]'::vector);

ALTER FUNCTION public.match_memory_chunks(vector, integer, text, text)
  SET hnsw.iterative_scan = 'strict_order';

ALTER FUNCTION public.match_memory_chunks_v2(vector, integer, text, text)
  SET hnsw.iterative_scan = 'strict_order';

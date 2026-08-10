-- salt2_qa_log に RLS を有効化し、anon には SELECT のみ許可する。
--
-- bootcamp_logs / salt2_members と同じ形にする（読み取りは anonCreds()、
-- 書き込みは service role のみ）。このテーブルは数分前にマイグレーションで
-- 作られたばかりで RLS を明示設定していないため、有効化前は
-- Supabaseのデフォルト権限により anon が読み書き自由な状態になり得る。
--
-- Supabase MCP（apply_migration, project_id zuadqnarsoykplkafyxv）が
-- net::ERR_FAILED で3回とも失敗したため、SQL Editor からの手動適用用に
-- ここへ書き出した。適用後は /bootcamp/tips が正常にデータを返すようになる
-- （未適用のままだと anon 読み取りが空/拒否になるか、RLS未設定のまま
-- 放置されるリスクが残る）。

ALTER TABLE public.salt2_qa_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "salt2_qa_log_anon_select" ON public.salt2_qa_log
  FOR SELECT TO anon USING (true);

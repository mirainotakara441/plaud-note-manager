-- =====================================================================
-- ニュース収集 pg_cron の pg_net タイムアウト延長（2026-09-17 適用済み）
-- =====================================================================
-- 9/15〜17 の3日間、fetch-news-multi が毎朝 HTTP 546（Edge 実行上限150秒）で
-- 全滅していたが、pg_cron の実行履歴は「succeeded」、pg_net の応答は
-- 「Timeout of 5000 ms」しか残らず、DB 側から死因が見えなかった。
-- pg_net 既定の5秒は「リクエストを積めた」ことしか保証しない。
-- 関数の内部締切（110秒）より長い150秒待ち、成否を net._http_response に残す。
--
-- 本体の修正は Edge Function 側（supabase/functions/fetch-news-multi v5）:
--   タイムアウト・並列・締切・テーマ別ログ・Google→Bing の二段構え。
--
-- 戻し方: timeout_milliseconds を外して cron.alter_job し直す（旧コマンドは cron.job の履歴なし。
--        以下の $cmd$ から timeout 行を削れば旧と同じ）。
SELECT cron.alter_job(
  job_id := 3,
  command := $cmd$
  select net.http_post(
    url := 'https://zuadqnarsoykplkafyxv.supabase.co/functions/v1/fetch-news-multi',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $cmd$
);

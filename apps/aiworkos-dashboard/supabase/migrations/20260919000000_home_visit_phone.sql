-- =====================================================================
-- 家庭訪問メンバーに電話番号を持たせる（2026-09-19 適用済み）
-- =====================================================================
-- 家庭訪問のリストから、その場で電話をかけられるようにするため。
-- 出典は城西支部の地区名簿（2026-07-18版 xlsx）。本人の連絡先欄が空で
-- 同じ世帯の別の人に番号がある場合は、その世帯の番号を入れ phone_note に出所を残す
-- （「本人の携帯」と「世帯の固定」を混同しないように）。
-- 表記は 03-xxxx-xxxx / 090-xxxx-xxxx に揃える（名簿は市内局番だけの表記が多い）。
-- 複数ある場合は " / " 区切り。
--
-- rollback: ALTER TABLE public.home_visit_members DROP COLUMN phone, DROP COLUMN phone_note;
ALTER TABLE public.home_visit_members
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS phone_note text;

COMMENT ON COLUMN public.home_visit_members.phone IS
  '電話番号。03-xxxx-xxxx / 090-xxxx-xxxx 形式、複数は " / " 区切り。出典は地区名簿（2026-07-18版）';
COMMENT ON COLUMN public.home_visit_members.phone_note IS
  '番号の出所の注記。本人欄なら null、同世帯の番号なら「世帯の番号（名簿の◯◯欄）」';

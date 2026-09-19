-- =====================================================================
-- AI発信者ウォッチ: 監視アカウントの初期データ（16名・2026-09-19）
-- =====================================================================
-- 20260919120000_x_creators.sql を適用したあとに流す。
-- 既に同じ handle があれば触らない（手で直した focus / followers を潰さない）。
-- followers は分かるものだけ。null は「未調査」であって0ではない。
-- url は https://x.com/<handle> で固定。
-- =====================================================================

INSERT INTO public.x_creator_accounts (handle, display_name, url, category, focus, followers) VALUES
  ('m_kumagai',        '熊谷正寿【GMO】',                'https://x.com/m_kumagai',        '経営者・VC',   'GMO代表。AI・ロボット・ドローンの経営者視点',                   277000),
  ('pop_ikeda',        '池田 朋弘',                      'https://x.com/pop_ikeda',        '速報',         '毎日21時にAIニュース深堀り。Claude自動化本の著者',               35000),
  ('ai_jitan',         'えーたん/AI×時短で仕事効率化',   'https://x.com/ai_jitan',         'ビジネス活用', 'Gemini Notebook（旧NotebookLM）で時短。KADOKAWA著者',           NULL),
  ('linxiaoxian2010',  'リンリン',                       'https://x.com/linxiaoxian2010',  'ビジネス活用', '生成AI×IP×企業動画。経営者の学びを箇条書き化',                   NULL),
  ('dennotai',         '川邊健太郎',                     'https://x.com/dennotai',         '経営者・VC',   'LINEヤフー会長。事業とAIの経営者視点',                           NULL),
  ('tetumemo',         'テツメモ',                       'https://x.com/tetumemo',         '図解',         'AI図解×検証×ニュースレター。Codex/Claude Codeの設定検証',       NULL),
  ('keigomori0503',    '森けいご',                       'https://x.com/keigomori0503',    '政治・行政',   '大阪市会議員。行政×AI',                                         NULL),
  ('taiyaki_ai3',      'たい焼き',                       'https://x.com/taiyaki_ai3',      '速報',         'Claude Codeの人。海外の話題を日本語で速報',                     NULL),
  ('keitowebai',       'KEITO',                          'https://x.com/keitowebai',       '検証',         'AIディレクター。全て自分で検証して発信。YouTube20万人',          45553),
  ('masahirochaen',    'チャエン',                       'https://x.com/masahirochaen',    '速報',         'デジライズ代表。AIニュースを最速で要約',                         NULL),
  ('shingo_copilot',   'しんご',                         'https://x.com/shingo_copilot',   'ビジネス活用', 'Copilotの専門家。ドブ板営業歴21年からの転身',                   NULL),
  ('macopeninsutaba',  'かずなり',                       'https://x.com/MacopeninSUTABA',  'ビジネス活用', '生成AI活用術。取締役COO・社外CAIO。1行プロンプト100の著者',      NULL),
  ('takahiroanno',     '安野貴博',                       'https://x.com/takahiroanno',     '政治・行政',   'チームみらい党首。AIと政治・社会',                               NULL),
  ('usutaku_channel',  'usutaku',                        'https://x.com/usutaku_channel',  '検証',         'AI活用の実演・検証。AI界隈のハブ',                               NULL),
  ('aoi_genai',        'aoi',                            'https://x.com/Aoi_genai',        'ビジネス活用', 'Claude Code徹底解説・セミナー',                                 NULL),
  ('ozarnozarn',       '小澤隆生（おざーん）',           'https://x.com/ozarnozarn',       '経営者・VC',   'BoostCapital。元ヤフー社長。起業と経営の考え方',                 NULL)
ON CONFLICT (handle) DO NOTHING;

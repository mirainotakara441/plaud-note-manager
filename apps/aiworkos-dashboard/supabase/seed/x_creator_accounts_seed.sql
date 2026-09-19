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

-- 2026-09-19 追加10名（類似アカウント候補。吉井さんが全員追加を選択）。
-- 本番には execute_sql で投入済み。followers はプロフィール実測（あるるは2025-07以降投稿停止中）。
INSERT INTO public.x_creator_accounts (handle, display_name, url, category, focus, followers) VALUES
  ('ctgptlb',       'AGIラボ（旧ChatGPT研究所）', 'https://x.com/ctgptlb',      '速報',         'OpenAI/Google/Anthropicの新機能を【速報】で即日整理',    138000),
  ('shota7180',     '木内翔大＠SHIFT AI代表',     'https://x.com/shota7180',    '速報',         'SHIFT AI代表。速報＋初心者向けの噛み砕き・活用30選',     150000),
  ('chatgptair',    'あるる ChatGPT × AIツール',  'https://x.com/chatgptair',   '図解',         'ツール活用を図解・手順で。2025年7月以降は投稿停止中',    106000),
  ('sugurukun_ai',  'すぐる｜ChatGPTガチ勢',      'https://x.com/SuguruKun_ai', '検証',         'Claude Code/Codex/MCPを動かした結果をスレッドで公開',    106000),
  ('karaage0703',   'からあげ',                   'https://x.com/karaage0703',  '検証',         'Claude Cowork・ローカルAIを日々試して短文報告',           30000),
  ('umiyuki_ai',    'うみゆき@AI研究',            'https://x.com/umiyuki_ai',   '速報',         '生成AIトレンドを独自視点で解説・論評',                   65000),
  ('hiraoka_dx',    '平岡｜本部長のClaude活用術', 'https://x.com/hiraoka_dx',   'ビジネス活用', '大手の本部長がClaude・Gemini Omniを実務で使う',          30000),
  ('hayakawagomi',  'ハヤカワ五味',               'https://x.com/hayakawagomi', 'ビジネス活用', 'メルカリAI Strategy。企業実務に落とす担当の目線',        118000),
  ('fukkyy',        '福島良典｜LayerX',           'https://x.com/fukkyy',       '経営者・VC',   'LayerX CEO。AIで事業を組み替える経営判断',               71000),
  ('fladdict',      '深津貴之',                   'https://x.com/fladdict',     '経営者・VC',   'note CSO。プロンプト設計・生成AI時代の意味づけ',         178000)
ON CONFLICT (handle) DO NOTHING;

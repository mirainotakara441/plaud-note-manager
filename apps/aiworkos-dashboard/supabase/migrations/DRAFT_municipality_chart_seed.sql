-- ============================================================================
-- DRAFT: municipalities マスタの種（43団体）
-- 作成 2026-09-19（Fable 5.1）。DRAFT_municipality_chart.sql 適用後に流す。
--
-- research_priority: 1=アプローチ済み（会議・週報・CRM商談中/リードのいずれかがある。2026-09-19時点の実データで判定）
--                    2=未アプローチ
-- minutes_system / minutes_url / minutes_api_hint:
--   政令市は 2026-09-13 の会議録調査（memory reference_kaigiroku_search_routes・調査/scripts）で実測済み。
--   特別区は 2026-09-19 にサブエージェントが入口URLを fetch で開いて確認。
--   「要確認」と書いた欄は未実測。Phase 2 の最初に埋める。
-- population は入れていない（時点の無い数字を載せないため。Phase 1 で population_as_of と一緒に入れる）。
-- ============================================================================

insert into public.municipalities
  (name, kind, prefecture, minutes_system, minutes_url, minutes_api_hint, council_video_url, research_priority, memo)
values
-- ---------------- 政令市 20 ----------------
('札幌市',    '政令市', '北海道',   'voiweb',    'https://sapporo.gijiroku.com/voices/',                      'host要確認（voiweb.exe パターン）', null, 1, '商談中。会議6件・週報3件'),
('仙台市',    '政令市', '宮城県',   'dbsr',      'https://www.city.sendai.dbsr.jp/',                          'host要確認。2021-10に郵送事務センター設置', null, 2, '未アプローチ。議員候補9名は登録済み'),
('さいたま市','政令市', '埼玉県',   'kaigiroku', 'https://ssp.kaigiroku.net/tenant/saitama/',                 'tenant=saitama id=134', null, 1, '商談中。公明4名の窓口DX質問あり'),
('千葉市',    '政令市', '千葉県',   'dbsr',      'http://www.city.chiba.dbsr.jp/',                            'httpのみ。host要確認', null, 2, '未アプローチ'),
('横浜市',    '政令市', '神奈川県', 'kaigiroku', 'https://ssp.kaigiroku.net/tenant/yokohama/',                'tenant=yokohama id=20', null, 1, '商談中。会議14件・成果物50件。郵送請求 年間約60万枚（2025-10答弁）'),
('川崎市',    '政令市', '神奈川県', 'voiweb',    'https://www13.gijiroku.com/kawasaki_council/cgi/',          'cgi=www13.gijiroku.com/kawasaki_council/cgi/voiweb.exe', null, 2, '未アプローチ。議員候補11名は登録済み'),
('相模原市',  '政令市', '神奈川県', 'kaigiroku', 'https://ssp.kaigiroku.net/tenant/sagamihara/',              'tenant=sagamihara id=400', null, 1, '商談中。大崎秀治議員（公明）2025-09-25 質問あり'),
('新潟市',    '政令市', '新潟県',   'voiweb',    'https://www06.gijiroku.com/niigata/cgi/',                   'cgi=www06.gijiroku.com/niigata/cgi/voiweb.exe', null, 2, '2026-09-18 訪問（会議記録は未登録）。窓口キャッシュレス率 約15%・手数料3.25%'),
('静岡市',    '政令市', '静岡県',   'dbsr',      'https://www.city.shizuoka.shizuoka.dbsr.jp/',               'host=shizuoka.shizuoka', null, 2, '未アプローチ。2026-07目途で郵送請求キャッシュレス導入（2026-03答弁）'),
('浜松市',    '政令市', '静岡県',   'kaigiroku', 'https://ssp.kaigiroku.net/tenant/hamamatsu/',               'tenant=hamamatsu id=405', null, 1, '2026-09-17 訪問。会議1件。コンビニ交付率43%'),
('名古屋市',  '政令市', '愛知県',   'kaigiroku', 'https://ssp.kaigiroku.net/tenant/nagoya/',                  'tenant=nagoya id=207', null, 1, 'リード。中村しゅうへい議員（公明）2024-06 質問あり'),
('京都市',    '政令市', '京都府',   'kaigiroku', 'https://ssp.kaigiroku.net/tenant/kyoto/',                   'tenant=kyoto id=355', null, 1, '商談中。郵送請求 年間32.7万件、士業 約5万通。2025-06 士業クレカ払い開始'),
('大阪市',    '政令市', '大阪府',   'kaigiroku', 'https://ssp.kaigiroku.net/tenant/cityosaka/',               'tenant=cityosaka id=357', null, 1, '会議9件・週報4件'),
('堺市',      '政令市', '大阪府',   'voiweb',    'https://www12.gijiroku.com/sakai/cgi/',                     'cgi=www12.gijiroku.com/sakai/cgi/voiweb.exe（voicesなし）', null, 1, '週報2件。郵送請求 年10万件超・個人は2〜10%（2025-09 信貴議員）'),
('神戸市',    '政令市', '兵庫県',   'dbsr',      'https://www.city.kobe.dbsr.jp/',                            'host要確認。民間からの郵送請求を2006年から民間委託', null, 2, '未アプローチ'),
('岡山市',    '政令市', '岡山県',   'kaigiroku', 'https://ssp.kaigiroku.net/tenant/okayama/',                 'tenant=okayama id=359', null, 2, '未アプローチ。林敏宏議員（公明）2026-06 質問あり'),
('広島市',    '政令市', '広島県',   'voiweb',    'https://hiroshima.gijiroku.com/voices/',                    'cgi=hiroshima.gijiroku.com/voices/cgi/voiweb.exe', null, 1, '商談中。並川雄一議員 2023-06 代表質問→2025-02 士業クレカ払い実現'),
('北九州市',  '政令市', '福岡県',   'kaigiroku', 'https://ssp.kaigiroku.net/tenant/kitakyushu/',              'tenant=kitakyushu id=528', null, 1, '商談中。会議14件・成果物27件。法人向け市税証明 電子申請 2026-01 開始（政令市10番目）'),
('福岡市',    '政令市', '福岡県',   'dbsr',      'https://www.city.fukuoka.dbsr.jp/',                         'host要確認。手続の94.4%をオンライン化（岡山市答弁で引用）', null, 1, '商談中。週報1件'),
('熊本市',    '政令市', '熊本県',   'voiweb',    'https://kumamoto.gijiroku.com/voices/',                     'host要確認（voiweb.exe パターン）', null, 1, '商談中。会議24件・週報5件（2026-09-10 最新）'),
-- ---------------- 特別区 23 ----------------
('千代田区',  '特別区', '東京都',   'dbsr',      'https://www.city.chiyoda.tokyo.dbsr.jp/',                   '入口 https://gikai-chiyoda-tokyo.jp/shingi/kensaku/index.html', 'https://www.kensakusystem.jp/chiyoda-vod/index.html', 2, '未アプローチ'),
('中央区',    '特別区', '東京都',   'other',     'https://www.kugikai.city.chuo.lg.jp/kaigiroku/index.html',  '自庁の独自cgi。検索は /kaigiroku/index.cgi?keyword= 。直接fetchは500', 'https://chuo-city.stream.jfit.co.jp/', 2, '未アプローチ'),
('港区',      '特別区', '東京都',   'other',     'https://gikai2.city.minato.tokyo.jp/voices/g07v_search.asp','自庁ドメインだが台東区(voiweb)と同じ .asp 命名。voiweb相当の可能性', 'https://gikai2.city.minato.tokyo.jp/g07_broadcasting.asp', 2, '未アプローチ'),
('新宿区',    '特別区', '東京都',   'kaigiroku', 'https://ssp.kaigiroku.net/tenant/shinjuku/pg/index.html',   'tenant=shinjuku id=211', 'https://smart.discussvision.net/smart/tenant/shinjuku/WebView/list.html', 1, '商談中。会議27件・成果物23件。井下田栄一議員（公明幹事長）と面談済み。委託先変更直後'),
('文京区',    '特別区', '東京都',   'dbsr',      'https://www.city.bunkyo.tokyo.dbsr.jp/',                    null, 'https://bunkyo-city.stream.jfit.co.jp/', 2, '未アプローチ'),
('台東区',    '特別区', '東京都',   'voiweb',    'https://taito.gijiroku.com/voices/g08v_search.asp',         'asp版。voiweb.exe ではなく g08v_search.asp', 'http://www.kensakusystem.jp/taito-vod/sapphire.html', 2, '未アプローチ'),
('墨田区',    '特別区', '東京都',   'kaigiroku', 'https://ssp.kaigiroku.net/tenant/sumida/SpTop.html',        'tenant=sumida id=396', 'https://smart.discussvision.net/smart/tenant/sumida/WebView/rd/council_1.html', 1, '会議21件・成果物20件（2026-08-24 最新）'),
('江東区',    '特別区', '東京都',   'dbsr',      'https://www.city.koto.tokyo.dbsr.jp/',                      '録画検索は koto-city.gijiroku.com（別系統）', 'https://koto-city.stream.jfit.co.jp/', 2, '未アプローチ')
,
('北区',      '特別区', '東京都',   'kaigiroku', 'https://ssp.kaigiroku.net/tenant/kita/',                    'tenant=kita id=395。入口 city.kita.lg.jp/assembly/records/1015123.html', 'https://www.city.kita.lg.jp/assembly/records/1015176.html', 2, '未アプローチ'),
('荒川区',    '特別区', '東京都',   'kaigiroku', 'https://ssp.kaigiroku.net/tenant/arakawa/',                 'tenant=arakawa id=577', 'YouTube公式チャンネル経由（区議会ページから）', 2, '未アプローチ'),
('板橋区',    '特別区', '東京都',   'voiweb',    'https://itabashi.gijiroku.com/voices/g07v_search.asp',      'cgi=itabashi.gijiroku.com/voices/cgi/voiweb.exe（.exe版あり）', 'https://itabashi.gijiroku.com/g07_broadcasting.asp', 2, '未アプローチ。議員候補10名は登録済み'),
('練馬区',    '特別区', '東京都',   'kaigiroku', 'https://ssp.kaigiroku.net/tenant/nerima/',                  'tenant=nerima id=367', 'https://smart.discussvision.net/smart/tenant/nerima/', 1, '会議15件・成果物17件・週報2件（2026-08-21 最新）'),
('足立区',    '特別区', '東京都',   'other',     'https://www.gikai-adachi.jp/voices/g07v_search.asp',        '自庁ドメイン .asp（voiweb相当の命名）。外部ベンダー不検出', 'https://www.gikai-adachi.jp/g07_Video_Search.asp', 2, '未アプローチ。CRM登録あり（接点なし）'),
('葛飾区',    '特別区', '東京都',   'kensakusystem', 'https://www.kensakusystem.jp/katsushika/sapphire.html', 'cgi-bin3/See.exe?Code=… 。入口 katsushika-kugikai.jp/50000.html', 'https://smart.discussvision.net/smart/tenant/katsushika/WebView/rd/council.html', 2, '未アプローチ'),
('江戸川区',  '特別区', '東京都',   'other',     'https://www.gikai.city.edogawa.tokyo.jp/voices/g07v_search.asp', '自庁ドメイン .asp（本会議 g08v_viewh / 委員会 g08v_views）。Shift-JIS', 'https://www.gikai.city.edogawa.tokyo.jp/g07_Video_Search.asp', 2, '未アプローチ')
,
('品川区',    '特別区', '東京都',   'other',     'https://kaigiroku.city.shinagawa.tokyo.jp/index.php/',      '自前システム（Laravel）。ssp.kaigiroku.net とは別物。入口 gikai.city.shinagawa.tokyo.jp/search', 'https://gikaichukei.city.shinagawa.tokyo.jp/', 1, 'CRMリード。議員候補7名は登録済み。接点なし'),
('目黒区',    '特別区', '東京都',   'kensakusystem', 'https://www.kensakusystem.jp/meguro/',                  'cgi-bin3/See.exe?Code=…', 'https://smart.discussvision.net/smart/tenant/meguro/WebView/rd/council_1.html', 2, '未アプローチ'),
('大田区',    '特別区', '東京都',   'other',     'https://www.gikai-ota-tokyo.jp/ota/',                       '自庁ドメインの VOICES/Web 系（g08v_search.asp）。杉並区と同エンジン', 'https://www.city.ota.tokyo.jp/gikai/hirakareta_gikai/g_chuukei/index.html', 2, '未アプローチ。CRM登録あり・議員候補10名は登録済み'),
('世田谷区',  '特別区', '東京都',   'other',     'https://kugi.city.setagaya.tokyo.jp/voices/',               '自庁ドメインの VOICES/Web 系（CGI/voiweb.exe あり）', 'https://setagaya-city.stream.jfit.co.jp/', 2, '未アプローチ'),
('渋谷区',    '特別区', '東京都',   'kaigiroku', 'https://ssp.kaigiroku.net/tenant/shibuya/SpTop.html',       'tenant=shibuya id=394。旧 kaigiroku.net/kensaku/shibuya は死んでいる', 'https://smart.discussvision.net/smart/tenant/shibuya/WebView/rd/council_1.html', 2, '未アプローチ'),
('中野区',    '特別区', '東京都',   'other',     'https://kugikai-nakano.jp/search.html',                     '独自開発。静的リンク＋Googleカスタム検索。機械検索は難しい', 'https://smart.discussvision.net/smart/tenant/nakano/WebView/rd/council_1.html', 2, '未アプローチ'),
('杉並区',    '特別区', '東京都',   'voiweb',    'https://suginami.gijiroku.com/voices/',                     'cgi=suginami.gijiroku.com/voices/voices/g08v_search.asp（asp版）', 'https://suginami.gijiroku.com/voices/g07_Video_Search.asp', 2, '未アプローチ'),
('豊島区',    '特別区', '東京都',   'kensakusystem', 'https://www.kensakusystem.jp/toshima/',                 'cgi-bin3/Search2.exe?Code=…&sTarget=2', 'https://www.kensakusystem.jp/toshima-vod/', 1, '商談中。会議10件・成果物48件。2025-11-18 辻薫議員 一般質問→区がトライアル検証を答弁（郵送22,111枚・法人98%）。吉井さんの地元')
on conflict (name) do update set
  kind = excluded.kind,
  prefecture = excluded.prefecture,
  minutes_system = excluded.minutes_system,
  minutes_url = excluded.minutes_url,
  minutes_api_hint = excluded.minutes_api_hint,
  council_video_url = coalesce(excluded.council_video_url, public.municipalities.council_video_url),
  research_priority = excluded.research_priority,
  memo = coalesce(public.municipalities.memo, excluded.memo),   -- 手で育てたメモは上書きしない
  updated_at = now();

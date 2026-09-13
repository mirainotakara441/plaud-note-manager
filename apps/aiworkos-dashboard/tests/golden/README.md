# Golden（切替前の正解基準）

production-change-protocol §5 の突合に使う「変更前の実経路の応答」の写し。

## ファイル

- `search-memory-20260913.json` … search-memory（v2経路）の応答。
  採取: 2026-09-13 09:21 JST / 15ケース・110行。
  **用途: ハイブリッド検索（match_memory_chunks_v3）へ切り替える際の before。**
  切替後に `scripts/golden-search-memory.mjs` で再採取し、
  `node ~/.claude/skills/production-change-protocol/golden-compare.mjs before.json after.json`
  で突合する。ハイブリッド切替では**差分が出ること自体は想定どおり**なので、
  許容差0ではなく「差分が docs/hybrid-search-shadow-report.md の実測（固有名詞の
  獲得）と同じ向きか」を人が読む。

- `search-memory-20260913-after-v3.json` … **切替後（v6・v3経路）の応答。突合の証跡。**
  突合結果（2026-09-13・切替直後に実施）: 15ケース中差分12件、すべて意図した向き。
  - 固有名詞・意味系: shadow実測どおりの獲得・入れ替わり
  - person（伊藤羊一）: **0件→2件**。v2のベクトル上位40に入らなかった学びチャンクを
    全文側が拾い、metadataフィルタが初めて機能した＝改善
  - org-熊本市: 同じ文書の別チャンクへの入れ替わりのみ（文書レベルの損失なし）
  - **完全一致（不変を確認）**: org-堺市 / type-成果物 / theme
  当初この README には「org・person・theme に差分が出たら rollback」と書いたが、
  person と org の差分は上記のとおりハイブリッドの正当な効果だったため、
  基準を「不変であるべきは *全文側が足すものが無い* ケース」に訂正する。
  差分は必ず中身を読んで判断する——機械的な件数判定に還元しない。

## 作法

- 採取は切替の**意思決定より前**に行う。切り替えてから「前はどうだったか」は二度と採れない
- 比較器は使う前に自己テストする（同一→差分0 / 改変→検出）。2026-09-13 実施済み

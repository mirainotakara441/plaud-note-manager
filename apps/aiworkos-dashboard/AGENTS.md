<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# AIワークOS 検証ルール（必読）

## UIを触ったら、pushする前に必ずブラウザで1回開く

2026-07-18 の教訓。`/weapons` は API を curl で検証しただけでブラウザで一度も開かず本番に出し、
`/api/organizations` が `{name,count}` オブジェクト配列を返すのに文字列として描画してクラッシュした
（吉井さんが実機で発見）。**tsc・build が通ることと、ページが表示できることは別物。**

- ページを追加・変更したら、`npm run build` → `npx next start -p 3033` → ブラウザで該当ページを開き、
  console エラーが無いことまで確認してから commit する。
- クエリパラメータ付きの導線（`/weapons?org=...&actions=...` 等）は、**パラメータ付きのURLで**開くこと。
  素のURLだけでは発症しないバグがある。
- API と UI の間の型（レスポンス形状）を変えたら、そのAPIを使う全ページを grep して合わせる。

### この確認は一部を自動化した（2026-08-28）

`npm run test:all` で「型チェック → build → スモーク(API) → E2E(ブラウザ)」が順に走る。
E2Eは Playwright で主要5画面（`/` `/organizations` `/actions` `/search` `/status`）を
実際にChromiumで開き、5xx・Reactのクラッシュ・`console.error`・
「取得に失敗しました」等の表示が無いことを見る。**読み取りのみで書き込みは出さない**
（POST/PUT/PATCH/DELETEはテスト側でブロックしている）。

ただし**自動化したのは5画面だけ**で、上のルールが要らなくなったわけではない。
E2Eの対象外を触ったときは、これまで通り自分でブラウザを開くこと。
クエリパラメータ付きの導線も自動化できていない。

## その他の再発防止

- 埋め込み(gte-small)は日本語約500字で頭打ち。content は400字/チャンクに刻む（実測済み・全登録経路で厳守）。
- `organization` は会議DB/提案エージェントの団体名と厳密一致。横断資料は擬似団体「共通」へ。
- 実績数値（自治体数・事業者数・カバー率）の正は source_id=`metrics:共通:最新実績サマリ` の1枚。
  数値が変わったらこの1枚を store-memory で上書きする（他の資料の数値は直さない）。

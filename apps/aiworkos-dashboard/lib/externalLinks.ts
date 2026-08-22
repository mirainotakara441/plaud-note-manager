// AIワークOSの外にある道具へのリンク。
//
// 画面へURLを直書きすると、公開先が変わったときに探して回ることになる。
// 別タブで開く外部の置き場は、ここ1箇所に集める。
//
// 環境変数で上書きできるようにしてあるのは、独自ドメインへ移すときに
// Vercelの設定を変えるだけで済ませるため（デプロイし直さなくてよい）。

/**
 * 提案素材ギャラリー。提案書に使う画像・動画・図解・訴求パターンの置き場。
 *
 * 独自ドメイン（materials.<親ドメイン>）へ移したら、Vercelの環境変数
 * NEXT_PUBLIC_PROPOSAL_MATERIAL_GALLERY_URL を変える。DNSが通って
 * HTTPSで開けることを確かめてから切り替えること。
 */
export const PROPOSAL_MATERIAL_GALLERY_URL =
  process.env.NEXT_PUBLIC_PROPOSAL_MATERIAL_GALLERY_URL ??
  "https://tenki-asset-gallery.vercel.app";

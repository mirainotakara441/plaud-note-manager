// ファミリー（ライフOS側の第2ブロック）の共通部品。
// 1行＝1つのお出かけ。「いつ・誰と・どこへ・何をしたか」を残す場所で、
// ラーメンのように外部サービス（食べログ・X）へ出す前提は無い。完全に内向きの記録。
// 写真は Supabase Storage の family-photos（非公開バケット）に置き、
// DBには相対パスの配列だけを持つ。公開URLは発行せず、表示は /api/family/photo 経由。
//
// このファイルは /family ページ（クライアント）からも読むので、
// next/server などサーバー専用のものは import しない（起票の認証は lib/familyAuth.ts）。

export const FAMILY_BUCKET = "family-photos";

export type FamilyRow = {
  id: number;
  happened_on: string; // YYYY-MM-DD
  title: string;
  place: string | null;
  place_kind: string | null;
  area: string | null;
  members: string[];
  memo: string | null;
  highlight: string | null;
  stars: number | null;
  cost: number | null;
  photo_paths: string[];
  photo_count: number;
};

// 同行者の候補。順番はそのままUIのチップの並びになる。
export const FAMILY_MEMBERS = [
  "裕子",
  "裕嗣",
  "心美",
  "心陽",
  "健翔",
  "心絆",
] as const;

// 行き先の種別。DBにCHECK制約は付けていない（後から増やすたびに
// 移行が必要になるため）。ここが実質の正の一覧。
export const PLACE_KINDS = [
  "映画館",
  "公園",
  "山・自然",
  "海・川",
  "旅行",
  "食事",
  "イベント",
  "学校行事",
  "スポーツ",
  "買い物",
  "家",
  "その他",
] as const;

export const PLACE_KIND_ICON: Record<string, string> = {
  映画館: "🎬",
  公園: "🌳",
  "山・自然": "⛰️",
  "海・川": "🌊",
  旅行: "🚗",
  食事: "🍽️",
  イベント: "🎪",
  学校行事: "🏫",
  スポーツ: "⚽",
  買い物: "🛍️",
  家: "🏠",
  その他: "📌",
};

// バケット内パスの検証。写真の配信・削除はクエリ文字列で受け取ったパスを
// そのまま storage API へ渡すので、上位ディレクトリへの脱出や
// 別バケットへの横断を弾いてから使う。
const SAFE_PATH = /^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;

export function isSafePhotoPath(path: string): boolean {
  return SAFE_PATH.test(path) && !path.includes("..");
}

export const PHOTO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

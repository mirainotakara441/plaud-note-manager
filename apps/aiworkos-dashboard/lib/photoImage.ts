// 写真の向きを直してJPEGにする。
//
// iPhoneで撮った写真は、横倒しの画素＋「表示するときは90度回して」という
// EXIF の向き情報（Orientation）で入っていることが多い。手元の162枚のうち
// 114枚がこれだった（2026-09-13に判明）。
//
// ブラウザは <img> を出すときに EXIF の向きを見てくれるが、sharp は
// rotate() を呼ばない限り見ない。呼ばずに縮小すると、向き情報だけ落ちて
// 横倒しの画素がそのまま残る——これが一覧で「ラーメンが横になる」正体。
//
// ここを通せば、画素そのものを回してから返すので、後段が EXIF を見るか
// どうかに関わらず正しい向きになる（Xへの投稿もそう）。

export async function uprightJpeg(
  input: Buffer,
  opts?: { width?: number; quality?: number }
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  let img = sharp(input).rotate(); // 引数なしの rotate() が EXIF の向きを反映する
  if (opts?.width) {
    // 元より大きくはしない（拡大してもデータが増えるだけで綺麗にならない）
    img = img.resize({ width: opts.width, withoutEnlargement: true });
  }
  return img.jpeg({ quality: opts?.quality ?? 78 }).toBuffer();
}

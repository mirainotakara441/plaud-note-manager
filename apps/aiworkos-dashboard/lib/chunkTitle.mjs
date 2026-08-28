// チャンク接尾辞の規則の Node 側の入口。**実装はここには無い。**
//
// 実体は supabase/functions/_shared/chunkTitle.mjs 1本だけ。
// Edge Function（Deno）とアプリ・テスト（Node）で同じ規則を使うため、
// 二重実装にせず、こちらは再輸出だけを担う薄い層にしている。
// 規則を直すときは _shared/chunkTitle.mjs を直すこと。ここは触らない。
// （lib/memoryIdentity.mjs と同じ形）

export {
  hasChunkSuffix,
  stripChunkSuffix,
} from "../supabase/functions/_shared/chunkTitle.mjs";

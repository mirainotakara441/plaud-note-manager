// Identity 導出の Node 側の入口。**実装はここには無い。**
//
// 実体は supabase/functions/_shared/identity.mjs 1本だけ。
// Edge Function（Deno）とアプリ・テスト（Node）で同じ規則を使うため、
// 二重実装にせず、こちらは再輸出だけを担う薄い層にしている。
// 規則を直すときは _shared/identity.mjs を直すこと。ここは触らない。

export {
  deriveIdentity,
  identityColumns,
  CALLER_FORBIDDEN_KEYS,
} from "../supabase/functions/_shared/identity.mjs";

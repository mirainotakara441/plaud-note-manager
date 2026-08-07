import { redirect } from "next/navigation";

// スライド壁打ちは /refine（壁打ちの統合入口）に移った。ブックマークや既存の導線を
// 壊さないため、旧URLはリダイレクトとしてだけ残す。本体は app/components/refine/SlideRefine.tsx。
export default function SlideRefineRedirect() {
  redirect("/refine?mode=slide");
}

import { redirect } from "next/navigation";

// 提出文書壁打ちは /refine（壁打ちの統合入口）に移った。ブックマークや既存の導線を
// 壊さないため、旧URLはリダイレクトとしてだけ残す。本体は app/components/refine/ProcedureRefine.tsx。
export default function ProcedureRefineRedirect() {
  redirect("/refine?mode=procedure");
}

import { NextRequest, NextResponse } from "next/server";
import { generateSlides } from "@/lib/claude";

export async function POST(req: NextRequest) {
  try {
    const { audience, purpose, message } = await req.json();

    if (!audience || !purpose || !message) {
      return NextResponse.json(
        { error: "対象者・目的・伝えたいことは必須です" },
        { status: 400 }
      );
    }

    const slideData = await generateSlides(audience, purpose, message);
    return NextResponse.json(slideData);
  } catch (error) {
    console.error("スライド生成エラー:", error);
    return NextResponse.json(
      { error: "スライドの生成に失敗しました" },
      { status: 500 }
    );
  }
}

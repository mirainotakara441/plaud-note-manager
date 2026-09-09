import { NextRequest, NextResponse } from "next/server";
import { generatePptx } from "@/lib/generatePptx";
import type { SlideData } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    const slideData: SlideData = await req.json();

    if (!slideData || !slideData.slides) {
      return NextResponse.json(
        { error: "スライドデータが不正です" },
        { status: 400 }
      );
    }

    const buffer = await generatePptx(slideData);
    const uint8 = new Uint8Array(buffer);

    return new NextResponse(uint8, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": `attachment; filename="slides.pptx"`,
        "Content-Length": String(buffer.length),
      },
    });
  } catch (error) {
    console.error("PPTX生成エラー:", error);
    return NextResponse.json(
      { error: "PowerPointファイルの生成に失敗しました" },
      { status: 500 }
    );
  }
}

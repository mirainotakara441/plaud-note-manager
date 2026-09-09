import pptxgen from "pptxgenjs";
import type { SlideData, Slide, Figure } from "./types";

const COLORS = {
  primary: "4F46E5",
  secondary: "7C3AED",
  accent: "EC4899",
  bg: "F8F7FF",
  white: "FFFFFF",
  text: "1E1B4B",
  subtext: "6B7280",
  lightPurple: "EDE9FE",
  green: "10B981",
  orange: "F59E0B",
  blue: "3B82F6",
};

function addTitleSlide(prs: pptxgen, title: string, subtitle: string) {
  const slide = prs.addSlide();
  slide.background = { color: COLORS.primary };

  slide.addShape(prs.ShapeType.rect, {
    x: 0, y: 3.5, w: "100%", h: 0.08,
    fill: { color: COLORS.accent },
    line: { color: COLORS.accent },
  });

  slide.addText(title, {
    x: 0.5, y: 1.2, w: 9, h: 1.8,
    fontSize: 40,
    bold: true,
    color: COLORS.white,
    align: "center",
    fontFace: "Meiryo UI",
    wrap: true,
  });

  slide.addText(subtitle, {
    x: 0.5, y: 3.8, w: 9, h: 0.8,
    fontSize: 20,
    color: "C4B5FD",
    align: "center",
    fontFace: "Meiryo UI",
    wrap: true,
  });
}

function addFigure(prs: pptxgen, slide: ReturnType<typeof prs.addSlide>, figure: Figure) {
  const baseX = 5.5;
  const baseY = 1.2;
  const w = 4.2;
  const h = 4.5;

  if (figure.kind === "process_flow") {
    const steps = figure.steps.slice(0, 5);
    const boxH = 0.55;
    const gap = 0.72;
    steps.forEach((step, i) => {
      const y = baseY + i * gap;
      slide.addShape(prs.ShapeType.roundRect, {
        x: baseX, y, w, h: boxH,
        fill: { color: i % 2 === 0 ? COLORS.primary : COLORS.secondary },
        line: { color: COLORS.white, width: 0 },
        rectRadius: 0.1,
      });
      slide.addText(step, {
        x: baseX, y, w, h: boxH,
        fontSize: 11,
        color: COLORS.white,
        align: "center",
        valign: "middle",
        fontFace: "Meiryo UI",
        bold: true,
      });
      if (i < steps.length - 1) {
        slide.addText("▼", {
          x: baseX + w / 2 - 0.15, y: y + boxH, w: 0.3, h: gap - boxH,
          fontSize: 10,
          color: COLORS.accent,
          align: "center",
          valign: "middle",
        });
      }
    });
  } else if (figure.kind === "comparison") {
    const half = (w - 0.2) / 2;
    [[figure.left, 0], [figure.right, half + 0.2]] as const;
    const sides = [
      { data: figure.left, x: baseX, color: COLORS.primary },
      { data: figure.right, x: baseX + half + 0.2, color: COLORS.secondary },
    ];
    sides.forEach(({ data, x, color }) => {
      slide.addShape(prs.ShapeType.rect, {
        x, y: baseY, w: half, h: 0.45,
        fill: { color },
        line: { color, width: 0 },
      });
      slide.addText(data.label, {
        x, y: baseY, w: half, h: 0.45,
        fontSize: 12,
        bold: true,
        color: COLORS.white,
        align: "center",
        valign: "middle",
        fontFace: "Meiryo UI",
      });
      data.points.slice(0, 4).forEach((pt, i) => {
        slide.addText(`• ${pt}`, {
          x: x + 0.1, y: baseY + 0.55 + i * 0.6, w: half - 0.2, h: 0.5,
          fontSize: 11,
          color: COLORS.text,
          align: "left",
          fontFace: "Meiryo UI",
          wrap: true,
        });
      });
    });
  } else if (figure.kind === "icon_grid") {
    const items = figure.items.slice(0, 6);
    const cols = 3;
    const cellW = w / cols;
    const cellH = 0.9;
    items.forEach((item, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = baseX + col * cellW;
      const y = baseY + row * (cellH + 0.3);
      slide.addShape(prs.ShapeType.roundRect, {
        x, y, w: cellW - 0.1, h: cellH,
        fill: { color: COLORS.lightPurple },
        line: { color: COLORS.primary, width: 1 },
        rectRadius: 0.1,
      });
      slide.addText(item.emoji, {
        x, y: y + 0.05, w: cellW - 0.1, h: 0.45,
        fontSize: 22,
        align: "center",
      });
      slide.addText(item.label, {
        x, y: y + 0.5, w: cellW - 0.1, h: 0.35,
        fontSize: 10,
        color: COLORS.text,
        align: "center",
        fontFace: "Meiryo UI",
        bold: true,
      });
    });
  } else if (figure.kind === "bar_chart") {
    const bars = figure.bars.slice(0, 5);
    const maxVal = Math.max(...bars.map((b) => b.value), 1);
    const barW = (w - 0.4) / bars.length - 0.15;
    const chartH = 3.0;
    const barColors = [COLORS.primary, COLORS.secondary, COLORS.accent, COLORS.green, COLORS.orange];
    bars.forEach((bar, i) => {
      const barH = (bar.value / maxVal) * chartH;
      const x = baseX + 0.2 + i * (barW + 0.15);
      const y = baseY + chartH - barH + 0.5;
      slide.addShape(prs.ShapeType.rect, {
        x, y, w: barW, h: barH,
        fill: { color: barColors[i % barColors.length] },
        line: { color: barColors[i % barColors.length], width: 0 },
      });
      slide.addText(String(bar.value), {
        x, y: y - 0.3, w: barW, h: 0.3,
        fontSize: 11,
        bold: true,
        color: COLORS.text,
        align: "center",
        fontFace: "Meiryo UI",
      });
      slide.addText(bar.label, {
        x: x - 0.05, y: baseY + chartH + 0.55, w: barW + 0.1, h: 0.5,
        fontSize: 10,
        color: COLORS.text,
        align: "center",
        fontFace: "Meiryo UI",
        wrap: true,
      });
    });
    slide.addShape(prs.ShapeType.line, {
      x: baseX + 0.1, y: baseY + chartH + 0.5, w: w - 0.2, h: 0,
      line: { color: COLORS.subtext, width: 1 },
    });
  }
}

function addContentSlide(prs: pptxgen, slideData: import("./types").ContentSlide) {
  const slide = prs.addSlide();
  slide.background = { color: COLORS.bg };

  slide.addShape(prs.ShapeType.rect, {
    x: 0, y: 0, w: "100%", h: 0.9,
    fill: { color: COLORS.primary },
    line: { color: COLORS.primary, width: 0 },
  });

  slide.addText(slideData.title, {
    x: 0.3, y: 0.05, w: 9.4, h: 0.8,
    fontSize: 24,
    bold: true,
    color: COLORS.white,
    valign: "middle",
    fontFace: "Meiryo UI",
    wrap: true,
  });

  const hasFigure = !!slideData.figure;
  const textW = hasFigure ? 4.8 : 9.4;

  slideData.bullets.slice(0, 4).forEach((bullet, i) => {
    slide.addShape(prs.ShapeType.roundRect, {
      x: 0.3, y: 1.1 + i * 0.9, w: textW, h: 0.75,
      fill: { color: COLORS.white },
      line: { color: COLORS.primary, width: 1.5 },
      rectRadius: 0.08,
      shadow: { type: "outer", color: "CCCCCC", blur: 3, offset: 2, angle: 45 },
    });
    slide.addText(`${["①", "②", "③", "④"][i]}  ${bullet}`, {
      x: 0.5, y: 1.1 + i * 0.9, w: textW - 0.4, h: 0.75,
      fontSize: 14,
      color: COLORS.text,
      valign: "middle",
      fontFace: "Meiryo UI",
      wrap: true,
    });
  });

  if (hasFigure) {
    addFigure(prs, slide, slideData.figure!);
  }

  if (slideData.speakerNote) {
    slide.addNotes(slideData.speakerNote);
  }
}

function addClosingSlide(prs: pptxgen, title: string, summary: string[]) {
  const slide = prs.addSlide();
  slide.background = { color: COLORS.secondary };

  slide.addText(title, {
    x: 0.5, y: 0.4, w: 9, h: 0.9,
    fontSize: 32,
    bold: true,
    color: COLORS.white,
    align: "center",
    fontFace: "Meiryo UI",
  });

  slide.addShape(prs.ShapeType.rect, {
    x: 3.5, y: 1.3, w: 3, h: 0.06,
    fill: { color: COLORS.accent },
    line: { color: COLORS.accent, width: 0 },
  });

  summary.slice(0, 5).forEach((point, i) => {
    slide.addText(`✓  ${point}`, {
      x: 1, y: 1.7 + i * 0.75, w: 8, h: 0.65,
      fontSize: 16,
      color: COLORS.white,
      fontFace: "Meiryo UI",
      wrap: true,
    });
  });

  slide.addText("ご清聴ありがとうございました！", {
    x: 0.5, y: 5.8, w: 9, h: 0.5,
    fontSize: 14,
    color: "C4B5FD",
    align: "center",
    fontFace: "Meiryo UI",
    italic: true,
  });
}

export async function generatePptx(data: SlideData): Promise<Buffer> {
  const prs = new pptxgen();
  prs.layout = "LAYOUT_WIDE";
  prs.author = "SlideCreator AI";
  prs.title = data.meta.title;

  for (const slideData of data.slides) {
    if (slideData.type === "title") {
      addTitleSlide(prs, slideData.title, slideData.subtitle);
    } else if (slideData.type === "content") {
      addContentSlide(prs, slideData);
    } else if (slideData.type === "closing") {
      addClosingSlide(prs, slideData.title, slideData.summary);
    }
  }

  const buffer = await prs.write({ outputType: "nodebuffer" }) as Buffer;
  return buffer;
}

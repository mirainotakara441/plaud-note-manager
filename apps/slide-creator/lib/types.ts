export interface SlideData {
  meta: {
    title: string;
    audience: string;
    purpose: string;
  };
  slides: Slide[];
}

export type Slide = TitleSlide | ContentSlide | ClosingSlide;

export interface TitleSlide {
  type: "title";
  title: string;
  subtitle: string;
}

export interface ContentSlide {
  type: "content";
  title: string;
  bullets: string[];
  figure?: Figure;
  speakerNote?: string;
}

export interface ClosingSlide {
  type: "closing";
  title: string;
  summary: string[];
}

export type Figure =
  | { kind: "process_flow"; steps: string[] }
  | { kind: "comparison"; left: { label: string; points: string[] }; right: { label: string; points: string[] } }
  | { kind: "icon_grid"; items: { emoji: string; label: string }[] }
  | { kind: "bar_chart"; bars: { label: string; value: number }[] };

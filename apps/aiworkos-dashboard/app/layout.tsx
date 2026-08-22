import type { Metadata, Viewport } from "next";
import BottomNav from "@/app/components/BottomNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "AIワークOS",
  description:
    "記録を記憶に、記憶を提案に。日々の記録を自然言語で横断検索し、次の一手につなげるワークOS。",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "AIワークOS",
    statusBarStyle: "default",
  },
  icons: {
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#4f46e5",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full">
        {/* 下部タブバー（BottomNav）の高さぶんだけ底に余白を確保する。
            これが無いとページ最下部のボタンや文がタブバーの裏に隠れて押せない。 */}
        <div className="pb-[calc(3.5rem+env(safe-area-inset-bottom))]">{children}</div>
        <BottomNav />
      </body>
    </html>
  );
}

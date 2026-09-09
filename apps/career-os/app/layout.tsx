import type { Metadata, Viewport } from "next";
import "./globals.css";

// robots: noindex/nofollow は必須。転職活動の内容が検索に載ると実害があるため、
// 合言葉認証（proxy.ts）と二重で塞ぐ。
export const metadata: Metadata = {
  title: "キャリアOS",
  description: "転職メールを案件データベースに変え、自分の判断軸で採点するキャリアOS。",
  robots: { index: false, follow: false, nocache: true },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "キャリアOS",
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
  themeColor: "#0f766e",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}

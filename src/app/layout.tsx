import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

// خط عربي واضح للواجهة الكاملة (RTL)
const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
});

export const metadata: Metadata = {
  title: "مولّد الوسائط — خادم MCP",
  description:
    "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع، مع لوحة إدارة عربية ومفاتيح API متسلسلة بتبديل تلقائي.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" className="dark" suppressHydrationWarning>
      <body className={`${cairo.variable} antialiased min-h-screen bg-[#070b16] text-foreground font-[family-name:var(--font-cairo)]`}>
        {children}
        <Toaster richColors position="bottom-left" />
      </body>
    </html>
  );
}

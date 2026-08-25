import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? 'http://localhost:3000'),
  title: 'CatGPT — 多模型 AI 工作空間',
  description: '支援平台模型、自備 API Key、用量控管與安全帳號驗證的多模型 AI 工作空間。',
  openGraph: {
    title: 'CatGPT — 多模型 AI 工作空間',
    description: '登入後使用平台模型，或加入自己的 API Key 解鎖更多模型。',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'CatGPT 多模型 AI 工作空間' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CatGPT — 多模型 AI 工作空間',
    description: '登入後使用平台模型，或加入自己的 API Key 解鎖更多模型。',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

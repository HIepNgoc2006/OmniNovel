import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import { Header } from '../components/layout/header';
import { Footer } from '../components/layout/footer';
import { MobileNav } from '../components/layout/mobile-nav';

export const metadata: Metadata = {
  title: {
    default: 'OmniNovel - Nền Tảng Đọc Manga & Light Novel Đa Phương Thức',
    template: '%s | OmniNovel',
  },
  description:
    'Đọc Manga 120Hz mượt mà và Light Novel tùy biến phong cách Sepia/Dark với hệ thống Studio AI Translation hiện đại.',
  keywords: ['Manga', 'Light Novel', 'Đọc truyện online', 'AI Translation', 'OmniNovel', 'TruyenQQ', 'DocLN'],
  authors: [{ name: 'OmniNovel Team' }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi" data-theme="dark" suppressHydrationWarning>
      <body className="antialiased flex flex-col min-h-screen">
        <Providers>
          <Header />
          <main className="flex-1 pb-16 md:pb-0">{children}</main>
          <Footer />
          <MobileNav />
        </Providers>
      </body>
    </html>
  );
}

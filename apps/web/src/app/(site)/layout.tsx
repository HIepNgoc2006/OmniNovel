import { Header } from '../../components/layout/header';
import { Footer } from '../../components/layout/footer';
import { MobileNav } from '../../components/layout/mobile-nav';

export default function SiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col min-h-screen">
      <Header />
      <main className="flex-1 pb-16 md:pb-0">{children}</main>
      <Footer />
      <MobileNav />
    </div>
  );
}

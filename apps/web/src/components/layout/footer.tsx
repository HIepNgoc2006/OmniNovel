import React from 'react';
import Link from 'next/link';
import { BookOpen, Heart, Shield } from 'lucide-react';

export function Footer() {
  return (
    <footer className="w-full bg-slate-950 border-t border-slate-900 text-slate-400 text-xs py-10 mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 md:grid-cols-4 gap-8">
        {/* Col 1: Brand & Bio */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-red-600 flex items-center justify-center text-white font-bold">
              <BookOpen className="w-4 h-4" />
            </div>
            <span className="text-base font-extrabold text-white">
              OMNI<span className="text-red-500">NOVEL</span>
            </span>
          </div>
          <p className="text-slate-400 text-xs leading-relaxed">
            Nền tảng đọc truyện Manga & Light Novel đa phương thức kết hợp công nghệ dịch thuật AI Studio tiên tiến nhất.
          </p>
        </div>

        {/* Col 2: Navigation */}
        <div className="space-y-2">
          <h4 className="font-bold text-white uppercase text-[11px] tracking-wider">Khám Phá</h4>
          <ul className="space-y-1.5">
            <li>
              <Link href="/search?format=COMIC" className="hover:text-white transition-colors">
                Manga / Webtoon
              </Link>
            </li>
            <li>
              <Link href="/search?format=NOVEL" className="hover:text-white transition-colors">
                Light Novel / Web Novel
              </Link>
            </li>
            <li>
              <Link href="/search?sort=popular" className="hover:text-white transition-colors">
                Bảng Xếp Hạng
              </Link>
            </li>
          </ul>
        </div>

        {/* Col 3: Legal & Disclaimer */}
        <div className="space-y-2">
          <h4 className="font-bold text-white uppercase text-[11px] tracking-wider">Chính Sách & Bản Quyền</h4>
          <p className="text-slate-500 text-[11px] leading-normal">
            Mọi thông tin và hình ảnh trên website đều được sưu tầm và dịch thuật phục vụ mục đích nghiên cứu học thuật đồ án.
          </p>
          <div className="flex items-center gap-1.5 text-slate-500 text-[11px]">
            <Shield className="w-3.5 h-3.5 text-emerald-500" />
            <span>Anti-Leech Bot & Rate-Limiting Protected</span>
          </div>
        </div>

        {/* Col 4: Credits */}
        <div className="space-y-2">
          <h4 className="font-bold text-white uppercase text-[11px] tracking-wider">Đồ Án Tốt Nghiệp</h4>
          <p className="text-slate-500 text-[11px]">
            Dự án OmniNovel phục vụ tích hợp 5 học phần Công nghệ Thông tin.
          </p>
          <p className="text-slate-600 text-[10px] flex items-center gap-1 mt-4">
            <span>Built with</span>
            <Heart className="w-3 h-3 text-red-500 fill-current" />
            <span>Next.js 16, React 19 & Tailwind 4</span>
          </p>
        </div>
      </div>
    </footer>
  );
}

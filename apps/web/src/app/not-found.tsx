import React from 'react';
import Link from 'next/link';
import { Button } from '../components/ui/button';
import { BookX, Home } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center">
      <div className="w-16 h-16 bg-slate-800 text-slate-400 rounded-2xl flex items-center justify-center mb-6">
        <BookX className="w-8 h-8" />
      </div>
      <h1 className="text-4xl font-black text-white mb-2">404 - Không Tìm Thấy Trang</h1>
      <p className="text-slate-400 text-sm max-w-md mb-6">
        Bộ truyện hoặc trang bạn đang tìm kiếm không tồn tại hoặc đã được di chuyển sang địa chỉ khác.
      </p>
      <Link href="/">
        <Button variant="primary" className="gap-2">
          <Home className="w-4 h-4" />
          <span>Về Trang Chủ</span>
        </Button>
      </Link>
    </div>
  );
}

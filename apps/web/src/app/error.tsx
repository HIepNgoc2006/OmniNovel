'use client';

import React, { useEffect } from 'react';
import { Button } from '../components/ui/button';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Application runtime error:', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center">
      <div className="w-16 h-16 bg-rose-500/10 text-rose-500 rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-rose-500/20">
        <AlertTriangle className="w-8 h-8" />
      </div>
      <h2 className="text-2xl font-black text-white mb-2">Đã xảy ra sự cố không mong muốn</h2>
      <p className="text-slate-400 text-sm max-w-md mb-6">
        Hệ thống đã ghi nhận lỗi này. Vui lòng tải lại hoặc quay lại trang trước đó.
      </p>
      <Button variant="primary" onClick={() => reset()} className="gap-2">
        <RotateCcw className="w-4 h-4" />
        <span>Thử Lại Ngay</span>
      </Button>
    </div>
  );
}

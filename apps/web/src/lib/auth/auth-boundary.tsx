'use client';

import React from 'react';
import { useAuth } from './auth-context';
import { ShieldAlert } from 'lucide-react';

export function AuthBoundary({
  children,
  fallbackMessage = 'Vui lòng đăng nhập để truy cập tính năng này.',
}: {
  children: React.ReactNode;
  fallbackMessage?: string;
}) {
  const { status, isAuthenticated } = useAuth();

  if (status === 'initializing') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] p-8">
        <div className="w-10 h-10 border-4 border-red-500/30 border-t-red-500 rounded-full animate-spin mb-4" />
        <p className="text-slate-400 text-sm animate-pulse">Đang kiểm tra phiên đăng nhập...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="max-w-md mx-auto my-16 p-8 bg-slate-900 border border-slate-800 rounded-2xl shadow-xl text-center">
        <div className="w-12 h-12 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4">
          <ShieldAlert className="w-6 h-6" />
        </div>
        <h2 className="text-xl font-bold text-white mb-2">Yêu Cầu Xác Thực</h2>
        <p className="text-slate-400 text-sm mb-6">{fallbackMessage}</p>
        <p className="text-xs text-slate-500">
          Hãy bấm vào nút Đăng nhập ở thanh điều hướng phía trên để tiếp tục.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

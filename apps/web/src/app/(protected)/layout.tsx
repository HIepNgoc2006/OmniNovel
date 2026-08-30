'use client';

import React from 'react';
import { AuthBoundary } from '../../lib/auth/auth-boundary';

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthBoundary fallbackMessage="Vui lòng đăng nhập để xem thông tin cá nhân và tủ truyện của bạn.">
      {children}
    </AuthBoundary>
  );
}

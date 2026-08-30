'use client';

import React from 'react';
import { AuthBoundary } from '../../lib/auth/auth-boundary';

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthBoundary fallbackMessage="Khu vực AI Translation Studio chỉ dành cho Biên dịch viên và Quản trị viên đã đăng nhập.">
      {children}
    </AuthBoundary>
  );
}

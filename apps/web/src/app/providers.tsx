'use client';

import React from 'react';
import { ThemeProvider } from '../lib/theme/theme-provider';
import { QueryProvider } from '../lib/query/query-provider';
import { AuthProvider } from '../lib/auth/auth-context';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <QueryProvider>
        <AuthProvider>{children}</AuthProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}

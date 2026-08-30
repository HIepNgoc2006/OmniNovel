'use client';

import React from 'react';
import { useTheme } from './theme-provider';
import { Sun, Moon, Monitor } from 'lucide-react';

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { siteTheme, setSiteTheme } = useTheme();

  const toggleNext = () => {
    if (siteTheme === 'dark') {
      setSiteTheme('light');
    } else if (siteTheme === 'light') {
      setSiteTheme('system');
    } else {
      setSiteTheme('dark');
    }
  };

  return (
    <button
      type="button"
      onClick={toggleNext}
      className={`relative inline-flex items-center justify-center p-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 cursor-pointer ${className}`}
      aria-label={`Chuyển chủ đề (Hiện tại: ${siteTheme})`}
      title={`Chuyển chủ đề (${siteTheme})`}
    >
      {siteTheme === 'dark' && <Moon className="w-5 h-5 text-indigo-400" />}
      {siteTheme === 'light' && <Sun className="w-5 h-5 text-amber-400" />}
      {siteTheme === 'system' && <Monitor className="w-5 h-5 text-slate-400" />}
    </button>
  );
}

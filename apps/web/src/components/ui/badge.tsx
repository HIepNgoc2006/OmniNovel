'use client';

import React from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'primary' | 'secondary' | 'success' | 'warning' | 'info' | 'outline' | 'rank';
}

export function Badge({ className, variant = 'primary', children, ...props }: BadgeProps) {
  const baseStyles = 'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold';

  const variants = {
    primary: 'bg-red-500/15 text-red-400 border border-red-500/30',
    secondary: 'bg-slate-800 text-slate-300 border border-slate-700',
    success: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
    warning: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
    info: 'bg-sky-500/15 text-sky-400 border border-sky-500/30',
    outline: 'bg-transparent text-slate-300 border border-slate-600',
    rank: 'bg-gradient-to-r from-amber-500/20 to-orange-500/20 text-amber-300 border border-amber-500/40 shadow-sm',
  };

  return (
    <span className={twMerge(clsx(baseStyles, variants[variant], className))} {...props}>
      {children}
    </span>
  );
}

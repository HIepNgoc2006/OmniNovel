'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Compass, BookOpen, Sliders, User, Bookmark } from 'lucide-react';
import { useAuth } from '../../lib/auth/auth-context';
import { GlobalRole } from '@omninovel/shared';

export function MobileNav() {
  const pathname = usePathname();
  const { user, isAuthenticated } = useAuth();

  const isTranslatorOrAdmin =
    isAuthenticated &&
    user &&
    (user.role === GlobalRole.TRANSLATOR || user.role === GlobalRole.ADMIN);

  const navItems = [
    { href: '/', label: 'Trang Chủ', icon: Home },
    { href: '/library', label: 'Thư Viện', icon: Bookmark },
    { href: '/search?format=COMIC', label: 'Manga', icon: Compass },
    { href: '/search?format=NOVEL', label: 'Novel', icon: BookOpen },
    ...(isTranslatorOrAdmin
      ? [{ href: '/studio', label: 'Studio', icon: Sliders }]
      : []),
    { href: isAuthenticated ? '/profile' : '/', label: 'Cá Nhân', icon: User },
  ];

  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-slate-950/95 backdrop-blur-md border-t border-slate-800 px-4 py-2 flex items-center justify-around">
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive = pathname === item.href;

        return (
          <Link
            key={item.label}
            href={item.href}
            className={`flex flex-col items-center gap-1 py-1 px-3 rounded-xl text-[10px] font-semibold transition-colors ${
              isActive ? 'text-red-500 font-bold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Icon className="w-5 h-5" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </div>
  );
}

'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '../../lib/auth/auth-context';
import { useProgression, useCheckinMutation } from '../../lib/query/hooks';
import { ThemeToggle } from '../../lib/theme/theme-toggle';
import { AuthModal } from '../auth/auth-modal';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  BookOpen,
  Search,
  Coins,
  Sparkles,
  User,
  LogOut,
  Sliders,
  CalendarCheck,
  ShieldCheck,
} from 'lucide-react';
import { GlobalRole } from '@omninovel/shared';

export function Header() {
  const { user, isAuthenticated, isLoading, logout } = useAuth();
  const { data: progression } = useProgression();
  const checkinMutation = useCheckinMutation();
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authModalTab, setAuthModalTab] = useState<'login' | 'register'>('login');
  const [searchQuery, setSearchQuery] = useState('');
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);

  const openLogin = () => {
    setAuthModalTab('login');
    setIsAuthModalOpen(true);
  };

  const openRegister = () => {
    setAuthModalTab('register');
    setIsAuthModalOpen(true);
  };

  const handleCheckin = () => {
    checkinMutation.mutate();
  };

  return (
    <>
      <header className="sticky top-0 z-40 w-full backdrop-blur-md bg-slate-950/85 border-b border-slate-800 transition-colors">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          {/* Logo & Brand */}
          <div className="flex items-center gap-6 shrink-0">
            <Link href="/" className="flex items-center gap-2.5 group">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-red-600 to-rose-500 flex items-center justify-center text-white shadow-lg shadow-red-600/30 group-hover:scale-105 transition-transform">
                <BookOpen className="w-5 h-5" />
              </div>
              <div className="flex flex-col">
                <span className="text-lg font-black tracking-tight text-white flex items-center gap-1.5">
                  OMNI<span className="text-red-500">NOVEL</span>
                </span>
                <span className="text-[10px] uppercase font-bold tracking-widest text-slate-400 -mt-1">
                  Manga & Light Novel
                </span>
              </div>
            </Link>

            {/* Navigation Links */}
            <nav className="hidden md:flex items-center gap-4 text-sm font-semibold text-slate-300">
              <Link href="/" className="hover:text-white transition-colors">
                Trang Chủ
              </Link>
              <Link href="/search?format=COMIC" className="hover:text-white transition-colors">
                Manga / Comic
              </Link>
              <Link href="/search?format=NOVEL" className="hover:text-white transition-colors">
                Light Novel
              </Link>
              {isAuthenticated &&
                (user?.role === GlobalRole.TRANSLATOR ||
                  user?.role === GlobalRole.ADMIN) && (
                  <Link
                    href="/studio"
                    className="text-red-400 hover:text-red-300 flex items-center gap-1 transition-colors"
                  >
                    <Sliders className="w-4 h-4" />
                    <span>AI Studio</span>
                  </Link>
                )}
            </nav>
          </div>

          {/* Mega Search Bar */}
          <div className="flex-1 max-w-md hidden sm:block">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Tìm kiếm Manga, Light Novel, Tác giả..."
                className="w-full bg-slate-900/90 border border-slate-800 focus:border-red-500 rounded-full pl-10 pr-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500 transition-all shadow-inner"
              />
            </div>
          </div>

          {/* Right Action Widgets */}
          <div className="flex items-center gap-3 shrink-0">
            {/* Theme Toggle */}
            <ThemeToggle />

            {/* Gamification & User State */}
            {isLoading ? (
              <div className="w-24 h-8 bg-slate-800/80 rounded-xl animate-pulse" />
            ) : isAuthenticated && user ? (
              <div className="flex items-center gap-3">
                {/* Gamification Summary Widget */}
                {progression && (
                  <div className="hidden lg:flex items-center gap-2.5 bg-slate-900/90 border border-slate-800 rounded-full px-3 py-1 text-xs">
                    {/* Level & Rank Badge */}
                    <Badge variant="rank" className="font-bold text-[11px] py-0 px-2">
                      Lv.{progression.level} {progression.rankTitle}
                    </Badge>

                    {/* EXP Progress Mini Bar */}
                    <div className="w-16 h-2 bg-slate-800 rounded-full overflow-hidden" title={`EXP: ${progression.currentLevelExp}/${progression.nextLevelExp}`}>
                      <div
                        className="h-full bg-gradient-to-r from-red-500 to-amber-500"
                        style={{
                          width: `${Math.min(100, Math.round((progression.currentLevelExp / progression.nextLevelExp) * 100))}%`,
                        }}
                      />
                    </div>

                    {/* Coins */}
                    <div className="flex items-center gap-1 text-amber-400 font-bold ml-1">
                      <Coins className="w-3.5 h-3.5" />
                      <span>{progression.omnicoinBalance}</span>
                    </div>

                    {/* Daily Check-in Button */}
                    <button
                      type="button"
                      onClick={handleCheckin}
                      disabled={checkinMutation.isPending}
                      className="p-1 text-slate-400 hover:text-amber-300 hover:bg-slate-800 rounded-full transition-colors cursor-pointer"
                      title="Điểm danh nhận EXP & OmniCoin"
                    >
                      <CalendarCheck className="w-4 h-4 text-emerald-400" />
                    </button>
                  </div>
                )}

                {/* User Dropdown */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
                    className="flex items-center gap-2 p-1 pl-2 pr-3 bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-full transition-colors cursor-pointer"
                  >
                    <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-red-500 to-rose-600 flex items-center justify-center text-white text-xs font-bold shadow">
                      {user.avatarUrl ? (
                        <img
                          src={user.avatarUrl}
                          alt={user.username || 'User'}
                          className="w-full h-full rounded-full object-cover"
                        />
                      ) : (
                        (user.username?.charAt(0) || 'U').toUpperCase()
                      )}
                    </div>
                    <span className="text-xs font-semibold text-slate-200 hidden sm:inline max-w-[100px] truncate">
                      {user.username || 'User'}
                    </span>
                  </button>

                  {/* Dropdown Menu */}
                  {isUserMenuOpen && (
                    <div
                      className="absolute right-0 mt-2 w-52 bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl py-2 z-50 animate-in fade-in zoom-in-95"
                      onClick={() => setIsUserMenuOpen(false)}
                    >
                      <div className="px-4 py-2 border-b border-slate-800">
                        <p className="text-xs font-bold text-white truncate">{user.username}</p>
                        <p className="text-[11px] text-slate-400 truncate">{user.email}</p>
                        <div className="mt-1">
                          <Badge variant={user.role === GlobalRole.ADMIN ? 'warning' : 'primary'}>
                            {user.role}
                          </Badge>
                        </div>
                      </div>

                      <Link
                        href="/profile"
                        className="flex items-center gap-2 px-4 py-2 text-xs text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
                      >
                        <User className="w-4 h-4" />
                        <span>Hồ Sơ & Cấp Độ</span>
                      </Link>

                      {(user.role === GlobalRole.TRANSLATOR || user.role === GlobalRole.ADMIN) && (
                        <Link
                          href="/studio"
                          className="flex items-center gap-2 px-4 py-2 text-xs text-red-400 hover:text-red-300 hover:bg-slate-800 transition-colors"
                        >
                          <Sliders className="w-4 h-4" />
                          <span>AI Translation Studio</span>
                        </Link>
                      )}

                      <button
                        type="button"
                        onClick={logout}
                        className="w-full flex items-center gap-2 px-4 py-2 text-xs text-rose-400 hover:text-rose-300 hover:bg-slate-800 transition-colors cursor-pointer text-left border-t border-slate-800 mt-1"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>Đăng Xuất</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={openLogin}>
                  Đăng Nhập
                </Button>
                <Button variant="primary" size="sm" onClick={openRegister}>
                  Đăng Ký
                </Button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Auth Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        defaultTab={authModalTab}
      />
    </>
  );
}

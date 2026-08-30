'use client';

import React, { createContext, useContext, useEffect, useState, useTransition } from 'react';

export type SiteTheme = 'dark' | 'light' | 'system';
export type ReaderTheme = 'dark' | 'light' | 'sepia';

interface ThemeContextType {
  siteTheme: SiteTheme;
  resolvedSiteTheme: 'dark' | 'light';
  readerTheme: ReaderTheme;
  setSiteTheme: (theme: SiteTheme) => void;
  setReaderTheme: (theme: ReaderTheme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const SITE_THEME_KEY = 'omninovel_site_theme';
const READER_THEME_KEY = 'omninovel_reader_theme';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [siteTheme, setSiteThemeState] = useState<SiteTheme>('dark');
  const [readerTheme, setReaderThemeState] = useState<ReaderTheme>('sepia');
  const [mounted, setMounted] = useState(false);
  const [, startTransition] = useTransition();

  // Determine system preference
  const getSystemTheme = (): 'dark' | 'light' => {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  };

  const resolvedSiteTheme = siteTheme === 'system' ? getSystemTheme() : siteTheme;

  useEffect(() => {
    try {
      const storedSiteTheme = localStorage.getItem(SITE_THEME_KEY) as SiteTheme | null;
      const storedReaderTheme = localStorage.getItem(READER_THEME_KEY) as ReaderTheme | null;

      if (storedSiteTheme && ['dark', 'light', 'system'].includes(storedSiteTheme)) {
        setSiteThemeState(storedSiteTheme);
      }
      if (storedReaderTheme && ['dark', 'light', 'sepia'].includes(storedReaderTheme)) {
        setReaderThemeState(storedReaderTheme);
      }
    } catch {
      // Ignore localStorage errors in private browsing
    }
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const actualTheme = siteTheme === 'system' ? getSystemTheme() : siteTheme;
    document.documentElement.setAttribute('data-theme', actualTheme);

    if (typeof window !== 'undefined' && window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
      const handleSystemChange = () => {
        if (siteTheme === 'system') {
          const sysTheme = mediaQuery?.matches ? 'light' : 'dark';
          document.documentElement.setAttribute('data-theme', sysTheme);
        }
      };

      if (mediaQuery?.addEventListener) {
        mediaQuery.addEventListener('change', handleSystemChange);
        return () => mediaQuery.removeEventListener('change', handleSystemChange);
      } else if (mediaQuery?.addListener) {
        mediaQuery.addListener(handleSystemChange);
        return () => mediaQuery.removeListener(handleSystemChange);
      }
    }
  }, [siteTheme, mounted]);

  const setSiteTheme = (theme: SiteTheme) => {
    startTransition(() => {
      setSiteThemeState(theme);
    });
    try {
      localStorage.setItem(SITE_THEME_KEY, theme);
    } catch {
      // ignore
    }
  };

  const setReaderTheme = (theme: ReaderTheme) => {
    startTransition(() => {
      setReaderThemeState(theme);
    });
    try {
      localStorage.setItem(READER_THEME_KEY, theme);
    } catch {
      // ignore
    }
  };

  return (
    <ThemeContext.Provider
      value={{
        siteTheme,
        resolvedSiteTheme,
        readerTheme,
        setSiteTheme,
        setReaderTheme,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

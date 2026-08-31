'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  ReaderSettings,
  MangaReaderSettings,
  NovelReaderSettings,
  DEFAULT_READER_SETTINGS,
} from './types';

const STORAGE_KEY = 'omninovel_reader_settings';

export function useReaderSettings() {
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_READER_SETTINGS);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setSettings({
          manga: { ...DEFAULT_READER_SETTINGS.manga, ...parsed.manga },
          novel: { ...DEFAULT_READER_SETTINGS.novel, ...parsed.novel },
        });
      }
    } catch {
      // Fallback to default
    } finally {
      setIsHydrated(true);
    }
  }, []);

  const updateMangaSettings = useCallback((updates: Partial<MangaReaderSettings>) => {
    setSettings((prev) => {
      const next = {
        ...prev,
        manga: { ...prev.manga, ...updates },
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const updateNovelSettings = useCallback((updates: Partial<NovelReaderSettings>) => {
    setSettings((prev) => {
      const next = {
        ...prev,
        novel: { ...prev.novel, ...updates },
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_READER_SETTINGS);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_READER_SETTINGS));
    } catch {}
  }, []);

  return {
    settings,
    isHydrated,
    updateMangaSettings,
    updateNovelSettings,
    resetSettings,
  };
}

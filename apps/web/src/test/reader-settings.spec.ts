import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReaderSettings } from '../lib/reader/use-reader-settings';
import { DEFAULT_READER_SETTINGS } from '../lib/reader/types';

describe('Reader Settings & Persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should initialize with default settings', () => {
    const { result } = renderHook(() => useReaderSettings());

    expect(result.current.settings.manga.mode).toBe('webtoon');
    expect(result.current.settings.manga.direction).toBe('rtl');
    expect(result.current.settings.novel.theme).toBe('sepia');
    expect(result.current.settings.novel.fontFamily).toBe('serif');
    expect(result.current.settings.novel.fontSize).toBe(18);
  });

  it('should update and persist manga settings', () => {
    const { result } = renderHook(() => useReaderSettings());

    act(() => {
      result.current.updateMangaSettings({ mode: 'paged', direction: 'ltr' });
    });

    expect(result.current.settings.manga.mode).toBe('paged');
    expect(result.current.settings.manga.direction).toBe('ltr');

    const stored = JSON.parse(localStorage.getItem('omninovel_reader_settings') || '{}');
    expect(stored.manga.mode).toBe('paged');
    expect(stored.manga.direction).toBe('ltr');
  });

  it('should update and persist novel typography settings', () => {
    const { result } = renderHook(() => useReaderSettings());

    act(() => {
      result.current.updateNovelSettings({
        theme: 'dark',
        fontSize: 22,
        fontFamily: 'sans',
        textAlign: 'left',
      });
    });

    expect(result.current.settings.novel.theme).toBe('dark');
    expect(result.current.settings.novel.fontSize).toBe(22);
    expect(result.current.settings.novel.fontFamily).toBe('sans');
    expect(result.current.settings.novel.textAlign).toBe('left');

    const stored = JSON.parse(localStorage.getItem('omninovel_reader_settings') || '{}');
    expect(stored.novel.theme).toBe('dark');
    expect(stored.novel.fontSize).toBe(22);
  });

  it('should reset settings to default', () => {
    const { result } = renderHook(() => useReaderSettings());

    act(() => {
      result.current.updateNovelSettings({ theme: 'light', fontSize: 26 });
    });
    expect(result.current.settings.novel.theme).toBe('light');

    act(() => {
      result.current.resetSettings();
    });

    expect(result.current.settings.novel.theme).toBe(DEFAULT_READER_SETTINGS.novel.theme);
    expect(result.current.settings.novel.fontSize).toBe(DEFAULT_READER_SETTINGS.novel.fontSize);
  });
});

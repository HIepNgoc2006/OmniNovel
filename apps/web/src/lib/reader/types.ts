export type ReaderTheme = 'dark' | 'light' | 'sepia';
export type MangaReadingMode = 'webtoon' | 'paged';
export type PagedDirection = 'rtl' | 'ltr';
export type PagedLayout = 'single' | 'double';
export type NovelFontFamily = 'serif' | 'sans';
export type NovelTextAlign = 'left' | 'justify';
export type NovelContainerWidth = 'narrow' | 'standard' | 'wide';

export interface MangaReaderSettings {
  mode: MangaReadingMode;
  direction: PagedDirection;
  layout: PagedLayout;
  fitWidth: boolean;
  preloadCount: number;
}

export interface NovelReaderSettings {
  theme: ReaderTheme;
  fontFamily: NovelFontFamily;
  fontSize: number; // 14 - 28px
  lineHeight: number; // 1.4 - 2.4
  paragraphSpacing: number; // 8 - 24px
  textAlign: NovelTextAlign;
  containerWidth: NovelContainerWidth;
}

export interface ReaderSettings {
  manga: MangaReaderSettings;
  novel: NovelReaderSettings;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  manga: {
    mode: 'webtoon',
    direction: 'rtl',
    layout: 'single',
    fitWidth: true,
    preloadCount: 3,
  },
  novel: {
    theme: 'sepia',
    fontFamily: 'serif',
    fontSize: 18,
    lineHeight: 1.8,
    paragraphSpacing: 16,
    textAlign: 'justify',
    containerWidth: 'standard',
  },
};

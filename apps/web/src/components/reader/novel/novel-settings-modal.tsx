'use client';

import { X, AlignLeft, AlignJustify } from 'lucide-react';
import {
  NovelReaderSettings,
  ReaderTheme,
  NovelFontFamily,
  NovelTextAlign,
  NovelContainerWidth,
} from '../../../lib/reader/types';

interface NovelSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: NovelReaderSettings;
  onUpdateSettings: (updates: Partial<NovelReaderSettings>) => void;
}

export function NovelSettingsModal({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
}: NovelSettingsModalProps) {
  if (!isOpen) return null;

  const themes: { id: ReaderTheme; label: string; bgClass: string; textClass: string; borderClass: string }[] = [
    {
      id: 'sepia',
      label: 'Sepia (Ấm áp)',
      bgClass: 'bg-[#f7efe1]',
      textClass: 'text-[#2d2319]',
      borderClass: 'border-[#d4c3a7]',
    },
    {
      id: 'dark',
      label: 'Dark (Tối)',
      bgClass: 'bg-[#0f172a]',
      textClass: 'text-[#f8fafc]',
      borderClass: 'border-slate-700',
    },
    {
      id: 'light',
      label: 'Light (Sáng)',
      bgClass: 'bg-white',
      textClass: 'text-slate-900',
      borderClass: 'border-slate-300',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-xs transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Dialog */}
      <div className="relative z-10 w-full max-w-md bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl p-5 shadow-2xl animate-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <h3 className="text-base font-bold text-slate-100">Tùy Chỉnh Giao Diện Đọc</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-4 space-y-5">
          {/* 1. Theme Selection */}
          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-2">
              MÀU NỀN & CHỦ ĐỀ
            </label>
            <div className="grid grid-cols-3 gap-2">
              {themes.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onUpdateSettings({ theme: t.id })}
                  className={`p-3 rounded-xl border flex flex-col items-center gap-1.5 transition-all ${
                    t.bgClass
                  } ${t.textClass} ${
                    settings.theme === t.id
                      ? 'ring-2 ring-brand-500 scale-[1.02]'
                      : 'opacity-80 hover:opacity-100'
                  }`}
                >
                  <span className="text-xs font-bold">{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 2. Font Family */}
          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-2">
              KIỂU CHỮ (FONT FAMILY)
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => onUpdateSettings({ fontFamily: 'serif' })}
                className={`py-2 px-3 rounded-xl border text-sm font-serif transition-all ${
                  settings.fontFamily === 'serif'
                    ? 'border-brand-500 bg-brand-500/10 text-brand-300'
                    : 'border-slate-800 bg-slate-800/50 text-slate-300 hover:bg-slate-800'
                }`}
              >
                Serif (Merriweather)
              </button>
              <button
                onClick={() => onUpdateSettings({ fontFamily: 'sans' })}
                className={`py-2 px-3 rounded-xl border text-sm font-sans transition-all ${
                  settings.fontFamily === 'sans'
                    ? 'border-brand-500 bg-brand-500/10 text-brand-300'
                    : 'border-slate-800 bg-slate-800/50 text-slate-300 hover:bg-slate-800'
                }`}
              >
                Sans-serif (Inter)
              </button>
            </div>
          </div>

          {/* 3. Font Size Slider */}
          <div>
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400 mb-1.5">
              <span>CỠ CHỮ</span>
              <span className="font-mono text-slate-200">{settings.fontSize}px</span>
            </div>
            <input
              type="range"
              min={14}
              max={28}
              step={1}
              value={settings.fontSize}
              onChange={(e) => onUpdateSettings({ fontSize: Number(e.target.value) })}
              className="w-full accent-brand-500 cursor-pointer h-1.5 bg-slate-700 rounded-lg"
            />
          </div>

          {/* 4. Line Height Slider */}
          <div>
            <div className="flex items-center justify-between text-xs font-semibold text-slate-400 mb-1.5">
              <span>KHOẢNG CÁCH DÒNG (LINE HEIGHT)</span>
              <span className="font-mono text-slate-200">{settings.lineHeight.toFixed(1)}x</span>
            </div>
            <input
              type="range"
              min={1.4}
              max={2.4}
              step={0.1}
              value={settings.lineHeight}
              onChange={(e) => onUpdateSettings({ lineHeight: Number(e.target.value) })}
              className="w-full accent-brand-500 cursor-pointer h-1.5 bg-slate-700 rounded-lg"
            />
          </div>

          {/* 5. Alignment & Width */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1.5">
                CĂN LỀ VĂN BẢN
              </label>
              <div className="flex gap-1.5 bg-slate-800/60 p-1 rounded-xl border border-slate-700">
                <button
                  onClick={() => onUpdateSettings({ textAlign: 'left' })}
                  className={`flex-1 py-1.5 rounded-lg flex items-center justify-center text-xs transition-colors ${
                    settings.textAlign === 'left'
                      ? 'bg-slate-700 text-slate-100 shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Căn trái"
                >
                  <AlignLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => onUpdateSettings({ textAlign: 'justify' })}
                  className={`flex-1 py-1.5 rounded-lg flex items-center justify-center text-xs transition-colors ${
                    settings.textAlign === 'justify'
                      ? 'bg-slate-700 text-slate-100 shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Căn đều hai bên"
                >
                  <AlignJustify className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1.5">
                ĐỘ RỘNG KHUNG
              </label>
              <select
                value={settings.containerWidth}
                onChange={(e) =>
                  onUpdateSettings({
                    containerWidth: e.target.value as NovelContainerWidth,
                  })
                }
                className="w-full py-2 px-2.5 bg-slate-800/60 border border-slate-700 rounded-xl text-xs text-slate-200 focus:outline-hidden"
              >
                <option value="narrow">Gọn (640px)</option>
                <option value="standard">Chuẩn (800px)</option>
                <option value="wide">Rộng (1024px)</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

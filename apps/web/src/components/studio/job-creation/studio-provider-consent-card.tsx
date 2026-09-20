'use client';

import React from 'react';
import {
  EXTERNAL_PROVIDERS,
  LOCAL_PROVIDERS,
  isExternalProvider,
} from '../../../lib/studio/studio-job-creation-policy';
import { JobCreationFormErrors } from '../../../lib/studio/studio-job-creation-policy';

export interface StudioProviderConsentCardProps {
  sourceLang: string;
  targetLang: string;
  provider: string;
  externalConsent: boolean;
  errors?: JobCreationFormErrors;
  onTargetLangChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onExternalConsentChange: (value: boolean) => void;
}

const TARGET_LANGUAGES = [
  ['vi', 'Tiếng Việt'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['zh', '中文'],
] as const;

export function StudioProviderConsentCard({
  sourceLang,
  targetLang,
  provider,
  externalConsent,
  errors = {},
  onTargetLangChange,
  onProviderChange,
  onExternalConsentChange,
}: StudioProviderConsentCardProps) {
  const external = isExternalProvider(provider);

  return (
    <section
      aria-labelledby="provider-heading"
      className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 space-y-5"
    >
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-indigo-400">
          Cấu hình dịch
        </p>
        <h2 id="provider-heading" className="mt-1 text-lg font-bold text-white">
          Ngôn ngữ & nhà cung cấp
        </h2>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <label className="space-y-2 text-sm text-slate-300">
          <span className="font-semibold">Ngôn ngữ nguồn</span>
          <input
            aria-label="Ngôn ngữ nguồn"
            value={sourceLang.toUpperCase()}
            readOnly
            className="w-full rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2.5 text-sm font-semibold text-slate-400"
          />
          {errors.sourceLang && (
            <span className="block text-xs text-rose-400">{errors.sourceLang}</span>
          )}
        </label>

        <label className="space-y-2 text-sm text-slate-300">
          <span className="font-semibold">Ngôn ngữ đích</span>
          <select
            aria-label="Ngôn ngữ đích"
            value={targetLang}
            onChange={(event) => onTargetLangChange(event.target.value)}
            className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
          >
            {TARGET_LANGUAGES.map(([value, label]) => (
              <option key={value} value={value}>
                {label} ({value.toUpperCase()})
              </option>
            ))}
          </select>
          {errors.targetLang && (
            <span className="block text-xs text-rose-400">{errors.targetLang}</span>
          )}
        </label>

        <label className="space-y-2 text-sm text-slate-300">
          <span className="font-semibold">AI Provider</span>
          <select
            aria-label="AI Provider"
            data-testid="job-create-provider-select"
            value={provider}
            onChange={(event) => onProviderChange(event.target.value)}
            className="w-full rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
          >
            <optgroup label="Local / nội bộ">
              {LOCAL_PROVIDERS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </optgroup>
            <optgroup label="Third-party cloud">
              {EXTERNAL_PROVIDERS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </optgroup>
          </select>
          {errors.provider && (
            <span className="block text-xs text-rose-400">{errors.provider}</span>
          )}
        </label>
      </div>

      {external && (
        <div
          data-testid="external-provider-consent-card"
          className="rounded-2xl border border-amber-700/60 bg-amber-950/30 p-4"
        >
          <div className="space-y-2">
            <p className="text-sm font-bold text-amber-200">
              Xác nhận gửi dữ liệu tới bên thứ ba
            </p>
            <p className="text-xs leading-5 text-amber-300/85">
              Nội dung văn bản cần dịch sẽ được gửi tới {provider} để xử lý.
              OmniNovel không yêu cầu bạn nhập hoặc lưu API key của provider trên trình duyệt.
            </p>
          </div>

          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-800/60 bg-slate-950/30 p-3">
            <input
              aria-label="Đồng ý gửi dữ liệu sang bên thứ ba"
              type="checkbox"
              checked={externalConsent}
              onChange={(event) => onExternalConsentChange(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-amber-500"
            />
            <span className="text-sm text-slate-200">
              Tôi xác nhận và đồng ý gửi dữ liệu văn bản sang bên thứ ba để thực hiện bản dịch này.
            </span>
          </label>

          {errors.externalConsent && (
            <p className="mt-2 text-xs text-rose-400">{errors.externalConsent}</p>
          )}
        </div>
      )}
    </section>
  );
}

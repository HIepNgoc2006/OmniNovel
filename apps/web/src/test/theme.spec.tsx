import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../lib/theme/theme-provider';
import { ThemeToggle } from '../lib/theme/theme-toggle';

function ThemeConsumer() {
  const { siteTheme, readerTheme, setSiteTheme, setReaderTheme } = useTheme();
  return (
    <div>
      <span data-testid="site-theme">{siteTheme}</span>
      <span data-testid="reader-theme">{readerTheme}</span>
      <button onClick={() => setSiteTheme('light')}>Set Light</button>
      <button onClick={() => setReaderTheme('sepia')}>Set Sepia</button>
      <ThemeToggle />
    </div>
  );
}

describe('ThemeProvider & Theme Engine Tests', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('phải khởi tạo mặc định siteTheme là dark và readerTheme là sepia', () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('site-theme').textContent).toBe('dark');
    expect(screen.getByTestId('reader-theme').textContent).toBe('sepia');
  });

  it('phải cập nhật siteTheme và lưu vào localStorage', () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    act(() => {
      fireEvent.click(screen.getByText('Set Light'));
    });

    expect(screen.getByTestId('site-theme').textContent).toBe('light');
    expect(localStorage.getItem('omninovel_site_theme')).toBe('light');
  });

  it('ThemeToggle phải luân chuyển qua các theme dark -> light -> system', () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    const toggleBtn = screen.getByRole('button', { name: /Chuyển chủ đề/i });

    // Đang dark -> click -> light
    act(() => {
      fireEvent.click(toggleBtn);
    });
    expect(screen.getByTestId('site-theme').textContent).toBe('light');

    // Đang light -> click -> system
    act(() => {
      fireEvent.click(toggleBtn);
    });
    expect(screen.getByTestId('site-theme').textContent).toBe('system');

    // Đang system -> click -> dark
    act(() => {
      fireEvent.click(toggleBtn);
    });
    expect(screen.getByTestId('site-theme').textContent).toBe('dark');
  });
});

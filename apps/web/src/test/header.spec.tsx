import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Header } from '../components/layout/header';
import { Providers } from '../app/providers';
import { memoryAuthStore } from '../lib/auth/auth-store';
import * as gamificationApi from '../lib/api/gamification';
import * as authApi from '../lib/api/auth';
import { GlobalRole } from '@omninovel/shared';

describe('Header Component & Gamification Integration', () => {
  beforeEach(() => {
    memoryAuthStore.clear();
    vi.restoreAllMocks();
  });

  it('phải render logo OmniNovel, mega search bar và nút Đăng Nhập / Đăng Ký ở trạng thái Anonymous', async () => {
    render(
      <Providers>
        <Header />
      </Providers>,
    );

    expect(screen.getByText('OMNI')).toBeInTheDocument();
    expect(screen.getByText('NOVEL')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Tìm kiếm Manga, Light Novel/i)).toBeInTheDocument();

    const loginBtn = await screen.findByRole('button', { name: 'Đăng Nhập' });
    const registerBtn = await screen.findByRole('button', { name: 'Đăng Ký' });

    expect(loginBtn).toBeInTheDocument();
    expect(registerBtn).toBeInTheDocument();
  });

  it('phải mở AuthModal khi click vào nút Đăng Nhập', async () => {
    render(
      <Providers>
        <Header />
      </Providers>,
    );

    const loginBtn = await screen.findByRole('button', { name: 'Đăng Nhập' });
    act(() => {
      fireEvent.click(loginBtn);
    });

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/reader@omninovel.com/i)).toBeInTheDocument();
  });
});

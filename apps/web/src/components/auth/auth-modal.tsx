'use client';

import React, { useState } from 'react';
import { Modal } from '../ui/modal';
import { Button } from '../ui/button';
import { useAuth } from '../../lib/auth/auth-context';
import { registerApi } from '../../lib/api/auth';
import { CheckCircle2, AlertCircle, Lock, Mail, User } from 'lucide-react';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultTab?: 'login' | 'register';
}

export function AuthModal({ isOpen, onClose, defaultTab = 'login' }: AuthModalProps) {
  const { login } = useAuth();
  const [tab, setTab] = useState<'login' | 'register'>(defaultTab);

  // Form states
  const [identifier, setIdentifier] = useState(''); // email or username for login
  const [loginPassword, setLoginPassword] = useState('');

  const [registerEmail, setRegisterEmail] = useState('');
  const [registerUsername, setRegisterUsername] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerFullName, setRegisterFullName] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const resetMessages = () => {
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    resetMessages();
    setIsLoading(true);

    try {
      const isEmail = identifier.includes('@');
      await login({
        email: isEmail ? identifier : undefined,
        username: !isEmail ? identifier : undefined,
        password: loginPassword,
      });
      onClose();
    } catch (err: any) {
      setErrorMessage(
        err.response?.data?.error?.message ||
          err.response?.data?.message ||
          'Đăng nhập thất bại. Vui lòng kiểm tra lại tài khoản hoặc mật khẩu.',
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    resetMessages();
    setIsLoading(true);

    try {
      const res = await registerApi({
        email: registerEmail,
        username: registerUsername,
        password: registerPassword,
        fullName: registerFullName || undefined,
      });
      setSuccessMessage(res.message || 'Đăng ký tài khoản thành công! Vui lòng đăng nhập.');
      setIdentifier(registerUsername);
      setLoginPassword('');
      // Chuyển sang tab login
      setTab('login');
    } catch (err: any) {
      setErrorMessage(
        err.response?.data?.error?.message ||
          err.response?.data?.message ||
          'Đăng ký không thành công. Email hoặc Tên đăng nhập có thể đã tồn tại.',
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="md">
      {/* Header Tabs */}
      <div className="flex border-b border-slate-800 -mx-6 -mt-6 mb-6">
        <button
          type="button"
          onClick={() => {
            setTab('login');
            resetMessages();
          }}
          className={`flex-1 py-4 text-center text-sm font-bold border-b-2 transition-colors cursor-pointer ${
            tab === 'login'
              ? 'border-red-500 text-white bg-slate-800/30'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          Đăng Nhập
        </button>
        <button
          type="button"
          onClick={() => {
            setTab('register');
            resetMessages();
          }}
          className={`flex-1 py-4 text-center text-sm font-bold border-b-2 transition-colors cursor-pointer ${
            tab === 'register'
              ? 'border-red-500 text-white bg-slate-800/30'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          Đăng Ký Tài Khoản
        </button>
      </div>

      {/* Success Banner */}
      {successMessage && (
        <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl flex items-start gap-2 text-emerald-400 text-xs">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Error Banner */}
      {errorMessage && (
        <div className="mb-4 p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl flex items-start gap-2 text-rose-400 text-xs">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Login Form */}
      {tab === 'login' && (
        <form onSubmit={handleLoginSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Email hoặc Tên đăng nhập
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              <input
                type="text"
                required
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="reader@omninovel.com hoặc user123"
                className="w-full bg-slate-950 border border-slate-800 focus:border-red-500 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">Mật khẩu</label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              <input
                type="password"
                required
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-slate-950 border border-slate-800 focus:border-red-500 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500"
              />
            </div>
          </div>

          <Button type="submit" variant="primary" className="w-full mt-2" isLoading={isLoading}>
            Đăng Nhập
          </Button>

          <p className="text-center text-xs text-slate-400 mt-3">
            Chưa có tài khoản?{' '}
            <button
              type="button"
              onClick={() => {
                setTab('register');
                resetMessages();
              }}
              className="text-red-400 hover:text-red-300 font-semibold cursor-pointer underline"
            >
              Đăng ký ngay
            </button>
          </p>
        </form>
      )}

      {/* Register Form */}
      {tab === 'register' && (
        <form onSubmit={handleRegisterSubmit} className="space-y-3.5">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Email</label>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              <input
                type="email"
                required
                value={registerEmail}
                onChange={(e) => setRegisterEmail(e.target.value)}
                placeholder="name@example.com"
                className="w-full bg-slate-950 border border-slate-800 focus:border-red-500 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Tên đăng nhập</label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              <input
                type="text"
                required
                value={registerUsername}
                onChange={(e) => setRegisterUsername(e.target.value)}
                placeholder="novel_master"
                className="w-full bg-slate-950 border border-slate-800 focus:border-red-500 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Họ và tên (Tùy chọn)</label>
            <input
              type="text"
              value={registerFullName}
              onChange={(e) => setRegisterFullName(e.target.value)}
              placeholder="Nguyễn Văn A"
              className="w-full bg-slate-950 border border-slate-800 focus:border-red-500 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Mật khẩu</label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              <input
                type="password"
                required
                minLength={6}
                value={registerPassword}
                onChange={(e) => setRegisterPassword(e.target.value)}
                placeholder="Tối thiểu 6 ký tự"
                className="w-full bg-slate-950 border border-slate-800 focus:border-red-500 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500"
              />
            </div>
          </div>

          <Button type="submit" variant="primary" className="w-full mt-2" isLoading={isLoading}>
            Tạo Tài Khoản
          </Button>

          <p className="text-center text-xs text-slate-400 mt-2">
            Đã có tài khoản?{' '}
            <button
              type="button"
              onClick={() => {
                setTab('login');
                resetMessages();
              }}
              className="text-red-400 hover:text-red-300 font-semibold cursor-pointer underline"
            >
              Đăng nhập ngay
            </button>
          </p>
        </form>
      )}
    </Modal>
  );
}

'use client';

import React, { useState } from 'react';
import { useTranslationSocket } from '../../../lib/websocket/use-translation-socket';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import {
  Sliders,
  Radio,
  Sparkles,
  Activity,
  Layers,
  Cpu,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { TranslationJobStatus } from '@omninovel/shared';

export default function StudioPage() {
  const [testJobId, setTestJobId] = useState('');
  const [activeJobId, setActiveJobId] = useState<string | undefined>(undefined);

  const { isConnected, lastProgress, error } = useTranslationSocket({
    jobId: activeJobId,
    onProgress: (evt) => {
      console.log('Socket progress received:', evt);
    },
  });

  const handleSubscribe = (e: React.FormEvent) => {
    e.preventDefault();
    if (testJobId.trim()) {
      setActiveJobId(testJobId.trim());
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-10 space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <div className="flex items-center gap-2 text-red-400 text-xs font-semibold uppercase tracking-wider mb-1">
            <Sliders className="w-4 h-4" />
            <span>AI Translation Studio</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-black text-white">Bảng Điều Khiển Dịch Thuật</h1>
        </div>

        {/* Live WebSocket Status Pill */}
        <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-full text-xs font-semibold">
          <Radio
            className={`w-3.5 h-3.5 ${
              isConnected ? 'text-emerald-400 animate-pulse' : 'text-slate-500'
            }`}
          />
          <span className="text-slate-400">WebSocket /ws/ai:</span>
          <span className={isConnected ? 'text-emerald-400' : 'text-slate-400'}>
            {isConnected ? 'Đã Kết Nối' : 'Chưa Kết Nối'}
          </span>
        </div>
      </div>

      {/* Grid Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Card 1: Pipeline Status */}
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Cpu className="w-4 h-4 text-red-500" />
              <span>AI Worker Cluster</span>
            </h3>
            <Badge variant="success">Active</Badge>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Dịch vụ AI Worker đang hoạt động trên FastAPI Python với Japanese Manga-OCR, Inpainting Telea, và Novel Canonical Rebuilder V2.
          </p>
          <div className="pt-2 text-[11px] text-slate-500 space-y-1">
            <p>• BullMQ Single Queue: 14 States Enforced</p>
            <p>• Protected Inline Anchors: Strict</p>
            <p>• Model: Manga-OCR + gpt-4o-mini / local</p>
          </div>
        </div>

        {/* Card 2: Live Job Monitor (WS Tester) */}
        <div className="md:col-span-2 bg-slate-900 border border-slate-800 rounded-3xl p-6 space-y-4">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Activity className="w-4 h-4 text-amber-400" />
            <span>Theo Dõi Tiến Trình Job Thời Gian Thực</span>
          </h3>

          <form onSubmit={handleSubscribe} className="flex gap-2">
            <input
              type="text"
              value={testJobId}
              onChange={(e) => setTestJobId(e.target.value)}
              placeholder="Nhập Translation Job UUID để theo dõi qua /ws/ai..."
              className="flex-1 bg-slate-950 border border-slate-800 focus:border-red-500 rounded-xl px-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500"
            />
            <Button type="submit" variant="primary" size="sm">
              Lắng Nghe
            </Button>
          </form>

          {/* Monitor Display */}
          {activeJobId ? (
            <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Job ID: <span className="font-mono text-white">{activeJobId}</span></span>
                {lastProgress && <Badge variant="primary">{lastProgress.stage}</Badge>}
              </div>

              {lastProgress ? (
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-slate-400">
                    <span>Tiến độ</span>
                    <span className="font-bold text-red-400">{lastProgress.progressPercentage}%</span>
                  </div>
                  <div className="w-full h-2.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                    <div
                      className="h-full bg-red-600 transition-all duration-300"
                      style={{ width: `${lastProgress.progressPercentage}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-slate-500 text-right">
                    Attempt #{lastProgress.attemptNumber} • Sequence {lastProgress.sequence}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-slate-500 italic">
                  Đang chờ sự kiện cập nhật tiến trình từ AI Worker qua WebSocket...
                </p>
              )}
            </div>
          ) : (
            <div className="bg-slate-950/60 p-4 rounded-2xl border border-dashed border-slate-800 text-center text-xs text-slate-500">
              Nhập Job UUID hoặc tạo bản dịch mới từ Studio để quan sát tiến trình 14 trạng thái.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

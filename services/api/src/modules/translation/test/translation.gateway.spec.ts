import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Server } from 'socket.io';
import { TranslationJobStatus } from '@omninovel/shared';
import { TranslationGateway } from '../translation.gateway';

describe('TranslationGateway Unit Tests & Security Invariants', () => {
  let gateway: TranslationGateway;
  let mockServer: {
    to: jest.Mock;
  };
  let mockRoomEmitter: {
    emit: jest.Mock;
  };

  const FORBIDDEN_KEYS = [
    'resultManifest',
    'storageKey',
    'previewKey',
    'htmlKey',
    'errorTrace',
  ];

  function assertNoForbiddenKeys(obj: any) {
    if (obj === null || obj === undefined) return;
    if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        expect(FORBIDDEN_KEYS).not.toContain(key);
        assertNoForbiddenKeys(obj[key]);
      }
    }
  }

  beforeEach(async () => {
    mockRoomEmitter = {
      emit: jest.fn(),
    };
    mockServer = {
      to: jest.fn().mockReturnValue(mockRoomEmitter),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranslationGateway,
        {
          provide: JwtService,
          useValue: {
            verify: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('mock_jwt_secret'),
          },
        },
        {
          provide: DataSource,
          useValue: {
            query: jest.fn(),
          },
        },
      ],
    }).compile();

    gateway = module.get<TranslationGateway>(TranslationGateway);
    gateway.server = mockServer as unknown as Server;
  });

  describe('broadcastJobProgress', () => {
    it('should broadcast job_progress with exact allowlist keys and zero forbidden keys', () => {
      const jobId = 'job-progress-123';
      const heartbeat = new Date('2026-09-06T12:00:00.000Z');

      gateway.broadcastJobProgress(
        jobId,
        TranslationJobStatus.OCR,
        45,
        heartbeat,
      );

      expect(mockServer.to).toHaveBeenCalledWith(`job_${jobId}`);
      expect(mockRoomEmitter.emit).toHaveBeenCalledTimes(1);

      const [eventName, payload] = mockRoomEmitter.emit.mock.calls[0];
      expect(eventName).toBe('job_progress');

      // 1. Exact allowlist keys
      const expectedKeys = ['jobId', 'status', 'progress', 'heartbeatAt', 'timestamp'].sort();
      expect(Object.keys(payload).sort()).toEqual(expectedKeys);

      // 2. Exact payload values
      expect(payload.jobId).toBe(jobId);
      expect(payload.status).toBe(TranslationJobStatus.OCR);
      expect(payload.progress).toBe(45);
      expect(payload.heartbeatAt).toBe('2026-09-06T12:00:00.000Z');
      expect(typeof payload.timestamp).toBe('string');
      expect(new Date(payload.timestamp).toISOString()).toBe(payload.timestamp);

      // 3. Security invariant: zero forbidden keys
      assertNoForbiddenKeys(payload);
    });

    it('should handle optional heartbeatAt cleanly without leaking fields', () => {
      const jobId = 'job-progress-no-heartbeat';

      gateway.broadcastJobProgress(jobId, TranslationJobStatus.TRANSLATING, 80);

      const [eventName, payload] = mockRoomEmitter.emit.mock.calls[0];
      expect(eventName).toBe('job_progress');

      const expectedKeys = ['jobId', 'status', 'progress', 'timestamp'].sort();
      expect(Object.keys(payload).sort()).toEqual(expectedKeys);
      expect(payload.heartbeatAt).toBeUndefined();
      assertNoForbiddenKeys(payload);
    });
  });

  describe('broadcastJobReady', () => {
    it('should broadcast job_ready_for_review with exact allowlist keys and zero forbidden keys', () => {
      const jobId = 'job-ready-123';

      gateway.broadcastJobReady(jobId);

      expect(mockServer.to).toHaveBeenCalledWith(`job_${jobId}`);
      expect(mockRoomEmitter.emit).toHaveBeenCalledTimes(1);

      const [eventName, payload] = mockRoomEmitter.emit.mock.calls[0];
      expect(eventName).toBe('job_ready_for_review');

      // 1. Exact allowlist keys
      const expectedKeys = ['jobId', 'status', 'timestamp'].sort();
      expect(Object.keys(payload).sort()).toEqual(expectedKeys);

      // 2. Exact values
      expect(payload.jobId).toBe(jobId);
      expect(payload.status).toBe(TranslationJobStatus.READY_FOR_REVIEW);
      expect(typeof payload.timestamp).toBe('string');

      // 3. Security invariant
      assertNoForbiddenKeys(payload);
    });

    it('CANARY: should ignore unexpected runtime arguments and NEVER leak resultManifest or storageKey', () => {
      const jobId = 'job-ready-canary';
      const leakCanary = 'SECRET_STORAGE_KEY_LEAK_CANARY_XYZ';

      // Simulate legacy or malicious runtime invocation passing resultManifest
      (gateway as any).broadcastJobReady(jobId, {
        resultManifest: {
          storageKey: leakCanary,
          previewKey: 'SECRET_PREVIEW_KEY',
          htmlKey: 'SECRET_HTML_KEY',
        },
      });

      const [eventName, payload] = mockRoomEmitter.emit.mock.calls[0];
      expect(eventName).toBe('job_ready_for_review');

      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(leakCanary);
      expect(serialized).not.toContain('SECRET_PREVIEW_KEY');
      expect(serialized).not.toContain('SECRET_HTML_KEY');
      expect(serialized).not.toContain('resultManifest');

      const expectedKeys = ['jobId', 'status', 'timestamp'].sort();
      expect(Object.keys(payload).sort()).toEqual(expectedKeys);
      assertNoForbiddenKeys(payload);
    });
  });

  describe('broadcastJobFailed', () => {
    it('should broadcast job_failed with exact allowlist keys and zero forbidden keys', () => {
      const jobId = 'job-failed-123';

      gateway.broadcastJobFailed(jobId);

      expect(mockServer.to).toHaveBeenCalledWith(`job_${jobId}`);
      expect(mockRoomEmitter.emit).toHaveBeenCalledTimes(1);

      const [eventName, payload] = mockRoomEmitter.emit.mock.calls[0];
      expect(eventName).toBe('job_failed');

      // 1. Exact allowlist keys
      const expectedKeys = ['jobId', 'status', 'timestamp'].sort();
      expect(Object.keys(payload).sort()).toEqual(expectedKeys);

      // 2. Exact values
      expect(payload.jobId).toBe(jobId);
      expect(payload.status).toBe(TranslationJobStatus.FAILED);
      expect(typeof payload.timestamp).toBe('string');

      // 3. Security invariant
      assertNoForbiddenKeys(payload);
    });

    it('CANARY: should ignore unexpected errorTrace argument and NEVER leak stack traces or paths', () => {
      const jobId = 'job-failed-canary';
      const traceCanary = 'DATABASE_CONNECTION_REFUSED_AT_HOST_10_0_0_1_CANARY';

      // Simulate legacy runtime invocation passing errorTrace
      (gateway as any).broadcastJobFailed(jobId, {
        errorTrace: traceCanary,
      });

      const [eventName, payload] = mockRoomEmitter.emit.mock.calls[0];
      expect(eventName).toBe('job_failed');

      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(traceCanary);
      expect(serialized).not.toContain('errorTrace');

      const expectedKeys = ['jobId', 'status', 'timestamp'].sort();
      expect(Object.keys(payload).sort()).toEqual(expectedKeys);
      assertNoForbiddenKeys(payload);
    });
  });

  describe('broadcastJobCanceled', () => {
    it('should broadcast job_canceled with exact allowlist keys and zero forbidden keys', () => {
      const jobId = 'job-canceled-123';

      gateway.broadcastJobCanceled(jobId);

      expect(mockServer.to).toHaveBeenCalledWith(`job_${jobId}`);
      expect(mockRoomEmitter.emit).toHaveBeenCalledTimes(1);

      const [eventName, payload] = mockRoomEmitter.emit.mock.calls[0];
      expect(eventName).toBe('job_canceled');

      // 1. Exact allowlist keys
      const expectedKeys = ['jobId', 'status', 'timestamp'].sort();
      expect(Object.keys(payload).sort()).toEqual(expectedKeys);

      // 2. Exact values
      expect(payload.jobId).toBe(jobId);
      expect(payload.status).toBe(TranslationJobStatus.CANCELED);
      expect(typeof payload.timestamp).toBe('string');

      // 3. Security invariant
      assertNoForbiddenKeys(payload);
    });
  });
});

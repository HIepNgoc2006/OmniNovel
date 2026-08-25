import { BadRequestException } from '@nestjs/common';
import { TranslationJobStatus } from '@omninovel/shared';
import {
  assertWorkerReportableState,
  assertTransitionAllowed,
  canBeginRetryAttempt,
  WORKER_REPORTABLE_ACTIVE_STATES,
  WORKER_FINAL_STATE,
  SYSTEM_TERMINAL_STATES,
} from '../translation-state-machine';

describe('Translation State Machine (Unit Tests)', () => {
  describe('assertWorkerReportableState', () => {
    it('should accept all worker-reportable active states and READY_FOR_REVIEW', () => {
      for (const state of WORKER_REPORTABLE_ACTIVE_STATES) {
        expect(() => assertWorkerReportableState(state)).not.toThrow();
      }
      expect(() => assertWorkerReportableState(WORKER_FINAL_STATE)).not.toThrow();
    });

    it('should reject system-owned terminal states when reported by worker', () => {
      for (const terminal of SYSTEM_TERMINAL_STATES) {
        expect(() => assertWorkerReportableState(terminal)).toThrow(
          BadRequestException,
        );
      }
    });

    it('should reject CREATED and VALIDATING and QUEUED when reported by worker', () => {
      expect(() =>
        assertWorkerReportableState(TranslationJobStatus.CREATED),
      ).toThrow(BadRequestException);
      expect(() =>
        assertWorkerReportableState(TranslationJobStatus.VALIDATING),
      ).toThrow(BadRequestException);
      expect(() =>
        assertWorkerReportableState(TranslationJobStatus.QUEUED),
      ).toThrow(BadRequestException);
    });
  });

  describe('assertTransitionAllowed', () => {
    it('should allow same-state transitions for active worker states (Heartbeat / Progress)', () => {
      for (const active of WORKER_REPORTABLE_ACTIVE_STATES) {
        expect(() => assertTransitionAllowed(active, active)).not.toThrow();
      }
    });

    it('should allow valid forward Manga workflow transitions', () => {
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.QUEUED,
          TranslationJobStatus.PREPROCESSING,
        ),
      ).not.toThrow();
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.PREPROCESSING,
          TranslationJobStatus.OCR,
        ),
      ).not.toThrow();
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.OCR,
          TranslationJobStatus.TRANSLATING,
        ),
      ).not.toThrow();
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.TRANSLATING,
          TranslationJobStatus.INPAINTING,
        ),
      ).not.toThrow();
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.INPAINTING,
          TranslationJobStatus.TYPESETTING,
        ),
      ).not.toThrow();
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.TYPESETTING,
          TranslationJobStatus.QUALITY_CHECK,
        ),
      ).not.toThrow();
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.QUALITY_CHECK,
          TranslationJobStatus.READY_FOR_REVIEW,
        ),
      ).not.toThrow();
    });

    it('should allow valid forward Novel workflow transitions (skipping OCR, Inpainting, Typesetting)', () => {
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.PREPROCESSING,
          TranslationJobStatus.TRANSLATING,
        ),
      ).not.toThrow();
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.TRANSLATING,
          TranslationJobStatus.QUALITY_CHECK,
        ),
      ).not.toThrow();
    });

    it('should allow transition from READY_FOR_REVIEW to APPLIED / CANCELED / EXPIRED', () => {
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.READY_FOR_REVIEW,
          TranslationJobStatus.APPLIED,
        ),
      ).not.toThrow();
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.READY_FOR_REVIEW,
          TranslationJobStatus.CANCELED,
        ),
      ).not.toThrow();
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.READY_FOR_REVIEW,
          TranslationJobStatus.EXPIRED,
        ),
      ).not.toThrow();
    });

    it('should reject backward transitions in normal pipeline', () => {
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.TRANSLATING,
          TranslationJobStatus.OCR,
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.READY_FOR_REVIEW,
          TranslationJobStatus.OCR,
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.READY_FOR_REVIEW,
          TranslationJobStatus.PREPROCESSING,
        ),
      ).toThrow(BadRequestException);
    });

    it('should reject illegal skipping transitions', () => {
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.QUEUED,
          TranslationJobStatus.READY_FOR_REVIEW,
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.OCR,
          TranslationJobStatus.APPLIED,
        ),
      ).toThrow(BadRequestException);
    });

    it('should reject same-state transition on READY_FOR_REVIEW (Worker-final invariant)', () => {
      expect(() =>
        assertTransitionAllowed(
          TranslationJobStatus.READY_FOR_REVIEW,
          TranslationJobStatus.READY_FOR_REVIEW,
        ),
      ).toThrow(BadRequestException);
    });

    it('should reject any transition originating from a Terminal state', () => {
      for (const terminal of SYSTEM_TERMINAL_STATES) {
        expect(() =>
          assertTransitionAllowed(terminal, TranslationJobStatus.PREPROCESSING),
        ).toThrow(BadRequestException);
        expect(() =>
          assertTransitionAllowed(terminal, TranslationJobStatus.READY_FOR_REVIEW),
        ).toThrow(BadRequestException);
      }
    });
  });

  describe('canBeginRetryAttempt', () => {
    it('should allow retry from any active state to attempt 2 or 3', () => {
      for (const active of WORKER_REPORTABLE_ACTIVE_STATES) {
        expect(canBeginRetryAttempt(active, 1, 2, 3)).toBe(true);
        expect(canBeginRetryAttempt(active, 2, 3, 3)).toBe(true);
      }
    });

    it('should allow attempt 1 from QUEUED or VALIDATING', () => {
      expect(
        canBeginRetryAttempt(TranslationJobStatus.QUEUED, 0, 1, 3),
      ).toBe(true);
      expect(
        canBeginRetryAttempt(TranslationJobStatus.VALIDATING, 0, 1, 3),
      ).toBe(true);
    });

    it('should reject attempt 2 or 3 from QUEUED or VALIDATING (must be active state)', () => {
      expect(
        canBeginRetryAttempt(TranslationJobStatus.QUEUED, 1, 2, 3),
      ).toBe(false);
      expect(
        canBeginRetryAttempt(TranslationJobStatus.VALIDATING, 1, 2, 3),
      ).toBe(false);
    });

    it('should disallow retry if job is in READY_FOR_REVIEW (Worker-final)', () => {
      expect(
        canBeginRetryAttempt(TranslationJobStatus.READY_FOR_REVIEW, 1, 2, 3),
      ).toBe(false);
      expect(
        canBeginRetryAttempt(TranslationJobStatus.READY_FOR_REVIEW, 2, 3, 3),
      ).toBe(false);
    });

    it('should disallow retry if new attempt <= current attempt or > max attempts', () => {
      expect(
        canBeginRetryAttempt(TranslationJobStatus.TRANSLATING, 2, 2, 3),
      ).toBe(false);
      expect(
        canBeginRetryAttempt(TranslationJobStatus.TRANSLATING, 2, 1, 3),
      ).toBe(false);
      expect(
        canBeginRetryAttempt(TranslationJobStatus.TRANSLATING, 3, 4, 3),
      ).toBe(false);
    });

    it('should disallow retry if job is already in a Terminal state', () => {
      for (const terminal of SYSTEM_TERMINAL_STATES) {
        expect(canBeginRetryAttempt(terminal, 1, 2, 3)).toBe(false);
      }
    });
  });
});

describe('Translation Fencing & Prefix Jail (Unit Tests)', () => {
  function validatePrefix(jobId: string, attemptNumber: number, storageKey: string): boolean {
    const allowedPrefix = `ai/jobs/${jobId}/attempt-${attemptNumber}/`;
    if (!storageKey.startsWith(allowedPrefix)) return false;
    if (storageKey.includes('..') || storageKey.includes('\\')) return false;
    return true;
  }

  function shouldAcceptCallback(
    currentAttempt: number,
    lastSequence: number,
    isTerminal: boolean,
    eventAttempt: number,
    eventSequence: number,
  ): { accepted: boolean; reason?: string } {
    if (isTerminal) return { accepted: false, reason: 'JOB_ALREADY_TERMINAL' };
    if (eventAttempt !== currentAttempt) return { accepted: false, reason: 'STALE_ATTEMPT' };
    if (eventSequence <= lastSequence) return { accepted: false, reason: 'OUT_OF_ORDER_SEQUENCE' };
    return { accepted: true };
  }

  it('should accept valid monotonic callback sequence within same attempt', () => {
    expect(shouldAcceptCallback(1, 0, false, 1, 1)).toEqual({ accepted: true });
    expect(shouldAcceptCallback(1, 1, false, 1, 2)).toEqual({ accepted: true });
    expect(shouldAcceptCallback(2, 0, false, 2, 1)).toEqual({ accepted: true });
  });

  it('should reject stale attempt callbacks (attempt 1 event when attempt 2 is running)', () => {
    expect(shouldAcceptCallback(2, 0, false, 1, 5)).toEqual({
      accepted: false,
      reason: 'STALE_ATTEMPT',
    });
    expect(shouldAcceptCallback(3, 1, false, 2, 10)).toEqual({
      accepted: false,
      reason: 'STALE_ATTEMPT',
    });
  });

  it('should reject out-of-order or duplicate sequence callbacks', () => {
    expect(shouldAcceptCallback(1, 3, false, 1, 3)).toEqual({
      accepted: false,
      reason: 'OUT_OF_ORDER_SEQUENCE',
    });
    expect(shouldAcceptCallback(1, 4, false, 1, 2)).toEqual({
      accepted: false,
      reason: 'OUT_OF_ORDER_SEQUENCE',
    });
  });

  it('should reject any event when job is terminal', () => {
    expect(shouldAcceptCallback(1, 0, true, 1, 1)).toEqual({
      accepted: false,
      reason: 'JOB_ALREADY_TERMINAL',
    });
  });

  it('should validate storage prefix jail correctly', () => {
    const jobId = 'a1b2c3d4-0000-4000-a000-000000000001';
    expect(
      validatePrefix(jobId, 1, `ai/jobs/${jobId}/attempt-1/page-001.webp`),
    ).toBe(true);
    expect(
      validatePrefix(jobId, 2, `ai/jobs/${jobId}/attempt-2/page-002.webp`),
    ).toBe(true);

    // Reject wrong attempt prefix
    expect(
      validatePrefix(jobId, 2, `ai/jobs/${jobId}/attempt-1/page-001.webp`),
    ).toBe(false);

    // Reject path traversal / outside prefix
    expect(
      validatePrefix(jobId, 1, `ai/jobs/${jobId}/attempt-1/../../../etc/passwd`),
    ).toBe(false);
    expect(
      validatePrefix(jobId, 1, `media/editions/other-story/page.webp`),
    ).toBe(false);
  });
});

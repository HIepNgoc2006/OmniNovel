import { runR2LiveSmokeTest } from './r2-live-smoke';

describe('Real Cloudflare R2 Lifecycle Smoke Test (Live Network E2E)', () => {
  const hasR2Creds =
    !!process.env.S3_ACCESS_KEY_ID &&
    !!process.env.S3_SECRET_ACCESS_KEY &&
    !!process.env.S3_ENDPOINT;

  const testFn = hasR2Creds ? it : it.skip;

  testFn(
    'should execute full R2 lifecycle: PUT presigned -> HEAD -> GET -> COPY/promote -> DELETE',
    async () => {
      const result = await runR2LiveSmokeTest();
      expect(result.status).toBe('SUCCESS');
    },
    30000,
  );

  it('should export runR2LiveSmokeTest runner function', () => {
    expect(typeof runR2LiveSmokeTest).toBe('function');
  });
});

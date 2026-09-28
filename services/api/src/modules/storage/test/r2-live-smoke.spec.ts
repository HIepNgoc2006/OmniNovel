import * as dotenv from 'dotenv';
import * as path from 'path';
import { runR2LiveSmokeTest } from './r2-live-smoke';

const envPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(__dirname, '../../../../.env'),
];
for (const p of envPaths) {
  dotenv.config({ path: p });
}

describe('Real Cloudflare R2 Lifecycle Smoke Test (Live Network E2E & Invariants)', () => {
  const isRequired = process.env.R2_LIVE_SMOKE_REQUIRED === 'true';
  const hasR2Creds =
    !!process.env.S3_ACCESS_KEY_ID &&
    !!process.env.S3_SECRET_ACCESS_KEY &&
    !!process.env.S3_ENDPOINT;

  describe('1. Acceptance Invariant: R2_LIVE_SMOKE_REQUIRED mode', () => {
    it('should FAIL-FAST when R2_LIVE_SMOKE_REQUIRED is enabled but credentials are missing', async () => {
      await expect(
        runR2LiveSmokeTest({
          required: true,
          endpoint: undefined,
          accessKeyId: undefined,
          secretAccessKey: undefined,
        }),
      ).rejects.toThrow(
        /Thiếu credentials: Bắt buộc cung cấp S3_ENDPOINT, S3_ACCESS_KEY_ID và S3_SECRET_ACCESS_KEY.*Fail-fast triggered/,
      );
    });

    it('should return SKIPPED status when required=false and credentials are missing', async () => {
      const result = await runR2LiveSmokeTest({
        required: false,
        endpoint: undefined,
        accessKeyId: undefined,
        secretAccessKey: undefined,
      });

      expect(result.status).toBe('SKIPPED');
      expect(result.reason).toContain('Thiếu credentials');
    });
  });

  describe('2. Real Network Lifecycle Execution', () => {
    // Nếu có credentials thật hoặc R2_LIVE_SMOKE_REQUIRED=true thì test chạy bắt buộc
    const runLive = hasR2Creds || isRequired;
    const testRunner = runLive ? it : it.skip;

    testRunner(
      'should execute full R2 lifecycle on both omninovel-manga and omninovel-novel buckets with zero leaks',
      async () => {
        const result = await runR2LiveSmokeTest({
          required: true,
        });

        expect(result.status).toBe('SUCCESS');
        expect(result.verifiedBuckets).toBeDefined();
        expect(result.verifiedBuckets).toContain('omninovel-manga');
        expect(result.verifiedBuckets).toContain('omninovel-novel');
      },
      60000,
    );
  });
});

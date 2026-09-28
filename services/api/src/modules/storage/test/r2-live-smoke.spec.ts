import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { runR2LiveSmokeTest } from './r2-live-smoke';

function findFileUpwards(fileName: string, startDir: string = process.cwd()): string | null {
  let curr = startDir;
  while (true) {
    const candidate = path.join(curr, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return null;
}

// CHỈ nạp credentials từ file riêng biệt .env.r2-live KHI explicit flag R2_LIVE_ACCEPTANCE=true
// Tuyệt đối KHÔNG tự động nạp production .env trong test suite thông thường để tránh rò rỉ network call
const isLiveAcceptanceEnabled = process.env.R2_LIVE_ACCEPTANCE === 'true';

if (isLiveAcceptanceEnabled) {
  const r2LiveEnvPath = findFileUpwards('.env.r2-live', __dirname);
  if (r2LiveEnvPath) {
    dotenv.config({ path: r2LiveEnvPath });
  }
}

describe('Real Cloudflare R2 Lifecycle Smoke Test (Live Network E2E & Invariants)', () => {
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

  // Tách biệt hoàn toàn khỏi test suite thường:
  // Suite này CHỈ chạy khi R2_LIVE_ACCEPTANCE=true được bật chủ động (Explicit Opt-In).
  // Khi chạy "npm test" thông thường, suite này sẽ tự động SKIPPED an toàn.
  const liveDescribe = isLiveAcceptanceEnabled ? describe : describe.skip;

  liveDescribe('2. Real Network Lifecycle Execution (Explicit Opt-In Only)', () => {
    it(
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

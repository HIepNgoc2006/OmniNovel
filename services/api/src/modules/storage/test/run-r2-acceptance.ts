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

/**
 * Dedicated CLI runner cho Cloudflare R2 Live Acceptance Smoke Test.
 * Chỉ được gọi khi lập trình viên hoặc release pipeline kích hoạt thủ công qua 'npm run test:r2-live'.
 * Ưu tiên nạp credentials từ file riêng biệt .env.r2-live (được .gitignore bảo vệ).
 * Nếu không có .env.r2-live, fallback sang .env của workspace.
 */
async function main() {
  const r2LiveEnv = findFileUpwards('.env.r2-live', __dirname);
  const defaultEnv = findFileUpwards('.env', __dirname);
  const targetEnv = r2LiveEnv || defaultEnv;

  if (targetEnv) {
    dotenv.config({ path: targetEnv });
  }

  console.log('='.repeat(70));
  console.log('🚀 OMNINOVEL: CLOUDFLARE R2 LIVE ACCEPTANCE RUNNER');
  console.log(`📁 Config source: ${targetEnv ? path.basename(targetEnv) : 'process.env'}`);
  console.log('='.repeat(70));

  process.env.R2_LIVE_ACCEPTANCE = 'true';

  try {
    const result = await runR2LiveSmokeTest({ required: true });
    console.log('='.repeat(70));
    console.log('✅ R2 LIVE ACCEPTANCE TEST THÀNH CÔNG VỚI ZERO LEAK!');
    console.log(`📦 Verified Buckets: ${result.verifiedBuckets?.join(', ')}`);
    console.log(`🆔 Test Run ID: ${result.testId}`);
    console.log('='.repeat(70));
    process.exit(0);
  } catch (error: any) {
    console.error('='.repeat(70));
    console.error('❌ R2 LIVE ACCEPTANCE TEST THẤT BẠI:');
    console.error(error.message || error);
    console.error('='.repeat(70));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

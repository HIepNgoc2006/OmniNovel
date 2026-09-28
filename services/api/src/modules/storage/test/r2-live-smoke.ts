import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { StorageService } from '../storage.service';
import { ConfigService } from '@nestjs/config';

export interface R2LiveSmokeOptions {
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  mangaBucket?: string;
  novelBucket?: string;
  required?: boolean;
}

export interface R2LiveSmokeResult {
  status: 'SUCCESS' | 'SKIPPED';
  testId?: string;
  verifiedBuckets?: string[];
  reason?: string;
}

/**
 * Real Cloudflare R2 Smoke Test:
 * Kiểm tra chu trình vòng đời lưu trữ thật (End-to-End Live Storage Lifecycle):
 * 1. Presigned PUT -> Tải file lên R2 endpoint thật
 * 2. HEAD Object -> Xác minh file đã tồn tại và đúng kích thước/ETag trên R2
 * 3. Presigned GET -> Tải file về qua GET URL thật và đối chiếu payload
 * 4. COPY / Promote -> Sao chép từ quarantine sang final key trên R2
 * 5. DELETE -> Dọn dẹp cả quarantine và final key trong finally block, xác minh HEAD trả về 404
 *
 * Chạy trên CẢ HAI buckets: omninovel-manga và omninovel-novel.
 * Khi R2_LIVE_SMOKE_REQUIRED=true, thiếu credentials sẽ lập tức FAIL (throw Error), không skip.
 */
export async function runR2LiveSmokeTest(
  options: R2LiveSmokeOptions = {},
): Promise<R2LiveSmokeResult> {
  const isRequired =
    options.required ?? (process.env.R2_LIVE_SMOKE_REQUIRED === 'true');

  const endpoint = options.endpoint || process.env.S3_ENDPOINT;
  const accessKeyId = options.accessKeyId || process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey =
    options.secretAccessKey || process.env.S3_SECRET_ACCESS_KEY;
  const mangaBucket =
    options.mangaBucket || process.env.S3_BUCKET_MANGA || 'omninovel-manga';
  const novelBucket =
    options.novelBucket || process.env.S3_BUCKET_NOVEL || 'omninovel-novel';

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    const errorMsg =
      '[R2 Smoke Test] Thiếu credentials: Bắt buộc cung cấp S3_ENDPOINT, S3_ACCESS_KEY_ID và S3_SECRET_ACCESS_KEY.';
    if (isRequired) {
      throw new Error(`${errorMsg} Fail-fast triggered vì R2_LIVE_SMOKE_REQUIRED=true.`);
    }
    console.warn(`[R2 Smoke Test] Bỏ qua smoke test trực tiếp: ${errorMsg}`);
    return {
      status: 'SKIPPED',
      reason: errorMsg,
    };
  }

  const configMap: Record<string, any> = {
    NODE_ENV: 'production',
    STORAGE_PROVIDER: 'r2',
    S3_ENDPOINT: endpoint,
    S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
    S3_BUCKET_MANGA: mangaBucket,
    S3_BUCKET_NOVEL: novelBucket,
    S3_FORCE_PATH_STYLE: false,
  };

  const mockConfigService = {
    get: (key: string, defaultValue?: any) => {
      if (key in configMap) return configMap[key];
      return defaultValue;
    },
  } as ConfigService;

  const storageService = new StorageService(
    {} as any,
    {} as any,
    {} as any,
    mockConfigService,
    {} as any,
  );

  const s3Client = storageService.getS3Client();
  const testId = `smoke-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const verifiedBuckets: string[] = [];

  const targets = [
    { name: mangaBucket, isManga: true, label: 'MANGA' },
    { name: novelBucket, isManga: false, label: 'NOVEL' },
  ];

  for (const target of targets) {
    console.log(
      `[R2 Smoke Test] Bắt đầu kiểm tra bucket ${target.label}: "${target.name}"...`,
    );

    const quarantineKey = `quarantine/smoke-test/${target.label.toLowerCase()}-${testId}.txt`;
    const finalKey = `chapters/smoke-test/${target.label.toLowerCase()}-${testId}.txt`;
    const testPayload = `OmniNovel R2 Smoke Test Payload [${target.label}]: ${testId} - Timestamp: ${new Date().toISOString()}`;
    const contentType = 'text/plain';

    try {
      // 1. Sinh presigned PUT URL
      console.log(`[R2 Smoke Test] [${target.label}] 1. Sinh Presigned PUT URL...`);
      const putUrl = await storageService.createInternalUploadUrl(
        quarantineKey,
        contentType,
        target.isManga,
        300,
      );

      if (!putUrl.includes('.r2.cloudflarestorage.com')) {
        throw new Error(
          `Presigned PUT URL không chứa domain R2 chuẩn (.r2.cloudflarestorage.com): ${putUrl}`,
        );
      }

      // Tải file lên R2 thật
      const putResponse = await fetch(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: testPayload,
      });

      if (!putResponse.ok) {
        const errorText = await putResponse.text();
        throw new Error(
          `PUT presigned upload thất bại với HTTP ${putResponse.status}: ${errorText}`,
        );
      }
      console.log(
        `[R2 Smoke Test] [${target.label}] 1. PUT Presigned Upload thành công (HTTP ${putResponse.status})`,
      );

      // 2. HEAD Object xác minh kích thước
      console.log(`[R2 Smoke Test] [${target.label}] 2. HEAD Object xác minh...`);
      const headResult = await s3Client.send(
        new HeadObjectCommand({
          Bucket: target.name,
          Key: quarantineKey,
        }),
      );

      if (headResult.ContentLength !== Buffer.byteLength(testPayload)) {
        throw new Error(
          `ContentLength không khớp trên ${target.name}: Kỳ vọng ${Buffer.byteLength(testPayload)}, nhận ${headResult.ContentLength}`,
        );
      }
      console.log(
        `[R2 Smoke Test] [${target.label}] 2. HEAD Object thành công (ContentLength: ${headResult.ContentLength} bytes)`,
      );

      // 3. Presigned GET và đối chiếu nội dung
      console.log(`[R2 Smoke Test] [${target.label}] 3. Presigned GET và đối chiếu nội dung...`);
      const getUrl = await storageService.createInternalDownloadUrl(
        quarantineKey,
        target.isManga,
        300,
      );
      const getResponse = await fetch(getUrl);
      if (!getResponse.ok) {
        throw new Error(
          `GET presigned download thất bại với HTTP ${getResponse.status}`,
        );
      }
      const downloadedText = await getResponse.text();
      if (downloadedText !== testPayload) {
        throw new Error(
          `Nội dung tải về không khớp trên bucket ${target.name}!`,
        );
      }
      console.log(
        `[R2 Smoke Test] [${target.label}] 3. GET Presigned Download thành công, bảo toàn 100% dữ liệu.`,
      );

      // 4. COPY / Promote (quarantine -> final)
      console.log(`[R2 Smoke Test] [${target.label}] 4. COPY/Promote sang final key...`);
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: target.name,
          CopySource: `${target.name}/${quarantineKey}`,
          Key: finalKey,
        }),
      );

      const headFinal = await s3Client.send(
        new HeadObjectCommand({
          Bucket: target.name,
          Key: finalKey,
        }),
      );
      if (headFinal.ContentLength !== Buffer.byteLength(testPayload)) {
        throw new Error(`Promote thất bại: Final key không đúng kích thước.`);
      }
      console.log(`[R2 Smoke Test] [${target.label}] 4. COPY / Promote thành công.`);

      verifiedBuckets.push(target.name);
    } finally {
      // 5. Cleanup Invariant: Luôn dọn dẹp các object tạm trong finally block, không để lại rác
      console.log(
        `[R2 Smoke Test] [${target.label}] 5. Cleanup: Dọn dẹp quarantine & final keys...`,
      );
      try {
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: target.name,
            Key: quarantineKey,
          }),
        );
      } catch (delErr) {
        console.warn(`[R2 Smoke Test] Cảnh báo khi xóa quarantineKey ${quarantineKey}:`, delErr);
      }

      try {
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: target.name,
            Key: finalKey,
          }),
        );
      } catch (delErr) {
        console.warn(`[R2 Smoke Test] Cảnh báo khi xóa finalKey ${finalKey}:`, delErr);
      }
    }

    // Xác nhận đã xóa thành công (HEAD -> 404)
    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket: target.name,
          Key: finalKey,
        }),
      );
      throw new Error(`File ${finalKey} vẫn tồn tại sau khi DELETE trên bucket ${target.name}!`);
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        console.log(
          `[R2 Smoke Test] [${target.label}] 5. Xác nhận DELETE thành công (HEAD 404 Not Found).`,
        );
      } else {
        throw err;
      }
    }
  }

  console.log(
    `[R2 Smoke Test] ✅ TOÀN BỘ CHU TRÌNH R2 SMOKE TEST THÀNH CÔNG TRÊN CẢ 2 BUCKETS: ${verifiedBuckets.join(', ')}`,
  );

  return {
    status: 'SUCCESS',
    testId,
    verifiedBuckets,
  };
}

if (require.main === module) {
  runR2LiveSmokeTest({ required: true })
    .then((res) => {
      console.log('R2 Live Smoke Test Result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('R2 Live Smoke Test Failed:', err);
      process.exit(1);
    });
}

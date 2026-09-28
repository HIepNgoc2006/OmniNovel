import { S3Client, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { StorageService } from '../storage.service';
import { ConfigService } from '@nestjs/config';

/**
 * Real Cloudflare R2 Smoke Test:
 * Kiểm tra chu trình vòng đời lưu trữ thật (End-to-End Live Storage Lifecycle):
 * 1. Presigned PUT -> Tải file lên R2 endpoint thật
 * 2. HEAD Object -> Xác minh file đã tồn tại và đúng kích thước/ETag trên R2
 * 3. Presigned GET -> Tải file về qua GET URL thật và đối chiếu payload
 * 4. COPY / Promote -> Sao chép từ quarantine sang final key trên R2
 * 5. DELETE -> Dọn dẹp cả quarantine và final key trên R2, xác minh HEAD trả về 404
 */
export async function runR2LiveSmokeTest(credentials?: {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  mangaBucket: string;
  novelBucket: string;
}) {
  const endpoint = credentials?.endpoint || process.env.S3_ENDPOINT;
  const accessKeyId = credentials?.accessKeyId || process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = credentials?.secretAccessKey || process.env.S3_SECRET_ACCESS_KEY;
  const mangaBucket = credentials?.mangaBucket || process.env.S3_BUCKET_MANGA || 'omninovel-manga';
  const novelBucket = credentials?.novelBucket || process.env.S3_BUCKET_NOVEL || 'omninovel-novel';

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    console.warn(
      '[R2 Smoke Test] Bỏ qua smoke test trực tiếp: Thiếu S3_ENDPOINT, S3_ACCESS_KEY_ID hoặc S3_SECRET_ACCESS_KEY.',
    );
    return {
      status: 'SKIPPED',
      reason: 'Missing Cloudflare R2 credentials (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY).',
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

  const testId = `smoke-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const quarantineKey = `quarantine/smoke-test/${testId}.txt`;
  const finalKey = `chapters/smoke-test/${testId}.txt`;
  const testPayload = `OmniNovel R2 Smoke Test Payload: ${testId} - Timestamp: ${new Date().toISOString()}`;
  const contentType = 'text/plain';

  console.log(`[R2 Smoke Test] Bắt đầu kiểm tra trên bucket "${mangaBucket}"...`);

  // 1. Sinh presigned PUT URL
  console.log(`[R2 Smoke Test] 1. Sinh Presigned PUT URL cho ${quarantineKey}...`);
  const putUrl = await storageService.createInternalUploadUrl(quarantineKey, contentType, true, 300);
  if (!putUrl.includes('.r2.cloudflarestorage.com')) {
    throw new Error(`Presigned PUT URL không trỏ về R2: ${putUrl}`);
  }

  // Thực hiện PUT tải lên R2
  const putResponse = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
    },
    body: testPayload,
  });

  if (!putResponse.ok) {
    const errorText = await putResponse.text();
    throw new Error(`PUT presigned upload thất bại với HTTP ${putResponse.status}: ${errorText}`);
  }
  console.log(`[R2 Smoke Test] 1. PUT Presigned Upload thành công (HTTP ${putResponse.status})`);

  // 2. HEAD Object
  console.log(`[R2 Smoke Test] 2. HEAD Object kiểm tra metadata...`);
  const s3Client = storageService.getS3Client();
  const headResult = await s3Client.send(
    new HeadObjectCommand({
      Bucket: mangaBucket,
      Key: quarantineKey,
    }),
  );

  if (headResult.ContentLength !== Buffer.byteLength(testPayload)) {
    throw new Error(
      `ContentLength không khớp: Kỳ vọng ${Buffer.byteLength(testPayload)}, nhận được ${headResult.ContentLength}`,
    );
  }
  console.log(`[R2 Smoke Test] 2. HEAD Object thành công (ContentLength: ${headResult.ContentLength} bytes)`);

  // 3. Presigned GET
  console.log(`[R2 Smoke Test] 3. Sinh Presigned GET URL và tải về...`);
  const getUrl = await storageService.createInternalDownloadUrl(quarantineKey, true, 300);
  const getResponse = await fetch(getUrl);
  if (!getResponse.ok) {
    throw new Error(`GET presigned download thất bại với HTTP ${getResponse.status}`);
  }
  const downloadedText = await getResponse.text();
  if (downloadedText !== testPayload) {
    throw new Error(`Nội dung tải về không khớp với nội dung đã upload!`);
  }
  console.log(`[R2 Smoke Test] 3. GET Presigned Download thành công và bảo toàn 100% nội dung.`);

  // 4. COPY / Promote (Sao chép từ quarantine -> final)
  console.log(`[R2 Smoke Test] 4. COPY / Promote Object sang ${finalKey}...`);
  await s3Client.send(
    new CopyObjectCommand({
      Bucket: mangaBucket,
      CopySource: `${mangaBucket}/${quarantineKey}`,
      Key: finalKey,
    }),
  );

  const headFinal = await s3Client.send(
    new HeadObjectCommand({
      Bucket: mangaBucket,
      Key: finalKey,
    }),
  );
  if (headFinal.ContentLength !== Buffer.byteLength(testPayload)) {
    throw new Error(`Promote thất bại: Final key không có đúng kích thước.`);
  }
  console.log(`[R2 Smoke Test] 4. COPY / Promote thành công.`);

  // 5. DELETE (Dọn dẹp cả hai key)
  console.log(`[R2 Smoke Test] 5. DELETE dọn dẹp các key tạm...`);
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: mangaBucket,
      Key: quarantineKey,
    }),
  );
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: mangaBucket,
      Key: finalKey,
    }),
  );

  // Xác minh đã bị xóa
  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: mangaBucket,
        Key: finalKey,
      }),
    );
    throw new Error(`File ${finalKey} vẫn tồn tại sau khi DELETE!`);
  } catch (err: any) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      console.log(`[R2 Smoke Test] 5. DELETE xác nhận thành công (HEAD trả về 404 Not Found).`);
    } else {
      throw err;
    }
  }

  console.log(`[R2 Smoke Test] ✅ TOÀN BỘ CHU TRÌNH R2 SMOKE TEST THÀNH CÔNG RỰC RỠ!`);
  return {
    status: 'SUCCESS',
    testId,
    bucket: mangaBucket,
  };
}

if (require.main === module) {
  runR2LiveSmokeTest()
    .then((res) => {
      console.log('Result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Smoke test failed:', err);
      process.exit(1);
    });
}

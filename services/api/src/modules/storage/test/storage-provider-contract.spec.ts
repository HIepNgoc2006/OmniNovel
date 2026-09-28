import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { StorageService } from '../storage.service';
import { UploadSession } from '../entities/upload-session.entity';
import { MediaAsset } from '../../chapters/entities/media-asset.entity';
import { StoryEdition } from '../../stories/entities/story-edition.entity';

describe('StorageService Provider-Neutral Contract (MinIO Local vs Cloudflare R2 Production)', () => {
  const mockSessionRepo = {};
  const mockMediaAssetRepo = {};
  const mockEditionRepo = {};
  const mockDataSource = {};

  const createServiceWithConfig = async (configMap: Record<string, any>): Promise<StorageService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: getRepositoryToken(UploadSession), useValue: mockSessionRepo },
        { provide: getRepositoryToken(MediaAsset), useValue: mockMediaAssetRepo },
        { provide: getRepositoryToken(StoryEdition), useValue: mockEditionRepo },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultVal?: any) => {
              if (key in configMap) {
                return configMap[key];
              }
              return defaultVal;
            }),
          },
        },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    return module.get<StorageService>(StorageService);
  };

  describe('1. Cloudflare R2 Production Configuration & Presigned URLs', () => {
    it('should initialize S3Client with Cloudflare R2 endpoint, auto region, and virtual-hosted style', async () => {
      const r2Config = {
        NODE_ENV: 'production',
        STORAGE_PROVIDER: 'r2',
        S3_ENDPOINT: 'https://0123456789abcdef.r2.cloudflarestorage.com',
        S3_REGION: 'auto',
        S3_ACCESS_KEY_ID: 'r2-test-access-key',
        S3_SECRET_ACCESS_KEY: 'r2-test-secret-key-12345',
        S3_BUCKET_MANGA: 'prod-omninovel-manga',
        S3_BUCKET_NOVEL: 'prod-omninovel-novel',
        S3_FORCE_PATH_STYLE: false,
      };

      const service = await createServiceWithConfig(r2Config);

      // Verify Buckets SSoT
      const buckets = service.getBucketConfig();
      expect(buckets.mangaBucket).toBe('prod-omninovel-manga');
      expect(buckets.novelBucket).toBe('prod-omninovel-novel');

      // Verify S3 Client Configuration
      const s3Client = service.getS3Client();
      expect(s3Client).toBeDefined();

      const resolvedEndpoint = await s3Client.config.endpoint();
      expect(resolvedEndpoint.protocol).toBe('https:');
      expect(resolvedEndpoint.hostname).toBe('0123456789abcdef.r2.cloudflarestorage.com');

      const resolvedRegion = await s3Client.config.region();
      expect(resolvedRegion).toBe('auto');

      const forcePathStyle = await (s3Client.config as any).forcePathStyle;
      expect(forcePathStyle).toBe(false);
    });

    it('should generate valid presigned PUT URL bound to Cloudflare R2 S3 API domain', async () => {
      const service = await createServiceWithConfig({
        STORAGE_PROVIDER: 'r2',
        S3_ENDPOINT: 'https://0123456789abcdef.r2.cloudflarestorage.com',
        S3_REGION: 'auto',
        S3_ACCESS_KEY_ID: 'r2-test-access-key',
        S3_SECRET_ACCESS_KEY: 'r2-test-secret-key-12345',
        S3_BUCKET_MANGA: 'prod-manga',
        S3_BUCKET_NOVEL: 'prod-novel',
        S3_FORCE_PATH_STYLE: false,
      });

      const presignedUrl = await service.createInternalUploadUrl('chapters/test-ch-1/p1.webp', 'image/webp', true, 600);
      expect(presignedUrl).toContain('r2.cloudflarestorage.com');
      expect(presignedUrl).toContain('X-Amz-Signature=');
      expect(presignedUrl).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    });

    it('should generate valid presigned GET URL bound to Cloudflare R2 S3 API domain', async () => {
      const service = await createServiceWithConfig({
        STORAGE_PROVIDER: 'r2',
        S3_ENDPOINT: 'https://0123456789abcdef.r2.cloudflarestorage.com',
        S3_REGION: 'auto',
        S3_ACCESS_KEY_ID: 'r2-test-access-key',
        S3_SECRET_ACCESS_KEY: 'r2-test-secret-key-12345',
        S3_BUCKET_MANGA: 'prod-manga',
        S3_BUCKET_NOVEL: 'prod-novel',
        S3_FORCE_PATH_STYLE: false,
      });

      const presignedUrl = await service.createInternalDownloadUrl('chapters/test-ch-1/p1.webp', true, 3600);
      expect(presignedUrl).toContain('r2.cloudflarestorage.com');
      expect(presignedUrl).toContain('X-Amz-Signature=');
      expect(presignedUrl).toContain('X-Amz-Expires=3600');
    });
  });

  describe('2. Fail-Fast Production Misconfiguration Guards', () => {
    it('should FAIL-FAST when STORAGE_PROVIDER is r2 but S3_ENDPOINT is missing', async () => {
      await expect(
        createServiceWithConfig({
          STORAGE_PROVIDER: 'r2',
          S3_ACCESS_KEY_ID: 'key',
          S3_SECRET_ACCESS_KEY: 'secret',
          S3_BUCKET_MANGA: 'manga',
          S3_BUCKET_NOVEL: 'novel',
        }),
      ).rejects.toThrow('Production / R2 Storage Misconfiguration: Missing required environment variables: S3_ENDPOINT');
    });

    it('should FAIL-FAST when NODE_ENV is production and credentials / buckets are missing', async () => {
      await expect(
        createServiceWithConfig({
          NODE_ENV: 'production',
          // No S3_* variables provided
        }),
      ).rejects.toThrow('Production / R2 Storage Misconfiguration: Missing required environment variables');
    });

    it('should NEVER silently fallback to minioadmin or localhost in production', async () => {
      await expect(
        createServiceWithConfig({
          NODE_ENV: 'production',
          STORAGE_PROVIDER: 'r2',
          MINIO_ENDPOINT: 'localhost',
          MINIO_ACCESS_KEY: 'minioadmin',
          MINIO_SECRET_KEY: 'minioadmin',
        }),
      ).rejects.toThrow('Production / R2 Storage Misconfiguration');
    });

    it('should FAIL-FAST when STORAGE_PROVIDER is invalid (e.g. typo r22)', async () => {
      await expect(
        createServiceWithConfig({
          NODE_ENV: 'development',
          STORAGE_PROVIDER: 'r22',
        }),
      ).rejects.toThrow("Invalid STORAGE_PROVIDER: 'r22'");
    });
  });

  describe('3. Local Dev & CI Backward Compatibility (MinIO Zero Regression)', () => {
    it('should fallback cleanly to MINIO_* variables when STORAGE_PROVIDER is minio in development', async () => {
      const minioConfig = {
        NODE_ENV: 'development',
        STORAGE_PROVIDER: 'minio',
        MINIO_ENDPOINT: 'localhost',
        MINIO_PORT: 9000,
        MINIO_USE_SSL: false,
        MINIO_ACCESS_KEY: 'minioadmin',
        MINIO_SECRET_KEY: 'minioadmin',
        MINIO_BUCKET_MANGA: 'manga-media',
        MINIO_BUCKET_NOVEL: 'novel-media',
      };

      const service = await createServiceWithConfig(minioConfig);

      const buckets = service.getBucketConfig();
      expect(buckets.mangaBucket).toBe('manga-media');
      expect(buckets.novelBucket).toBe('novel-media');

      const s3Client = service.getS3Client();
      const resolvedEndpoint = await s3Client.config.endpoint();
      expect(resolvedEndpoint.protocol).toBe('http:');
      expect(resolvedEndpoint.hostname).toBe('localhost');
      expect(resolvedEndpoint.port).toBe(9000);

      const resolvedRegion = await s3Client.config.region();
      expect(resolvedRegion).toBe('us-east-1');

      const forcePathStyle = await (s3Client.config as any).forcePathStyle;
      expect(forcePathStyle).toBe(true);
    });

    it('should support S3_* variables in development mode when specified', async () => {
      const devS3Config = {
        NODE_ENV: 'development',
        STORAGE_PROVIDER: 'minio',
        S3_ENDPOINT: 'http://custom-minio:9000',
        S3_ACCESS_KEY_ID: 'custom-key',
        S3_SECRET_ACCESS_KEY: 'custom-secret',
        S3_BUCKET_MANGA: 'dev-manga',
        S3_BUCKET_NOVEL: 'dev-novel',
      };

      const service = await createServiceWithConfig(devS3Config);

      const buckets = service.getBucketConfig();
      expect(buckets.mangaBucket).toBe('dev-manga');
      expect(buckets.novelBucket).toBe('dev-novel');

      const s3Client = service.getS3Client();
      const resolvedEndpoint = await s3Client.config.endpoint();
      expect(resolvedEndpoint.hostname).toBe('custom-minio');
    });
  });
});

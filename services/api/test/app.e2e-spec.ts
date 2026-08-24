import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import axios from 'axios';
const AdmZip = require('adm-zip');
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/http-exception.filter';
import {
  GlobalRole,
  StoryVisibility,
  MediaFormat,
  PublicationFormat,
  ChapterVersionType,
  StoryMemberRole,
} from '@omninovel/shared';
import { AllowedUploadFileType } from '../src/modules/storage/dto/create-upload-session.dto';

describe('OmniNovel Backend Core API (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  // Tokens & Cookies
  let readerUserId: string;
  let readerAccessToken: string;
  let readerRefreshTokenCookie: string;

  let translatorAAccessToken: string;
  let translatorARefreshTokenCookie: string;

  let translatorBAccessToken: string;

  // Resource IDs
  let storyAId: string;
  let storyASlug: string;
  let editionAId: string;
  let volumeAId: string;
  let chapterAId: string;
  let versionA1Id: string;
  let versionA2Id: string;

  let storyBId: string;
  let editionBId: string;
  let volumeBId: string;
  let chapterBId: string;

  let testAssetId: string;

  const testReader = {
    username: `reader_${Date.now()}`,
    email: `reader_${Date.now()}@omninovel.com`,
    password: 'Password123@Secure',
  };

  const testTranslatorA = {
    username: `translatorA_${Date.now()}`,
    email: `translatorA_${Date.now()}@omninovel.com`,
    password: 'Password123@Secure',
  };

  const testTranslatorB = {
    username: `translatorB_${Date.now()}`,
    email: `translatorB_${Date.now()}@omninovel.com`,
    password: 'Password123@Secure',
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.setGlobalPrefix('api/v1', {
      exclude: ['health/live', 'health/ready'],
    });

    await app.init();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  // ==========================================
  // 1. HEALTH CHECKS
  // ==========================================
  describe('1. Health Checks', () => {
    it('GET /health/live should return UP status', () => {
      return request(app.getHttpServer())
        .get('/health/live')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('UP');
          expect(res.body.timestamp).toBeDefined();
        });
    });

    it('GET /health/ready should verify Postgres & Redis UP', () => {
      return request(app.getHttpServer())
        .get('/health/ready')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('UP');
          expect(res.body.services.database).toBe('UP');
          expect(res.body.services.redis).toBe('UP');
        });
    });
  });

  // ==========================================
  // 2. AUTHENTICATION, REFRESH ROTATION & TOKEN FAMILY REVOCATION
  // ==========================================
  describe('2. Authentication Module, Token Lifecycle & Token Family Revocation', () => {
    it('POST /api/v1/auth/register should create user and user_progression in single transaction', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(testReader)
        .expect(201);

      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe(testReader.username);
      expect(res.body.user.role).toBe(GlobalRole.READER);
      readerUserId = res.body.user.id;

      const prog = await dataSource.query(
        `SELECT * FROM user_progression WHERE user_id = $1`,
        [res.body.user.id],
      );
      expect(prog.length).toBe(1);
      expect(prog[0].level).toBe(1);
      expect(prog[0].total_exp.toString()).toBe('0');
      expect(prog[0].omnicoin_balance.toString()).toBe('0');
      expect(prog[0].current_streak).toBe(0);
      expect(prog[0].max_streak).toBe(0);
      expect(prog[0].last_checkin_date).toBeNull();
      expect(prog[0].rank_theme_id).toBe('DEFAULT');
    });

    it('POST /api/v1/auth/register should return 409 Conflict on duplicate email/username', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(testReader)
        .expect(409);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('POST /api/v1/auth/login should authenticate with Argon2id and set httpOnly cookie', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          identifier: testReader.email,
          password: testReader.password,
        })
        .expect(200);

      expect(res.body.accessToken).toBeDefined();
      readerAccessToken = res.body.accessToken;

      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      readerRefreshTokenCookie = (cookies as unknown as string[])[0];
      expect(readerRefreshTokenCookie).toContain('refreshToken=');
      expect(readerRefreshTokenCookie).toContain('HttpOnly');
    });

    it('POST /api/v1/auth/refresh should rotate token and return new access token', async () => {
      const oldCookie = readerRefreshTokenCookie;

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', oldCookie)
        .expect(200);

      expect(res.body.accessToken).toBeDefined();
      readerAccessToken = res.body.accessToken;

      const newCookies = res.headers['set-cookie'];
      expect(newCookies).toBeDefined();
      readerRefreshTokenCookie = (newCookies as unknown as string[])[0];

      // Thử dùng lại refreshToken cũ (Token A) -> Bị phát hiện reuse và thu hồi toàn bộ Token Family!
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', oldCookie)
        .expect(401);

      // CHỨNG MINH WHOLE TOKEN FAMILY REVOCATION:
      // Thử dùng Token B (vừa được cấp mới ở trên) -> Phải bị 401 Unauthorized vì toàn bộ Family đã bị revoke!
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', readerRefreshTokenCookie)
        .expect(401);
    });

    it('GET /api/v1/auth/me should return reader profile and permissions', async () => {
      // Đăng nhập lại để có active session
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          identifier: testReader.email,
          password: testReader.password,
        });
      readerAccessToken = loginRes.body.accessToken;
      readerRefreshTokenCookie = (loginRes.headers['set-cookie'] as unknown as string[])[0];

      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .expect(200);

      expect(res.body.user.username).toBe(testReader.username);
      expect(res.body.permissions.canCreateStory).toBe(false);
      expect(res.body.permissions.isAdmin).toBe(false);
    });

    it('POST /api/v1/auth/logout should revoke session on Redis and subsequent refresh fails with 401', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', readerRefreshTokenCookie)
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', readerRefreshTokenCookie)
        .expect(401);
    });
  });

  // ==========================================
  // 3. RBAC, STORY CATALOG & PRIVACY ENFORCEMENT
  // ==========================================
  describe('3. RBAC & Story Catalog Security', () => {
    beforeAll(async () => {
      // Đăng ký Translator A
      await request(app.getHttpServer()).post('/api/v1/auth/register').send(testTranslatorA);
      await dataSource.query(`UPDATE users SET role = 'TRANSLATOR' WHERE email = $1`, [testTranslatorA.email]);
      const loginA = await request(app.getHttpServer()).post('/api/v1/auth/login').send({
        identifier: testTranslatorA.email,
        password: testTranslatorA.password,
      });
      translatorAAccessToken = loginA.body.accessToken;
      translatorARefreshTokenCookie = (loginA.headers['set-cookie'] as unknown as string[])[0];

      // Đăng ký Translator B
      await request(app.getHttpServer()).post('/api/v1/auth/register').send(testTranslatorB);
      await dataSource.query(`UPDATE users SET role = 'TRANSLATOR' WHERE email = $1`, [testTranslatorB.email]);
      const loginB = await request(app.getHttpServer()).post('/api/v1/auth/login').send({
        identifier: testTranslatorB.email,
        password: testTranslatorB.password,
      });
      translatorBAccessToken = loginB.body.accessToken;

      // Đăng nhập lại Reader
      const readerLogin = await request(app.getHttpServer()).post('/api/v1/auth/login').send({
        identifier: testReader.email,
        password: testReader.password,
      });
      readerAccessToken = readerLogin.body.accessToken;
    });

    it('POST /api/v1/studio/stories should block READER with 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/studio/stories')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({
          title: 'Truyện Độc Quyền Test',
          mediaFormat: MediaFormat.COMIC,
          publicationFormat: PublicationFormat.MANGA,
          coverUrl: 'https://example.com/cover.jpg',
        })
        .expect(403);
    });

    it('POST /api/v1/studio/stories should allow Translator A and transactionally create Story, Owner, Default Edition', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/studio/stories')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          title: `Đại Quản Gia Là Ma Hoàng ${Date.now()}`,
          mediaFormat: MediaFormat.COMIC,
          publicationFormat: PublicationFormat.MANGA,
          originCountry: 'CN',
          originalLanguage: 'zh',
          coverUrl: 'https://example.com/cover.jpg',
          summary: 'Tác phẩm huyền huyễn kinh điển.',
        })
        .expect(201);

      expect(res.body.storyId).toBeDefined();
      expect(res.body.defaultEditionId).toBeDefined();
      storyAId = res.body.storyId;
      storyASlug = res.body.slug;
      editionAId = res.body.defaultEditionId;

      const members = await dataSource.query(
        `SELECT role FROM story_members WHERE story_id = $1`,
        [storyAId],
      );
      expect(members.length).toBe(1);
      expect(members[0].role).toBe(StoryMemberRole.OWNER);
    });

    it('POST /api/v1/studio/stories should allow Translator B to create Story B', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/studio/stories')
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .send({
          title: `Toàn Chức Pháp Sư ${Date.now()}`,
          mediaFormat: MediaFormat.NOVEL,
          publicationFormat: PublicationFormat.LIGHT_NOVEL,
          coverUrl: 'https://example.com/cover.jpg',
        })
        .expect(201);

      storyBId = res.body.storyId;
      editionBId = res.body.defaultEditionId;
    });

    it('GET /api/v1/stories/rankings should return top rankings feed', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/stories/rankings')
        .expect(200);

      expect(res.body.topComics).toBeDefined();
      expect(res.body.topNovels).toBeDefined();
    });

    it('POST /api/v1/studio/stories/:id/editions should allow Story Owner to create second Edition', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/studio/stories/${storyAId}/editions`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          editionName: 'Bản Dịch Tiếng Anh (English)',
          language: 'en',
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
    });

    it('POST /api/v1/studio/editions/:editionId/volumes should create Volume', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/studio/editions/${editionAId}/volumes`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          volumeNumber: 1,
          title: 'Quyển 1: Lạc Gia Phong Vân',
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      volumeAId = res.body.id;
    });

    it('PATCH /api/v1/stories/:id/visibility should allow Owner to change to UNLISTED', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/stories/${storyAId}/visibility`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({ visibility: StoryVisibility.UNLISTED })
        .expect(200);

      expect(res.body.visibility).toBe(StoryVisibility.UNLISTED);
    });

    it('GET /api/v1/stories/:slug should allow anonymous access for UNLISTED story via direct URL', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/stories/${storyASlug}`)
        .expect(200);

      expect(res.body.id).toBe(storyAId);
    });

    it('PATCH /api/v1/stories/:id/visibility should allow Owner to change to PRIVATE', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/stories/${storyAId}/visibility`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({ visibility: StoryVisibility.PRIVATE })
        .expect(200);
    });

    it('GET /api/v1/stories/:slug should block anonymous access on PRIVATE story with 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/stories/${storyASlug}`)
        .expect(403);
    });

    it('GET /api/v1/stories/:slug should block unauthorized user on PRIVATE story with 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/stories/${storyASlug}`)
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .expect(403);
    });

    it('GET /api/v1/stories/:slug should allow Story Owner to access PRIVATE story with 200 OK', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/stories/${storyASlug}`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(200);

      expect(res.body.id).toBe(storyAId);
    });
  });

  // ==========================================
  // 4. CROSS-RESOURCE IDOR PROTECTION & CHAPTER HIERARCHY
  // ==========================================
  describe('4. Chapter Management, IDOR Protection & Invariant Hierarchy', () => {
    beforeAll(async () => {
      // Đổi lại Story A sang PUBLIC để test chapter reading
      await dataSource.query(`UPDATE stories SET visibility = 'PUBLIC' WHERE id = $1`, [storyAId]);

      // Tạo Volume B cho Story B
      const resVolB = await request(app.getHttpServer())
        .post(`/api/v1/studio/editions/${editionBId}/volumes`)
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .send({ volumeNumber: 1, title: 'Tập 1' });
      volumeBId = resVolB.body.id;
    });

    it('POST /api/v1/studio/editions/:editionId/chapters should block IDOR: Translator B cannot create chapter on Edition of Story A', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/studio/editions/${editionAId}/chapters`)
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .send({
          chapterNumber: '1.00',
          title: 'Hồi 1: Trùng Sinh',
        })
        .expect(403); // Cross-Story IDOR Blocked!
    });

    it('POST /api/v1/studio/editions/:editionId/chapters should reject mismatched volumeId (Hierarchy Violation)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/studio/editions/${editionAId}/chapters`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          chapterNumber: '1.00',
          title: 'Hồi 1: Trùng Sinh',
          volumeId: volumeBId, // SAI HIERARCHY
        })
        .expect(400);
    });

    it('POST /api/v1/studio/editions/:editionId/chapters should succeed with correct Volume and Story Owner', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/studio/editions/${editionAId}/chapters`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          chapterNumber: '1.00',
          title: 'Hồi 1: Trùng Sinh',
          volumeId: volumeAId,
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      chapterAId = res.body.id;
    });

    it('POST /api/v1/studio/chapters/:id/versions should block IDOR: Translator B cannot create version on Chapter A', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/studio/chapters/${chapterAId}/versions`)
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .send({
          versionType: ChapterVersionType.RAW_ORIGINAL,
          language: 'vi',
        })
        .expect(403); // IDOR Blocked!
    });

    it('POST /api/v1/studio/chapters/:id/versions should create immutable version 1 (auto active) and version 2', async () => {
      const res1 = await request(app.getHttpServer())
        .post(`/api/v1/studio/chapters/${chapterAId}/versions`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          versionType: ChapterVersionType.RAW_ORIGINAL,
          language: 'vi',
        })
        .expect(201);

      versionA1Id = res1.body.id;
      expect(res1.body.versionNumber).toBe(1);

      const res2 = await request(app.getHttpServer())
        .post(`/api/v1/studio/chapters/${chapterAId}/versions`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          versionType: ChapterVersionType.HUMAN_EDITED,
          language: 'vi',
        })
        .expect(201);

      versionA2Id = res2.body.id;
      expect(res2.body.versionNumber).toBe(2);
    });

    it('PATCH /api/v1/studio/chapters/:id/active-version should block Story TRANSLATOR from activating version (Must be EDITOR/OWNER)', async () => {
      const userC = {
        username: `transC_${Date.now()}`,
        email: `transC_${Date.now()}@omninovel.com`,
        password: 'Password123@Secure',
      };
      const regC = await request(app.getHttpServer()).post('/api/v1/auth/register').send(userC);
      await dataSource.query(`UPDATE users SET role = 'TRANSLATOR' WHERE id = $1`, [regC.body.user.id]);
      await dataSource.query(
        `INSERT INTO story_members (story_id, user_id, role) VALUES ($1, $2, 'TRANSLATOR')`,
        [storyAId, regC.body.user.id],
      );

      const loginC = await request(app.getHttpServer()).post('/api/v1/auth/login').send({
        identifier: userC.email,
        password: userC.password,
      });

      // Role TRANSLATOR trong story cố kích hoạt version -> Phải bị chặn với 403 Forbidden!
      await request(app.getHttpServer())
        .patch(`/api/v1/studio/chapters/${chapterAId}/active-version`)
        .set('Authorization', `Bearer ${loginC.body.accessToken}`)
        .send({ versionId: versionA2Id })
        .expect(403);

      // Nâng User C lên Story EDITOR
      await dataSource.query(
        `UPDATE story_members SET role = 'EDITOR' WHERE story_id = $1 AND user_id = $2`,
        [storyAId, regC.body.user.id],
      );

      // Role EDITOR kích hoạt version -> Thành công 200 OK!
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/studio/chapters/${chapterAId}/active-version`)
        .set('Authorization', `Bearer ${loginC.body.accessToken}`)
        .send({ versionId: versionA2Id })
        .expect(200);

      expect(res.body.activeVersionId).toBe(versionA2Id);
    });

    it('PATCH /api/v1/studio/chapters/:id/active-version should reject version belonging to different chapter (Same-Chapter Invariant)', async () => {
      const chB = await request(app.getHttpServer())
        .post(`/api/v1/studio/editions/${editionBId}/chapters`)
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .send({ chapterNumber: '1.00', title: 'Chương 1' });
      chapterBId = chB.body.id;

      const vB = await request(app.getHttpServer())
        .post(`/api/v1/studio/chapters/${chapterBId}/versions`)
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .send({ versionType: ChapterVersionType.RAW_ORIGINAL, language: 'vi' });

      await request(app.getHttpServer())
        .patch(`/api/v1/studio/chapters/${chapterAId}/active-version`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({ versionId: vB.body.id })
        .expect(400);
    });

    it('GET /api/v1/chapters/:id should return chapter details and active version for public readers', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/chapters/${chapterAId}`)
        .expect(200);

      expect(res.body.chapter.id).toBe(chapterAId);
      expect(res.body.chapter.activeVersionId).toBe(versionA2Id);
      expect(res.body.activeVersion).toBeDefined();
    });
  });

  // ==========================================
  // 5. STORAGE MINIO: QUARANTINE -> VALIDATE -> PROMOTE & PRESIGNED ACCESS
  // ==========================================
  describe('5. MinIO Storage Security & Upload Lifecycle', () => {
    let validSessionId: string;
    let validUploadUrl: string;

    let spoofSessionId: string;
    let spoofUploadUrl: string;

    let zipSlipSessionId: string;
    let zipSlipUploadUrl: string;

    it('MinIO direct anonymous access to media bucket should be rejected with 403 Forbidden', async () => {
      try {
        await axios.get('http://localhost:9000/manga-media/test.png');
        fail('MinIO anonymous access should have failed!');
      } catch (err: any) {
        expect(err.response?.status).toBe(403);
      }
    });

    it('POST /api/v1/uploads/sessions should block outsider with 403 Forbidden (IDOR Blocked)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/uploads/sessions')
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .send({
          storyEditionId: editionAId, // Translator B cố tạo session trên Story A
          fileType: AllowedUploadFileType.MANGA_IMAGE,
          expectedSize: 1024,
        })
        .expect(403);
    });

    it('POST /api/v1/uploads/sessions should allow Story Member and return Presigned PUT URL in Quarantine', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/uploads/sessions')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          storyEditionId: editionAId,
          chapterVersionId: versionA2Id,
          fileType: AllowedUploadFileType.MANGA_IMAGE,
          expectedSize: 33, // Khớp chính xác 33 bytes của validPngBuffer
        })
        .expect(201);

      expect(res.body.sessionId).toBeDefined();
      expect(res.body.uploadUrl).toBeDefined();
      expect(res.body.quarantineKey).toContain('quarantine/editions/');
      validSessionId = res.body.sessionId;
      validUploadUrl = res.body.uploadUrl;
    });

    it('Presigned PUT Upload and Finalize Valid PNG Image should succeed and promote to MediaAsset', async () => {
      // 1. Tạo buffer PNG thật 33 bytes với đúng Magic Bytes [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
      const validPngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
      ]);

      // Upload trực tiếp lên MinIO qua Presigned URL
      const uploadRes = await axios.put(validUploadUrl, validPngBuffer, {
        headers: { 'Content-Type': 'image/png' },
      });
      expect(uploadRes.status).toBe(200);

      // Thử cố tình finalize bằng tài khoản không có quyền -> 403 Forbidden và session vẫn giữ nguyên PENDING
      await request(app.getHttpServer())
        .post(`/api/v1/uploads/sessions/${validSessionId}/finalize`)
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .expect(403);

      const checkPending = await dataSource.query(
        `SELECT status FROM upload_sessions WHERE id = $1`,
        [validSessionId],
      );
      expect(checkPending[0].status).toBe('PENDING');

      // 2. Finalize & Validate hợp lệ bằng Story Owner
      const finalizeRes = await request(app.getHttpServer())
        .post(`/api/v1/uploads/sessions/${validSessionId}/finalize`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(200);

      expect(finalizeRes.body.status).toBe('PROMOTED');
      expect(finalizeRes.body.finalKey).toContain('media/editions/');
      expect(finalizeRes.body.mediaAsset).toBeDefined();
      testAssetId = finalizeRes.body.mediaAsset.id;
    });

    it('Finalize with expectedSize mismatch should be rejected with 400 Bad Request', async () => {
      const sessRes = await request(app.getHttpServer())
        .post('/api/v1/uploads/sessions')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          storyEditionId: editionAId,
          fileType: AllowedUploadFileType.MANGA_IMAGE,
          expectedSize: 5000, // Khai báo 5000 bytes
        })
        .expect(201);

      // Nhưng chỉ upload 10 bytes
      await axios.put(sessRes.body.uploadUrl, Buffer.from('1234567890'), {
        headers: { 'Content-Type': 'image/png' },
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/uploads/sessions/${sessRes.body.sessionId}/finalize`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(400);

      expect(res.body.error.message).toContain('không khớp với expectedSize');
    });

    it('Finalize with MIME Spoofing (Text bytes disguised as Image) should be rejected and purged from quarantine', async () => {
      const fakePayload = Buffer.from('FAKE_MALICIOUS_SCRIPT_PAYLOAD_NOT_IMAGE_123456');
      const sessRes = await request(app.getHttpServer())
        .post('/api/v1/uploads/sessions')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          storyEditionId: editionAId,
          fileType: AllowedUploadFileType.MANGA_IMAGE,
          expectedSize: fakePayload.length,
        })
        .expect(201);
      spoofSessionId = sessRes.body.sessionId;
      spoofUploadUrl = sessRes.body.uploadUrl;

      // Upload payload độc hại giả mạo
      await axios.put(spoofUploadUrl, fakePayload, {
        headers: { 'Content-Type': 'image/png' },
      });

      // Finalize -> Phải bị từ chối 400 Bad Request
      const res = await request(app.getHttpServer())
        .post(`/api/v1/uploads/sessions/${spoofSessionId}/finalize`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(400);

      expect(res.body.error.message).toContain('Magic bytes không khớp');
    });

    it('Finalize with Path Traversal / Zip Slip entry should be rejected', async () => {
      const zip = new AdmZip();
      zip.addFile('validfile.txt', Buffer.from('malicious payload'));
      let zipBuffer = zip.toBuffer();
      const searchTarget = Buffer.from('validfile.txt');
      const replaceWith = Buffer.from('../evil.txt');
      let idx = zipBuffer.indexOf(searchTarget);
      while (idx !== -1) {
        replaceWith.copy(zipBuffer, idx);
        idx = zipBuffer.indexOf(searchTarget, idx + 1);
      }

      const sessRes = await request(app.getHttpServer())
        .post('/api/v1/uploads/sessions')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          storyEditionId: editionAId,
          fileType: AllowedUploadFileType.MANGA_ZIP,
          expectedSize: zipBuffer.length,
        })
        .expect(201);
      zipSlipSessionId = sessRes.body.sessionId;
      zipSlipUploadUrl = sessRes.body.uploadUrl;

      await axios.put(zipSlipUploadUrl, zipBuffer, {
        headers: { 'Content-Type': 'application/zip' },
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/uploads/sessions/${zipSlipSessionId}/finalize`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(400);

      expect(res.body.error.message).toContain('Zip Slip');
    });

    it('Finalize valid EPUB structure should succeed and mark as raw source package', async () => {
      const epubZip = new AdmZip();
      epubZip.addFile('mimetype', Buffer.from('application/epub+zip'));
      epubZip.addFile(
        'META-INF/container.xml',
        Buffer.from('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
      );
      const epubBuffer = epubZip.toBuffer();

      const sessRes = await request(app.getHttpServer())
        .post('/api/v1/uploads/sessions')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          storyEditionId: editionAId,
          fileType: AllowedUploadFileType.NOVEL_EPUB,
          expectedSize: epubBuffer.length,
        })
        .expect(201);

      await axios.put(sessRes.body.uploadUrl, epubBuffer, {
        headers: { 'Content-Type': 'application/epub+zip' },
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/uploads/sessions/${sessRes.body.sessionId}/finalize`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(200);

      expect(res.body.status).toBe('PROMOTED');
      expect(res.body.isRawSourcePackage).toBe(true);
    });

    it('Finalize Markdown with dangerous script tags should be rejected (XSS Blocked)', async () => {
      const maliciousMd = Buffer.from('# Chương 1\n<script>alert("XSS Attack");</script>\nNội dung truyện...');
      const sessRes = await request(app.getHttpServer())
        .post('/api/v1/uploads/sessions')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          storyEditionId: editionAId,
          fileType: AllowedUploadFileType.NOVEL_MD,
          expectedSize: maliciousMd.length,
        })
        .expect(201);

      await axios.put(sessRes.body.uploadUrl, maliciousMd, {
        headers: { 'Content-Type': 'text/markdown' },
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/uploads/sessions/${sessRes.body.sessionId}/finalize`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(400);

      expect(res.body.error.message).toContain('XSS Blocked');
    });

    it('GET /api/v1/storage/media-url/:assetId should return Presigned GET URL for public reader', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/storage/media-url/${testAssetId}`)
        .expect(200);

      expect(res.body.downloadUrl).toBeDefined();
      expect(res.body.expiresIn).toBe(900);

      // Thử tải media qua presigned GET URL
      const downloadRes = await axios.get(res.body.downloadUrl);
      expect(downloadRes.status).toBe(200);
    });

    it('GET /api/v1/storage/media-url/:assetId on PRIVATE story should block anonymous and allow Story Owner', async () => {
      // Đổi Story A sang PRIVATE
      await dataSource.query(`UPDATE stories SET visibility = 'PRIVATE' WHERE id = $1`, [storyAId]);

      // Anonymous -> Bị chặn 403 Forbidden
      await request(app.getHttpServer())
        .get(`/api/v1/storage/media-url/${testAssetId}`)
        .expect(403);

      // Story Owner -> Cấp URL 200 OK
      const res = await request(app.getHttpServer())
        .get(`/api/v1/storage/media-url/${testAssetId}`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(200);

      expect(res.body.downloadUrl).toBeDefined();
    });
  });

  // ==========================================
  // 6. REDIS RATE LIMITING & ANTI-LEECH PROTECTION
  // ==========================================
  describe('6. Redis Rate Limiting & Anti-Leech Protection', () => {
    it('GET /api/v1/chapters/:id should attach X-RateLimit headers', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/chapters/${chapterAId}`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(200);

      expect(res.headers['x-ratelimit-limit']).toBe('60');
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    });

    it('Exceeding rate limit should trigger 429 Too Many Requests with Retry-After header', async () => {
      // Giả lập gửi liên tục các request đăng nhập vượt quá giới hạn 30 req/phút của IP test
      const testIp = '198.51.100.42';

      // 30 requests đầu thành công hoặc trả về lỗi xác thực nhưng không bị 429
      for (let i = 0; i < 30; i++) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('X-Forwarded-For', testIp)
          .send({
            identifier: 'wrong_user@omninovel.com',
            password: 'wrong_password',
          });
      }

      // Request thứ 31 từ cùng IP -> Phải bị chặn với 429 Too Many Requests
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', testIp)
        .send({
          identifier: 'wrong_user@omninovel.com',
          password: 'wrong_password',
        })
        .expect(429);

      expect(res.headers['retry-after']).toBeDefined();
      expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
      expect(res.body.error.message).toContain('vượt quá giới hạn');
    });

    it('GET /api/v1/storage/media-url/:assetId should enforce rate limiting per IP/User to prevent mass scraping', async () => {
      const scraperIp = '203.0.113.88';
      const res = await request(app.getHttpServer())
        .get(`/api/v1/storage/media-url/${testAssetId}`)
        .set('X-Forwarded-For', scraperIp)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(200);

      expect(res.headers['x-ratelimit-limit']).toBe('60');
      expect(Number(res.headers['x-ratelimit-remaining'])).toBeLessThanOrEqual(59);
    });
  });

  // ==========================================
  // 7. GAMIFICATION MODULE & SỔ CÁI BẤT BIẾN (REWARD LEDGER)
  // ==========================================
  describe('7. Gamification Module & Sổ Cái Bất Biến (Reward Ledger)', () => {
    it('GET /api/v1/gamification/progression should return initial Reader level 1 and active theme DEFAULT', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/gamification/progression')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .expect(200);

      expect(res.body.level).toBe(1);
      expect(res.body.totalExp.toString()).toBe('0');
      expect(res.body.omnicoinBalance.toString()).toBe('0');
      expect(res.body.currentStreak).toBe(0);
      expect(res.body.hasCheckedInToday).toBe(false);
      expect(res.body.activeTheme.id).toBe('DEFAULT');
      expect(res.body.activeTheme.rankTitle).toBe('Độc Giả Sơ Cấp');
      expect(res.body.progress.expNeededForNextLevel).toBe(100);
    });

    it('POST /api/v1/gamification/check-in should award +10 EXP, +5 Omnicoin and record 2 immutable ledger transactions', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/gamification/check-in')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .expect(200);

      expect(res.body.alreadyCheckedIn).toBe(false);
      expect(res.body.streakCount).toBe(1);
      expect(res.body.rewardExp).toBe(10);
      expect(res.body.rewardCoins).toBe(5);
      expect(res.body.totalExp.toString()).toBe('10');
      expect(res.body.omnicoinBalance.toString()).toBe('5');

      // Kiểm tra 2 dòng ledger trong bảng reward_transactions cho reader hiện tại
      const txs = await dataSource.query(
        `SELECT * FROM reward_transactions WHERE user_id = $1 AND source_type = 'CHECKIN' ORDER BY created_at ASC`,
        [readerUserId],
      );
      expect(txs.length).toBe(2);
      const expTx = txs.find((t: any) => t.reward_type === 'EXP');
      const coinTx = txs.find((t: any) => t.reward_type === 'OMNICOIN');
      expect(expTx).toBeDefined();
      expect(expTx.amount).toBe(10);
      expect(coinTx).toBeDefined();
      expect(coinTx.amount).toBe(5);
    });

    it('POST /api/v1/gamification/check-in a second time today should be idempotent (no duplicate rewards)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/gamification/check-in')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .expect(200);

      expect(res.body.alreadyCheckedIn).toBe(true);
      expect(res.body.totalExp.toString()).toBe('10');
      expect(res.body.omnicoinBalance.toString()).toBe('5');

      // Số dòng ledger CHECKIN của reader vẫn giữ nguyên là 2
      const txs = await dataSource.query(
        `SELECT * FROM reward_transactions WHERE user_id = $1 AND source_type = 'CHECKIN'`,
        [readerUserId],
      );
      expect(txs.length).toBe(2);
    });

    it('POST /api/v1/gamification/read-chapter should award +10 EXP and record unique idempotency_key', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/gamification/read-chapter')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({ chapterId: chapterAId })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.earnedExp).toBe(10);
      expect(res.body.totalExp.toString()).toBe('20');

      // Kiểm tra Sổ Cái có dòng READ_CHAPTER với idempotency_key duy nhất
      const tx = await dataSource.query(
        `SELECT * FROM reward_transactions WHERE source_type = 'READ_CHAPTER' AND source_id = $1`,
        [chapterAId],
      );
      expect(tx.length).toBe(1);
      expect(tx[0].idempotency_key).toBe(`READ:${readerUserId}:${chapterAId}:EXP`);
    });

    it('POST /api/v1/gamification/read-chapter for the same chapter should return ALREADY_REWARDED (Idempotent)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/gamification/read-chapter')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({ chapterId: chapterAId })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.earnedExp).toBe(0);
      expect(res.body.reason).toBe('ALREADY_REWARDED');

      // Không ghi thêm dòng transaction nào
      const tx = await dataSource.query(
        `SELECT * FROM reward_transactions WHERE source_type = 'READ_CHAPTER' AND source_id = $1`,
        [chapterAId],
      );
      expect(tx.length).toBe(1);
    });

    it('POST /api/v1/gamification/read-chapter should enforce daily 100 EXP cap from reading', async () => {
      // Giả lập reader đã cày 9 chương khác nhau (90 EXP thêm -> tổng hôm nay đạt 100 EXP)
      for (let i = 1; i <= 9; i++) {
        const fakeChapterId = `a0000000-0000-4000-8000-00000000000${i}`;
        await request(app.getHttpServer())
          .post('/api/v1/gamification/read-chapter')
          .set('Authorization', `Bearer ${readerAccessToken}`)
          .send({ chapterId: fakeChapterId })
          .expect(200);
      }

      // Đọc chương thứ 11 -> Đã chạm mốc 100 EXP/ngày -> Bị chặn cấp thêm EXP
      const chapter11Id = 'a0000000-0000-4000-8000-000000000011';
      const capRes = await request(app.getHttpServer())
        .post('/api/v1/gamification/read-chapter')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({ chapterId: chapter11Id })
        .expect(200);

      expect(capRes.body.earnedExp).toBe(0);
      expect(capRes.body.reason).toBe('DAILY_CAP_REACHED');
    });

    it('POST /api/v1/gamification/themes/:themeId/equip should equip TU_TIEN theme and return Luyện Khí Kỳ title', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/gamification/themes/TU_TIEN/equip')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .expect(200);

      expect(res.body.activeTheme.id).toBe('TU_TIEN');
      expect(res.body.activeTheme.name).toBe('Tu Tiên');
      expect(res.body.activeTheme.rankTitle).toBe('Luyện Khí Kỳ');
    });

    it('POST /api/v1/gamification/level-rewards/:milestoneLevel/claim should award coins when level requirement is met', async () => {
      // Cấp độ hiện tại của reader là 2 (tổng 110 EXP > 100 EXP Level 2 threshold)
      const res = await request(app.getHttpServer())
        .post('/api/v1/gamification/level-rewards/2/claim')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.milestoneLevel).toBe(2);
      expect(res.body.rewardCoins).toBe(20); // 2 * 10 = 20 coin

      // Claim lại lần 2 -> Bị từ chối 400 Bad Request (Đã nhận)
      await request(app.getHttpServer())
        .post('/api/v1/gamification/level-rewards/2/claim')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .expect(400);
    });

    it('GET /api/v1/gamification/leaderboard should return top reader rankings sorted by total_exp DESC', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/gamification/leaderboard?limit=10')
        .expect(200);

      expect(res.body.leaderboard).toBeDefined();
      expect(res.body.leaderboard.length).toBeGreaterThan(0);
      expect(res.body.leaderboard[0].rank).toBe(1);
      expect(res.body.leaderboard[0].username).toBeDefined();
      expect(res.body.leaderboard[0].totalExp).toBeDefined();
    });

    it('GET /api/v1/gamification/history should return paginated reward transactions ledger', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/gamification/history?page=1&limit=10')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .expect(200);

      expect(res.body.items).toBeDefined();
      expect(res.body.total).toBeGreaterThan(0);
      expect(res.body.items[0].idempotencyKey).toBeDefined();
      expect(res.body.items[0].balanceAfter).toBeDefined();
    });
  });
});



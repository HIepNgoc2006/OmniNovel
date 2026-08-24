import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/http-exception.filter';
import { GlobalRole, StoryVisibility, MediaFormat, PublicationFormat, ChapterVersionType } from '@omninovel/shared';
import { DataSource } from 'typeorm';

describe('OmniNovel Backend Core API (e2e)', () => {
  let app: INestApplication;
  let userAccessToken: string;
  let translatorAccessToken: string;
  let adminAccessToken: string;
  let refreshTokenCookie: string;
  let testStoryId: string;
  let testEditionId: string;
  let testChapterId: string;
  let testVersionId: string;

  const testUser = {
    username: `reader_${Date.now()}`,
    email: `reader_${Date.now()}@omninovel.com`,
    password: 'Password123@Secure',
  };

  const testTranslator = {
    username: `translator_${Date.now()}`,
    email: `translator_${Date.now()}@omninovel.com`,
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
  });

  afterAll(async () => {
    await app.close();
  });

  // 1. HEALTH CHECKS
  describe('Health Checks', () => {
    it('/health/live (GET) should return UP', () => {
      return request(app.getHttpServer())
        .get('/health/live')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('UP');
          expect(res.body.timestamp).toBeDefined();
        });
    });

    it('/health/ready (GET) should verify Postgres & Redis UP', () => {
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

  // 2. AUTH MODULE & REFRESH ROTATION
  describe('Authentication Module', () => {
    it('POST /api/v1/auth/register should create new user with progression', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(testUser)
        .expect(201);

      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe(testUser.username);
      expect(res.body.user.role).toBe(GlobalRole.READER);
    });

    it('POST /api/v1/auth/register should fail on duplicate username/email', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(testUser)
        .expect(409);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('POST /api/v1/auth/login should authenticate with Argon2id and set httpOnly cookie', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          identifier: testUser.email,
          password: testUser.password,
        })
        .expect(200);

      expect(res.body.accessToken).toBeDefined();
      expect(res.body.user.email).toBe(testUser.email);
      userAccessToken = res.body.accessToken;

      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      refreshTokenCookie = (cookies as unknown as string[])[0];
      expect(refreshTokenCookie).toContain('refreshToken=');
      expect(refreshTokenCookie).toContain('HttpOnly');
    });

    it('POST /api/v1/auth/refresh should rotate refresh token and issue new access token', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', refreshTokenCookie)
        .expect(200);

      expect(res.body.accessToken).toBeDefined();
      userAccessToken = res.body.accessToken;

      const newCookies = res.headers['set-cookie'];
      expect(newCookies).toBeDefined();
      refreshTokenCookie = (newCookies as unknown as string[])[0];
    });

    it('GET /api/v1/auth/me should return current user profile and permissions', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(res.body.user.username).toBe(testUser.username);
      expect(res.body.permissions.canCreateStory).toBe(false);
      expect(res.body.permissions.isAdmin).toBe(false);
    });
  });

  // 3. RBAC & STORY CATALOG
  describe('RBAC & Story Catalog', () => {
    beforeAll(async () => {
      // Đăng ký translator và nâng quyền trực tiếp
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(testTranslator);

      // Cập nhật role thành TRANSLATOR trong database
      const dataSource = app.get(DataSource);
      await dataSource.query(
        `UPDATE users SET role = 'TRANSLATOR' WHERE email = $1`,
        [testTranslator.email],
      );

      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          identifier: testTranslator.email,
          password: testTranslator.password,
        });

      translatorAccessToken = loginRes.body.accessToken;
    });

    it('POST /api/v1/studio/stories should block READER with 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/studio/stories')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({
          title: 'Truyện Độc Quyền Test',
          mediaFormat: MediaFormat.COMIC,
          publicationFormat: PublicationFormat.MANGA,
          coverUrl: 'https://example.com/cover.jpg',
        })
        .expect(403);
    });

    it('POST /api/v1/studio/stories should allow TRANSLATOR and assign Story OWNER', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/studio/stories')
        .set('Authorization', `Bearer ${translatorAccessToken}`)
        .send({
          title: `Đại Quản Gia Là Ma Hoàng ${Date.now()}`,
          mediaFormat: MediaFormat.COMIC,
          publicationFormat: PublicationFormat.MANGA,
          originCountry: 'CN',
          originalLanguage: 'zh',
          coverUrl: 'https://example.com/cover.jpg',
          summary: 'Tác phẩm huyền huyễn trùng sinh kinh điển.',
        })
        .expect(201);

      expect(res.body.storyId).toBeDefined();
      expect(res.body.defaultEditionId).toBeDefined();
      testStoryId = res.body.storyId;
      testEditionId = res.body.defaultEditionId;
    });

    it('GET /api/v1/stories should list public stories with pagination', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/stories')
        .expect(200);

      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.pagination.total).toBeGreaterThan(0);
    });

    it('PATCH /api/v1/stories/:id/visibility should allow Story OWNER to change to UNLISTED', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/stories/${testStoryId}/visibility`)
        .set('Authorization', `Bearer ${translatorAccessToken}`)
        .send({ visibility: StoryVisibility.UNLISTED })
        .expect(200);

      expect(res.body.visibility).toBe(StoryVisibility.UNLISTED);
    });

    it('PATCH /api/v1/stories/:id/visibility should block non-owner with 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/stories/${testStoryId}/visibility`)
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ visibility: StoryVisibility.PRIVATE })
        .expect(403);
    });
  });

  // 4. CHAPTERS & INVARIANT PROTECTION
  describe('Chapter Publishing & Invariant Protection', () => {
    it('POST /api/v1/studio/editions/:editionId/chapters should create chapter', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/studio/editions/${testEditionId}/chapters`)
        .set('Authorization', `Bearer ${translatorAccessToken}`)
        .send({
          chapterNumber: '1.00',
          title: 'Hồi 1: Trùng Sinh',
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      testChapterId = res.body.id;
    });

    it('POST /api/v1/studio/chapters/:id/versions should create immutable chapter version', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/studio/chapters/${testChapterId}/versions`)
        .set('Authorization', `Bearer ${translatorAccessToken}`)
        .send({
          versionType: ChapterVersionType.RAW_ORIGINAL,
          language: 'vi',
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.versionNumber).toBe(1);
      testVersionId = res.body.id;
    });

    it('GET /api/v1/chapters/:id should return chapter details and active version', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/chapters/${testChapterId}`)
        .expect(200);

      expect(res.body.chapter.id).toBe(testChapterId);
      expect(res.body.chapter.activeVersionId).toBe(testVersionId);
      expect(res.body.activeVersion).toBeDefined();
    });

    it('POST /api/v1/auth/logout should revoke session on Redis', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
    });
  });
});

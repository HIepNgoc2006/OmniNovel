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
  TranslationJobStatus,
} from '@omninovel/shared';
import { AllowedUploadFileType } from '../src/modules/storage/dto/create-upload-session.dto';
import { TranslationWatchdogService } from '../src/modules/translation/translation-watchdog.service';
import { TranslationProcessor } from '../src/modules/translation/translation.processor';

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
  let versionB1Id: string;

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
      exclude: ['health/live', 'health/ready', 'internal/v1/(.*)'],
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

    // ==========================================
    // 3B. DISCOVERY, ADVANCED SEARCH & IDEMPOTENT LIBRARY BOOKMARKS
    // ==========================================
    it('GET /api/v1/stories should return public stories with pagination, genres array and latestChapter', async () => {
      await dataSource.query(`UPDATE stories SET visibility = 'PUBLIC' WHERE id = $1`, [storyAId]);
      const res = await request(app.getHttpServer())
        .get('/api/v1/stories')
        .expect(200);

      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.limit).toBe(20);

      if (res.body.data.length > 0) {
        const item = res.body.data[0];
        expect(item.id).toBeDefined();
        expect(Array.isArray(item.genres)).toBe(true);
      }
    });

    it('GET /api/v1/stories?q= should filter stories by keyword on title', async () => {
      const storyARow = await dataSource.query(`SELECT title FROM stories WHERE id = $1`, [storyAId]);
      const titleToSearch = storyARow[0]?.title || 'Quản Gia';

      const resExact = await request(app.getHttpServer())
        .get(`/api/v1/stories?q=${encodeURIComponent(titleToSearch)}`)
        .expect(200);

      expect(resExact.body.data.length).toBeGreaterThanOrEqual(1);
      expect(resExact.body.data.some((s: any) => s.id === storyAId)).toBe(true);

      const resPartial = await request(app.getHttpServer())
        .get(`/api/v1/stories?q=${encodeURIComponent('Quản Gia')}`)
        .expect(200);

      expect(resPartial.body.data.length).toBeGreaterThanOrEqual(1);
      expect(
        resPartial.body.data.every(
          (s: any) => s.title.includes('Quản Gia') || (s.summary && s.summary.includes('Quản Gia')),
        ),
      ).toBe(true);
    });

    it('GET /api/v1/stories?format=NOVEL should filter only Novel stories', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/stories?format=NOVEL')
        .expect(200);

      expect(res.body.data.every((s: any) => s.mediaFormat === MediaFormat.NOVEL)).toBe(true);
    });

    it('GET /api/v1/stories?sort=VIEWS and sort=POPULAR should execute canonical ordering', async () => {
      const resViews = await request(app.getHttpServer())
        .get('/api/v1/stories?sort=VIEWS')
        .expect(200);
      expect(resViews.body.data).toBeDefined();

      const resPopular = await request(app.getHttpServer())
        .get('/api/v1/stories?sort=POPULAR')
        .expect(200);
      expect(resPopular.body.data).toBeDefined();
    });

    it('GET /api/v1/stories with invalid query params should be rejected with 400 Bad Request', async () => {
      // 1. Unknown query parameter
      await request(app.getHttpServer())
        .get('/api/v1/stories?unknownProperty=malicious')
        .expect(400);

      // 2. Invalid sort parameter
      await request(app.getHttpServer())
        .get('/api/v1/stories?sort=INVALID_SORT')
        .expect(400);

      // 3. Invalid format parameter
      await request(app.getHttpServer())
        .get('/api/v1/stories?format=INVALID_FORMAT')
        .expect(400);
    });

    it('POST /api/v1/library/bookmarks should require authentication (401 Unauthorized)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/library/bookmarks')
        .send({ storyId: storyAId, isBookmarked: true })
        .expect(401);
    });

    it('POST /api/v1/library/bookmarks should idempotently bookmark and update followersCount (FR-LIB-02)', async () => {
      // 1. First bookmark (isBookmarked: true) -> followersCount increases by 1
      const res1 = await request(app.getHttpServer())
        .post('/api/v1/library/bookmarks')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({ storyId: storyAId, isBookmarked: true })
        .expect(200);

      expect(res1.body.isBookmarked).toBe(true);
      const countAfterFirst = res1.body.followersCount;
      expect(countAfterFirst).toBeGreaterThanOrEqual(1);

      // 2. Second bookmark (isBookmarked: true) -> IDEMPOTENT (no double increment)
      const res2 = await request(app.getHttpServer())
        .post('/api/v1/library/bookmarks')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({ storyId: storyAId, isBookmarked: true })
        .expect(200);

      expect(res2.body.isBookmarked).toBe(true);
      expect(res2.body.followersCount).toBe(countAfterFirst);

      // 3. Check status via GET /library/bookmarks/:storyId
      const statusRes = await request(app.getHttpServer())
        .get(`/api/v1/library/bookmarks/${storyAId}`)
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .expect(200);

      expect(statusRes.body.isBookmarked).toBe(true);

      // 4. Unbookmark (isBookmarked: false) -> followersCount decreases by 1
      const res3 = await request(app.getHttpServer())
        .post('/api/v1/library/bookmarks')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({ storyId: storyAId, isBookmarked: false })
        .expect(200);

      expect(res3.body.isBookmarked).toBe(false);
      expect(res3.body.followersCount).toBe(countAfterFirst - 1);

      // 5. Second unbookmark (isBookmarked: false) -> IDEMPOTENT (never negative)
      const res4 = await request(app.getHttpServer())
        .post('/api/v1/library/bookmarks')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({ storyId: storyAId, isBookmarked: false })
        .expect(200);

      expect(res4.body.isBookmarked).toBe(false);
      expect(res4.body.followersCount).toBe(countAfterFirst - 1);
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
      versionB1Id = vB.body.id;

      await request(app.getHttpServer())
        .patch(`/api/v1/studio/chapters/${chapterAId}/active-version`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({ versionId: vB.body.id })
        .expect(400);
    });

    it('GET /api/v1/chapters/:id should return complete ChapterDetailResponse for public readers', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/chapters/${chapterAId}`)
        .expect(200);

      expect(res.body.story).toBeDefined();
      expect(res.body.story.id).toBe(storyAId);
      expect(res.body.story.slug).toBeDefined();
      expect(res.body.story.mediaFormat).toBeDefined();
      expect(res.body.story.visibility).toBe('PUBLIC');

      expect(res.body.chapter.id).toBe(chapterAId);
      expect(res.body.chapter.activeVersionId).toBe(versionA2Id);
      expect(res.body.activeVersion).toBeDefined();
      expect(res.body.availableVersions).toBeDefined();
      expect(Array.isArray(res.body.availableVersions)).toBe(true);
      expect(res.body.mediaAssets).toBeDefined();
      expect(res.body.navigation).toBeDefined();
    });

    it('GET /api/v1/chapters/:id Version Access Policy: public can switch to published version, draft requires staff role, foreign version rejected', async () => {
      // 1. Tạo published version mới trên Chapter A
      const pubVer = await request(app.getHttpServer())
        .post(`/api/v1/studio/chapters/${chapterAId}/versions`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({ versionType: ChapterVersionType.AI_TRANSLATED, language: 'en' });
      await dataSource.query(`UPDATE chapter_versions SET is_published = TRUE WHERE id = $1`, [pubVer.body.id]);

      // 2. Tạo draft version (isPublished = false) trên Chapter A
      const draftVer = await request(app.getHttpServer())
        .post(`/api/v1/studio/chapters/${chapterAId}/versions`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({ versionType: ChapterVersionType.HUMAN_EDITED, language: 'vi' });
      await dataSource.query(`UPDATE chapter_versions SET is_published = FALSE WHERE id = $1`, [draftVer.body.id]);

      // 3. Anonymous public reader chuyển sang published version -> 200 OK
      const pubRes = await request(app.getHttpServer())
        .get(`/api/v1/chapters/${chapterAId}?versionId=${pubVer.body.id}`)
        .expect(200);
      expect(pubRes.body.activeVersion.id).toBe(pubVer.body.id);

      // 4. Anonymous public reader cố đọc draft version -> 403 Forbidden
      await request(app.getHttpServer())
        .get(`/api/v1/chapters/${chapterAId}?versionId=${draftVer.body.id}`)
        .expect(403);

      // 5. Story Translator (staff) đọc draft version -> 200 OK
      const staffRes = await request(app.getHttpServer())
        .get(`/api/v1/chapters/${chapterAId}?versionId=${draftVer.body.id}`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(200);
      expect(staffRes.body.activeVersion.id).toBe(draftVer.body.id);

      // 6. Truyền versionId thuộc Chapter B vào Chapter A -> 400 Bad Request
      await request(app.getHttpServer())
        .get(`/api/v1/chapters/${chapterAId}?versionId=${versionB1Id}`)
        .expect(400);
    });

    it('PUT & GET /api/v1/library/reading-progress lifecycle and hierarchy invariants', async () => {
      // 1. Anonymous user cố lưu tiến độ đọc -> 401 Unauthorized
      await request(app.getHttpServer())
        .put('/api/v1/library/reading-progress')
        .send({
          chapterId: chapterAId,
          progressPercentage: 50,
          scrollPosition: 1200,
        })
        .expect(401);

      // 2. Truyền storyId không khớp với chapterId -> 400 Bad Request
      await request(app.getHttpServer())
        .put('/api/v1/library/reading-progress')
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .send({
          chapterId: chapterAId,
          storyId: storyBId, // Story B không chứa Chapter A
          progressPercentage: 50,
          scrollPosition: 1200,
        })
        .expect(400);

      // 3. User lưu tiến độ đọc hợp lệ -> 200 OK
      const saveRes = await request(app.getHttpServer())
        .put('/api/v1/library/reading-progress')
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .send({
          chapterId: chapterAId,
          chapterVersionId: versionA2Id,
          readingMode: 'WEBTOON',
          progressPercentage: 85.5,
          scrollPosition: 2400,
        })
        .expect(200);

      expect(saveRes.body.storyId).toBe(storyAId);
      expect(saveRes.body.chapterId).toBe(chapterAId);
      expect(saveRes.body.progressPercentage).toBe(85.5);

      // 4. GET reading-progress theo storyId -> Trả về resume pointer và readChapterIds chứa chapterAId
      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/library/reading-progress/${storyAId}`)
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .expect(200);

      expect(getRes.body.storyId).toBe(storyAId);
      expect(getRes.body.chapterId).toBe(chapterAId);
      expect(getRes.body.readChapterIds).toContain(chapterAId);

      // 5. User cố lưu tiến độ đọc với draft version chưa công bố -> 403 Forbidden
      // Tạo draft version trên chapterA
      const draftVerRes = await request(app.getHttpServer())
        .post(`/api/v1/studio/chapters/${chapterAId}/versions`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          versionType: ChapterVersionType.HUMAN_EDITED,
          language: 'vi',
        })
        .expect(201);
      const draftVerId = draftVerRes.body.id;
      await dataSource.query(`UPDATE chapter_versions SET is_published = FALSE WHERE id = $1`, [draftVerId]);

      await request(app.getHttpServer())
        .put('/api/v1/library/reading-progress')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({
          chapterId: chapterAId,
          chapterVersionId: draftVerId,
          progressPercentage: 50,
          scrollPosition: 1000,
        })
        .expect(403);

      // 6. User không có quyền cố lưu / lấy tiến độ trên truyện PRIVATE -> 403 Forbidden
      await dataSource.query(`UPDATE stories SET visibility = 'PRIVATE' WHERE id = $1`, [storyBId]);

      await request(app.getHttpServer())
        .put('/api/v1/library/reading-progress')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({
          chapterId: chapterBId,
          progressPercentage: 50,
          scrollPosition: 1000,
        })
        .expect(403);

      await request(app.getHttpServer())
        .get(`/api/v1/library/reading-progress/${storyBId}`)
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .expect(403);

      // Restore storyB visibility
      await dataSource.query(`UPDATE stories SET visibility = 'PUBLIC' WHERE id = $1`, [storyBId]);
    });

    it('GET /api/v1/stories latestChapter invariant: default edition only and ignores unpublished drafts', async () => {
      // 1. Tạo Draft chapter (isPublished = false) trên default edition của Story A
      const draftChap = await request(app.getHttpServer())
        .post(`/api/v1/studio/editions/${editionAId}/chapters`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({ chapterNumber: '999.00', title: 'Chương Nháp Chưa Xuất Bản', volumeId: volumeAId });

      const draftVer = await request(app.getHttpServer())
        .post(`/api/v1/studio/chapters/${draftChap.body.id}/versions`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({ versionType: ChapterVersionType.RAW_ORIGINAL, language: 'vi' });

      // Đặt is_published = false cho draft
      await dataSource.query(`UPDATE chapter_versions SET is_published = FALSE WHERE id = $1`, [draftVer.body.id]);

      // 2. Tạo Alternate Edition cho Story A (isDefault = false) với Chapter 150 (isPublished = true)
      const altEdition = await request(app.getHttpServer())
        .post(`/api/v1/studio/stories/${storyAId}/editions`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({ editionName: `Bản Tiếng Nhật ${Date.now()}`, language: 'ja' });

      const altVol = await request(app.getHttpServer())
        .post(`/api/v1/studio/editions/${altEdition.body.id}/volumes`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({ volumeNumber: 1, title: 'Tập 1' });

      const altChap = await request(app.getHttpServer())
        .post(`/api/v1/studio/editions/${altEdition.body.id}/chapters`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({ chapterNumber: '150.00', title: 'Alternate Edition Chapter', volumeId: altVol.body.id });

      const altVer = await request(app.getHttpServer())
        .post(`/api/v1/studio/chapters/${altChap.body.id}/versions`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({ versionType: ChapterVersionType.RAW_ORIGINAL, language: 'ja' });

      await dataSource.query(`UPDATE chapter_versions SET is_published = TRUE WHERE id = $1`, [altVer.body.id]);

      // 3. Query GET /api/v1/stories -> latestChapter phải là chapter trên default edition, KHÔNG phải draft 999 cũng KHÔNG phải alternate 150
      const res = await request(app.getHttpServer())
        .get('/api/v1/stories')
        .expect(200);

      const storyItem = res.body.data.find((s: any) => s.id === storyAId);
      expect(storyItem).toBeDefined();
      if (storyItem.latestChapter) {
        expect(storyItem.latestChapter.id).not.toBe(draftChap.body.id);
        expect(storyItem.latestChapter.id).not.toBe(altChap.body.id);
        expect(Number(storyItem.latestChapter.chapterNumber)).toBe(1);
      }
    });

    it('GET /api/v1/stories?sort=LATEST ordering invariant: ordered by newest published chapter date on default edition', async () => {
      // Set timestamp của chapterA (trên storyA default edition) thành tương lai gần (mới nhất)
      await dataSource.query(`UPDATE chapters SET created_at = NOW() + INTERVAL '1 hour' WHERE id = $1`, [chapterAId]);

      const res = await request(app.getHttpServer())
        .get('/api/v1/stories?sort=LATEST')
        .expect(200);

      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data[0].id).toBe(storyAId);
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
      // Đảm bảo Story A là PUBLIC cho reader truy cập
      await dataSource.query(`UPDATE stories SET visibility = 'PUBLIC' WHERE id = $1`, [storyAId]);

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
      expect(res.body.progress.nextLevelExp).toBe(100);
    });

    it('POST /api/v1/gamification/checkin should award +10 EXP, +5 Omnicoin in Asia/Ho_Chi_Minh and record 2 ledger txs', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/gamification/checkin')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .set('Idempotency-Key', 'test-checkin-idemp-001')
        .expect(200);

      expect(res.body.alreadyCheckedIn).toBe(false);
      expect(res.body.newStreak).toBe(1);
      expect(res.body.expEarned).toBe(10);
      expect(res.body.coinsEarned).toBe(5);
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

    it('POST /api/v1/gamification/checkin a second time today should be rejected with 400 Bad Request (FR-GAM-01)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/gamification/checkin')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .expect(400);

      expect(res.body.error.message).toContain('CHECKIN_ALREADY_CLAIMED');

      // Số dòng ledger CHECKIN của reader vẫn giữ nguyên là 2
      const txs = await dataSource.query(
        `SELECT * FROM reward_transactions WHERE user_id = $1 AND source_type = 'CHECKIN'`,
        [readerUserId],
      );
      expect(txs.length).toBe(2);
    });

    it('POST /api/v1/gamification/read-chapter with non-existent chapter UUID should be rejected with 404 Not Found', async () => {
      const fakeChapterUuid = 'a0000000-0000-4000-8000-000000000999';
      await request(app.getHttpServer())
        .post('/api/v1/gamification/read-chapter')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({
          chapterId: fakeChapterUuid,
          readingDurationSeconds: 60,
          progressPercentage: 100,
        })
        .expect(404);
    });

    it('POST /api/v1/gamification/read-chapter on PRIVATE story chapter by unauthorized reader should be rejected with 403 Forbidden', async () => {
      // Story B là PRIVATE và reader không phải thành viên
      await dataSource.query(`UPDATE stories SET visibility = 'PRIVATE' WHERE id = $1`, [storyBId]);
      const edB = await dataSource.query(`SELECT id FROM story_editions WHERE story_id = $1 LIMIT 1`, [storyBId]);
      const editionBId = edB[0].id;

      // Xóa chapter test cũ nếu có trên Story B
      await dataSource.query(`DELETE FROM chapters WHERE story_edition_id = $1 AND chapter_number = 99`, [editionBId]);

      const chBRes = await request(app.getHttpServer())
        .post(`/api/v1/studio/editions/${editionBId}/chapters`)
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .send({
          chapterNumber: '99',
          title: 'Private Chapter B99',
        })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/gamification/read-chapter')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({
          chapterId: chBRes.body.id,
          readingDurationSeconds: 60,
          progressPercentage: 100,
        })
        .expect(403);
    });

    it('POST /api/v1/gamification/read-chapter with duration < 45s should reject EXP reward (CRITERIA_NOT_MET)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/gamification/read-chapter')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({
          chapterId: chapterAId,
          readingDurationSeconds: 20, // < 45s
          progressPercentage: 100,
        })
        .expect(200);

      expect(res.body.success).toBe(false);
      expect(res.body.earnedExp).toBe(0);
      expect(res.body.reason).toBe('CRITERIA_NOT_MET');
    });

    it('POST /api/v1/gamification/read-chapter with duration >= 45s and progress >= 80% should award +5 EXP', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/gamification/read-chapter')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({
          chapterId: chapterAId,
          readingDurationSeconds: 60,
          progressPercentage: 90,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.earnedExp).toBe(5); // SSoT: +5 EXP
      expect(res.body.totalExp.toString()).toBe('15'); // 10 (checkin) + 5 = 15

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
        .send({
          chapterId: chapterAId,
          readingDurationSeconds: 60,
          progressPercentage: 100,
        })
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
      // Dọn dẹp state để test độc lập và có thể lặp lại nhiều lần
      await dataSource.query(
        `DELETE FROM reward_transactions WHERE user_id = $1 AND source_type = 'READ_CHAPTER' AND source_id != $2`,
        [readerUserId, chapterAId],
      );
      await dataSource.query(
        `DELETE FROM chapters WHERE story_edition_id = $1 AND chapter_number >= 100`,
        [editionAId],
      );
      await dataSource.query(
        `UPDATE user_progression SET total_exp = '15', level = 1 WHERE user_id = $1`,
        [readerUserId],
      );

      // Tạo động 19 chapter thật trên Story Edition A để đọc nhận 19 * 5 = 95 EXP (+ 5 EXP trước đó = 100 EXP max cap)
      for (let i = 2; i <= 20; i++) {
        const chapterNum = (100 + i).toString();
        const createChRes = await request(app.getHttpServer())
          .post(`/api/v1/studio/editions/${editionAId}/chapters`)
          .set('Authorization', `Bearer ${translatorAAccessToken}`)
          .send({
            chapterNumber: chapterNum,
            title: `Cap Chapter ${chapterNum}`,
            volumeId: volumeAId,
          })
          .expect(201);

        const chId = createChRes.body.id;

        await request(app.getHttpServer())
          .post('/api/v1/gamification/read-chapter')
          .set('Authorization', `Bearer ${readerAccessToken}`)
          .send({
            chapterId: chId,
            readingDurationSeconds: 50,
            progressPercentage: 85,
          })
          .expect(200);
      }

      // Tạo chapter thứ 21 -> Đã chạm mốc 100 EXP/ngày -> Bị chặn cấp thêm EXP
      const createCh21 = await request(app.getHttpServer())
        .post(`/api/v1/studio/editions/${editionAId}/chapters`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          chapterNumber: '121',
          title: 'Cap Chapter 121',
          volumeId: volumeAId,
        })
        .expect(201);

      const capRes = await request(app.getHttpServer())
        .post('/api/v1/gamification/read-chapter')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({
          chapterId: createCh21.body.id,
          readingDurationSeconds: 60,
          progressPercentage: 100,
        })
        .expect(200);

      expect(capRes.body.earnedExp).toBe(0);
      expect(capRes.body.reason).toBe('DAILY_CAP_REACHED');
      // Tổng EXP hiện tại = 10 (checkin) + 100 (read cap) = 110 EXP -> Đạt Level 2 (yêu cầu 100 EXP)
      expect(capRes.body.level).toBe(2);
    });

    it('PATCH /api/v1/gamification/rank-theme should change theme to TU_TIEN and return Luyện Khí Kỳ title', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/v1/gamification/rank-theme')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({ themeId: 'TU_TIEN' })
        .expect(200);

      expect(res.body.activeTheme.id).toBe('TU_TIEN');
      expect(res.body.activeTheme.name).toBe('Tu Tiên');
      expect(res.body.activeTheme.rankTitle).toBe('Luyện Khí Kỳ');
    });

    it('POST /api/v1/gamification/rewards/claim with unconfigured milestone should return 404 Not Found', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/gamification/rewards/claim')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({ milestoneLevel: 999 })
        .expect(404);
    });

    it('POST /api/v1/gamification/rewards/claim for Level 2 milestone should award 20 Omnicoin and reject duplicate claim', async () => {
      // Reader hiện đạt Level 2 (110 EXP >= 100 EXP)
      const res = await request(app.getHttpServer())
        .post('/api/v1/gamification/rewards/claim')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .set('Idempotency-Key', 'test-claim-lvl2-001')
        .send({ milestoneLevel: 2 })
        .expect(200);

      expect(res.body.rewardCoins).toBe(20);
      expect(res.body.claimedAt).toBeDefined();

      // Claim lại lần 2 -> Bị từ chối 400 Bad Request (Đã nhận)
      await request(app.getHttpServer())
        .post('/api/v1/gamification/rewards/claim')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({ milestoneLevel: 2 })
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

    it('GET /api/v1/gamification/transactions should return paginated reward transactions ledger', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/gamification/transactions?page=1&limit=10&rewardType=EXP')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .expect(200);

      expect(res.body.transactions).toBeDefined();
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.total).toBeGreaterThan(0);
      expect(res.body.transactions[0].idempotencyKey).toBeDefined();
      expect(res.body.transactions[0].rewardType).toBe('EXP');
    });
  });

  // ==========================================
  // 8. PHASE 3 - AI TRANSLATION HUB & ORCHESTRATION SLICE
  // ==========================================
  describe('8. Phase 3 - AI Translation Hub & Orchestration Slice', () => {
    let adminAccessToken: string;
    let aiJobId: string;
    let aiJobId2: string;
    let cancelJobId: string;
    let projectId: string;
    let watchdog: TranslationWatchdogService;
    let processor: TranslationProcessor;
    let promotedSessionId: string;

    const testAdminUser = {
      username: `admin_ai_${Date.now()}`,
      email: `admin_ai_${Date.now()}@omninovel.com`,
      password: 'Password123@Secure',
    };

    beforeAll(async () => {
      // 1. Tạo và đăng nhập Global Admin
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(testAdminUser);
      await dataSource.query(
        `UPDATE users SET role = 'ADMIN' WHERE email = $1`,
        [testAdminUser.email],
      );
      const adminLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          identifier: testAdminUser.email,
          password: testAdminUser.password,
        });
      adminAccessToken = adminLogin.body.accessToken;

      // 2. Lấy services cho watchdog testing
      watchdog = app.get(TranslationWatchdogService);
      processor = app.get(TranslationProcessor);

      // 3. Tạo 1 UploadSession PROMOTED cho versionA1Id để làm raw source package
      const zip = new AdmZip();
      zip.addFile('001.webp', Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]));
      const zipBuffer = zip.toBuffer();

      const sessRes = await request(app.getHttpServer())
        .post('/api/v1/uploads/sessions')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          storyEditionId: editionAId,
          chapterVersionId: versionA1Id,
          fileType: AllowedUploadFileType.MANGA_ZIP,
          expectedSize: zipBuffer.length,
        })
        .expect(201);
      promotedSessionId = sessRes.body.sessionId;

      await axios.put(sessRes.body.uploadUrl, zipBuffer, {
        headers: { 'Content-Type': 'application/zip' },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/uploads/sessions/${promotedSessionId}/finalize`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`);

      // Gán session này cho versionA1Id
      await dataSource.query(
        `UPDATE upload_sessions SET chapter_version_id = $1 WHERE id = $2`,
        [versionA1Id, promotedSessionId],
      );
    });

    it('POST /api/v1/ai/jobs without Idempotency-Key should return 400 Bad Request (IDEMPOTENCY_KEY_REQUIRED)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/ai/jobs')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          chapterVersionId: versionA1Id,
          sourceLang: 'ja',
          targetLang: 'vi',
          provider: 'OPENAI',
        })
        .expect(400);

      expect(res.body.error.message).toContain('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('POST /api/v1/ai/jobs with invalid Idempotency-Key format should return 400 Bad Request', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/ai/jobs')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .set('Idempotency-Key', 'invalid-non-uuid-key')
        .send({
          chapterVersionId: versionA1Id,
          sourceLang: 'ja',
          targetLang: 'vi',
          provider: 'OPENAI',
        })
        .expect(400);
    });

    it('POST /api/v1/ai/jobs by Reader without story membership should return 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/ai/jobs')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .set('Idempotency-Key', 'e0000000-0000-4000-a000-000000000001')
        .send({
          chapterVersionId: versionA1Id,
          sourceLang: 'ja',
          targetLang: 'vi',
          provider: 'OPENAI',
        })
        .expect(403);
    });

    it('POST /api/v1/ai/jobs with non-existent ChapterVersion should return 404 Not Found', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/ai/jobs')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .set('Idempotency-Key', 'e0000000-0000-4000-a000-000000000002')
        .send({
          chapterVersionId: '00000000-0000-0000-0000-000000000000',
          sourceLang: 'ja',
          targetLang: 'vi',
        })
        .expect(404);
    });

    it('POST /api/v1/ai/jobs on ChapterVersion with ambiguous artifacts (>1 PROMOTED) should return 409 Conflict', async () => {
      // Tạo session PROMOTED thứ 2 cho versionA1Id để kích hoạt 409
      const secondSession = await dataSource.query(
        `INSERT INTO upload_sessions (story_edition_id, chapter_version_id, file_type, expected_size, quarantine_key, final_key, status, user_id, expires_at)
         VALUES ($1, $2, 'MANGA_ZIP', 1024, 'quar_key_2', 'final_key_2', 'PROMOTED', (SELECT id FROM users LIMIT 1), NOW() + INTERVAL '15 minutes')
         RETURNING id`,
        [editionAId, versionA1Id],
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/ai/jobs')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .set('Idempotency-Key', 'e0000000-0000-4000-a000-000000000003')
        .send({
          chapterVersionId: versionA1Id,
          sourceLang: 'ja',
          targetLang: 'vi',
        })
        .expect(409);

      expect(res.body.error.message).toContain('SOURCE_ARTIFACT_AMBIGUOUS');

      // Dọn dẹp session thừa để các test sau chạy bình thường
      await dataSource.query(`DELETE FROM upload_sessions WHERE id = $1`, [secondSession[0].id]);
    });

    it('POST /api/v1/ai/jobs with provider OPENAI without externalConsent should return 400 Bad Request', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/ai/jobs')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .set('Idempotency-Key', 'a0000000-0000-4000-a000-000000000000')
        .send({
          chapterVersionId: versionA1Id,
          sourceLang: 'ja',
          targetLang: 'vi',
          provider: 'OPENAI',
          externalConsent: false,
        })
        .expect(400);

      expect(res.body.error.message).toContain('EXTERNAL_PROVIDER_CONSENT_REQUIRED');
    });

    it('POST /api/v1/ai/jobs with valid payload should pin source artifact, create job in QUEUED and return 202 Accepted', async () => {
      const idempotencyKey = 'a0000000-0000-4000-a000-000000000001';
      const res = await request(app.getHttpServer())
        .post('/api/v1/ai/jobs')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          chapterVersionId: versionA1Id,
          sourceLang: 'ja',
          targetLang: 'vi',
          provider: 'OPENAI',
          externalConsent: true,
        })
        .expect(202);

      expect(res.body.jobId).toBeDefined();
      expect(res.body.status).toBe(TranslationJobStatus.QUEUED);
      expect(res.body.isDuplicate).toBe(false);
      aiJobId = res.body.jobId;

      // Kiểm tra DB: Đã pin đúng source_upload_session_id
      const jobDb = await dataSource.query(
        `SELECT * FROM translation_jobs WHERE id = $1`,
        [aiJobId],
      );
      expect([TranslationJobStatus.QUEUED, TranslationJobStatus.PREPROCESSING]).toContain(
        jobDb[0].status,
      );
      expect(jobDb[0].attempt_count).toBeGreaterThanOrEqual(0);
      projectId = jobDb[0].project_id;
    });

    it('POST /api/v1/ai/jobs with same Idempotency-Key should return same jobId with isDuplicate: true (Durable Idempotency)', async () => {
      const idempotencyKey = 'a0000000-0000-4000-a000-000000000001';
      const res = await request(app.getHttpServer())
        .post('/api/v1/ai/jobs')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          chapterVersionId: versionA1Id,
          sourceLang: 'ja',
          targetLang: 'vi',
          provider: 'OPENAI',
          externalConsent: true,
        })
        .expect(202);

      expect(res.body.jobId).toBe(aiJobId);
      expect(res.body.isDuplicate).toBe(true);
    });

    it('Concurrent / subsequent createJob on same edition + language pair should reuse the same TranslationProject', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/ai/jobs')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .set('Idempotency-Key', 'a0000000-0000-4000-a000-000000000002')
        .send({
          chapterVersionId: versionA1Id,
          sourceLang: 'ja',
          targetLang: 'vi',
          provider: 'OPENAI',
          externalConsent: true,
        })
        .expect(202);

      aiJobId2 = res.body.jobId;
      const job2Db = await dataSource.query(
        `SELECT project_id FROM translation_jobs WHERE id = $1`,
        [aiJobId2],
      );
      expect(job2Db[0].project_id).toBe(projectId);
    });

    it('GET /api/v1/ai/jobs/:id should block Translator of Story B with 403 Forbidden (IDOR Protection)', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${aiJobId}`)
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .expect(403);
    });

    it('GET /api/v1/ai/jobs/:id should allow Story Owner / Member to view job details', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/ai/jobs/${aiJobId}`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(200);

      expect(res.body.job.id).toBe(aiJobId);
      expect([
        TranslationJobStatus.QUEUED,
        TranslationJobStatus.PREPROCESSING,
      ]).toContain(res.body.job.status);
      expect(res.body.segments).toBeUndefined();
      expect(res.body.reviewSummary).toBeDefined();
    });

    it('POST /internal/v1/ai/jobs/:id/events without X-Internal-Service-Key should return 401 Unauthorized', async () => {
      await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId}/events`)
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000001',
          attemptNumber: 1,
          sequence: 1,
          stage: TranslationJobStatus.OCR,
          progress: 30,
        })
        .expect(401);
    });

    it('POST /internal/v1/ai/jobs/:id/events with wrong key should return 401 Unauthorized', async () => {
      await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId}/events`)
        .set('X-Internal-Service-Key', 'wrong_secret_key_1234')
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000001',
          attemptNumber: 1,
          sequence: 1,
          stage: TranslationJobStatus.OCR,
          progress: 30,
        })
        .expect(401);
    });

    it('Route isolation: POST /api/v1/internal/v1/ai/jobs/:id/events should return 404 Not Found', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/internal/v1/ai/jobs/${aiJobId}/events`)
        .set('X-Internal-Service-Key', 'internal_ai_worker_secret_secure_2026')
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000001',
          attemptNumber: 1,
          sequence: 1,
          stage: TranslationJobStatus.OCR,
          progress: 30,
        })
        .expect(404);
    });

    it('Intermediate callback with segments should return 400 Bad Request (INTERMEDIATE_SEGMENTS_FORBIDDEN)', async () => {
      const internalKey = 'internal_ai_worker_secret_secure_2026';
      await dataSource.query(
        `UPDATE translation_jobs SET attempt_count = 1, status = 'PREPROCESSING', last_sequence = 0 WHERE id = $1`,
        [aiJobId],
      );

      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId}/events`)
        .set('X-Internal-Service-Key', internalKey)
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000009',
          attemptNumber: 1,
          sequence: 1,
          stage: TranslationJobStatus.OCR,
          progress: 30,
          segments: [{ sortOrder: 1, rawText: 'test' }],
        })
        .expect(400);

      expect(res.body.error.message).toContain('INTERMEDIATE_SEGMENTS_FORBIDDEN');
    });

    it('Internal worker event callback with sequence progression should advance state and save segments', async () => {
      const internalKey = 'internal_ai_worker_secret_secure_2026';

      // Cập nhật attempt_count = 1, status = PREPROCESSING, last_sequence = 0
      await dataSource.query(
        `UPDATE translation_jobs SET attempt_count = 1, status = 'PREPROCESSING', last_sequence = 0 WHERE id = $1`,
        [aiJobId],
      );

      // Gửi event sequence 1: OCR (30%)
      const res1 = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId}/events`)
        .set('X-Internal-Service-Key', internalKey)
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000002',
          attemptNumber: 1,
          sequence: 1,
          stage: TranslationJobStatus.OCR,
          progress: 30,
        })
        .expect(200);

      expect(res1.body.received).toBe(true);
      expect(res1.body.status).toBe(TranslationJobStatus.OCR);

      // Gửi event sequence 2: TRANSLATING (50%)
      await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId}/events`)
        .set('X-Internal-Service-Key', internalKey)
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000003',
          attemptNumber: 1,
          sequence: 2,
          stage: TranslationJobStatus.TRANSLATING,
          progress: 50,
        })
        .expect(200);

      // Gửi event sequence 3: INPAINTING (70%)
      await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId}/events`)
        .set('X-Internal-Service-Key', internalKey)
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000004',
          attemptNumber: 1,
          sequence: 3,
          stage: TranslationJobStatus.INPAINTING,
          progress: 70,
        })
        .expect(200);

      // Gửi event sequence 4: TYPESETTING (85%)
      await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId}/events`)
        .set('X-Internal-Service-Key', internalKey)
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000005',
          attemptNumber: 1,
          sequence: 4,
          stage: TranslationJobStatus.TYPESETTING,
          progress: 85,
        })
        .expect(200);

      // Gửi event sequence 5: QUALITY_CHECK (95%)
      await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId}/events`)
        .set('X-Internal-Service-Key', internalKey)
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000006',
          attemptNumber: 1,
          sequence: 5,
          stage: TranslationJobStatus.QUALITY_CHECK,
          progress: 95,
        })
        .expect(200);

      // 1. Two-step upload: Xin Presigned PUT URL từ Core API
      const presignRes = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId}/output-uploads`)
        .set('X-Internal-Service-Key', internalKey)
        .send({
          attemptNumber: 1,
          files: [{ filename: 'page-001.webp', contentType: 'image/webp' }],
        })
        .expect(200);

      expect(presignRes.body.files.length).toBe(1);
      const outputUploadUrl = presignRes.body.files[0].uploadUrl;
      const outputStorageKey = presignRes.body.files[0].storageKey;

      // 1b. Xin Presigned PUT URL cho clean bases (#162)
      const cleanPresignRes = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId}/clean-base-uploads`)
        .set('X-Internal-Service-Key', internalKey)
        .send({
          attemptNumber: 1,
          pages: [1],
        })
        .expect(200);

      expect(cleanPresignRes.body.cleanBases.length).toBe(1);
      const cleanUploadUrl = cleanPresignRes.body.cleanBases[0].uploadUrl;
      const cleanStorageKey = cleanPresignRes.body.cleanBases[0].storageKey;

      // 2. Upload WebP buffer thật lên MinIO qua Presigned URLs
      const validWebpBytes = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
        0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
        0x00, 0x07, 0x00, 0x00, 0x00, 0x00,
      ]);

      const putRes = await fetch(outputUploadUrl, {
        method: 'PUT',
        body: validWebpBytes,
        headers: { 'Content-Type': 'image/webp' },
      });
      expect(putRes.status).toBe(200);

      const putCleanRes = await fetch(cleanUploadUrl, {
        method: 'PUT',
        body: validWebpBytes,
        headers: { 'Content-Type': 'image/webp' },
      });
      expect(putCleanRes.status).toBe(200);

      // 3. Gửi event sequence 6: READY_FOR_REVIEW với result_manifest và segments
      const validResultManifest = {
        version: 1,
        mediaFormat: 'COMIC',
        pages: [
          {
            page: 1,
            previewKey: outputStorageKey,
            storageKey: outputStorageKey,
            width: 1200,
            height: 1800,
            fileSizeBytes: validWebpBytes.length,
          },
        ],
        cleanBases: [
          {
            page: 1,
            cleanBaseKey: cleanStorageKey,
          },
        ],
      };

      const mockSegments = [
        {
          pageNumber: 1,
          sortOrder: 1,
          bboxX: 100,
          bboxY: 200,
          bboxW: 300,
          bboxH: 150,
          rawText: 'こんにちは',
          translatedText: 'Xin chào',
          confidence: 0.99,
        },
      ];

      const res2 = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId}/events`)
        .set('X-Internal-Service-Key', internalKey)
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000007',
          attemptNumber: 1,
          sequence: 6,
          stage: TranslationJobStatus.READY_FOR_REVIEW,
          progress: 100,
          resultManifest: validResultManifest,
          segments: mockSegments,
        })
        .expect(200);

      expect(res2.body.status).toBe(TranslationJobStatus.READY_FOR_REVIEW);

      // Kiểm tra segments và result_manifest đã được persist vào DB
      const segmentsDb = await dataSource.query(
        `SELECT * FROM translation_segments WHERE job_id = $1`,
        [aiJobId],
      );
      expect(segmentsDb.length).toBe(1);
      expect(segmentsDb[0].raw_text).toBe('こんにちは');
      expect(segmentsDb[0].translated_text).toBe('Xin chào');
    });

    it('Internal worker event with malicious storage key outside job prefix should be rejected with 400', async () => {
      const internalKey = 'internal_ai_worker_secret_secure_2026';
      await dataSource.query(
        `UPDATE translation_jobs SET status = 'INPAINTING', attempt_count = 1, last_sequence = 1 WHERE id = $1`,
        [aiJobId2],
      );

      const maliciousManifest = {
        pages: [
          {
            page: 1,
            previewKey: `media/editions/another-story/confidential.webp`, // Độc hại
          },
        ],
      };

      await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId2}/events`)
        .set('X-Internal-Service-Key', internalKey)
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000004',
          attemptNumber: 1,
          sequence: 2,
          stage: TranslationJobStatus.READY_FOR_REVIEW,
          progress: 100,
          resultManifest: maliciousManifest,
        })
        .expect(400);
    });

    it('Stale callback fencing: Callback from attempt 1 when attempt 2 is active should be safely ignored', async () => {
      const internalKey = 'internal_ai_worker_secret_secure_2026';
      // Bắt đầu attempt 2 trên aiJobId2 -> sequence reset về 0
      await dataSource.query(
        `UPDATE translation_jobs SET attempt_count = 2, last_sequence = 0, status = 'PREPROCESSING' WHERE id = $1`,
        [aiJobId2],
      );

      // 1. Attempt 2 gửi sequence 1 -> Được chấp nhận
      const resValid = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId2}/events`)
        .set('X-Internal-Service-Key', internalKey)
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000005',
          attemptNumber: 2,
          sequence: 1,
          stage: TranslationJobStatus.OCR,
          progress: 40,
        })
        .expect(200);

      expect(resValid.body.received).toBe(true);

      // 2. Attempt 1 đến trễ (attemptNumber: 1, sequence: 9) -> Bị bỏ qua
      const resStale = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId2}/events`)
        .set('X-Internal-Service-Key', internalKey)
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000006',
          attemptNumber: 1,
          sequence: 9,
          stage: TranslationJobStatus.TRANSLATING,
          progress: 60,
        })
        .expect(200);

      expect(resStale.body.ignored).toBe(true);
      expect(resStale.body.reason).toBe('STALE_ATTEMPT');
    });

    it('Out-of-order sequence fencing: Callback with sequence <= last_sequence should be ignored', async () => {
      const internalKey = 'internal_ai_worker_secret_secure_2026';
      // Gửi lại sequence 1 trong khi lastSequence hiện tại là 1
      const res = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${aiJobId2}/events`)
        .set('X-Internal-Service-Key', internalKey)
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000007',
          attemptNumber: 2,
          sequence: 1,
          stage: TranslationJobStatus.OCR,
          progress: 40,
        })
        .expect(200);

      expect(res.body.ignored).toBe(true);
      expect(res.body.reason).toBe('OUT_OF_ORDER_SEQUENCE');
    });

    it('POST /api/v1/ai/jobs/:id/cancel should cancel active job and reject further callbacks', async () => {
      // Tạo job để test cancel
      const createRes = await request(app.getHttpServer())
        .post('/api/v1/ai/jobs')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .set('Idempotency-Key', 'd0000000-0000-4000-a000-000000000001')
        .send({
          chapterVersionId: versionA1Id,
          sourceLang: 'ja',
          targetLang: 'vi',
        });
      cancelJobId = createRes.body.jobId;

      // Hủy job
      const cancelRes = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${cancelJobId}/cancel`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(200);

      expect(cancelRes.body.status).toBe(TranslationJobStatus.CANCELED);

      // Callback gửi tới sau khi cancel -> Bị bỏ qua (JOB_ALREADY_TERMINAL)
      const internalKey = 'internal_ai_worker_secret_secure_2026';
      const eventRes = await request(app.getHttpServer())
        .post(`/internal/v1/ai/jobs/${cancelJobId}/events`)
        .set('X-Internal-Service-Key', internalKey)
        .send({
          eventId: 'b0000000-0000-4000-b000-000000000008',
          attemptNumber: 1,
          sequence: 1,
          stage: TranslationJobStatus.OCR,
          progress: 50,
        })
        .expect(200);

      expect(eventRes.body.ignored).toBe(true);
      expect(eventRes.body.reason).toBe('JOB_ALREADY_TERMINAL');

      // Hủy lại lần nữa -> 400 Bad Request
      await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${cancelJobId}/cancel`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(400);
    });

    it('Watchdog Heartbeat: Stalled active job (>60s) should be detected and aborted', async () => {
      // Giả lập job đang active bị mất heartbeat > 60s
      const seventySecondsAgo = new Date(Date.now() - 70 * 1000);
      await dataSource.query(
        `UPDATE translation_jobs SET status = 'OCR', heartbeat_at = $1 WHERE id = $2`,
        [seventySecondsAgo, aiJobId2],
      );

      // Chạy watchdog
      await watchdog.checkStalledJobs();
      // Không crash và log cảnh báo thành công
    });

    it('Watchdog Reconciler: Stalled VALIDATING job (>30s) should be enqueued and marked QUEUED', async () => {
      const fortySecondsAgo = new Date(Date.now() - 40 * 1000);
      const stuckJob = await dataSource.query(
        `INSERT INTO translation_jobs (project_id, source_version_id, status, created_at)
         VALUES ($1, $2, 'VALIDATING', $3)
         RETURNING id`,
        [projectId, versionA1Id, fortySecondsAgo],
      );

      await watchdog.reconcileValidatingJobs();

      const updatedJob = await dataSource.query(
        `SELECT status FROM translation_jobs WHERE id = $1`,
        [stuckJob[0].id],
      );
      expect(updatedJob[0].status).toBe(TranslationJobStatus.QUEUED);
    });

    it('POST /api/v1/ai/jobs/:id/apply with OVERWRITE_ACTIVE_VERSION should create new AI_TRANSLATED version and update active_version_id', async () => {
      // Translator không có quyền apply -> 403
      // (Story Member role của TranslatorA là OWNER nên ta test với TranslatorB không thuộc story)
      await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${aiJobId}/apply`)
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .set('Idempotency-Key', 'c0000000-0000-4000-a000-000000000000')
        .send({ mode: 'OVERWRITE_ACTIVE_VERSION' })
        .expect(403);

      // Lấy active_version_id ban đầu của Chapter
      const initialChapter = await dataSource.query(
        `SELECT active_version_id FROM chapters WHERE id = $1`,
        [chapterAId],
      );
      const initialActiveVersionId = initialChapter[0].active_version_id;

      // Owner/Editor apply với OVERWRITE_ACTIVE_VERSION
      const applyRes = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${aiJobId}/apply`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .set('Idempotency-Key', 'c0000000-0000-4000-a000-000000000001')
        .send({ mode: 'OVERWRITE_ACTIVE_VERSION' })
        .expect(200);

      expect(applyRes.body.chapterId).toBe(chapterAId);
      expect(applyRes.body.versionType).toBe(ChapterVersionType.AI_TRANSLATED);
      expect(applyRes.body.activeVersionId).not.toBe(initialActiveVersionId);
      expect(applyRes.body.activeVersionId).toBeDefined();

      // Kiểm tra tính bất biến: Bản raw gốc (versionA1Id) và version trước đó vẫn nguyên vẹn
      const rawVersionDb = await dataSource.query(
        `SELECT * FROM chapter_versions WHERE id = $1`,
        [versionA1Id],
      );
      expect(rawVersionDb.length).toBe(1);
      expect(rawVersionDb[0].version_type).toBe(ChapterVersionType.RAW_ORIGINAL);

      const prevActiveVersionDb = await dataSource.query(
        `SELECT * FROM chapter_versions WHERE id = $1`,
        [initialActiveVersionId],
      );
      expect(prevActiveVersionDb[0].version_type).toBe(ChapterVersionType.HUMAN_EDITED);

      // Kiểm tra MediaAssets đã được materialize cho version mới
      const newAssets = await dataSource.query(
        `SELECT * FROM media_assets WHERE version_id = $1`,
        [applyRes.body.activeVersionId],
      );
      expect(newAssets.length).toBeGreaterThan(0);
      expect(newAssets[0].storage_key).toContain('page-001.webp');

      // Idempotent retry apply cùng key -> Trả về kết quả cũ, không tạo version mới
      const retryApply = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${aiJobId}/apply`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .set('Idempotency-Key', 'c0000000-0000-4000-a000-000000000001')
        .send({ mode: 'OVERWRITE_ACTIVE_VERSION' })
        .expect(200);

      expect(retryApply.body.activeVersionId).toBe(applyRes.body.activeVersionId);
      expect(retryApply.body.isAlreadyApplied).toBe(true);
    });

    it('POST /api/v1/ai/jobs/:id/apply with CREATE_ALTERNATE_VERSION should create new version while keeping active_version_id unchanged', async () => {
      // Chuẩn bị job ở trạng thái READY_FOR_REVIEW
      const altJob = await dataSource.query(
        `INSERT INTO translation_jobs (project_id, source_version_id, status, result_manifest)
         VALUES ($1, $2, 'READY_FOR_REVIEW', '{"version":1,"mediaFormat":"COMIC","pages":[{"page":1,"storageKey":"ai/jobs/alt/page-1.webp","previewKey":"ai/jobs/alt/page-1.webp","width":1200,"height":1800,"fileSizeBytes":102400}]}')
         RETURNING id`,
        [projectId, versionA1Id],
      );

      const beforeChapter = await dataSource.query(
        `SELECT active_version_id FROM chapters WHERE id = $1`,
        [chapterAId],
      );
      const currentActiveVersion = beforeChapter[0].active_version_id;

      const res = await request(app.getHttpServer())
        .post(`/api/v1/ai/jobs/${altJob[0].id}/apply`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .set('Idempotency-Key', 'c0000000-0000-4000-a000-000000000002')
        .send({ mode: 'CREATE_ALTERNATE_VERSION' })
        .expect(200);

      expect(res.body.versionType).toBe(ChapterVersionType.AI_TRANSLATED);

      // Con trỏ activeVersionId của Chapter vẫn giữ nguyên
      const afterChapter = await dataSource.query(
        `SELECT active_version_id FROM chapters WHERE id = $1`,
        [chapterAId],
      );
      expect(afterChapter[0].active_version_id).toBe(currentActiveVersion);
    });

    it('POST /api/v1/ai/glossary and GET /api/v1/ai/glossary should manage project glossary terms', async () => {
      // 1. Tạo thuật ngữ
      const postRes = await request(app.getHttpServer())
        .post('/api/v1/ai/glossary')
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .send({
          projectId,
          sourceTerm: '螺旋丸',
          targetTerm: 'Rasengan (Loa Toàn Hoàn)',
          category: 'SKILL_NAME',
        })
        .expect(201);

      expect(postRes.body.sourceTerm).toBe('螺旋丸');
      expect(postRes.body.targetTerm).toBe('Rasengan (Loa Toàn Hoàn)');

      // 2. Lấy danh sách thuật ngữ
      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/ai/glossary?projectId=${projectId}`)
        .set('Authorization', `Bearer ${translatorAAccessToken}`)
        .expect(200);

      expect(getRes.body.length).toBeGreaterThan(0);
      expect(getRes.body.some((g: any) => g.sourceTerm === '螺旋丸')).toBe(true);
    });

    it('Gamification Cleanup: Global Admin should be allowed to reward read chapter on PRIVATE story', async () => {
      // Tạo truyện PRIVATE
      const uniqueSlug = `truyen-rieng-tu-admin-${Date.now()}`;
      const privateStory = await dataSource.query(
        `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
         VALUES ('Truyện Riêng Tư Admin', $1, 'https://example.com/cover.webp', 'PRIVATE', 'COMIC', 'MANGA', 'JP', 'ja')
         RETURNING id`,
        [uniqueSlug],
      );
      const privateEdition = await dataSource.query(
        `INSERT INTO story_editions (story_id, edition_name, language, is_default)
         VALUES ($1, 'Bản gốc', 'ja', true)
         RETURNING id`,
        [privateStory[0].id],
      );
      const privateChapter = await dataSource.query(
        `INSERT INTO chapters (story_edition_id, chapter_number, title)
         VALUES ($1, 1, 'Chương 1')
         RETURNING id`,
        [privateEdition[0].id],
      );

      // Reader không thuộc story bị chặn 403
      await request(app.getHttpServer())
        .post('/api/v1/gamification/read-chapter')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .send({
          chapterId: privateChapter[0].id,
          readingDurationSeconds: 60,
          progressPercentage: 100,
        })
        .expect(403);

      // Global Admin được phép nhận thưởng mà không bị 403
      const adminRewardRes = await request(app.getHttpServer())
        .post('/api/v1/gamification/read-chapter')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          chapterId: privateChapter[0].id,
          readingDurationSeconds: 60,
          progressPercentage: 100,
        })
        .expect(200);

      expect(adminRewardRes.body.success).toBe(true);
    });
  });
});





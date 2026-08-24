import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
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

describe('OmniNovel Backend Core API (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  // Tokens & Cookies
  let readerAccessToken: string;
  let readerRefreshTokenCookie: string;

  let translatorAAccessToken: string;
  let translatorARefreshTokenCookie: string;

  let translatorBAccessToken: string;

  let adminAccessToken: string;

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
  // 2. AUTHENTICATION & REFRESH ROTATION
  // ==========================================
  describe('2. Authentication Module & Token Lifecycle', () => {
    it('POST /api/v1/auth/register should create user and user_progression in single transaction', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(testReader)
        .expect(201);

      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe(testReader.username);
      expect(res.body.user.role).toBe(GlobalRole.READER);

      const prog = await dataSource.query(
        `SELECT * FROM user_progression WHERE user_id = $1`,
        [res.body.user.id],
      );
      expect(prog.length).toBe(1);
      expect(prog[0].level).toBe(1);
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

      // Thử dùng lại refreshToken cũ -> Bị chặn với 401 Unauthorized do đã bị xoá session
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', oldCookie)
        .expect(401);
    });

    it('GET /api/v1/auth/me should return reader profile and permissions', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${readerAccessToken}`)
        .expect(200);

      expect(res.body.user.username).toBe(testReader.username);
      expect(res.body.permissions.canCreateStory).toBe(false);
      expect(res.body.permissions.isAdmin).toBe(false);
    });

    it('POST /api/v1/auth/logout should revoke session on Redis and subsequent refresh fails with 401', async () => {
      // 1. Đăng xuất với cookie hiện tại
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', readerRefreshTokenCookie)
        .expect(200);

      // 2. Thử refresh lại bằng chính cookie vừa đăng xuất -> phải bị 401 Unauthorized
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

      // Đăng nhập lại Reader để có valid token
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

      // Kiểm tra trong bảng story_members đã gán vai trò OWNER cho Translator A
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
      // Cố tình truyền volumeBId (thuộc Edition B) vào Edition A
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

      // Tạo version 2
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
      // Thêm User C làm Story Member với role TRANSLATOR
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
      // Tạo Chapter B trên Story B
      const chB = await request(app.getHttpServer())
        .post(`/api/v1/studio/editions/${editionBId}/chapters`)
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .send({ chapterNumber: '1.00', title: 'Chương 1' });
      chapterBId = chB.body.id;

      const vB = await request(app.getHttpServer())
        .post(`/api/v1/studio/chapters/${chapterBId}/versions`)
        .set('Authorization', `Bearer ${translatorBAccessToken}`)
        .send({ versionType: ChapterVersionType.RAW_ORIGINAL, language: 'vi' });

      // Thử gán version của Chapter B vào Chapter A -> Bị từ chối với 400 Bad Request!
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
});

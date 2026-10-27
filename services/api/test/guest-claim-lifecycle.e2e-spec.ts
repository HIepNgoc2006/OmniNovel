import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { GuestClaimService } from '../src/modules/claims/guest-claim.service';
import { RedisService } from '../src/redis/redis.service';
import { JwtService } from '@nestjs/jwt';
import { v4 as uuidv4 } from 'uuid';
import {
  CanonicalReadingMode,
  PrepareGuestClaimDto,
} from '../src/modules/claims/dto/prepare-guest-claim.dto';
import { CommitGuestClaimDto } from '../src/modules/claims/dto/commit-guest-claim.dto';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { verifyTestDatabaseIdentity } from '../src/common/guards/test-isolation-guard';

describe('Phase 7B.4: Guest Claim Comprehensive E2E Lifecycle & Crash Matrix (Task 7B.4)', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let dataSource: DataSource;
  let guestClaimService: GuestClaimService;
  let redisService: RedisService;
  let jwtService: JwtService;

  // Test Users
  let userA: any;
  let userAToken: string;
  let userB: any;
  let userBToken: string;
  let userGamification: any;
  let userGamificationToken: string;

  // Test Entities
  let storyPagedId: string;
  let chapterPagedId: string;
  let versionPagedId: string;

  let storyWebtoonId: string;
  let chapterWebtoonId: string;
  let versionWebtoonId: string;

  let storyNovelId: string;
  let chapterNovelId: string;
  let versionNovelId: string;

  let unpublishedStoryId: string;
  let unpublishedChapterId: string;
  let unpublishedVersionId: string;

  const validGuestProfileId = 'b8888888-8888-4888-8888-888888888888';

  beforeAll(async () => {
    await verifyTestDatabaseIdentity();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix('api/v1', {
      exclude: ['health/live', 'health/ready', 'internal/v1/(.*)'],
    });
    await app.init();

    dataSource = app.get(DataSource);
    guestClaimService = app.get(GuestClaimService);
    redisService = app.get(RedisService);
    jwtService = app.get(JwtService);

    const now = Date.now();

    // 1. Tạo User A (Chính chủ)
    const [uA] = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active, is_deleted)
       VALUES ('user_claim_7b4_a_${now}', 'user_7b4_a_${now}@omninovel.test', 'hash', 'READER', true, false)
       RETURNING id, username, email, role`,
    );
    userA = uA;
    const sidA = `session-7b4-a-${now}`;
    await redisService.set(
      `auth_session:${userA.id}:${sidA}`,
      JSON.stringify({ sessionId: sidA, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }),
    );
    userAToken = jwtService.sign({ sub: userA.id, username: userA.username, role: userA.role, sid: sidA });

    // 2. Tạo User B (Attacker / Không sở hữu claim)
    const [uB] = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active, is_deleted)
       VALUES ('user_claim_7b4_b_${now}', 'user_7b4_b_${now}@omninovel.test', 'hash', 'READER', true, false)
       RETURNING id, username, email, role`,
    );
    userB = uB;
    const sidB = `session-7b4-b-${now}`;
    await redisService.set(
      `auth_session:${userB.id}:${sidB}`,
      JSON.stringify({ sessionId: sidB, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }),
    );
    userBToken = jwtService.sign({ sub: userB.id, username: userB.username, role: userB.role, sid: sidB });

    // 3. Tạo User Gamification (Chuyên biệt thẩm định Zero-Gamification P0)
    const [uG] = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active, is_deleted)
       VALUES ('user_claim_7b4_g_${now}', 'user_7b4_g_${now}@omninovel.test', 'hash', 'READER', true, false)
       RETURNING id, username, email, role`,
    );
    userGamification = uG;
    const sidG = `session-7b4-g-${now}`;
    await redisService.set(
      `auth_session:${userGamification.id}:${sidG}`,
      JSON.stringify({ sessionId: sidG, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }),
    );
    userGamificationToken = jwtService.sign({ sub: userGamification.id, username: userGamification.username, role: userGamification.role, sid: sidG });

    // Khởi tạo bảng user_progression với số liệu cố định cho userGamification
    await dataSource.query(
      `INSERT INTO user_progression (user_id, level, total_exp, omnicoin_balance, current_streak, max_streak, rank_theme_id)
       VALUES ($1, 2, '250', '80', 7, 14, 'DEFAULT')
       ON CONFLICT (user_id) DO UPDATE SET total_exp = '250', omnicoin_balance = '80', current_streak = 7, max_streak = 14`,
      [userGamification.id],
    );

    // 4. Tạo Stories, Editions, Chapters và Versions:
    // a. Paged Manga Story
    const [sPaged] = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
       VALUES ('7B.4 Paged Manga', 'paged-manga-${now}', 'https://example.com/cover.webp', 'PUBLIC', 'COMIC', 'MANGA', 'JP', 'ja')
       RETURNING id`,
    );
    storyPagedId = sPaged.id;
    const [ePaged] = await dataSource.query(
      `INSERT INTO story_editions (story_id, edition_name, language, is_default) VALUES ($1, 'Default', 'vi', true) RETURNING id`,
      [storyPagedId],
    );
    const [cPaged] = await dataSource.query(
      `INSERT INTO chapters (story_edition_id, chapter_number, title) VALUES ($1, '1', 'Chapter 1') RETURNING id`,
      [ePaged.id],
    );
    chapterPagedId = cPaged.id;
    const [vPaged] = await dataSource.query(
      `INSERT INTO chapter_versions (chapter_id, version_number, version_type, is_published) VALUES ($1, 1, 'RAW_ORIGINAL', true) RETURNING id`,
      [chapterPagedId],
    );
    versionPagedId = vPaged.id;

    // b. Webtoon Story
    const [sWebtoon] = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
       VALUES ('7B.4 Webtoon', 'webtoon-${now}', 'https://example.com/cover.webp', 'PUBLIC', 'COMIC', 'WEBTOON', 'KR', 'ko')
       RETURNING id`,
    );
    storyWebtoonId = sWebtoon.id;
    const [eWebtoon] = await dataSource.query(
      `INSERT INTO story_editions (story_id, edition_name, language, is_default) VALUES ($1, 'Default', 'vi', true) RETURNING id`,
      [storyWebtoonId],
    );
    const [cWebtoon] = await dataSource.query(
      `INSERT INTO chapters (story_edition_id, chapter_number, title) VALUES ($1, '1', 'Chapter 1') RETURNING id`,
      [eWebtoon.id],
    );
    chapterWebtoonId = cWebtoon.id;
    const [vWebtoon] = await dataSource.query(
      `INSERT INTO chapter_versions (chapter_id, version_number, version_type, is_published) VALUES ($1, 1, 'RAW_ORIGINAL', true) RETURNING id`,
      [chapterWebtoonId],
    );
    versionWebtoonId = vWebtoon.id;

    // c. Novel Story
    const [sNovel] = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
       VALUES ('7B.4 Novel', 'novel-${now}', 'https://example.com/cover.webp', 'PUBLIC', 'NOVEL', 'WEB_NOVEL', 'CN', 'zh')
       RETURNING id`,
    );
    storyNovelId = sNovel.id;
    const [eNovel] = await dataSource.query(
      `INSERT INTO story_editions (story_id, edition_name, language, is_default) VALUES ($1, 'Default', 'vi', true) RETURNING id`,
      [storyNovelId],
    );
    const [cNovel] = await dataSource.query(
      `INSERT INTO chapters (story_edition_id, chapter_number, title) VALUES ($1, '1', 'Chapter 1') RETURNING id`,
      [eNovel.id],
    );
    chapterNovelId = cNovel.id;
    const [vNovel] = await dataSource.query(
      `INSERT INTO chapter_versions (chapter_id, version_number, version_type, is_published) VALUES ($1, 1, 'RAW_ORIGINAL', true) RETURNING id`,
      [chapterNovelId],
    );
    versionNovelId = vNovel.id;

    // d. Unpublished Chapter Story (để test boundary)
    const [sUnpub] = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
       VALUES ('7B.4 Unpublished', 'unpub-${now}', 'https://example.com/cover.webp', 'PUBLIC', 'COMIC', 'MANGA', 'JP', 'ja')
       RETURNING id`,
    );
    unpublishedStoryId = sUnpub.id;
    const [eUnpub] = await dataSource.query(
      `INSERT INTO story_editions (story_id, edition_name, language, is_default) VALUES ($1, 'Default', 'vi', true) RETURNING id`,
      [unpublishedStoryId],
    );
    const [cUnpub] = await dataSource.query(
      `INSERT INTO chapters (story_edition_id, chapter_number, title) VALUES ($1, '99', 'Draft Chapter') RETURNING id`,
      [eUnpub.id],
    );
    unpublishedChapterId = cUnpub.id;
    const [vUnpub] = await dataSource.query(
      `INSERT INTO chapter_versions (chapter_id, version_number, version_type, is_published) VALUES ($1, 1, 'RAW_ORIGINAL', false) RETURNING id`,
      [unpublishedChapterId],
    );
    unpublishedVersionId = vUnpub.id;
  });

  afterAll(async () => {
    // Dọn dẹp dữ liệu test
    const userIds = [userA?.id, userB?.id, userGamification?.id].filter(Boolean);
    if (userIds.length > 0) {
      await dataSource.query(`DELETE FROM user_progression WHERE user_id = ANY($1)`, [userIds]);
      await dataSource.query(`DELETE FROM guest_claims WHERE user_id = ANY($1)`, [userIds]);
      await dataSource.query(`DELETE FROM bookmarks WHERE user_id = ANY($1)`, [userIds]);
      await dataSource.query(`DELETE FROM chapter_read_states WHERE user_id = ANY($1)`, [userIds]);
      await dataSource.query(`DELETE FROM reading_progress WHERE user_id = ANY($1)`, [userIds]);
      await dataSource.query(`DELETE FROM reading_history_tombstones WHERE user_id = ANY($1)`, [userIds]);
      await dataSource.query(`DELETE FROM reading_history_epoch_counters WHERE user_id = ANY($1)`, [userIds]);
      await dataSource.query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
    }

    const storyIds = [storyPagedId, storyWebtoonId, storyNovelId, unpublishedStoryId].filter(Boolean);
    if (storyIds.length > 0) {
      await dataSource.query(`DELETE FROM stories WHERE id = ANY($1)`, [storyIds]);
    }

    if (app) {
      await app.close();
    }
  });

  // ============================================================================
  // KỊCH BẢN 1: Input Boundaries & DTO Validation
  // ============================================================================
  describe('Kịch bản 1: Input Boundaries & DTO Validation (HTTP Strict Gate)', () => {
    it('1.1. Reject pageIndex < 1: should reject pageIndex: 0 with 400 Bad Request', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          guestProfileId: validGuestProfileId,
          bookmarks: [],
          history: [],
          progress: [
            {
              storyId: storyPagedId,
              chapterId: chapterPagedId,
              chapterVersionId: versionPagedId,
              readingMode: CanonicalReadingMode.PAGED,
              pageIndex: 0, // VI PHẠM: 1-based index invariant
              scrollPosition: 0,
              progressPercentage: 50,
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('pageIndex must be >= 1 (1-based index)');
    });

    it('1.2. Reject invalid readingMode: should reject unknown mode with 400 Bad Request', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          guestProfileId: validGuestProfileId,
          bookmarks: [],
          history: [],
          progress: [
            {
              storyId: storyPagedId,
              chapterId: chapterPagedId,
              chapterVersionId: versionPagedId,
              readingMode: 'INVALID_MODE',
              pageIndex: 1,
              scrollPosition: 0,
              progressPercentage: 50,
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('readingMode must be WEBTOON, PAGED, or NOVEL');
    });

    it('1.3. Reject payload > 500 items: should reject progress exceeding 500 items with 400 Bad Request', async () => {
      const oversizedProgress = Array.from({ length: 501 }, () => ({
        storyId: storyPagedId,
        chapterId: chapterPagedId,
        readingMode: CanonicalReadingMode.PAGED,
        pageIndex: 1,
        scrollPosition: 0,
        progressPercentage: 50,
      }));

      const res = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          guestProfileId: validGuestProfileId,
          bookmarks: [],
          history: [],
          progress: oversizedProgress,
        });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('progress array cannot exceed 500 items');
    });

    it('1.4. Reject unpublished chapter: should filter out or reject draft chapter versions', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          guestProfileId: validGuestProfileId,
          bookmarks: [],
          history: [
            {
              storyId: unpublishedStoryId,
              chapterId: unpublishedChapterId,
              readAt: new Date().toISOString(),
              progressPercentage: 100,
            },
          ],
          progress: [],
        });

      // Chapter unpublished bị chặn fail-closed với HTTP 400
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('is not published and cannot be claimed');
    });
  });

  // ============================================================================
  // KỊCH BẢN 2: Mode-Aware Progress Conflict Detection
  // ============================================================================
  describe('Kịch bản 2: Mode-Aware Progress Conflict Detection', () => {
    it('2.1. PAGED Mode: should detect conflict when guest pageIndex differs from cloud pageIndex', async () => {
      // 1. Tạo progress sẵn trên cloud: pageIndex: 5
      await dataSource.query(
        `INSERT INTO reading_progress (user_id, story_id, chapter_id, chapter_version_id, reading_mode, page_index, scroll_position, progress_percentage, updated_at)
         VALUES ($1, $2, $3, $4, 'PAGED', 5, 0, 25, NOW())
         ON CONFLICT (user_id, story_id) DO UPDATE SET page_index = 5, reading_mode = 'PAGED'`,
        [userA.id, storyPagedId, chapterPagedId, versionPagedId],
      );

      // 2. Guest gửi tiến độ khác: pageIndex: 12
      const res = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          guestProfileId: validGuestProfileId,
          bookmarks: [],
          history: [],
          progress: [
            {
              storyId: storyPagedId,
              chapterId: chapterPagedId,
              chapterVersionId: versionPagedId,
              readingMode: CanonicalReadingMode.PAGED,
              pageIndex: 12,
              scrollPosition: 0,
              progressPercentage: 50,
            },
          ],
        });

      if (res.status !== 200) {
        console.error('RES 2.1 ERROR:', JSON.stringify(res.body));
      }
      expect(res.status).toBe(200);
      expect(res.body.conflicts).toHaveLength(1);
      const conflict = res.body.conflicts[0];
      expect(conflict.storyId).toBe(storyPagedId);
      expect(conflict.cloudProgress.pageIndex).toBe(5);
      expect(conflict.guestProgress.pageIndex).toBe(12);

      // Dọn dẹp progress
      await dataSource.query(`DELETE FROM reading_progress WHERE user_id = $1 AND story_id = $2`, [userA.id, storyPagedId]);
    });

    it('2.2. WEBTOON Mode: should detect conflict based on scrollPosition and progressPercentage', async () => {
      // 1. Cloud có scrollPosition: 1500, percentage: 40
      await dataSource.query(
        `INSERT INTO reading_progress (user_id, story_id, chapter_id, chapter_version_id, reading_mode, page_index, scroll_position, progress_percentage, updated_at)
         VALUES ($1, $2, $3, $4, 'WEBTOON', 1, 1500, 40, NOW())
         ON CONFLICT (user_id, story_id) DO UPDATE SET scroll_position = 1500, progress_percentage = 40, reading_mode = 'WEBTOON'`,
        [userA.id, storyWebtoonId, chapterWebtoonId, versionWebtoonId],
      );

      // 2. Guest có scrollPosition: 3200, percentage: 80
      const res = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          guestProfileId: validGuestProfileId,
          bookmarks: [],
          history: [],
          progress: [
            {
              storyId: storyWebtoonId,
              chapterId: chapterWebtoonId,
              chapterVersionId: versionWebtoonId,
              readingMode: CanonicalReadingMode.WEBTOON,
              pageIndex: 1,
              scrollPosition: 3200,
              progressPercentage: 80,
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.conflicts).toHaveLength(1);
      const conflict = res.body.conflicts[0];
      expect(conflict.cloudProgress.scrollPosition).toBe(1500);
      expect(conflict.guestProgress.scrollPosition).toBe(3200);

      await dataSource.query(`DELETE FROM reading_progress WHERE user_id = $1 AND story_id = $2`, [userA.id, storyWebtoonId]);
    });

    it('2.3. NOVEL Mode: should detect conflict based on anchorBlockId and textOffset', async () => {
      // 1. Cloud có anchorBlockId: 'p-10', textOffset: 25
      await dataSource.query(
        `INSERT INTO reading_progress (user_id, story_id, chapter_id, chapter_version_id, reading_mode, page_index, scroll_position, progress_percentage, anchor_block_id, text_offset, updated_at)
         VALUES ($1, $2, $3, $4, 'NOVEL', 1, 0, 10, 'p-10', 25, NOW())
         ON CONFLICT (user_id, story_id) DO UPDATE SET anchor_block_id = 'p-10', text_offset = 25, reading_mode = 'NOVEL'`,
        [userA.id, storyNovelId, chapterNovelId, versionNovelId],
      );

      // 2. Guest có anchorBlockId: 'p-25', textOffset: 0
      const res = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          guestProfileId: validGuestProfileId,
          bookmarks: [],
          history: [],
          progress: [
            {
              storyId: storyNovelId,
              chapterId: chapterNovelId,
              chapterVersionId: versionNovelId,
              readingMode: CanonicalReadingMode.NOVEL,
              pageIndex: 1,
              scrollPosition: 0,
              progressPercentage: 30,
              anchorBlockId: 'p-25',
              textOffset: 0,
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.conflicts).toHaveLength(1);
      const conflict = res.body.conflicts[0];
      expect(conflict.cloudProgress.anchorBlockId).toBe('p-10');
      expect(conflict.guestProgress.anchorBlockId).toBe('p-25');

      await dataSource.query(`DELETE FROM reading_progress WHERE user_id = $1 AND story_id = $2`, [userA.id, storyNovelId]);
    });
  });

  // ============================================================================
  // KỊCH BẢN 3: Tombstone Anti-Resurrection Invariant
  // ============================================================================
  describe('Kịch bản 3: Tombstone Anti-Resurrection Invariant', () => {
    it('3.1. Tombstoned story: should block read states and progress from being resurrected', async () => {
      // 1. Thêm tombstone cho storyPagedId với epoch = 1
      await dataSource.query(
        `INSERT INTO reading_history_tombstones (user_id, story_id, epoch, deleted_at)
         VALUES ($1, $2, 1, NOW())
         ON CONFLICT (user_id, story_id) DO UPDATE SET epoch = 1, deleted_at = NOW()`,
        [userA.id, storyPagedId],
      );

      // 2. Guest gửi cả bookmark, history và progress cho story bị tombstone
      const prepareRes = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          guestProfileId: validGuestProfileId,
          bookmarks: [{ storyId: storyPagedId }],
          history: [
            {
              storyId: storyPagedId,
              chapterId: chapterPagedId,
              readAt: new Date().toISOString(),
              progressPercentage: 100,
            },
          ],
          progress: [
            {
              storyId: storyPagedId,
              chapterId: chapterPagedId,
              chapterVersionId: versionPagedId,
              readingMode: CanonicalReadingMode.PAGED,
              pageIndex: 10,
              scrollPosition: 0,
              progressPercentage: 50,
            },
          ],
        });

      expect(prepareRes.status).toBe(200);
      expect(prepareRes.body.readStatesIgnoredAntiResurrectionCount).toBe(2);

      // 3. Commit claim
      const commitRes = await request(app.getHttpServer())
        .post(`/api/v1/account/guest-claims/${prepareRes.body.claimId}/commit`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          expectedStateFingerprint: prepareRes.body.stateFingerprint,
          conflictDecisions: {},
        });

      expect(commitRes.status).toBe(200);
      expect(commitRes.body.summary.bookmarksImported).toBe(1);
      expect(commitRes.body.summary.historyMerged).toBe(0);
      expect(commitRes.body.summary.progressUpdated).toBe(0);

      // Xác minh PostgreSQL: Bookmark có thể import, nhưng progress & read-state KHÔNG được phục sinh
      const progRows = await dataSource.query(
        `SELECT * FROM reading_progress WHERE user_id = $1 AND story_id = $2`,
        [userA.id, storyPagedId],
      );
      expect(progRows).toHaveLength(0);

      const crsRows = await dataSource.query(
        `SELECT * FROM chapter_read_states WHERE user_id = $1 AND chapter_id = $2`,
        [userA.id, chapterPagedId],
      );
      expect(crsRows).toHaveLength(0);

      // Dọn dẹp
      await dataSource.query(`DELETE FROM reading_history_tombstones WHERE user_id = $1 AND story_id = $2`, [userA.id, storyPagedId]);
      await dataSource.query(`DELETE FROM bookmarks WHERE user_id = $1 AND story_id = $2`, [userA.id, storyPagedId]);
      await dataSource.query(`DELETE FROM guest_claims WHERE claim_id = $1`, [prepareRes.body.claimId]);
    });
  });

  // ============================================================================
  // KỊCH BẢN 4: Commit Idempotency First
  // ============================================================================
  describe('Kịch bản 4: Commit Idempotency First', () => {
    it('4.1. Calling commit twice: second call returns 200 OK immediately from ledger without duplicate insertions', async () => {
      // 1. Prepare
      const prepareRes = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          guestProfileId: validGuestProfileId,
          bookmarks: [{ storyId: storyNovelId }],
          history: [],
          progress: [],
        });
      const claimId = prepareRes.body.claimId;
      const fp = prepareRes.body.stateFingerprint;

      // 2. Commit lần 1
      const commit1 = await request(app.getHttpServer())
        .post(`/api/v1/account/guest-claims/${claimId}/commit`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ expectedStateFingerprint: fp, conflictDecisions: {} });
      expect(commit1.status).toBe(200);
      expect(commit1.body.status).toBe('COMMITTED');
      const committedAt1 = commit1.body.committedAt;

      // 3. Commit lần 2 (ngay lập tức)
      const commit2 = await request(app.getHttpServer())
        .post(`/api/v1/account/guest-claims/${claimId}/commit`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ expectedStateFingerprint: fp, conflictDecisions: {} });
      expect(commit2.status).toBe(200);
      expect(commit2.body.status).toBe('COMMITTED');
      expect(commit2.body.committedAt).toBe(committedAt1);

      // Kiểm tra database: chỉ có đúng 1 bản ghi bookmark
      const bmCount = await dataSource.query(
        `SELECT COUNT(*) FROM bookmarks WHERE user_id = $1 AND story_id = $2`,
        [userA.id, storyNovelId],
      );
      expect(parseInt(bmCount[0].count, 10)).toBe(1);

      await dataSource.query(`DELETE FROM bookmarks WHERE user_id = $1 AND story_id = $2`, [userA.id, storyNovelId]);
      await dataSource.query(`DELETE FROM guest_claims WHERE claim_id = $1`, [claimId]);
    });
  });

  // ============================================================================
  // KỊCH BẢN 5: Redis Loss Fallback & High Availability
  // ============================================================================
  describe('Kịch bản 5: Redis Loss Fallback & High Availability', () => {
    it('5.1. Redis loss fallback: commit succeeds via PostgreSQL row lock even when Redis lock fails', async () => {
      // 1. Prepare
      const prepareRes = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          guestProfileId: validGuestProfileId,
          bookmarks: [{ storyId: storyWebtoonId }],
          history: [],
          progress: [],
        });
      const claimId = prepareRes.body.claimId;
      const fp = prepareRes.body.stateFingerprint;

      // 2. Mock Redis setnx ném lỗi (giả lập Redis outage)
      const originalSetnx = redisService.setnx.bind(redisService);
      jest.spyOn(redisService, 'setnx').mockImplementationOnce(async () => {
        throw new Error('REDIS_CONNECTION_REFUSED_SIMULATION');
      });

      // 3. Commit vẫn phải hoàn tất an toàn nhờ fallback sang PostgreSQL row lock
      const commitRes = await request(app.getHttpServer())
        .post(`/api/v1/account/guest-claims/${claimId}/commit`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({ expectedStateFingerprint: fp, conflictDecisions: {} });

      expect(commitRes.status).toBe(200);
      expect(commitRes.body.status).toBe('COMMITTED');
      expect(commitRes.body.summary.bookmarksImported).toBe(1);

      // Khôi phục mock
      jest.spyOn(redisService, 'setnx').mockImplementation(originalSetnx);

      await dataSource.query(`DELETE FROM bookmarks WHERE user_id = $1 AND story_id = $2`, [userA.id, storyWebtoonId]);
      await dataSource.query(`DELETE FROM guest_claims WHERE claim_id = $1`, [claimId]);
    });
  });

  // ============================================================================
  // KỊCH BẢN 6: TOCTOU Protection & Stale Fingerprint Detection
  // ============================================================================
  describe('Kịch bản 6: TOCTOU Protection & Stale Fingerprint Detection', () => {
    it('6.1. Stale fingerprint: should reject with 409 Conflict (CLAIM_STALE_REPREPARE) when cloud data changes', async () => {
      // 1. Prepare
      const prepareRes = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          guestProfileId: validGuestProfileId,
          bookmarks: [{ storyId: storyPagedId }],
          history: [],
          progress: [],
        });
      const claimId = prepareRes.body.claimId;

      // 2. Giả lập Cloud thay đổi giữa chừng: user tự thêm bookmark của storyPagedId trên cloud
      await dataSource.query(
        `INSERT INTO bookmarks (user_id, story_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
        [userA.id, storyPagedId],
      );

      // 3. Gọi commit với fingerprint cũ lúc prepare -> Bị chặn 409
      const commitRes = await request(app.getHttpServer())
        .post(`/api/v1/account/guest-claims/${claimId}/commit`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          expectedStateFingerprint: prepareRes.body.stateFingerprint,
          conflictDecisions: {},
        });

      expect(commitRes.status).toBe(409);
      expect(JSON.stringify(commitRes.body)).toContain('CLAIM_STALE_REPREPARE');

      // Dọn dẹp
      await dataSource.query(`DELETE FROM bookmarks WHERE user_id = $1`, [userA.id]);
      await dataSource.query(`DELETE FROM guest_claims WHERE claim_id = $1`, [claimId]);
    });
  });

  // ============================================================================
  // KỊCH BẢN 7: Security Ownership Enforcement
  // ============================================================================
  describe('Kịch bản 7: Security Ownership Enforcement (Multi-Tenant Isolation)', () => {
    it('7.1. User B cannot commit User A claim: should return 403 Forbidden', async () => {
      // 1. User A prepare claim
      const prepareRes = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          guestProfileId: validGuestProfileId,
          bookmarks: [{ storyId: storyPagedId }],
          history: [],
          progress: [],
        });
      const claimId = prepareRes.body.claimId;

      // 2. User B cố tình dùng token của mình gọi commit claim của User A
      const commitRes = await request(app.getHttpServer())
        .post(`/api/v1/account/guest-claims/${claimId}/commit`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({
          expectedStateFingerprint: prepareRes.body.stateFingerprint,
          conflictDecisions: {},
        });

      expect(commitRes.status).toBe(403);
      expect(JSON.stringify(commitRes.body)).toContain('You do not own this claim');

      // 3. User B cố tình xem status của User A -> 403 Forbidden
      const statusRes = await request(app.getHttpServer())
        .get(`/api/v1/account/guest-claims/${claimId}/status`)
        .set('Authorization', `Bearer ${userBToken}`);

      expect(statusRes.status).toBe(403);
      expect(JSON.stringify(statusRes.body)).toContain('You do not own this claim');

      await dataSource.query(`DELETE FROM guest_claims WHERE claim_id = $1`, [claimId]);
    });
  });

  // ============================================================================
  // KỊCH BẢN 8: Expired Session Handshake
  // ============================================================================
  describe('Kịch bản 8: Expired Session Handshake', () => {
    it('8.1. Expired claim: should return 410 Gone and update status to EXPIRED in database', async () => {
      // 1. Tạo claim đã hết hạn trong DB (quá hạn 15 phút) với 64-char hex fingerprint
      const expiredClaimId = uuidv4();
      const fpExpired = 'e'.repeat(64);
      await dataSource.query(
        `INSERT INTO guest_claims (claim_id, user_id, guest_profile_id, payload_hash, state_fingerprint, status, preview_data, expires_at)
         VALUES ($1, $2, $3, 'hash_expired', $4, 'PREPARED', '{}'::jsonb, NOW() - INTERVAL '5 minutes')
         ON CONFLICT (claim_id) DO UPDATE SET expires_at = NOW() - INTERVAL '5 minutes', status = 'PREPARED'`,
        [expiredClaimId, userA.id, validGuestProfileId, fpExpired],
      );

      // 2. Gọi commit -> 410 Gone
      const res = await request(app.getHttpServer())
        .post(`/api/v1/account/guest-claims/${expiredClaimId}/commit`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          expectedStateFingerprint: fpExpired,
          conflictDecisions: {},
        });

      expect(res.status).toBe(410);
      expect(JSON.stringify(res.body)).toContain('Claim has expired');

      // 3. Kiểm tra DB: trạng thái được cập nhật thành EXPIRED
      const claimRow = await dataSource.query(`SELECT status FROM guest_claims WHERE claim_id = $1`, [expiredClaimId]);
      expect(claimRow[0].status).toBe('EXPIRED');

      await dataSource.query(`DELETE FROM guest_claims WHERE claim_id = $1`, [expiredClaimId]);
    });
  });

  // ============================================================================
  // KỊCH BẢN 9: Crash Recovery via Status Polling
  // ============================================================================
  describe('Kịch bản 9: Crash Recovery via Status Polling', () => {
    it('9.1. GET /status should return COMMITTED with finalization data for client crash reconciliation', async () => {
      // 1. Prepare & Commit a claim
      const prepareRes = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          guestProfileId: validGuestProfileId,
          bookmarks: [{ storyId: storyNovelId }],
          history: [],
          progress: [],
        });
      const claimId = prepareRes.body.claimId;

      await request(app.getHttpServer())
        .post(`/api/v1/account/guest-claims/${claimId}/commit`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          expectedStateFingerprint: prepareRes.body.stateFingerprint,
          conflictDecisions: {},
        });

      // 2. Client bị crash mạng / mất kết nối ngay sau commit -> khi mở lại, poll status:
      const statusRes = await request(app.getHttpServer())
        .get(`/api/v1/account/guest-claims/${claimId}/status`)
        .set('Authorization', `Bearer ${userAToken}`);

      expect(statusRes.status).toBe(200);
      expect(statusRes.body.status).toBe('COMMITTED');
      expect(statusRes.body.claimId).toBe(claimId);
      expect(statusRes.body.finalization).toBeDefined();
      expect(statusRes.body.resultSummary.bookmarksImported).toBe(1);

      const bookmarkRows = await dataSource.query(`SELECT * FROM bookmarks WHERE user_id = $1 AND story_id = $2`, [userA.id, storyNovelId]);
      expect(bookmarkRows).toHaveLength(1);

      await dataSource.query(`DELETE FROM bookmarks WHERE user_id = $1 AND story_id = $2`, [userA.id, storyNovelId]);
      await dataSource.query(`DELETE FROM guest_claims WHERE claim_id = $1`, [claimId]);
    });
  });

  // ============================================================================
  // KỊCH BẢN 10: ZERO-GAMIFICATION VERIFICATION (P0 BẮT BUỘC)
  // ============================================================================
  describe('Kịch bản 10: ZERO-GAMIFICATION VERIFICATION (Anti-Exploit Invariant)', () => {
    it('10.1. Snapshot user_progression before and after commit: Assert Delta = 0 across all progression metrics', async () => {
      // 1. Lấy snapshot CSDL thực tế TRƯỚC khi commit
      const [progBefore] = await dataSource.query(
        `SELECT level, total_exp, omnicoin_balance, current_streak, max_streak FROM user_progression WHERE user_id = $1`,
        [userGamification.id],
      );

      expect(progBefore).toBeDefined();
      const expBefore = BigInt(progBefore.total_exp);
      const coinBefore = BigInt(progBefore.omnicoin_balance);
      const levelBefore = progBefore.level;
      const streakBefore = progBefore.current_streak;
      const maxStreakBefore = progBefore.max_streak;

      // 2. Prepare một Guest Claim nặng ký: chứa bookmark, nhiều lượt đọc lịch sử và tiến độ
      const prepareRes = await request(app.getHttpServer())
        .post('/api/v1/account/guest-claims/prepare')
        .set('Authorization', `Bearer ${userGamificationToken}`)
        .send({
          guestProfileId: validGuestProfileId,
          bookmarks: [{ storyId: storyPagedId }],
          history: [
            {
              storyId: storyPagedId,
              chapterId: chapterPagedId,
              readAt: new Date().toISOString(),
              progressPercentage: 100,
            },
            {
              storyId: storyWebtoonId,
              chapterId: chapterWebtoonId,
              readAt: new Date().toISOString(),
              progressPercentage: 100,
            },
          ],
          progress: [
            {
              storyId: storyPagedId,
              chapterId: chapterPagedId,
              chapterVersionId: versionPagedId,
              readingMode: CanonicalReadingMode.PAGED,
              pageIndex: 20,
              scrollPosition: 0,
              progressPercentage: 50,
            },
          ],
        });

      expect(prepareRes.status).toBe(200);

      // 3. Thực hiện Commit
      const commitRes = await request(app.getHttpServer())
        .post(`/api/v1/account/guest-claims/${prepareRes.body.claimId}/commit`)
        .set('Authorization', `Bearer ${userGamificationToken}`)
        .send({
          expectedStateFingerprint: prepareRes.body.stateFingerprint,
          conflictDecisions: {},
        });

      expect(commitRes.status).toBe(200);
      expect(commitRes.body.status).toBe('COMMITTED');

      // 4. Lấy snapshot CSDL thực tế SAU khi commit
      const [progAfter] = await dataSource.query(
        `SELECT level, total_exp, omnicoin_balance, current_streak, max_streak FROM user_progression WHERE user_id = $1`,
        [userGamification.id],
      );

      const expAfter = BigInt(progAfter.total_exp);
      const coinAfter = BigInt(progAfter.omnicoin_balance);
      const levelAfter = progAfter.level;
      const streakAfter = progAfter.current_streak;
      const maxStreakAfter = progAfter.max_streak;

      // 5. KHẲNG ĐỊNH BẤT BIẾN DELTA = 0 (Tuyệt đối không cộng EXP, Coin hay Streak khi Claim)
      expect(expAfter - expBefore).toBe(0n);
      expect(coinAfter - coinBefore).toBe(0n);
      expect(levelAfter - levelBefore).toBe(0);
      expect(streakAfter - streakBefore).toBe(0);
      expect(maxStreakAfter - maxStreakBefore).toBe(0);

      // Dọn dẹp
      await dataSource.query(`DELETE FROM bookmarks WHERE user_id = $1`, [userGamification.id]);
      await dataSource.query(`DELETE FROM chapter_read_states WHERE user_id = $1`, [userGamification.id]);
      await dataSource.query(`DELETE FROM reading_progress WHERE user_id = $1`, [userGamification.id]);
      await dataSource.query(`DELETE FROM guest_claims WHERE claim_id = $1`, [prepareRes.body.claimId]);
    });
  });

  // ============================================================================
  // KỊCH BẢN 11: Two-Phase Deletion & Account Lifecycle Integrity
  // ============================================================================
  describe('Kịch bản 11: Two-Phase Deletion & Account Lifecycle Integrity', () => {
    it('11.1. Soft-delete preserves guest claims attribution and reactivate restores full state', async () => {
      // 1. Tạo user riêng cho lifecycle test
      const tempEmail = `lifecycle_test_${Date.now()}@test.com`;
      const [uLife] = await dataSource.query(
        `INSERT INTO users (username, email, password_hash, role, is_active, is_deleted)
         VALUES ('user_life_${Date.now()}', $1, 'hash', 'READER', true, false)
         RETURNING id`,
        [tempEmail],
      );
      const lifeUserId = uLife.id;

      // 2. Tạo claim gắn với user này với valid UUID
      const claimId = uuidv4();
      await dataSource.query(
        `INSERT INTO guest_claims (claim_id, user_id, guest_profile_id, payload_hash, state_fingerprint, status, preview_data, expires_at)
         VALUES ($1, $2, $3, 'hash', 'fp', 'COMMITTED', '{}'::jsonb, NOW() + INTERVAL '1 day')`,
        [claimId, lifeUserId, validGuestProfileId],
      );

      // 3. Day 0 Soft-delete: đánh dấu is_deleted = true
      await dataSource.query(
        `UPDATE users SET is_deleted = true, scheduled_purge_at = NOW() + INTERVAL '30 days' WHERE id = $1`,
        [lifeUserId],
      );

      // Khẳng định: Claim user_id VẪN NGUYÊN VẸN, không bị xóa hay set null ở Day 0
      const [claimAfterSoft] = await dataSource.query(
        `SELECT user_id FROM guest_claims WHERE claim_id = $1`,
        [claimId],
      );
      expect(claimAfterSoft.user_id).toBe(lifeUserId);

      // 4. Reactivate trong thời hạn: khôi phục is_deleted = false
      await dataSource.query(
        `UPDATE users SET is_deleted = false, scheduled_purge_at = NULL WHERE id = $1`,
        [lifeUserId],
      );

      const [userRestored] = await dataSource.query(
        `SELECT is_deleted, scheduled_purge_at FROM users WHERE id = $1`,
        [lifeUserId],
      );
      expect(userRestored.is_deleted).toBe(false);
      expect(userRestored.scheduled_purge_at).toBeNull();

      // Dọn dẹp
      await dataSource.query(`DELETE FROM guest_claims WHERE claim_id = $1`, [claimId]);
      await dataSource.query(`DELETE FROM users WHERE id = $1`, [lifeUserId]);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, ForbiddenException } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { GuestClaimService } from '../src/modules/claims/guest-claim.service';
import {
  CanonicalReadingMode,
  PrepareGuestClaimDto,
} from '../src/modules/claims/dto/prepare-guest-claim.dto';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { JwtService } from '@nestjs/jwt';

describe('Guest Claim Engine & Durable Ledger (PostgreSQL Integration - Task 7B.1)', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let dataSource: DataSource;
  let guestClaimService: GuestClaimService;
  let jwtService: JwtService;

  let testUser: any;
  let testUserToken: string;
  let otherUser: any;
  let testStoryId: string;
  let testEditionId: string;
  let testChapterId: string;
  let testVersionId: string;

  beforeAll(async () => {
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
    jwtService = app.get(JwtService);
    const { RedisService } = await import('../src/redis/redis.service');
    const redisService = app.get(RedisService);

    // 1. Tạo test users
    const uRes1 = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active, is_deleted)
       VALUES ('user_claim_int_${Date.now()}', 'user_claim_${Date.now()}@example.com', 'hash', 'READER', true, false)
       RETURNING id, username, email, role`,
    );
    testUser = uRes1[0];
    const sid = 'claim-int-session-id';
    await redisService.set(
      `auth_session:${testUser.id}:${sid}`,
      JSON.stringify({ sessionId: sid, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }),
    );
    testUserToken = jwtService.sign({
      sub: testUser.id,
      username: testUser.username,
      role: testUser.role,
      sid: sid,
    });

    const uRes2 = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active)
       VALUES ('user_other_int_${Date.now()}', 'user_other_${Date.now()}@example.com', 'hash', 'READER', true)
       RETURNING id, email, role`,
    );
    otherUser = uRes2[0];

    // 2. Tạo test story, edition, chapter, chapter_version
    const sRes = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
       VALUES ('Claim Integration Story', 'claim-story-${Date.now()}', 'https://example.com/cover.webp', 'PUBLIC', 'COMIC', 'MANGA', 'JP', 'ja')
       RETURNING id`,
    );
    testStoryId = sRes[0].id;

    const eRes = await dataSource.query(
      `INSERT INTO story_editions (story_id, edition_name, language, is_default)
       VALUES ($1, 'Default Edition', 'vi', true)
       RETURNING id`,
      [testStoryId],
    );
    testEditionId = eRes[0].id;

    const cRes = await dataSource.query(
      `INSERT INTO chapters (story_edition_id, chapter_number, title)
       VALUES ($1, '1', 'Chapter 1')
       RETURNING id`,
      [testEditionId],
    );
    testChapterId = cRes[0].id;

    const vRes = await dataSource.query(
      `INSERT INTO chapter_versions (chapter_id, version_number, version_type, language, is_published)
       VALUES ($1, 1, 'RAW_ORIGINAL', 'vi', true)
       RETURNING id`,
      [testChapterId],
    );
    testVersionId = vRes[0].id;

    await dataSource.query(
      `UPDATE chapters SET active_version_id = $1 WHERE id = $2`,
      [testVersionId, testChapterId],
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      if (testUser?.id) {
        await dataSource.query(`DELETE FROM guest_claims WHERE user_id = $1`, [testUser.id]);
        await dataSource.query(`DELETE FROM reading_progress WHERE user_id = $1`, [testUser.id]);
        await dataSource.query(`DELETE FROM chapter_read_states WHERE user_id = $1`, [testUser.id]);
        await dataSource.query(`DELETE FROM bookmarks WHERE user_id = $1`, [testUser.id]);
        await dataSource.query(`DELETE FROM reading_history_epoch_counters WHERE user_id = $1`, [testUser.id]);
        await dataSource.query(`DELETE FROM users WHERE id = $1`, [testUser.id]);
      }
      if (otherUser?.id) {
        await dataSource.query(`DELETE FROM guest_claims WHERE user_id = $1`, [otherUser.id]);
        await dataSource.query(`DELETE FROM users WHERE id = $1`, [otherUser.id]);
      }
      if (testStoryId) {
        await dataSource.query(`DELETE FROM stories WHERE id = $1`, [testStoryId]);
      }
    }
    if (app) {
      await app.close();
    }
  });

  it('Full cycle against real PostgreSQL: prepare -> persisted guest_claims row -> commit -> COMMITTED -> repeated commit (idempotent)', async () => {
    const prepareDto: PrepareGuestClaimDto = {
      guestProfileId: 'a1111111-b222-c333-d444-e55555555555',
      bookmarks: [{ storyId: testStoryId }],
      history: [
        {
          storyId: testStoryId,
          chapterId: testChapterId,
          progressPercentage: 100,
        },
      ],
      progress: [
        {
          storyId: testStoryId,
          chapterId: testChapterId,
          chapterVersionId: testVersionId,
          readingMode: CanonicalReadingMode.PAGED,
          pageIndex: 10,
          scrollPosition: 0,
          progressPercentage: 60,
        },
      ],
    };

    // 1. PREPARE CLAIM
    const preview = await guestClaimService.prepareClaim(testUser.id, prepareDto);
    expect(preview).toBeDefined();
    expect(preview.claimId).toBeDefined();
    expect(preview.status).toBe('PREPARED');
    expect(preview.stateFingerprint).toBeDefined();
    expect(preview.bookmarksToImport).toBe(1);
    expect(preview.historyToImport).toBe(1);
    expect(preview.progressToImport).toBe(1);

    const claimId = preview.claimId;
    const stateFingerprint = preview.stateFingerprint;

    // Xác minh trực tiếp trong bảng guest_claims thực tế trên PostgreSQL
    const rawClaims = await dataSource.query(
      `SELECT claim_id, user_id, status, state_fingerprint, preview_data, committed_at FROM guest_claims WHERE claim_id = $1`,
      [claimId],
    );
    expect(rawClaims).toHaveLength(1);
    const rawClaim = rawClaims[0];
    expect(rawClaim.claim_id).toBe(claimId);
    expect(rawClaim.user_id).toBe(testUser.id);
    expect(rawClaim.status).toBe('PREPARED');
    expect(rawClaim.state_fingerprint).toBe(stateFingerprint);
    expect(rawClaim.committed_at).toBeNull();

    // 2. OWNERSHIP CHECK (other user cannot commit this claim)
    await expect(
      guestClaimService.commitClaim(otherUser.id, claimId, {
        expectedStateFingerprint: stateFingerprint,
      }),
    ).rejects.toThrow(ForbiddenException);

    // 3. COMMIT CLAIM (Sử dụng raw row reading được sửa lỗi trong P0-1)
    const commitRes = await guestClaimService.commitClaim(testUser.id, claimId, {
      expectedStateFingerprint: stateFingerprint,
    });

    expect(commitRes.status).toBe('COMMITTED');
    expect(commitRes.claimId).toBe(claimId);
    expect(commitRes.committedAt).toBeDefined();
    expect(commitRes.summary.bookmarksImported).toBe(1);
    expect(commitRes.summary.historyMerged).toBe(1);
    expect(commitRes.summary.progressUpdated).toBe(1);

    // 4. KIỂM TRA TRẠNG THÁI DỮ LIỆU ĐÃ MERGE VÀ FINALIZATION DATA TRONG POSTGRESQL
    const committedRows = await dataSource.query(
      `SELECT status, committed_at, result_summary, finalization_data FROM guest_claims WHERE claim_id = $1`,
      [claimId],
    );
    expect(committedRows[0].status).toBe('COMMITTED');
    expect(committedRows[0].committed_at).not.toBeNull();
    expect(committedRows[0].finalization_data).toBeDefined();
    expect(committedRows[0].finalization_data).not.toBeNull();
    expect(committedRows[0].finalization_data.tombstonedStoryIds).toEqual([]);
    expect(committedRows[0].finalization_data.finalizedProgress).toHaveLength(1);
    expect(committedRows[0].finalization_data.finalizedProgress[0].storyId).toBe(testStoryId);
    expect(committedRows[0].finalization_data.finalizedProgress[0].chapterId).toBe(testChapterId);
    expect(committedRows[0].finalization_data.finalizedProgress[0].pageIndex).toBe(10);
    expect(committedRows[0].finalization_data.finalizedProgress[0].progressPercentage).toBe(60);
    expect(committedRows[0].finalization_data.finalizedChapterReadStates).toHaveLength(1);
    expect(committedRows[0].finalization_data.finalizedChapterReadStates[0].storyId).toBe(testStoryId);
    expect(committedRows[0].finalization_data.finalizedChapterReadStates[0].chapterId).toBe(testChapterId);
    expect(committedRows[0].finalization_data.finalizedChapterReadStates[0].progressPercentage).toBe(100);

    // Snapshot trong response commit khớp chính xác với snapshot đã lưu trong DB
    expect(commitRes.finalization).toBeDefined();
    expect(commitRes.finalization).toEqual(committedRows[0].finalization_data);

    const bookmarks = await dataSource.query(
      `SELECT * FROM bookmarks WHERE user_id = $1 AND story_id = $2`,
      [testUser.id, testStoryId],
    );
    expect(bookmarks).toHaveLength(1);

    const readStates = await dataSource.query(
      `SELECT * FROM chapter_read_states WHERE user_id = $1 AND chapter_id = $2`,
      [testUser.id, testChapterId],
    );
    expect(readStates).toHaveLength(1);
    expect(Number(readStates[0].max_progress_percentage)).toBe(100);

    const progressList = await dataSource.query(
      `SELECT * FROM reading_progress WHERE user_id = $1 AND story_id = $2`,
      [testUser.id, testStoryId],
    );
    expect(progressList).toHaveLength(1);
    expect(progressList[0].reading_mode).toBe('PAGED');
    expect(progressList[0].page_index).toBe(10);
    expect(progressList[0].chapter_version_id).toBe(testVersionId);

    // 5. IDEMPOTENCY: RETRY COMMIT PHẢI TRẢ VỀ 200 OK VỚI CÙNG SUMMARY VÀ FINALIZATION SNAPSHOT ĐÃ LƯU
    const retryCommitRes = await guestClaimService.commitClaim(testUser.id, claimId, {
      expectedStateFingerprint: stateFingerprint,
    });
    expect(retryCommitRes.status).toBe('COMMITTED');
    expect(retryCommitRes.claimId).toBe(claimId);
    expect(retryCommitRes.summary).toEqual(commitRes.summary);
    expect(retryCommitRes.finalization).toEqual(commitRes.finalization);

    // 6. KIỂM TRA GET STATUS (Crash Recovery Contract)
    const statusRes = await guestClaimService.getClaimStatus(testUser.id, claimId);
    expect(statusRes.status).toBe('COMMITTED');
    expect(statusRes.claimId).toBe(claimId);
    expect(statusRes.committedAt).toBeDefined();
    expect(statusRes.resultSummary).toEqual(commitRes.summary);
    expect(statusRes.finalization).toEqual(commitRes.finalization);
  });

  it('Anti-Resurrection with Global Tombstone Sentinel: should block reading states but import bookmarks on real PostgreSQL', async () => {
    // 1. Tạo global tombstone sentinel cho user
    const GLOBAL_SENTINEL = '00000000-0000-0000-0000-000000000000';
    await dataSource.query(
      `INSERT INTO reading_history_tombstones (user_id, story_id, epoch, deleted_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (user_id, story_id) DO UPDATE SET epoch = 1`,
      [testUser.id, GLOBAL_SENTINEL],
    );

    // Tạo thêm 1 story mới để test import với global tombstone
    const sRes = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
       VALUES ('Tombstone Guard Story', 'tombstone-story-${Date.now()}', 'https://example.com/cover.webp', 'PUBLIC', 'COMIC', 'MANGA', 'JP', 'ja')
       RETURNING id`,
    );
    const tombstoneStoryId = sRes[0].id;

    const eRes = await dataSource.query(
      `INSERT INTO story_editions (story_id, edition_name, language, is_default)
       VALUES ($1, 'Default Edition', 'vi', true)
       RETURNING id`,
      [tombstoneStoryId],
    );
    const editionId = eRes[0].id;

    const cRes = await dataSource.query(
      `INSERT INTO chapters (story_edition_id, chapter_number, title)
       VALUES ($1, '1', 'Chapter 1')
       RETURNING id`,
      [editionId],
    );
    const chapterId = cRes[0].id;

    const vRes = await dataSource.query(
      `INSERT INTO chapter_versions (chapter_id, version_number, version_type, language, is_published)
       VALUES ($1, 1, 'RAW_ORIGINAL', 'vi', true)
       RETURNING id`,
      [chapterId],
    );
    const versionId = vRes[0].id;

    await dataSource.query(
      `UPDATE chapters SET active_version_id = $1 WHERE id = $2`,
      [versionId, chapterId],
    );

    const prepareDto: PrepareGuestClaimDto = {
      guestProfileId: 'd1111111-b222-c333-d444-e55555555555',
      bookmarks: [{ storyId: tombstoneStoryId }],
      history: [
        {
          storyId: tombstoneStoryId,
          chapterId: chapterId,
          progressPercentage: 100,
        },
      ],
      progress: [
        {
          storyId: tombstoneStoryId,
          chapterId: chapterId,
          chapterVersionId: versionId,
          readingMode: CanonicalReadingMode.PAGED,
          pageIndex: 5,
          scrollPosition: 0,
          progressPercentage: 30,
        },
      ],
    };

    // 2. Prepare claim: Bookmarks to import = 1, nhưng history và progress bị bỏ qua
    const preview = await guestClaimService.prepareClaim(testUser.id, prepareDto);
    expect(preview.bookmarksToImport).toBe(1);
    expect(preview.historyToImport).toBe(0); // Bị chặn bởi global sentinel
    expect(preview.progressToImport).toBe(0); // Bị chặn bởi global sentinel
    expect(preview.readStatesIgnoredAntiResurrectionCount).toBe(2);

    // 3. Commit claim
    const commitRes = await guestClaimService.commitClaim(testUser.id, preview.claimId, {
      expectedStateFingerprint: preview.stateFingerprint,
    });
    expect(commitRes.status).toBe('COMMITTED');
    expect(commitRes.summary.bookmarksImported).toBe(1);
    expect(commitRes.summary.historyMerged).toBe(0);
    expect(commitRes.summary.progressUpdated).toBe(0);

    // Bookmark được import thành công
    const bmRows = await dataSource.query(
      `SELECT * FROM bookmarks WHERE user_id = $1 AND story_id = $2`,
      [testUser.id, tombstoneStoryId],
    );
    expect(bmRows).toHaveLength(1);

    // Tiến độ và lịch sử KHÔNG bị resurrection vào PostgreSQL
    const progRows = await dataSource.query(
      `SELECT * FROM reading_progress WHERE user_id = $1 AND story_id = $2`,
      [testUser.id, tombstoneStoryId],
    );
    expect(progRows).toHaveLength(0);

    const crsRows = await dataSource.query(
      `SELECT * FROM chapter_read_states WHERE user_id = $1 AND chapter_id = $2`,
      [testUser.id, chapterId],
    );
    expect(crsRows).toHaveLength(0);

    // Authoritative snapshot phản ánh tombstone
    expect(commitRes.finalization).toBeDefined();
    expect(commitRes.finalization!.tombstonedStoryIds).toContain(tombstoneStoryId);

    // Dọn dẹp
    await dataSource.query(`DELETE FROM reading_history_tombstones WHERE user_id = $1`, [testUser.id]);
    await dataSource.query(`DELETE FROM bookmarks WHERE user_id = $1 AND story_id = $2`, [testUser.id, tombstoneStoryId]);
    await dataSource.query(`DELETE FROM guest_claims WHERE claim_id = $1`, [preview.claimId]);
    await dataSource.query(`DELETE FROM stories WHERE id = $1`, [tombstoneStoryId]);
  });

  it('Atomic Rollback on Stale Fingerprint: should not merge data and leave finalization_data null on transaction abort', async () => {
    const prepareDto: PrepareGuestClaimDto = {
      guestProfileId: 'e1111111-b222-c333-d444-e55555555555',
      bookmarks: [{ storyId: testStoryId }],
      history: [],
      progress: [],
    };
    const preview = await guestClaimService.prepareClaim(testUser.id, prepareDto);
    const wrongFingerprint = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    await expect(
      guestClaimService.commitClaim(testUser.id, preview.claimId, {
        expectedStateFingerprint: wrongFingerprint,
      }),
    ).rejects.toThrow();

    // Xác minh ledger trong PostgreSQL không bị commit dở dang
    const claimRows = await dataSource.query(
      `SELECT status, committed_at, finalization_data FROM guest_claims WHERE claim_id = $1`,
      [preview.claimId],
    );
    expect(claimRows[0].status).toBe('PREPARED');
    expect(claimRows[0].committed_at).toBeNull();
    expect(claimRows[0].finalization_data).toBeNull();

    await dataSource.query(`DELETE FROM guest_claims WHERE claim_id = $1`, [preview.claimId]);
  });

  it('Legacy Claims Backward Compatibility: should return finalization: null when finalization_data is null', async () => {
    const legacyClaimId = '99999999-9999-4999-9999-999999999999';
    await dataSource.query(
      `INSERT INTO guest_claims (claim_id, user_id, guest_profile_id, payload_hash, state_fingerprint, status, preview_data, result_summary, finalization_data, expires_at, committed_at)
       VALUES ($1, $2, '88888888-8888-4888-8888-888888888888', 'hash', 'fingerprint', 'COMMITTED', '{}'::jsonb, '{"bookmarksImported": 0}'::jsonb, NULL, NOW() + INTERVAL '1 day', NOW())
       ON CONFLICT (claim_id) DO UPDATE SET finalization_data = NULL, status = 'COMMITTED'`,
      [legacyClaimId, testUser.id],
    );

    // 1. getClaimStatus an toàn với claim cũ
    const statusRes = await guestClaimService.getClaimStatus(testUser.id, legacyClaimId);
    expect(statusRes.status).toBe('COMMITTED');
    expect(statusRes.finalization).toBeNull();

    // 2. commit retry an toàn với claim cũ
    const retryRes = await guestClaimService.commitClaim(testUser.id, legacyClaimId, {
      expectedStateFingerprint: 'fingerprint',
    });
    expect(retryRes.status).toBe('COMMITTED');
    expect(retryRes.finalization).toBeNull();

    await dataSource.query(`DELETE FROM guest_claims WHERE claim_id = $1`, [legacyClaimId]);
  });

  it('ValidationPipe HTTP Contract: should reject commit when expectedStateFingerprint is missing (400 Bad Request)', async () => {
    // 1. Prepare a claim
    const prepareDto: PrepareGuestClaimDto = {
      guestProfileId: 'b1111111-b222-c333-d444-e55555555555',
      bookmarks: [{ storyId: testStoryId }],
      history: [],
      progress: [],
    };
    const preview = await guestClaimService.prepareClaim(testUser.id, prepareDto);

    // 2. Commit without expectedStateFingerprint (the previous contract mismatch bug)
    const res = await request(app.getHttpServer())
      .post(`/api/v1/account/guest-claims/${preview.claimId}/commit`)
      .set('Authorization', `Bearer ${testUserToken}`)
      .send({
        conflictDecisions: {},
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('expectedStateFingerprint');
  });

  it('ValidationPipe HTTP Contract: should accept commit matching canonical CommitGuestClaimPayload (200 OK COMMITTED)', async () => {
    // 1. Prepare a claim
    const prepareDto: PrepareGuestClaimDto = {
      guestProfileId: 'c1111111-b222-c333-d444-e55555555555',
      bookmarks: [{ storyId: testStoryId }],
      history: [],
      progress: [],
    };
    const preview = await guestClaimService.prepareClaim(testUser.id, prepareDto);

    // 2. Commit with canonical payload containing expectedStateFingerprint
    const res = await request(app.getHttpServer())
      .post(`/api/v1/account/guest-claims/${preview.claimId}/commit`)
      .set('Authorization', `Bearer ${testUserToken}`)
      .send({
        expectedStateFingerprint: preview.stateFingerprint,
        conflictDecisions: {},
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMMITTED');
    expect(res.body.claimId).toBe(preview.claimId);
    expect(res.body.committedAt).toBeDefined();
    expect(res.body.finalization).toBeDefined();
  });
});

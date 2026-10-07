import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, ForbiddenException } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { GuestClaimService } from '../src/modules/claims/guest-claim.service';
import {
  CanonicalReadingMode,
  PrepareGuestClaimDto,
} from '../src/modules/claims/dto/prepare-guest-claim.dto';

describe('Guest Claim Engine & Durable Ledger (PostgreSQL Integration - Task 7B.1)', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let dataSource: DataSource;
  let guestClaimService: GuestClaimService;

  let testUser: any;
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
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    dataSource = app.get(DataSource);
    guestClaimService = app.get(GuestClaimService);

    // 1. Tạo test users
    const uRes1 = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active)
       VALUES ('user_claim_int_${Date.now()}', 'user_claim_${Date.now()}@example.com', 'hash', 'READER', true)
       RETURNING id, email, role`,
    );
    testUser = uRes1[0];

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

    // 4. KIỂM TRA TRẠNG THÁI DỮ LIỆU ĐÃ MERGE TRONG POSTGRESQL
    const committedRows = await dataSource.query(
      `SELECT status, committed_at, result_summary FROM guest_claims WHERE claim_id = $1`,
      [claimId],
    );
    expect(committedRows[0].status).toBe('COMMITTED');
    expect(committedRows[0].committed_at).not.toBeNull();

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

    // 5. IDEMPOTENCY: RETRY COMMIT PHẢI TRẢ VỀ 200 OK VỚI CÙNG SUMMARY MÀ KHÔNG GÂY LỖI
    const retryCommitRes = await guestClaimService.commitClaim(testUser.id, claimId, {
      expectedStateFingerprint: stateFingerprint,
    });
    expect(retryCommitRes.status).toBe('COMMITTED');
    expect(retryCommitRes.claimId).toBe(claimId);
    expect(retryCommitRes.summary).toEqual(commitRes.summary);

    // 6. KIỂM TRA GET STATUS (Crash Recovery Contract)
    const statusRes = await guestClaimService.getClaimStatus(testUser.id, claimId);
    expect(statusRes.status).toBe('COMMITTED');
    expect(statusRes.claimId).toBe(claimId);
    expect(statusRes.committedAt).toBeDefined();
    expect(statusRes.resultSummary).toEqual(commitRes.summary);
  });
});

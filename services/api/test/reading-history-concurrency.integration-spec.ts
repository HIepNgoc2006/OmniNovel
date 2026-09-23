import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { StoriesService } from '../src/modules/stories/stories.service';

describe('Reading History Concurrency & Lock Serialization (Integration - Gate 6A/6B)', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let dataSource: DataSource;
  let storiesService: StoriesService;

  let testUser: any;
  let testStoryId: string;
  let testChapterId: string;

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
    storiesService = app.get(StoriesService);

    // 1. Chuẩn bị test user
    const uRes = await dataSource.query(
      `INSERT INTO users (username, email, password_hash, role, is_active)
       VALUES ('user_epoch_test_${Date.now()}', 'user_epoch_${Date.now()}@example.com', 'hash', 'READER', true)
       RETURNING id, email, role`,
    );
    testUser = uRes[0];

    // 2. Chuẩn bị test story & chapter
    const sRes = await dataSource.query(
      `INSERT INTO stories (title, slug, cover_url, visibility, media_format, publication_format, origin_country, original_language)
       VALUES ('Concurrency Test Story', 'concurrency-story-${Date.now()}', 'https://example.com/cover.webp', 'PUBLIC', 'COMIC', 'MANGA', 'JP', 'ja')
       RETURNING id`,
    );
    testStoryId = sRes[0].id;

    const eRes = await dataSource.query(
      `INSERT INTO story_editions (story_id, edition_name, language, is_default)
       VALUES ($1, 'Default Edition', 'vi', true)
       RETURNING id`,
      [testStoryId],
    );
    const editionId = eRes[0].id;

    const cRes = await dataSource.query(
      `INSERT INTO chapters (story_edition_id, chapter_number, title)
       VALUES ($1, '1', 'Chapter 1')
       RETURNING id`,
      [editionId],
    );
    testChapterId = cRes[0].id;
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      if (testStoryId) {
        await dataSource.query(`DELETE FROM stories WHERE id = $1`, [testStoryId]);
      }
      if (testUser?.id) {
        await dataSource.query(`DELETE FROM users WHERE id = $1`, [testUser.id]);
      }
    }
    if (app) {
      await app.close();
    }
  });

  it('Gate 6A: PostgreSQL FOR SHARE vs FOR UPDATE row lock contention enforces serialization', async () => {
    // Đảm bảo epoch counter ban đầu tồn tại với epoch = 0
    await dataSource.query(
      `INSERT INTO reading_history_epoch_counters (user_id, epoch, updated_at)
       VALUES ($1, 0, NOW())
       ON CONFLICT (user_id) DO UPDATE SET epoch = 0`,
      [testUser.id],
    );

    // Mở 2 query runner độc lập mô phỏng 2 client sessions đồng thời
    const qrSave = dataSource.createQueryRunner();
    const qrDelete = dataSource.createQueryRunner();
    await qrSave.connect();
    await qrDelete.connect();

    await qrSave.startTransaction();
    await qrDelete.startTransaction();

    let deleteResolved = false;

    try {
      // 1. Transaction SAVE lấy FOR SHARE lock trên dòng counter của user
      const saveRows = await qrSave.query(
        `SELECT epoch FROM reading_history_epoch_counters WHERE user_id = $1 FOR SHARE`,
        [testUser.id],
      );
      expect(Number(saveRows[0]?.epoch)).toBe(0);

      // 2. Transaction DELETE cố gắng lấy exclusive row update trên cùng counter
      // Trong PostgreSQL: INSERT ... ON CONFLICT DO UPDATE đòi exclusive row lock (FOR UPDATE), sẽ bị BLOCK bởi FOR SHARE lock của qrSave!
      const deletePromise = qrDelete.query(
        `INSERT INTO reading_history_epoch_counters (user_id, epoch, updated_at)
         VALUES ($1, 1, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           epoch = reading_history_epoch_counters.epoch + 1,
           updated_at = NOW()
         RETURNING epoch`,
        [testUser.id],
      ).then((res) => {
        deleteResolved = true;
        return res;
      });

      // 3. Chờ 150ms để verify PostgreSQL đang block transaction DELETE (contention verification)
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(deleteResolved).toBe(false);

      // Verify trong PostgreSQL system catalog: Có lock contention thực sự (waiting lock)
      const lockCheck = await dataSource.query(
        `SELECT COUNT(*) AS "waitingCount"
         FROM pg_locks
         WHERE granted = false`,
      );
      expect(Number(lockCheck[0]?.waitingCount)).toBeGreaterThanOrEqual(1);

      // 4. Transaction SAVE hoàn tất việc chèn reading_progress (với writeEpoch = 0) và COMMIT
      await qrSave.query(
        `INSERT INTO reading_progress (
          user_id, story_id, chapter_id, reading_mode, progress_percentage,
          scroll_position, page_index, updated_at
        ) VALUES ($1, $2, $3, 'WEBTOON', 50.0, 1000.0, 5, NOW())
        ON CONFLICT (user_id, story_id) DO UPDATE SET
          progress_percentage = EXCLUDED.progress_percentage`,
        [testUser.id, testStoryId, testChapterId],
      );
      await qrSave.commitTransaction();

      // 5. Ngay khi qrSave COMMIT, qrDelete lập tức được unblock và hoàn thành UPDATE epoch lên 1!
      const deleteRes = await deletePromise;
      expect(deleteResolved).toBe(true);
      const returnedEpoch = Array.isArray(deleteRes[0])
        ? Number(deleteRes[0][0]?.epoch)
        : Number(deleteRes[0]?.epoch);
      expect(returnedEpoch).toBe(1);

      // Transaction DELETE tiếp tục xóa reading_progress và ghi tombstone epoch 1
      await qrDelete.query(
        `DELETE FROM reading_progress WHERE user_id = $1 AND story_id = $2`,
        [testUser.id, testStoryId],
      );
      await qrDelete.query(
        `INSERT INTO reading_history_tombstones (user_id, story_id, epoch, deleted_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, story_id) DO UPDATE SET epoch = EXCLUDED.epoch`,
        [testUser.id, testStoryId, 1],
      );
      await qrDelete.commitTransaction();

      // 6. Verification cuối: reading_progress phải HOÀN TOÀN TRỐNG (DELETE ghi đè sau SAVE)
      const finalProgress = await dataSource.query(
        `SELECT * FROM reading_progress WHERE user_id = $1 AND story_id = $2`,
        [testUser.id, testStoryId],
      );
      expect(finalProgress.length).toBe(0);
    } finally {
      if (qrSave.isTransactionActive) await qrSave.rollbackTransaction();
      if (qrDelete.isTransactionActive) await qrDelete.rollbackTransaction();
      await qrSave.release();
      await qrDelete.release();
    }
  });

  it('Gate 6B: Stale write with writeEpoch=0 is rejected against currentEpoch=1 after DELETE', async () => {
    // Thử gọi saveReadingProgress với epoch cũ = 0 (giả lập HTTP in-flight request đến muộn)
    const result = await storiesService.saveReadingProgress(testUser, {
      storyId: testStoryId,
      chapterId: testChapterId,
      pageIndex: 10,
      progressPercentage: 80,
      scrollPosition: 2000,
      writeEpoch: 0, // Stale!
    });

    // Verify kết quả HTTP payload trả về STALE_WRITE_EPOCH
    expect(result).toEqual(
      expect.objectContaining({
        ignored: true,
        reason: 'STALE_WRITE_EPOCH',
        storyId: testStoryId,
        writeEpoch: 0,
        currentEpoch: 1,
      }),
    );

    // Verify trong database PostgreSQL thật: Không có bản ghi reading_progress nào được phục sinh (Zombie prevention)
    const records = await dataSource.query(
      `SELECT * FROM reading_progress WHERE user_id = $1 AND story_id = $2`,
      [testUser.id, testStoryId],
    );
    expect(records.length).toBe(0);
  });

  it('Gate 6B (ClearAll): Global tombstone sentinel increments counter and rejects stale write on ANY story', async () => {
    // 1. Thực hiện clearAllReadingHistory
    await storiesService.clearAllReadingHistory(testUser.id);

    const epochRows = await dataSource.query(
      `SELECT epoch FROM reading_history_epoch_counters WHERE user_id = $1`,
      [testUser.id],
    );
    const newGlobalEpoch = Number(epochRows[0]?.epoch);
    expect(newGlobalEpoch).toBeGreaterThanOrEqual(2);

    // 2. Client gửi saveProgress với epoch cũ (writeEpoch = 1)
    const staleResult = await storiesService.saveReadingProgress(testUser, {
      storyId: testStoryId,
      chapterId: testChapterId,
      pageIndex: 1,
      progressPercentage: 10,
      scrollPosition: 100,
      writeEpoch: 1, // Stale đối với global epoch >= 2
    });

    // 3. Verify server reject stale epoch
    expect(staleResult).toEqual(
      expect.objectContaining({
        ignored: true,
        reason: 'STALE_WRITE_EPOCH',
        currentEpoch: newGlobalEpoch,
      }),
    );

    // 4. Verify database vẫn sạch, không có reading history nào
    const historyRecords = await dataSource.query(
      `SELECT * FROM reading_progress WHERE user_id = $1`,
      [testUser.id],
    );
    expect(historyRecords.length).toBe(0);
  });
});

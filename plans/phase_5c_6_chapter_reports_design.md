# Thiết Kế Kỹ Thuật Phase 5C.6: Hệ Thống Báo Lỗi Chương Truyện
**Tracking Issues:** [#191](https://github.com/HIepNgoc2006/OmniNovel/issues/191) (Backend Core API) & [#202](https://github.com/HIepNgoc2006/OmniNovel/issues/202) (Mobile MOB-011 & Parity)

---

## 1. Mục Tiêu & 5 Invariants Cốt Lõi (Locked Architecture)
1. **Canonical Version Context (P0):** Báo cáo phải gắn chặt với `chapterVersionId` (phiên bản bất biến cụ thể mà người dùng đang xem), không chỉ `chapterId`. Nếu `chapterVersionId` không thuộc `chapterId` ➔ 400 `CHAPTER_REPORT_VERSION_MISMATCH`.
2. **Reader Access Policy Parity (P0):** Tái sử dụng `assertChapterReadable` từ logic `findById()` (không increment views). Nếu Story là `PRIVATE` và người dùng không phải Staff/Member/Admin ➔ 403 `FORBIDDEN`.
3. **Pessimistic Concurrency Defense (P0):** Bọc toàn bộ kiểm tra duplicate và ghi nhận báo cáo trong PostgreSQL transaction với pessimistic write lock trên dòng `Chapter`. Hai request đồng thời cùng tuple `(reporterId, chapterId, errorType)` ➔ chính xác 1 bản ghi `201 Created` và request kia nhận `409 CHAPTER_REPORT_DUPLICATE`.
4. **Unified Shared Contract (P0):** Đồng bộ hóa một bộ enum và DTO duy nhất giữa DB, `packages/shared`, NestJS API và Flutter Mobile:
   - `ChapterReportErrorType`: `IMAGE_CORRUPT`, `WRONG_ORDER`, `TRANSLATION_ERROR`, `TYPO`, `INAPPROPRIATE_CONTENT`, `COPYRIGHT_INFRINGEMENT`, `OTHER`.
   - `ChapterReportStatus`: `PENDING`, `INVESTIGATING`, `RESOLVED`, `REJECTED`.
5. **Standardized Rate-Limit Metadata (P0/P1):**
   - Mở rộng `RateLimitOptions` hỗ trợ `routeParam: 'chapterId'` ➔ Key cô lập theo từng chương: `ratelimit:chapter_report:chapterId_<id>:user:<userId>`.
   - Allowlist `retryAfter` trong `GlobalExceptionFilter` ➔ phát sinh `error.meta.retryAfter` (kèm HTTP header `Retry-After: N`) cho client Flutter.

---

## 2. Thiết Kế Cơ Sở Dữ Liệu & Migration

### 2.1 Migration: `1700000000016-AddChapterReportAnchorBlockAndEnums.ts`
Bổ sung trường và mở rộng constraint cho bảng `chapter_error_reports`:
```sql
-- 1. Bổ sung chapter_version_id (Foreign Key tới chapter_versions.id)
ALTER TABLE chapter_error_reports 
ADD COLUMN IF NOT EXISTS chapter_version_id UUID NULL 
REFERENCES chapter_versions(id) ON DELETE SET NULL;

-- 2. Bổ sung anchor_block_id cho tiểu thuyết chữ
ALTER TABLE chapter_error_reports 
ADD COLUMN IF NOT EXISTS anchor_block_id VARCHAR(100) NULL;

-- 3. Cập nhật CHECK constraint error_type hỗ trợ đầy đủ 7 loại lỗi chuẩn
ALTER TABLE chapter_error_reports 
DROP CONSTRAINT IF EXISTS chapter_error_reports_error_type_check;

ALTER TABLE chapter_error_reports 
ADD CONSTRAINT chapter_error_reports_error_type_check 
CHECK (error_type IN ('IMAGE_CORRUPT', 'WRONG_ORDER', 'TRANSLATION_ERROR', 'TYPO', 'COPYRIGHT_INFRINGEMENT', 'INAPPROPRIATE_CONTENT', 'OTHER'));

-- 4. Cho phép description nullable hoặc có default rỗng
ALTER TABLE chapter_error_reports 
ALTER COLUMN description DROP NOT NULL;

ALTER TABLE chapter_error_reports 
ALTER COLUMN description SET DEFAULT '';
```

### 2.2 Entity: `ChapterErrorReport`
Đặt tại `services/api/src/modules/chapters/entities/chapter-error-report.entity.ts`:
```typescript
@Entity('chapter_error_reports')
export class ChapterErrorReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'reporter_id', type: 'uuid', nullable: true })
  reporterId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'reporter_id' })
  reporter?: User;

  @Column({ name: 'chapter_id', type: 'uuid' })
  chapterId: string;

  @ManyToOne(() => Chapter, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'chapter_id' })
  chapter?: Chapter;

  @Column({ name: 'chapter_version_id', type: 'uuid', nullable: true })
  chapterVersionId: string | null;

  @ManyToOne(() => ChapterVersion, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'chapter_version_id' })
  chapterVersion?: ChapterVersion;

  @Column({ name: 'page_number', type: 'int', nullable: true })
  pageNumber: number | null;

  @Column({ name: 'anchor_block_id', type: 'varchar', length: 100, nullable: true })
  anchorBlockId: string | null;

  @Column({ name: 'error_type', type: 'varchar', length: 30 })
  errorType: ChapterReportErrorType;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status: ChapterReportStatus;

  @Column({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

---

## 3. Thiết Kế Backend API (#191 Parity)

### 3.1 Endpoint Contract & DTO
- **HTTP Method & Path:** `POST /api/v1/chapters/:chapterId/reports`
- **Guards:**
  - `JwtAuthGuard`: Bắt buộc đăng nhập.
  - `RateLimitGuard`: Tối đa 3 reports / 60 giây / user per-chapter:
    `@RateLimit({ limit: 3, ttlSeconds: 60, keyPrefix: 'chapter_report', scope: 'IP_AND_USER', routeParam: 'chapterId' })`
- **Request Body Contract (`packages/shared`):**
  ```typescript
  export class CreateChapterReportDto implements CreateChapterReportRequest {
    @IsUUID('4')
    chapterVersionId: string;

    @IsEnum(ChapterReportErrorType)
    errorType: ChapterReportErrorType;

    @IsOptional()
    @IsInt()
    @Min(1)
    pageNumber?: number;

    @IsOptional()
    @IsString()
    @MaxLength(100)
    anchorBlockId?: string;

    @IsOptional()
    @IsString()
    @MaxLength(1000)
    description?: string;
  }
  ```
- **XOR Semantics Validation:**
  - Không cho phép đồng thời cả `pageNumber` và `anchorBlockId` có giá trị (`400 CHAPTER_REPORT_MUTUAL_EXCLUSION`).
  - Hợp lệ:
    - Manga/Webtoon: `pageNumber >= 1`, `anchorBlockId = null`.
    - Novel: `pageNumber = null`, `anchorBlockId = 'block-X'`.
    - Toàn bộ chương: `pageNumber = null`, `anchorBlockId = null`.
- **Response Payload:**
  - `201 Created`:
    ```json
    {
      "success": true,
      "reportId": "uuid",
      "status": "PENDING",
      "message": "Báo cáo lỗi đã được tiếp nhận và sẽ được xử lý sớm nhất."
    }
    ```
  - `400 Bad Request`: `CHAPTER_REPORT_VERSION_MISMATCH` hoặc `CHAPTER_REPORT_MUTUAL_EXCLUSION`.
  - `401 Unauthorized`: Chưa đăng nhập.
  - `403 Forbidden`: Truy cập chapter của story PRIVATE mà không có quyền.
  - `404 Not Found`: Chapter không tồn tại.
  - `409 Conflict`: `CHAPTER_REPORT_DUPLICATE` (đã có pending report cùng loại lỗi trong 10 phút).
  - `429 Too Many Requests`: Vượt rate limit (kèm `error.meta.retryAfter` và header `Retry-After`).

### 3.2 Concurrency-Safe Service Logic
```typescript
async createReport(chapterId: string, dto: CreateChapterReportDto, user: { id: string; role?: string }) {
  // 1. Kiểm tra quyền đọc chương (Reader Access Policy, không tăng view)
  const { chapter } = await this.assertChapterReadable(chapterId, user);

  // 2. Kiểm tra XOR semantics
  if (dto.pageNumber && dto.anchorBlockId) {
    throw new BadRequestException({
      code: 'CHAPTER_REPORT_MUTUAL_EXCLUSION',
      message: 'Không thể cung cấp đồng thời cả pageNumber và anchorBlockId.',
    });
  }

  // 3. Thực thi trong PostgreSQL transaction với pessimistic write lock trên Chapter row
  return await this.dataSource.transaction(async (manager) => {
    await manager.findOne(Chapter, {
      where: { id: chapterId },
      lock: { mode: 'pessimistic_write' },
    });

    // Enforce chapterVersionId thuộc về chapterId
    const version = await manager.findOne(ChapterVersion, {
      where: { id: dto.chapterVersionId, chapterId },
    });
    if (!version) {
      throw new BadRequestException({
        code: 'CHAPTER_REPORT_VERSION_MISMATCH',
        message: 'Phiên bản chương truyện (chapterVersionId) không thuộc về chương này.',
      });
    }

    // Anti-duplicate: Kiểm tra pending report cùng loại lỗi trong 10 phút
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const existing = await manager.findOne(ChapterErrorReport, {
      where: {
        reporterId: user.id,
        chapterId,
        errorType: dto.errorType,
        status: ChapterReportStatus.PENDING,
        createdAt: MoreThan(tenMinutesAgo),
      },
    });

    if (existing) {
      throw new ConflictException({
        code: 'CHAPTER_REPORT_DUPLICATE',
        message: 'Bạn đã gửi báo cáo lỗi này cho chương truyện trong vòng 10 phút qua và hệ thống đang xử lý.',
      });
    }

    const report = manager.create(ChapterErrorReport, {
      reporterId: user.id,
      chapterId,
      chapterVersionId: dto.chapterVersionId,
      errorType: dto.errorType,
      pageNumber: dto.pageNumber ?? null,
      anchorBlockId: dto.anchorBlockId ?? null,
      description: dto.description?.trim() || '',
      status: ChapterReportStatus.PENDING,
    });

    const saved = await manager.save(report);

    return {
      success: true,
      reportId: saved.id,
      status: ChapterReportStatus.PENDING,
      message: 'Báo cáo lỗi đã được tiếp nhận và sẽ được xử lý sớm nhất.',
    };
  });
}
```

---

## 4. Thiết Kế Mobile Client (MOB-011 Bottom Sheet)

### 4.1 State Lifting trong Reader
- Trong [`NovelReaderView`](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/features/reader/presentation/novel_reader_view.dart):
  - Thêm callback: `final ValueChanged<String?>? onAnchorChanged`.
  - Khi người dùng cuộn đến block mới, gọi `onAnchorChanged?.call(currentBlock.anchorBlockId)`.
- Trong [`ReaderScreen`](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/features/reader/presentation/reader_screen.dart):
  - Lưu `String? _currentNovelAnchorBlockId`.
  - Truyền `onAnchorChanged: (anchor) => setState(() => _currentNovelAnchorBlockId = anchor)`.
  - Lấy `chapterVersionId` chính xác từ `_sessionController.state.chapterDetail?.activeVersion?.id` hoặc version đang nạp.
  - Comic/Webtoon: lấy `pageNumber = _sessionController.state.focusedPageIndex + 1`.

### 4.2 Modal Bottom Sheet (`ChapterReportSheet`)
1. **Tiêu đề & Ngữ cảnh:**
   - Tiêu đề: "Báo lỗi chương [Số chương]"
   - Badge vị trí:
     - Truyện tranh: `Trang [pageNumber]`
     - Truyện chữ: `Đoạn văn [anchorBlockId]`
   - Switch / Checkbox: "Áp dụng cho toàn bộ chương" ➔ khi bật thì gửi `pageNumber = null` và `anchorBlockId = null`.
2. **7 Danh mục lỗi chuẩn enum:**
   1. Ảnh hỏng / Không tải được (`IMAGE_CORRUPT`)
   2. Sai thứ tự trang (`WRONG_ORDER`)
   3. Bản dịch sai / Khó hiểu (`TRANSLATION_ERROR`)
   4. Lỗi chính tả / Lời thoại (`TYPO`)
   5. Nội dung phản cảm / Vi phạm (`INAPPROPRIATE_CONTENT`)
   6. Vi phạm bản quyền (`COPYRIGHT_INFRINGEMENT`)
   7. Lỗi khác (`OTHER`)
3. **Mô tả chi tiết:**
   - `TextFormField` 3 dòng, tối đa 1000 ký tự (tùy chọn).
4. **Xử lý phản hồi & Rate Limit:**
   - Đọc `error.meta?['retryAfter']` từ API response.
   - Hiển thị SnackBar: `"Bạn thao tác quá nhanh. Vui lòng thử lại sau ${retryAfter} giây."`.

---

## 5. Kế Hoạch Kiểm Thử & Verification Gates

1. **Gate 1: Reader Access Policy Guard (Backend):**
   - PUBLIC story + authenticated user ➔ 201 Created.
   - PRIVATE story + unauthenticated user ➔ 401 Unauthorized.
   - PRIVATE story + non-member user ➔ 403 Forbidden.
   - PRIVATE story + story member/admin ➔ 201 Created.
   - Unknown chapter ID ➔ 404 Not Found.
2. **Gate 2: Version Mismatch & XOR Semantics (Backend):**
   - Foreign `chapterVersionId` không thuộc `chapterId` ➔ 400 `CHAPTER_REPORT_VERSION_MISMATCH`.
   - Cung cấp đồng thời cả `pageNumber` và `anchorBlockId` ➔ 400 `CHAPTER_REPORT_MUTUAL_EXCLUSION`.
   - `pageNumber < 1` ➔ 400 validation error.
3. **Gate 3: Concurrency Duplicate Defense (Backend):**
   - Hai request đồng thời cùng tuple `(reporterId, chapterId, errorType)` chạy song song qua `Promise.all` ➔ Đúng 1 request thành công 201, request còn lại nhận 409 `CHAPTER_REPORT_DUPLICATE`.
4. **Gate 4: Rate Limiting & retryAfter Metadata (Backend):**
   - Request 1, 2, 3 trong 60s ➔ 201 Created.
   - Request 4 trong 60s ➔ 429 Too Many Requests kèm `error.meta.retryAfter > 0` và header `Retry-After`.
   - Gửi request tới chapter khác ➔ Vẫn được phép (routeParam isolation).
5. **Gate 5: Mobile Report Submission & Error Handling (Flutter):**
   - Unit test `ChapterReportRepository`: serialize payload với `chapterVersionId`, parse 201, parse `error.meta.retryAfter` trên 429, parse 409.
   - Widget test `ChapterReportSheet`: tự động điền `pageNumber` (comic) / `anchorBlockId` (novel), toggle whole chapter, validate radio selection, hiển thị countdown retryAfter khi gặp 429.
6. **Gate 6: Monorepo CI Parity:**
   - Backend `npm test` & `npm run build` = 100% GREEN.
   - Mobile `flutter test` & `flutter analyze` = 100% GREEN (0 errors, 0 warnings).

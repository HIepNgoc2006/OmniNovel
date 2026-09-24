# Phase 5C.6: Chapter Content Reporting System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Triển khai hệ thống Báo cáo Lỗi Chương truyện hoàn chỉnh gồm Backend API (#191) và Mobile Bottom Sheet (MOB-011) với kiểm soát quyền truy cập Reader (story & unpublished version), gắn canonical rendered `chapterVersionId`, ngăn chặn spam qua Rate Limiting per-chapter, và chống trùng lặp báo cáo bằng PostgreSQL pessimistic write lock với NULL-safe location equality.

**Architecture:** Monorepo NestJS API + Flutter Mobile. Backend quản lý bảng `chapter_error_reports`, endpoint `POST /api/v1/chapters/:id/reports` được bảo vệ bởi `JwtAuthGuard`, `RateLimitGuard` (cô lập theo `routeParam: 'id'`), và transaction `pessimistic_write` chống race condition duplicate. Mobile hiển thị `ChapterReportSheet` từ Reader Top HUD, tự động gắn `activeVersion.id` (rendered version) và tọa độ trang (Comic) hoặc đoạn văn (Novel) với cơ chế XOR semantics.

**Tech Stack:** NestJS, TypeORM, PostgreSQL, Redis, TypeScript, Flutter, Dart, Mocktail.

## Global Constraints & 7 Verification Gates
- **Gate 1 (Migration & Schema):** Migration up/down hoàn chỉnh, constraint `page_number IS NULL OR page_number >= 1`, 7 error types, down() xử lý `description NULL` trước khi `SET NOT NULL`.
- **Gate 2 (Access Policy):** PUBLIC published -> 201; PRIVATE non-member -> 403; unpublished version + ordinary reader -> 403; unpublished version + authorized staff -> 201; chapter không tồn tại -> 404.
- **Gate 3 (Version & XOR):** Foreign `chapterVersionId` -> 400 `CHAPTER_REPORT_VERSION_MISMATCH`; vừa có `pageNumber` vừa có `anchorBlockId` -> structured 400 `CHAPTER_REPORT_MUTUAL_EXCLUSION`.
- **Gate 4 (Concurrent Duplicate):**
  - Same exact context -> 201 + 409 `CHAPTER_REPORT_DUPLICATE` (NULL-safe location check, `status IN ('PENDING', 'INVESTIGATING')` trong 10 phút).
  - Different page/anchor -> cả 2 đều 201.
  - Whole chapter duplicate -> 201 + 409.
- **Gate 5 (Rate Limit):** 3 req/60s per-chapter; 4 reqs với 4 error types khác nhau trên cùng chapter -> req #4 nhận 429 (`error.meta.retryAfter > 0`, header `Retry-After > 0`); request sang chapter khác vẫn được phép (key isolation).
- **Gate 6 (Mobile Rendered Version Binding):** Lấy `state.chapterDetail!.activeVersion!.id` (fail-closed nếu null).
- **Gate 7 (Guest Auth Gate):** Chưa đăng nhập -> hiển thị login dialog, phát sinh đúng 0 API calls.

---

### Task 1: Shared Enums, DTOs & Database Migration

**Files:**
- Modify: `packages/shared/src/index.ts`
- Create: `services/api/src/database/migrations/1700000000016-AddChapterReportAnchorBlockAndEnums.ts`
- Create: `services/api/src/modules/chapters/entities/chapter-error-report.entity.ts`
- Modify: `services/api/src/modules/chapters/chapters.module.ts`

**Interfaces:**
- Consumes: `Chapter`, `ChapterVersion`, `User` entities.
- Produces: `ChapterReportErrorType`, `ChapterReportStatus`, `CreateChapterReportRequest`, `CreateChapterReportResponse`, `ChapterErrorReport` entity.

- [x] **Step 1: Định nghĩa enums và contracts trong `packages/shared/src/index.ts`**
  ```typescript
  export enum ChapterReportErrorType {
    IMAGE_CORRUPT = 'IMAGE_CORRUPT',
    WRONG_ORDER = 'WRONG_ORDER',
    TRANSLATION_ERROR = 'TRANSLATION_ERROR',
    TYPO = 'TYPO',
    INAPPROPRIATE_CONTENT = 'INAPPROPRIATE_CONTENT',
    COPYRIGHT_INFRINGEMENT = 'COPYRIGHT_INFRINGEMENT',
    OTHER = 'OTHER',
  }

  export enum ChapterReportStatus {
    PENDING = 'PENDING',
    INVESTIGATING = 'INVESTIGATING',
    RESOLVED = 'RESOLVED',
    REJECTED = 'REJECTED',
  }

  export interface CreateChapterReportRequest {
    chapterVersionId: string;
    errorType: ChapterReportErrorType;
    pageNumber?: number;
    anchorBlockId?: string;
    description?: string;
  }

  export interface CreateChapterReportResponse {
    success: true;
    reportId: string;
    status: ChapterReportStatus.PENDING;
    message: string;
  }
  ```

- [x] **Step 2: Build `packages/shared`**
  Chạy `npm run build` trong `packages/shared`.

- [x] **Step 3: Tạo migration `1700000000016-AddChapterReportAnchorBlockAndEnums.ts`**
  - **`up()`:**
    ```sql
    ALTER TABLE chapter_error_reports ALTER COLUMN description DROP NOT NULL;
    ALTER TABLE chapter_error_reports ALTER COLUMN description SET DEFAULT '';
    ALTER TABLE chapter_error_reports ADD COLUMN IF NOT EXISTS chapter_version_id UUID NULL REFERENCES chapter_versions(id) ON DELETE SET NULL;
    ALTER TABLE chapter_error_reports ADD COLUMN IF NOT EXISTS anchor_block_id VARCHAR(100) NULL;
    ALTER TABLE chapter_error_reports DROP CONSTRAINT IF EXISTS chapter_error_reports_page_number_check;
    ALTER TABLE chapter_error_reports ADD CONSTRAINT chapter_error_reports_page_number_check CHECK (page_number IS NULL OR page_number >= 1);
    ALTER TABLE chapter_error_reports DROP CONSTRAINT IF EXISTS chapter_error_reports_error_type_check;
    ALTER TABLE chapter_error_reports ADD CONSTRAINT chapter_error_reports_error_type_check CHECK (error_type IN ('IMAGE_CORRUPT', 'WRONG_ORDER', 'TRANSLATION_ERROR', 'TYPO', 'COPYRIGHT_INFRINGEMENT', 'INAPPROPRIATE_CONTENT', 'OTHER'));
    ```
  - **`down()`:**
    ```sql
    ALTER TABLE chapter_error_reports DROP CONSTRAINT IF EXISTS chapter_error_reports_error_type_check;
    ALTER TABLE chapter_error_reports ADD CONSTRAINT chapter_error_reports_error_type_check CHECK (error_type IN ('IMAGE_CORRUPT', 'WRONG_ORDER', 'TRANSLATION_ERROR', 'TYPO', 'COPYRIGHT_INFRINGEMENT', 'OTHER'));
    ALTER TABLE chapter_error_reports DROP CONSTRAINT IF EXISTS chapter_error_reports_page_number_check;
    ALTER TABLE chapter_error_reports DROP COLUMN IF EXISTS anchor_block_id;
    ALTER TABLE chapter_error_reports DROP COLUMN IF EXISTS chapter_version_id;
    UPDATE chapter_error_reports SET description = '' WHERE description IS NULL;
    ALTER TABLE chapter_error_reports ALTER COLUMN description SET NOT NULL;
    ```

- [x] **Step 4: Tạo TypeORM entity `ChapterErrorReport`**
  Đặt tại `services/api/src/modules/chapters/entities/chapter-error-report.entity.ts`.

- [x] **Step 5: Đăng ký `ChapterErrorReport` trong `chapters.module.ts`**
  Thêm `ChapterErrorReport` vào `TypeOrmModule.forFeature([..., ChapterErrorReport])`.

---

### Task 2: Rate Limit routeParam Extension & GlobalExceptionFilter retryAfter Metadata

**Files:**
- Modify: `services/api/src/common/decorators/rate-limit.decorator.ts`
- Modify: `services/api/src/common/guards/rate-limit.guard.ts`
- Modify: `services/api/src/common/filters/http-exception.filter.ts`
- Test: `services/api/src/common/filters/http-exception.filter.spec.ts`

**Interfaces:**
- Consumes: `RateLimitOptions`, `GlobalExceptionFilter`.
- Produces: `error.meta.retryAfter`, per-chapter rate limit keys.

- [ ] **Step 1: Viết failing test trong `http-exception.filter.spec.ts`**
  Kiểm tra `HttpException` chứa `{ code: 'TOO_MANY_REQUESTS', message: '...', meta: { retryAfter: 45 } }` bảo toàn `error.meta.retryAfter`.

- [ ] **Step 2: Thêm `'retryAfter'` vào `PUBLIC_ERROR_META_FIELDS` trong `http-exception.filter.ts`**

- [ ] **Step 3: Mở rộng `rate-limit.decorator.ts` với `routeParam?: string`**

- [ ] **Step 4: Cập nhật `rate-limit.guard.ts` để đọc `options.routeParam`**
  - Nếu `options.routeParam` được cấu hình mà `request.params?.[options.routeParam]` không tồn tại: ném `InternalServerErrorException('Rate limit routeParam is missing from request params')` để tránh fallback âm thầm.
  - Ghép `${options.keyPrefix}:${options.routeParam}_${paramValue}` vào key prefix.
  - Ném `HttpException` chứa `meta: { retryAfter }`.

- [ ] **Step 5: Chạy unit test kiểm tra**
  Chạy `npm test -- src/common/filters/http-exception.filter.spec.ts`.

---

### Task 3: Backend Chapter Report Service, Controller & Testing Gates

**Files:**
- Create: `services/api/src/modules/chapters/dto/create-chapter-report.dto.ts`
- Modify: `services/api/src/modules/chapters/chapters.service.ts`
- Modify: `services/api/src/modules/chapters/chapters.controller.ts`
- Create: `services/api/src/modules/chapters/test/chapter-reports.spec.ts`

**Interfaces:**
- Consumes: `CreateChapterReportDto`, `ChapterErrorReport`, `resolveReadableChapterVersion`.
- Produces: Endpoint `POST /api/v1/chapters/:id/reports`.

- [ ] **Step 1: Tạo DTO `CreateChapterReportDto`**
  Validate `@IsUUID('4') chapterVersionId`, `@IsEnum(ChapterReportErrorType) errorType`, `@IsOptional() @IsInt() @Min(1) pageNumber`, `@IsOptional() @IsString() @MaxLength(100) anchorBlockId`, `@IsOptional() @IsString() @MaxLength(1000) description`.

- [ ] **Step 2: Viết test suite `chapter-reports.spec.ts` bao phủ các Gates**
  - **Gate 2 (Access Policy):**
    - PUBLIC story + published version ➔ 201 Created.
    - PRIVATE story + unauthenticated ➔ 401 Unauthorized.
    - PRIVATE story + non-member reader ➔ 403 Forbidden.
    - Unpublished version + ordinary reader ➔ 403 Forbidden.
    - Unpublished version + story staff / admin ➔ 201 Created.
    - Chapter không tồn tại ➔ 404 Not Found.
  - **Gate 3 (Version Mismatch & XOR):**
    - Foreign `chapterVersionId` không thuộc `chapterId` ➔ 400 `CHAPTER_REPORT_VERSION_MISMATCH`.
    - Vừa có `pageNumber` vừa có `anchorBlockId` ➔ 400 `CHAPTER_REPORT_MUTUAL_EXCLUSION`.
  - **Gate 4 (Concurrent Duplicate):**
    - 2 concurrent requests cùng tuple `(reporterId, chapterId, chapterVersionId, errorType, location)` qua `Promise.all` ➔ 1 request 201, 1 request 409 `CHAPTER_REPORT_DUPLICATE`.
    - Khác page hoặc anchor ➔ cả 2 đều 201.
    - Whole chapter duplicate (cả 2 đều null page & anchor) ➔ 201 + 409.
  - **Gate 5 (Rate Limit Isolation & retryAfter):**
    - 4 requests với 4 error types khác nhau trên cùng chapter ➔ request #4 nhận 429 kèm `error.meta.retryAfter > 0` và header `Retry-After > 0`.
    - Request tới chapter khác ➔ vẫn thành công 201 (key isolation).

- [ ] **Step 3: Triển khai `resolveReadableChapterVersion(chapterId, chapterVersionId, user, manager)` trong `chapters.service.ts`**
  - Kiểm tra story access (PRIVATE ➔ bắt buộc admin hoặc story member).
  - Kiểm tra `chapterVersionId` thuộc về `chapterId` (nếu không ➔ 400 `CHAPTER_REPORT_VERSION_MISMATCH`).
  - Kiểm tra version `isPublished` (nếu unpublished ➔ chỉ cho phép admin hoặc story staff, người khác ➔ 403 `FORBIDDEN`).

- [ ] **Step 4: Triển khai `createReport(chapterId, dto, user)` trong `chapters.service.ts`**
  - Structured XOR check: nếu cả 2 tồn tại ➔ `throw new BadRequestException({ code: 'CHAPTER_REPORT_MUTUAL_EXCLUSION', message: 'pageNumber và anchorBlockId không được cùng tồn tại.' })`.
  - Bọc transaction với `lock: { mode: 'pessimistic_write' }` trên dòng `Chapter`.
  - Gọi `resolveReadableChapterVersion(...)`.
  - Kiểm tra duplicate với NULL-safe SQL logic:
    ```sql
    SELECT id FROM chapter_error_reports
    WHERE reporter_id = $1
      AND chapter_id = $2
      AND chapter_version_id = $3
      AND error_type = $4
      AND page_number IS NOT DISTINCT FROM $5
      AND anchor_block_id IS NOT DISTINCT FROM $6
      AND status IN ('PENDING', 'INVESTIGATING')
      AND created_at >= NOW() - INTERVAL '10 minutes'
    ```
    Nếu tìm thấy ➔ ném `409 CHAPTER_REPORT_DUPLICATE`.
  - Lưu và trả về `CreateChapterReportResponse` (201 Created).

- [ ] **Step 5: Khai báo endpoint trong `chapters.controller.ts`**
  ```typescript
  @Post('chapters/:id/reports')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ limit: 3, ttlSeconds: 60, keyPrefix: 'chapter_report', scope: 'IP_AND_USER', routeParam: 'id' })
  @HttpCode(HttpStatus.CREATED)
  createReport(
    @Param('id', new ParseUUIDPipe({ version: '4' })) chapterId: string,
    @Body() dto: CreateChapterReportDto,
    @CurrentUser() user: any,
  ) {
    return this.chaptersService.createReport(chapterId, dto, user);
  }
  ```

- [ ] **Step 6: Chạy kiểm thử Backend**
  Chạy `npm test -- src/modules/chapters/test/chapter-reports.spec.ts` và đảm bảo toàn bộ tests PASS.

---

### Task 4: Mobile NovelReaderView onAnchorChanged & Reader State Lifting

**Files:**
- Modify: `apps/mobile/lib/features/reader/presentation/novel_reader_view.dart`
- Modify: `apps/mobile/lib/features/reader/presentation/reader_screen.dart`

**Interfaces:**
- Consumes: `NovelReaderView`, `ReaderScreen`.
- Produces: `onAnchorChanged` callback, lifted `_currentNovelAnchorBlockId`, Report button trên Top HUD.

- [ ] **Step 1: Cập nhật `NovelReaderView` với `onAnchorChanged`**
  - Bổ sung `final ValueChanged<String?>? onAnchorChanged;`.
  - Thêm biến `String? _lastEmittedAnchor;` để cache và chống rebuild spam.
  - Gọi `_emitAnchor(anchor)` cả sau `_performInitialResumption()` / layout ban đầu VÀ khi cuộn (`_onScrollNotification`).

- [ ] **Step 2: Cập nhật `ReaderScreen`**
  - Thêm optional parameters `AuthService? authService` và `ChapterReportRepository? reportRepository` trong constructor (backward-compatible cho existing tests).
  - Quản lý state `String? _currentNovelAnchorBlockId;`.
  - Gắn `onAnchorChanged: (anchor) => _currentNovelAnchorBlockId = anchor`.
  - Thêm nút icon `IconButton(icon: Icon(Icons.outlined_flag), tooltip: 'Báo lỗi chương', onPressed: _openReportSheet)`.
  - Trong `_openReportSheet`:
    - Gate 7 check: nếu user chưa đăng nhập (`!(authService?.state.isAuthenticated ?? false)`) ➔ hiển thị login-required dialog, không gửi request.
    - Gate 6 check: lấy rendered version `final activeVersion = _sessionController.state.chapterDetail?.activeVersion;`. Nếu `activeVersion == null` ➔ fail-closed, thông báo chưa có version content.
    - Truyền `chapterId`, `chapterVersionId: activeVersion.id`, `pageNumber` (nếu là manga/comic = `focusedPageIndex + 1`), `anchorBlockId` (nếu là novel = `_currentNovelAnchorBlockId`).

---

### Task 5: Mobile Chapter Report Repository & Error Handling

**Files:**
- Create: `apps/mobile/lib/features/reader/models/chapter_report_models.dart`
- Create: `apps/mobile/lib/features/reader/repositories/chapter_report_repository.dart`
- Test: `apps/mobile/test/features/reader/chapter_report_repository_test.dart`

**Interfaces:**
- Consumes: `ApiClient`, `ApiEndpoints`.
- Produces: `ChapterReportRepository.sendReport()`.

- [ ] **Step 1: Viết failing test `chapter_report_repository_test.dart`**
  - Test serialize request payload với `chapterVersionId`, `errorType`, `pageNumber`, `anchorBlockId`, `description`.
  - Test parse 201 response.
  - Test parse `error.meta['retryAfter']` khi gặp 429.
  - Test ném `ApiError` khi gặp 409 Duplicate.

- [ ] **Step 2: Tạo DTOs trong `chapter_report_models.dart`**
  `ChapterReportErrorType` enum (7 types), `ChapterReportPayload`, `ChapterReportResult`.

- [ ] **Step 3: Triển khai `ChapterReportRepository`**
  Gọi `POST /api/v1/chapters/:chapterId/reports`.

- [ ] **Step 4: Chạy test repository**
  Chạy `powershell -ExecutionPolicy Bypass -File apps/mobile/scripts/flutter-runner.ps1 test test/features/reader/chapter_report_repository_test.dart`.

---

### Task 6: Mobile MOB-011 Bottom Sheet UI & Widget Tests

**Files:**
- Create: `apps/mobile/lib/features/reader/presentation/chapter_report_sheet.dart`
- Test: `apps/mobile/test/features/reader/chapter_report_sheet_test.dart`

**Interfaces:**
- Consumes: `ChapterReportRepository`, `ChapterReportErrorType`.
- Produces: `ChapterReportSheet.show(context, ...)`.

- [ ] **Step 1: Viết failing widget test `chapter_report_sheet_test.dart`**
  - Test hiển thị đúng ngữ cảnh: badge `Trang X` (Comic) hoặc badge `Đoạn văn Y` (Novel).
  - Test checkbox "Áp dụng cho toàn bộ chương" xóa bỏ pageNumber/anchorBlockId.
  - Test chọn 7 loại lỗi và nhập mô tả.
  - Test trạng thái Loading và đóng sheet khi gửi thành công.
  - Test hiển thị SnackBar với số giây đếm lùi khi gặp lỗi 429 (`retryAfter`).
  - Test hiển thị cảnh báo khi gặp 409 Duplicate.

- [ ] **Step 2: Triển khai `ChapterReportSheet`**
  - Giao diện Bottom Sheet bo tròn, nền `AppColors.darkSurfaceElevated`, primary accent từ `context.primaryColor`.
  - Radio list / Chips cho 7 danh mục lỗi chuẩn.
  - Tùy chọn checkbox toàn bộ chương.
  - TextField mô tả chi tiết tối đa 1000 ký tự.
  - Nút Hủy và Gửi báo cáo với `CircularProgressIndicator` khi `_isSubmitting`.
  - Đọc `(error.meta?['retryAfter'] as num?)?.toInt()` khi lỗi 429 để thông báo thời gian chờ chính xác.

- [ ] **Step 3: Chạy test widget**
  Chạy `powershell -ExecutionPolicy Bypass -File apps/mobile/scripts/flutter-runner.ps1 test test/features/reader/chapter_report_sheet_test.dart`.

---

### Task 7: Full Monorepo Regression, Git Sync & GitHub Issue #202 Tracking

**Files:**
- Modify: `plans/phases/phase_05_mobile_app.md`

- [ ] **Step 1: Backend Full Regression**
  Chạy `npm test` trong `services/api` (xác nhận 100% test suites PASS).
  Chạy `npm run build` trong `services/api` (xác nhận build exit code 0).

- [ ] **Step 2: Mobile Full Regression & Analyzer**
  Chạy `powershell -ExecutionPolicy Bypass -File apps/mobile/scripts/flutter-runner.ps1 test`.
  Chạy `powershell -ExecutionPolicy Bypass -File apps/mobile/scripts/flutter-runner.ps1 analyze --no-pub lib test`.

- [ ] **Step 3: Cập nhật tài liệu tiến độ**
  Đánh dấu hoàn thành Phase 5C.6 trong `plans/phases/phase_05_mobile_app.md`.

- [ ] **Step 4: Git Commit & Push**
  `git add .`
  `git commit -m "feat(reader): implement chapter content error reporting system (#191, #202)"`
  `git push origin main`

- [ ] **Step 5: Cập nhật & Đóng Issue #191 và #202 trên GitHub**
  Sử dụng `gh issue close 191 --reason completed` và `gh issue close 202 --reason completed` với comment nghiệm thu chi tiết.

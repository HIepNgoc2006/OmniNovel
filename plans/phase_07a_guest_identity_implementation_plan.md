# Phase 7A: Guest-first Identity & Account Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Triển khai cơ chế Guest-first Identity, vòng đời tài khoản hoàn chỉnh và API di chuyển trạng thái Guest lên Cloud Account (`POST /api/v1/account/import-guest-state`) với luật merge đơn định (LWW - Last-Write-Wins), đảm bảo người dùng có thể đọc truyện và lưu tiến độ offline/local mà không cần đăng nhập trước.

**Architecture:** Thiết kế theo mô hình Local-first Repository trên cả Web và Mobile. Guest state được lưu trữ hoàn toàn tại client (IndexedDB/LocalStorage cho Web, SQLite cho Mobile) mà không tạo user rác trong DB PostgreSQL. Khi người dùng đăng ký hoặc đăng nhập, client tự động đẩy snapshot dữ liệu qua API `import-guest-state`, Backend xử lý idempotent merge và biến Cloud Account thành Single Source of Truth (SSoT).

**Tech Stack:** TypeScript, NestJS, TypeORM, PostgreSQL, Jest, Next.js 14, Flutter (Dart).

## Global Constraints
- Không tạo user nặc danh vào bảng `users` của PostgreSQL.
- Mọi thao tác merge dữ liệu trên server phải idempotent (gọi nhiều lần không nhân bản hay làm sai lệch dữ liệu).
- Quy tắc giải quyết xung đột (Conflict Resolution): Last-Write-Wins (LWW) dựa trên `updatedAt` timestamp (client/server monotonic check), hợp nhất danh sách chương đã đọc (`readChapterIds = Array.from(new Set([...server, ...guest]))`).
- Tất cả thư viện và mã nguồn chỉ cài đặt cục bộ trong monorepo, không cài global.

---

### Task 1: Shared Contracts & Migration DTOs (`@omninovel/shared`)

**Files:**
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/guest-migration-contract.spec.ts`

**Interfaces:**
- Produces:
  - `GuestBookmarkItem`: `{ storyId: string; title?: string; coverUrl?: string; createdAt: string; }`
  - `GuestReadingProgressItem`: `{ storyId: string; chapterId: string; chapterVersionId?: string | null; readingMode?: string; progressPercentage: number; scrollPosition: number; anchorBlockId?: string | null; textOffset?: number; readChapterIds?: string[]; updatedAt: string; }`
  - `GuestHistoryItem`: `{ storyId: string; chapterId: string; chapterTitle?: string; storyTitle?: string; readAt: string; }`
  - `GuestReaderPreferences`: `{ fontSize?: number; lineHeight?: number; fontFamily?: string; readingDirection?: 'LTR' | 'RTL' | 'VERTICAL'; theme?: 'DARK' | 'LIGHT' | 'SEPIA' | 'AMOLED'; }`
  - `GuestStatePayload`: `{ bookmarks: GuestBookmarkItem[]; progress: GuestReadingProgressItem[]; history: GuestHistoryItem[]; preferences?: GuestReaderPreferences; }`
  - `ImportGuestStateResponse`: `{ importedBookmarksCount: number; mergedProgressCount: number; importedHistoryCount: number; serverSyncedAt: string; }`

- [ ] **Step 1: Viết test kiểm tra schema và type guards cho Guest Migration Contract**

Tạo file `packages/shared/src/__tests__/guest-migration-contract.spec.ts`:
```typescript
import {
  GuestBookmarkItem,
  GuestReadingProgressItem,
  GuestStatePayload,
  ImportGuestStateResponse,
  validateGuestStatePayload,
} from '../index';

describe('Guest Migration Contract', () => {
  it('validates a well-formed guest state payload', () => {
    const payload: GuestStatePayload = {
      bookmarks: [
        {
          storyId: 'story-1',
          createdAt: new Date().toISOString(),
        },
      ],
      progress: [
        {
          storyId: 'story-1',
          chapterId: 'chapter-10',
          scrollPosition: 1200,
          progressPercentage: 85,
          anchorBlockId: 'p-42',
          textOffset: 120,
          readChapterIds: ['chapter-8', 'chapter-9', 'chapter-10'],
          updatedAt: new Date().toISOString(),
        },
      ],
      history: [
        {
          storyId: 'story-1',
          chapterId: 'chapter-10',
          readAt: new Date().toISOString(),
        },
      ],
    };

    expect(validateGuestStatePayload(payload)).toBe(true);
  });

  it('rejects invalid guest state payload without required arrays', () => {
    expect(validateGuestStatePayload(null)).toBe(false);
    expect(validateGuestStatePayload({})).toBe(false);
    expect(validateGuestStatePayload({ bookmarks: 'invalid' })).toBe(false);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `npm test packages/shared/src/__tests__/guest-migration-contract.spec.ts` (trong thư mục monorepo)
Expected: FAIL do chưa khai báo `validateGuestStatePayload`.

- [ ] **Step 3: Định nghĩa contracts và validator trong `packages/shared/src/index.ts`**

Bổ sung các types và hàm `validateGuestStatePayload` vào `packages/shared/src/index.ts`.

- [ ] **Step 4: Chạy test và build `@omninovel/shared`**

Run: `npm --prefix packages/shared run build && npm --prefix packages/shared test`
Expected: PASS 100%.

- [ ] **Step 5: Git commit**

```bash
git add packages/shared
git commit -m "feat(shared): define contracts and validators for guest state migration"
```

---

### Task 2: Backend Migration Endpoint `POST /api/v1/account/import-guest-state` (`services/api`)

**Files:**
- Create: `services/api/src/modules/users/dto/import-guest-state.dto.ts`
- Modify: `services/api/src/modules/stories/stories.service.ts`
- Modify: `services/api/src/modules/users/users.controller.ts` (hoặc tạo `account.controller.ts`)
- Test: `services/api/src/modules/users/test/import-guest-state.spec.ts`

**Interfaces:**
- Consumes: `GuestStatePayload` từ `@omninovel/shared`
- Produces: `POST /api/v1/account/import-guest-state` trả về `ImportGuestStateResponse`

- [ ] **Step 1: Viết test cho logic merge idempotent của `importGuestState`**

Tạo test `services/api/src/modules/users/test/import-guest-state.spec.ts` mô phỏng:
1. User có sẵn tiến độ chapter 8 trên server.
2. Guest gửi tiến độ chapter 10 với `updatedAt` mới hơn -> server cập nhật sang chapter 10 và gộp mảng `readChapterIds`.
3. Guest gửi bookmark đã tồn tại trên server -> không tạo bản ghi trùng lặp, giữ nguyên bookmark.
4. Guest gửi bookmark mới -> tạo mới trong database.

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `npm --prefix services/api test -- import-guest-state.spec.ts`
Expected: FAIL với service method not found.

- [ ] **Step 3: Cài đặt DTO và Service Method `importGuestState`**

Viết DTO với `class-validator` và phương thức xử lý transaction trong service đảm bảo tính toàn vẹn dữ liệu.

- [ ] **Step 4: Chạy test để xác nhận pass**

Run: `npm --prefix services/api test -- import-guest-state.spec.ts`
Expected: PASS.

- [ ] **Step 5: Git commit**

```bash
git add services/api
git commit -m "feat(api): implement POST /api/v1/account/import-guest-state with LWW deterministic merge"
```

---

### Task 3: Backend Account Lifecycle Endpoints (`services/api`)

**Files:**
- Create: `services/api/src/modules/users/dto/change-password.dto.ts`
- Modify: `services/api/src/modules/auth/auth.service.ts`
- Modify: `services/api/src/modules/auth/auth.controller.ts`
- Modify: `services/api/src/modules/users/users.service.ts`
- Test: `services/api/src/modules/auth/test/account-lifecycle.spec.ts`

**Interfaces:**
- `POST /api/v1/auth/change-password` (bảo vệ bởi `JwtAuthGuard`)
- `DELETE /api/v1/account` (xóa tài khoản cá nhân, cascade xóa session và tokens)
- `GET /api/v1/account/export-data` (xuất JSON toàn bộ thông tin profile, bookmarks, reading progress)

- [ ] **Step 1: Viết test cho các endpoint vòng đời tài khoản**
- [ ] **Step 2: Chạy test xác nhận fail**
- [ ] **Step 3: Triển khai DTO, Service logic và Controller endpoints**
- [ ] **Step 4: Chạy test xác nhận pass**
- [ ] **Step 5: Git commit**

```bash
git add services/api
git commit -m "feat(api): add change-password, account deletion and data export endpoints"
```

---

### Task 4: Web Client Local-First Library Repository (`apps/web`)

**Files:**
- Create: `apps/web/src/lib/storage/local-library-repository.ts`
- Modify: `apps/web/src/lib/reader/use-reading-progress.ts`
- Test: `apps/web/src/test/local-library-repository.spec.ts`

**Interfaces:**
- `LocalLibraryRepository`:
  - `saveBookmark(storyId: string, metadata?: any): void`
  - `removeBookmark(storyId: string): void`
  - `getBookmarks(): GuestBookmarkItem[]`
  - `isBookmarked(storyId: string): boolean`
  - `saveProgress(progress: GuestReadingProgressItem): void`
  - `getProgress(storyId: string): GuestReadingProgressItem | null`
  - `exportGuestState(): GuestStatePayload`
  - `clearGuestState(): void`

- [ ] **Step 1: Viết unit test cho `local-library-repository`**
- [ ] **Step 2: Chạy test xác nhận fail**
- [ ] **Step 3: Triển khai `LocalLibraryRepository` với LocalStorage & fallback an toàn**
- [ ] **Step 4: Tích hợp vào `use-reading-progress.ts` để ghi nhận tiến độ Guest khi unauthenticated**
- [ ] **Step 5: Chạy unit test xác nhận pass**
- [ ] **Step 6: Git commit**

```bash
git add apps/web
git commit -m "feat(web): add LocalLibraryRepository for guest-first reading progress and bookmarks"
```

---

### Task 5: Web Client Auto Migration Hook Khi Đăng Nhập (`apps/web`)

**Files:**
- Create: `apps/web/src/lib/auth/use-guest-migration.ts`
- Modify: `apps/web/src/lib/auth/auth-context.tsx`
- Modify: `apps/web/src/lib/api/account.ts`
- Test: `apps/web/src/test/guest-migration-flow.spec.ts`

**Interfaces:**
- Hook `useGuestMigration`:
  - Kiểm tra `LocalLibraryRepository.hasData()` ngay sau khi `isAuthenticated` chuyển sang `true`.
  - Gọi `importGuestStateApi(payload)`.
  - Sau khi server phản hồi thành công, dọn dẹp hoặc gán nhãn `merged` cho local state và trigger refresh thư viện cloud.

- [ ] **Step 1: Viết test cho luồng tự động migration sau khi đăng nhập**
- [ ] **Step 2: Chạy test xác nhận fail**
- [ ] **Step 3: Triển khai `useGuestMigration` và tích hợp vào `auth-context.tsx`**
- [ ] **Step 4: Chạy test xác nhận pass**
- [ ] **Step 5: Git commit**

```bash
git add apps/web
git commit -m "feat(web): trigger automatic guest state migration to cloud on login/register"
```

---

### Task 6: Mobile Client Guest Mode & SQLite Local Persistence (`apps/mobile`)

**Files:**
- Modify: `apps/mobile/lib/features/auth/presentation/login_screen.dart`
- Modify: `apps/mobile/lib/features/library/domain/repositories/library_repository.dart`
- Create: `apps/mobile/lib/features/library/data/repositories/guest_library_repository.dart`
- Test: `apps/mobile/test/features/library/guest_library_repository_test.dart`

**Interfaces:**
- Cung cấp nút `Tiếp tục với tư cách Khách` (Continue as Guest) trên màn hình đăng nhập.
- `GuestLibraryRepository` lưu trữ bookmarks và reading progress cục bộ vào SQLite/SharedPreferences.
- Khi người dùng đăng nhập trong màn hình Profile, gọi API `/api/v1/account/import-guest-state` để đồng bộ lên cloud.

- [ ] **Step 1: Viết unit test cho `GuestLibraryRepository` trên Flutter**
- [ ] **Step 2: Triển khai Guest Mode UI và Local Storage Repository**
- [ ] **Step 3: Tích hợp trigger sync khi đăng nhập**
- [ ] **Step 4: Chạy flutter test**
- [ ] **Step 5: Git commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): add Continue as Guest mode and local library persistence"
```

# Phase 7A: Guest Local Runtime Engine Implementation Plan

> **Trạng thái:** ACTIVE — Sau khi hoàn tất và nghiệm thu **Phase 7.0 Design Gate** ([identity_and_ownership_model.md](product/identity_and_ownership_model.md), [guest_to_account_claim_protocol.md](product/guest_to_account_claim_protocol.md), [unified_sync_protocol.md](product/unified_sync_protocol.md), [web_mobile_capability_matrix.md](product/web_mobile_capability_matrix.md)).  
> **Phạm vi Phase 7A:** Tập trung 100% vào **Local-First Engine cho Guest**. Tuyệt đối **CHƯA triển khai Cloud Claim / Migration Endpoint trong phase này** (Cloud Claim chuyển sang Phase 7B theo kiến trúc Two-Step Claim Protocol).

**Goal:** Thiết lập môi trường thực thi cục bộ (Local Runtime) cho Khách vãng lai trên Web và Mobile, cho phép người dùng mở ứng dụng đọc truyện, lưu tiến độ, lịch sử và đánh dấu trang mà không cần tài khoản, hoàn toàn độc lập với JWT và không tạo bất kỳ dữ liệu rác nào trong CSDL PostgreSQL.

**Architecture:**
- **Web Client (`apps/web`):** Sử dụng **IndexedDB** (`omninovel_local_v2`) làm primary store cho Guest Library (Bookmarks, Reading Progress, Reading History) với partition `guest:<installationId>`. `localStorage` chỉ lưu các cấu hình phần cứng nhỏ (`theme_mode`, `ui_density`).
- **Mobile Client (`apps/mobile`):** Sử dụng **Hạ tầng SQLite hiện hữu** kết hợp cột `owner_scope = 'guest:<installationId>'` (không dựng thêm silo DB mới).
- **Backend Core API (`services/api`):** Đảm bảo các API đọc nội dung công khai (`/stories`, `/chapters/:id`) phục vụ khách vãng lai mà không yêu cầu hay kiểm tra Bearer token.

**Tech Stack:**
- Web: **Next.js 16.3.3 / React 19.2**, TypeScript, IndexedDB (IDB / Dexie), Tailwind CSS v4.
- Mobile: **Flutter 3.x / Dart 3.x**, SQLite (Floor/sqflite), Flutter Secure Storage.
- Shared: `@omninovel/shared`.

## Global Constraints
- Không tạo bản ghi `User` nặc danh trong PostgreSQL.
- Dữ liệu của Guest chỉ lưu cục bộ tại client trong partition `guest:<installationId>`.
- Tuyệt đối không dùng `localStorage` cho tiến độ đọc hay bookmark trên Web (IndexedDB là chuẩn bắt buộc).
- Giữ nguyên các bất biến bảo mật và ranh giới đã khóa tại Phase 7.0.

---

### Task 1: Web Client IndexedDB Primary Store (`apps/web`)

**Files:**
- Create: `apps/web/src/lib/storage/indexed-db-client.ts`
- Create: `apps/web/src/lib/storage/guest-library-store.ts`
- Test: `apps/web/src/test/guest-indexed-db.spec.ts`

**Interfaces:**
- `GuestLibraryStore`:
  - `saveBookmark(storyId: string): Promise<void>`
  - `removeBookmark(storyId: string): Promise<void>`
  - `getBookmarks(): Promise<Array<{ storyId: string; createdAt: string }>>`
  - `saveProgress(item: GuestReadingProgress): Promise<void>`
  - `getProgress(storyId: string): Promise<GuestReadingProgress | null>`
  - `recordHistory(storyId: string, chapterId: string): Promise<void>`
  - `getHistory(): Promise<Array<{ storyId: string; chapterId: string; readAt: string }>>`
  - `purgeGuestData(): Promise<void>`

- [ ] **Step 1: Viết test kiểm tra các thao tác CRUD trên IndexedDB với mock IDB**
- [ ] **Step 2: Chạy test xác nhận fail**
- [ ] **Step 3: Triển khai `indexed-db-client.ts` và `guest-library-store.ts` với namespace `guest:<installationId>`**
- [ ] **Step 4: Chạy test xác nhận pass**
- [ ] **Step 5: Git commit**

```bash
git add apps/web
git commit -m "feat(web): implement IndexedDB guest library store with isolated namespace"
```

---

### Task 2: Tích Hợp Guest Store Vào Web Reader & Thư Viện (`apps/web`)

**Files:**
- Modify: `apps/web/src/lib/reader/use-reading-progress.ts`
- Modify: `apps/web/src/components/story/bookmark-button.tsx` (hoặc hook tương đương)
- Test: `apps/web/src/test/guest-reading-progress.spec.ts`

**Interfaces:**
- Khi `isAuthenticated = false`:
  - `useReadingProgress` ghi nhận và đọc tiến độ trực tiếp từ `GuestLibraryStore` trong IndexedDB (bao gồm `anchorBlockId`, `textOffset`, `scrollPosition`).
  - Nút Bookmark lưu/xóa trực tiếp trong IndexedDB mà không báo lỗi 401 Unauthorized.
  - Trang Thư viện hiển thị danh sách truyện đã đánh dấu từ IndexedDB.

- [ ] **Step 1: Viết test cho `useReadingProgress` ở chế độ unauthenticated**
- [ ] **Step 2: Chạy test xác nhận fail**
- [ ] **Step 3: Cập nhật `useReadingProgress` và Bookmark components**
- [ ] **Step 4: Chạy test xác nhận pass**
- [ ] **Step 5: Git commit**

```bash
git add apps/web
git commit -m "feat(web): wire guest IndexedDB store into novel and manga readers"
```

---

### Task 3: Mobile Client SQLite `owner_scope` Adapter (`apps/mobile`)

**Files:**
- Modify: `apps/mobile/lib/core/database/app_database.dart` (hoặc DAO tương ứng)
- Create: `apps/mobile/lib/features/library/data/datasources/guest_sqlite_datasource.dart`
- Test: `apps/mobile/test/features/library/guest_sqlite_datasource_test.dart`

**Interfaces:**
- Thêm trường `owner_scope TEXT NOT NULL` vào các bảng dữ liệu cục bộ.
- Tự động sinh `installationId` (UUIDv4) lưu vào SecureStorage nếu chưa tồn tại.
- Mọi câu truy vấn của `GuestSqliteDatasource` lọc cứng theo `owner_scope = 'guest:<installationId>'`.

- [ ] **Step 1: Viết unit test cho SQLite migration và truy vấn scoped**
- [ ] **Step 2: Triển khai cập nhật database schema và `guest_sqlite_datasource.dart`**
- [ ] **Step 3: Chạy `flutter test` xác nhận pass**
- [ ] **Step 4: Git commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): add owner_scope partitioning to SQLite for guest isolation"
```

---

### Task 4: Mobile Guest Mode Navigation & Reader Wiring (`apps/mobile`)

**Files:**
- Modify: `apps/mobile/lib/features/auth/presentation/login_screen.dart`
- Modify: `apps/mobile/lib/features/reader/presentation/reader_screen.dart`
- Test: `apps/mobile/test/features/auth/guest_mode_navigation_test.dart`

**Interfaces:**
- Nút "Tiếp tục với tư cách Khách" (Continue as Guest) cho phép người dùng vào thẳng màn hình Home mà không bị chặn ở Login.
- Trình đọc Novel và Manga ghi nhận tiến độ vào SQLite dưới scope `guest:<installationId>`.

- [ ] **Step 1: Viết widget test cho luồng đăng nhập có nút Continue as Guest**
- [ ] **Step 2: Cập nhật navigation và reader controller**
- [ ] **Step 3: Chạy `flutter test` xác nhận pass**
- [ ] **Step 4: Git commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): enable Continue as Guest and wire local progress tracking"
```

---

### Task 5: Kiểm Thử Xác Minh Ranh Giới Định Danh & Cô Lập (Identity Isolation Verification)

**Files:**
- Create: `apps/web/src/test/guest-identity-isolation.spec.ts`
- Create: `apps/mobile/test/features/library/guest_identity_isolation_test.dart`

**Mục tiêu kiểm thử:**
1. **Scenario 1:** Guest đọc truyện -> đóng app / tải lại trang -> tiến độ và bookmark vẫn còn nguyên từ IndexedDB / SQLite.
2. **Scenario 2:** Không có bất kỳ HTTP request nào gửi Bearer token rác hoặc tạo user DB khi Guest thực hiện các thao tác đọc truyện.
3. **Scenario 3 (P0 Invariant):** User A đăng xuất -> Active scope chuyển về Guest sạch -> không nhìn thấy bất kỳ dữ liệu cá nhân nào của User A.

- [ ] **Step 1: Viết kịch bản kiểm thử toàn diện**
- [ ] **Step 2: Chạy kiểm thử Web & Mobile**
- [ ] **Step 3: Git commit**

```bash
git add apps/web apps/mobile
git commit -m "test: verify guest identity isolation and zero-leakage invariants"
```

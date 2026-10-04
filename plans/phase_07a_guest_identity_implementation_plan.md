# Phase 7A: Guest Local Runtime Engine Implementation Plan (Amended)

> **Trạng thái:** AMENDED & APPROVED FOR EXECUTION  
> **Kiến trúc cơ sở:** Phase 7.0 Design Gate PASS ([identity_and_ownership_model.md](product/identity_and_ownership_model.md), [guest_to_account_claim_protocol.md](product/guest_to_account_claim_protocol.md), [unified_sync_protocol.md](product/unified_sync_protocol.md), [web_mobile_capability_matrix.md](product/web_mobile_capability_matrix.md)).  
> **Mục tiêu Phase 7A:** Thiết lập môi trường thực thi cục bộ (Local-First Runtime) cho Khách vãng lai (Guest) trên Web và Mobile. Cho phép đọc truyện, lưu tiến độ, lịch sử và đánh dấu trang hoàn toàn ngoại tuyến, không cần tài khoản, độc lập với JWT và tuyệt đối không tạo dữ liệu rác trong CSDL PostgreSQL.  
> **Giới hạn phạm vi (Boundary):** Phase 7A chỉ triển khai Local Engine & ActiveScope. Tuyệt đối **CHƯA triển khai Cloud Claim / Migration Endpoint** (thuộc Phase 7B) và **CHƯA triển khai Cloud Sync** (thuộc Phase 7C).

---

## 1. Các Quyết Định Kiến Trúc Đã Khóa (Architectural Invariants & Amendments)

Sau khi đối chiếu trực tiếp với codebase hiện hữu (`apps/mobile/lib/core/storage/offline_database.dart`, `apps/mobile/lib/features/library/repositories/library_repository.dart`, `apps/web/src/lib/reader/use-reading-progress.ts`), Phase 7A khóa 11 nguyên tắc thực thi sau:

1. **Phân định trách nhiệm Storage trên Mobile (SQLite v3 Expansion):**
   - Không tạo physical DB mới (`omninovel_client.db`). Mở rộng database SQLite hiện hữu `omninovel_offline.db` từ **v2 lên v3**.
   - Bổ sung 3 bảng riêng biệt cho Local Library: `local_library_bookmarks`, `local_reading_progress`, `local_reading_history`.
   - Giữ nguyên vẹn 100% schema và logic của các bảng Offline Artifact v2 (`offline_chapters`, `download_tasks`, `offline_deletion_tombstones`).
2. **Bảo toàn `user_id` hiện tại của Offline Engine (Tránh Regression Phase 5D):**
   - Tuyệt đối **không rename** cột `user_id` trong schema offline v2.
   - Các bảng mới của Local Library sử dụng cột `owner_scope TEXT NOT NULL` với format chuẩn: `guest:<installationId>` hoặc `account:<userId>`.
   - Định nghĩa abstraction `LocalOwnerScope` tại application layer để điều phối, bảo vệ toàn bộ test suites và invariants của Phase 5D.
3. **Canonical Resume State đầy đủ cho Guest (`GuestReadingProgress`):**
   - Khóa chặt mọi trường resume state ngay từ 7A để hỗ trợ Webtoon, Manga Paged và Light Novel mà không phải migrate lại ở 7C:
     - `storyId: string`
     - `chapterId: string`
     - `chapterVersionId: string | null`
     - `readingMode: 'WEBTOON' | 'MANGA_PAGED' | 'NOVEL' | string`
     - `progressPercentage: number` (0.0 đến 100.0)
     - `scrollPosition: number` (double px)
     - `pageIndex: number` (1-based integer cho Manga/PDF/EPUB)
     - `anchorBlockId: string | null` (DOM block ID cho Novel)
     - `textOffset: number | null` (character offset cho Novel)
     - `updatedAt: string` (ISO 8601 string)
     - `deviceTimestamp: number` (Unix epoch milliseconds)
4. **Tách Web Repository Abstraction trước khi wiring Reader:**
   - Hook `use-reading-progress.ts` hiện đang ôm cả `localStorage`, `saveReadingProgressApi` và gamification.
   - Xây dựng abstraction `ReadingStateRepository` với hai implementations:
     - `GuestReadingStateRepository`: Giao tiếp độc quyền với IndexedDB (`omninovel_local_v2`), hoàn toàn không gọi network, không kích hoạt gamification.
     - `AccountReadingStateRepository`: Đọc/ghi cache cục bộ + đồng bộ server API + bảo vệ thưởng gamification khi thỏa điều kiện đọc thực.
   - Hook `useReadingProgress` và components phụ thuộc vào `ReadingStateRepository` thông qua `ActiveScopeCoordinator`.
5. **Non-Authoritative Local Presentation Cache:**
   - Khi lưu Bookmark hoặc History trong IndexedDB / SQLite, client được phép cache thêm: `title`, `slug`, `coverUrl`, `chapterTitle`, `chapterNumber`.
   - Đây là **presentation cache không có thẩm quyền (non-authoritative)**, chỉ dùng để render UI Library/History khi offline hoặc ở chế độ Guest.
   - **Quy tắc bắt buộc:** Khi gửi dữ liệu lên server trong Phase 7B Claim Protocol, client phải **strip bỏ toàn bộ các trường presentation này**, chỉ gửi canonical IDs (`storyId`, `chapterId`, `chapterVersionId`).
6. **Lịch sử đọc theo ngữ nghĩa Snapshot (Snapshot Semantics):**
   - Composite Primary Key: `(ownerScope, storyId, chapterId)`.
   - Mỗi chapter chỉ có một row duy nhất trong lịch sử đọc. Khi đọc lại, thực hiện `UPDATE lastReadAt, progressPercentage`, không append vô hạn các dòng log sự kiện.
7. **Hành vi Cancel Claim — Bảo toàn dữ liệu Guest:**
   - Khi người dùng bấm Hủy Claim (Cancel/Skip) lúc đăng nhập/đăng ký: **TUYỆT ĐỐI KHÔNG MUTATE GUEST DATA**.
   - Dữ liệu guest được giữ nguyên vẹn trong partition `guest:<installationId>`. Chỉ khi Claim Commit thành công (HTTP 200) mới được phép purge hoặc rebind sang account.
8. **Đăng xuất tạo Fresh Guest & Chính sách Quarantine:**
   - Khi người dùng đăng xuất: Tạo ngay một **Fresh Guest Scope** (`guest:<newInstallationId>`) mới tinh với thư viện rỗng, đảm bảo không rò rỉ bất kỳ dữ liệu nào của tài khoản vừa thoát.
   - Đối với guest scope cũ trước khi login: Nếu đã claim thành công -> đã purge/rebind; nếu chưa claim (do cancel/abort) -> lưu ở trạng thái **Quarantine / Retained Storage** kèm timestamp, không silently destroy.
9. **Prerequisite: ActiveScopeCoordinator trước khi kiểm thử Task 5:**
   - Toàn bộ kịch bản kiểm thử chuyển đổi định danh (User A logout -> Guest sạch) phải chạy trên Coordinator thật, không dùng mock runtime lỏng lẻo.
10. **IndexedDB Versioning & Transactional Boundary ngay từ đầu:**
    - `DB_NAME = 'omninovel_local_v2'`, `DB_VERSION = 1`.
    - Định nghĩa upgrade callback, composite keys, transaction `readwrite` nguyên tử khi đồng thời lưu progress và history.
    - Xử lý triệt để: `QuotaExceededError`, graceful fallback khi IndexedDB bị tắt (Private Browsing), và SSR guards (`typeof window === 'undefined'`) cho Next.js 16 App Router.
11. **Single Source of Truth (SSoT) cho `installationId`:**
    - Web: `InstallationIdentityProvider` quản lý duy nhất tại `localStorage.getItem('omninovel_installation_id')`.
    - Mobile: `InstallationIdentityProvider` quản lý qua `FlutterSecureStorage` (fallback `SharedPreferences`).
    - Tất cả các module inject qua Provider này, tuyệt đối không tự sinh UUID phân tán rải rác trong code.

---

## 2. Kế Hoạch Triển Khai Chi Tiết (7A.1 ➔ 7A.7)

```text
7A.1  Local Identity & ActiveScope Coordinator
7A.2  Canonical Local Library Schema + Migration
7A.3  Web Repository Layer + IndexedDB Implementation
7A.4  Web Reader / Bookmark / History Integration
7A.5  Mobile Local Library Schema + Repository
7A.6  Mobile Guest Navigation + Reader Integration
7A.7  Identity Isolation / Persistence / Crash / No-Network Acceptance
```

---

### Task 7A.1: Local Identity & ActiveScope Coordinator (Web & Mobile)

**Mục tiêu:** Xây dựng SSoT định danh thiết bị (`installationId`) và bộ điều phối phạm vi người dùng (`ActiveScopeCoordinator`), cung cấp scope phân định ranh giới cho toàn bộ hệ thống lưu trữ cục bộ.

**Files:**
- Web:
  - Create: `apps/web/src/lib/identity/installation-identity-provider.ts`
  - Create: `apps/web/src/lib/identity/active-scope-coordinator.ts`
  - Test: `apps/web/src/test/active-scope-coordinator.spec.ts`
- Mobile:
  - Create: `apps/mobile/lib/core/identity/installation_identity_provider.dart`
  - Create: `apps/mobile/lib/core/identity/active_scope_coordinator.dart`
  - Test: `apps/mobile/test/core/identity/active_scope_coordinator_test.dart`

**Contract & Invariants:**
- `InstallationIdentityProvider`:
  - `getOrCreateInstallationId(): Promise<string> / Future<String>`: Đọc UUIDv4 từ storage hoặc sinh mới và lưu vĩnh viễn trên thiết bị.
  - `resetInstallationId(): Promise<string> / Future<String>`: Sinh ID mới cho luồng fresh guest sau logout.
- `ActiveScopeCoordinator`:
  - `activeScope`: Trả về `guest:<installationId>` khi unauthenticated hoặc `account:<userId>` khi authenticated.
  - State transitions:
    - `initialize()`: Nhận diện trạng thái auth hiện tại.
    - `onLogin(userId: string)`: Chuyển active scope sang `account:<userId>`.
    - `onLogout()`: Khởi tạo fresh guest scope `guest:<freshInstallationId>`, chuyển active scope về fresh guest.
    - `onCancelClaim()`: Giữ nguyên guest scope cũ vào quarantine, kích hoạt account session.

- [ ] **Step 1: Viết unit tests cho `InstallationIdentityProvider` và `ActiveScopeCoordinator` (Web & Mobile)**
- [ ] **Step 2: Triển khai Identity Provider và Coordinator trên Web (`apps/web`)**
- [ ] **Step 3: Triển khai Identity Provider và Coordinator trên Mobile (`apps/mobile`)**
- [ ] **Step 4: Chạy test xác nhận pass 100%**
- [ ] **Step 5: Git commit**

```bash
git add apps/web apps/mobile
git commit -m "feat(identity): implement InstallationIdentityProvider and ActiveScopeCoordinator for web and mobile"
```

---

### Task 7A.2: Canonical Local Library Schema & Migration Definitions

**Mục tiêu:** Định nghĩa hợp đồng kiểu dữ liệu Canonical Local Library DTOs và migration script cho IndexedDB v1 trên Web và SQLite v3 trên Mobile.

**Files:**
- Shared:
  - Modify: `packages/shared/src/types/local-library.ts` (hoặc `packages/shared/src/index.ts`)
- Web:
  - Create: `apps/web/src/lib/storage/indexed-db-schema.ts`
- Mobile:
  - Modify: `apps/mobile/lib/core/storage/offline_database.dart`
  - Test: `apps/mobile/test/core/storage/offline_database_v3_migration_test.dart`

**Schema Specifications:**
- **Shared Canonical Types:**
  - `LocalBookmark`: `{ ownerScope: string; storyId: string; title: string; slug?: string; coverUrl?: string; createdAt: string; }`
  - `LocalReadingProgress`: `{ ownerScope: string; storyId: string; chapterId: string; chapterVersionId?: string | null; readingMode: string; progressPercentage: number; scrollPosition: number; pageIndex: number; anchorBlockId?: string | null; textOffset?: number | null; updatedAt: string; deviceTimestamp: number; }`
  - `LocalReadingHistory`: `{ ownerScope: string; storyId: string; chapterId: string; chapterVersionId?: string | null; storyTitle: string; storySlug?: string; storyCoverUrl?: string; chapterNumber: string | number; chapterTitle?: string; progressPercentage: number; lastReadAt: string; }`
- **Mobile SQLite v3 Schema (`OfflineDatabase`):**
  - Nâng `databaseVersion = 3`.
  - Giữ nguyên `_createV2Tables` cho v2. Thêm `_upgradeToV3(Database db)`:
    ```sql
    CREATE TABLE local_library_bookmarks (
      owner_scope TEXT NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      slug TEXT,
      cover_url TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (owner_scope, story_id)
    );

    CREATE TABLE local_reading_progress (
      owner_scope TEXT NOT NULL,
      story_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      chapter_version_id TEXT,
      reading_mode TEXT NOT NULL,
      progress_percentage REAL NOT NULL,
      scroll_position REAL NOT NULL,
      page_index INTEGER NOT NULL DEFAULT 1,
      anchor_block_id TEXT,
      text_offset INTEGER,
      updated_at INTEGER NOT NULL,
      device_timestamp INTEGER NOT NULL,
      PRIMARY KEY (owner_scope, story_id)
    );

    CREATE TABLE local_reading_history (
      owner_scope TEXT NOT NULL,
      story_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      chapter_version_id TEXT,
      story_title TEXT NOT NULL,
      story_slug TEXT,
      story_cover_url TEXT,
      chapter_number TEXT NOT NULL,
      chapter_title TEXT,
      progress_percentage REAL NOT NULL,
      last_read_at INTEGER NOT NULL,
      PRIMARY KEY (owner_scope, story_id, chapter_id)
    );

    CREATE INDEX idx_local_bookmarks_owner ON local_library_bookmarks(owner_scope);
    CREATE INDEX idx_local_progress_owner ON local_reading_progress(owner_scope);
    CREATE INDEX idx_local_history_owner_time ON local_reading_history(owner_scope, last_read_at DESC);
    ```

- [ ] **Step 1: Khai báo Canonical Local Types trong `packages/shared`**
- [ ] **Step 2: Viết migration test v2 ➔ v3 cho `OfflineDatabase` kiểm tra bảo toàn dữ liệu v2**
- [ ] **Step 3: Cập nhật `OfflineDatabase` lên v3 với 3 bảng local library mới**
- [ ] **Step 4: Chạy test xác nhận migration pass và không chạm vào tables v2**
- [ ] **Step 5: Git commit**

```bash
git add packages/shared apps/mobile
git commit -m "feat(storage): define canonical local library schema and bump OfflineDatabase to v3"
```

---

### Task 7A.3: Web Repository Layer & IndexedDB Implementation (`apps/web`)

**Mục tiêu:** Xây dựng tầng IndexedDB client chuẩn công nghiệp (versioning, transactions, quota handling, SSR guards) và triển khai `ReadingStateRepository`, `BookmarkRepository`, `ReadingHistoryRepository` cho Guest Mode.

**Files:**
- Create: `apps/web/src/lib/storage/indexed-db-client.ts`
- Create: `apps/web/src/lib/storage/guest-reading-state-repository.ts`
- Create: `apps/web/src/lib/storage/guest-library-repository.ts`
- Test: `apps/web/src/test/guest-indexed-db.spec.ts`

**Specifications:**
- `IndexedDbClient`:
  - Quản lý database `omninovel_local_v2` (version 1).
  - Object stores:
    - `bookmarks` với keyPath `['ownerScope', 'storyId']`
    - `progress` với keyPath `['ownerScope', 'storyId']`
    - `history` với keyPath `['ownerScope', 'storyId', 'chapterId']` và index `by_owner_time` trên `['ownerScope', 'lastReadAt']`
  - Atomic transaction: `recordReadingSession(progress: LocalReadingProgress, history: LocalReadingHistory)` thực hiện ghi đồng thời cả 2 store trong 1 `readwrite` transaction.
  - Quota error handling: Bắt `QuotaExceededError` và thông báo hoặc xử lý eviction mềm.
  - Private Browsing fallback: Graceful in-memory fallback nếu IndexedDB bị chặn.
- `GuestReadingStateRepository`:
  - `getProgress(storyId: string): Promise<LocalReadingProgress | null>`
  - `saveProgress(progress: LocalReadingProgress): Promise<void>`
  - `getReadChapterIds(storyId: string): Promise<string[]>`
- `GuestLibraryRepository`:
  - `getBookmarks(): Promise<LocalBookmark[]>`
  - `addBookmark(bookmark: LocalBookmark): Promise<void>`
  - `removeBookmark(storyId: string): Promise<void>`
  - `getHistory(): Promise<LocalReadingHistory[]>`
  - `deleteStoryHistory(storyId: string): Promise<void>`
  - `clearAllHistory(): Promise<void>`

- [ ] **Step 1: Viết comprehensive unit test cho IndexedDbClient và Guest Repositories (fake-indexeddb)**
- [ ] **Step 2: Triển khai `indexed-db-client.ts` với đầy đủ transaction boundary và SSR guards**
- [ ] **Step 3: Triển khai `guest-reading-state-repository.ts` và `guest-library-repository.ts`**
- [ ] **Step 4: Chạy test xác nhận pass 100%**
- [ ] **Step 5: Git commit**

```bash
git add apps/web
git commit -m "feat(web): implement IndexedDB client and guest library repositories"
```

---

### Task 7A.4: Web Reader, Bookmark & History Integration (`apps/web`)

**Mục tiêu:** Refactor `use-reading-progress.ts` và các UI components để sử dụng Repository abstraction, kích hoạt Guest reading mượt mà, lưu local presentation cache, và không gọi server endpoints khi chưa đăng nhập.

**Files:**
- Modify: `apps/web/src/lib/reader/use-reading-progress.ts`
- Create: `apps/web/src/lib/storage/account-reading-state-repository.ts`
- Create: `apps/web/src/lib/storage/reading-repository-factory.ts`
- Modify: `apps/web/src/components/story/bookmark-button.tsx` (hoặc component tương đương)
- Modify: `apps/web/src/app/(public)/library/page.tsx` (hoặc library view component)
- Test: `apps/web/src/test/guest-reader-integration.spec.ts`

**Key Invariants:**
- `useReadingProgress` lấy repository qua Factory dựa trên `ActiveScopeCoordinator`:
  - Nếu `scope.isGuest`: Sử dụng `GuestReadingStateRepository`. Hoàn toàn không gọi `getReadingProgressApi`, `saveReadingProgressApi`, hay `rewardReadChapterApi`.
  - Nếu `scope.isAccount`: Sử dụng `AccountReadingStateRepository`.
- Khi đọc truyện: `updateProgress` tự động gọi atomic transaction lưu cả `LocalReadingProgress` và `LocalReadingHistory` vào IndexedDB với display metadata (`storyTitle`, `chapterNumber`, `chapterTitle`).
- Bookmark button: Khi click ở chế độ Guest, thêm/gỡ bookmark trong IndexedDB ngay lập tức, không redirect sang Login, không báo lỗi 401.
- Library Page: Khi Guest mở tab Bookmarks / History, query trực tiếp từ IndexedDB và render danh sách truyện kèm title, coverUrl từ presentation cache.

- [ ] **Step 1: Viết test cho `useReadingProgress` ở chế độ Guest và Account**
- [ ] **Step 2: Refactor `use-reading-progress.ts` sử dụng `ReadingStateRepository`**
- [ ] **Step 3: Tích hợp Bookmark button và Library page với Guest Store**
- [ ] **Step 4: Chạy test xác nhận pass**
- [ ] **Step 5: Git commit**

```bash
git add apps/web
git commit -m "refactor(web): integrate guest repositories into reader and library UI"
```

---

### Task 7A.5: Mobile Local Library Schema & Repository (`apps/mobile`)

**Mục tiêu:** Xây dựng DAO và Repository trên SQLite v3 (`omninovel_offline.db`) cho Local Library trên Mobile, đảm bảo phân định rõ ràng giữa Offline Artifacts và Local Library.

**Files:**
- Create: `apps/mobile/lib/features/library/data/datasources/local_library_dao.dart`
- Create: `apps/mobile/lib/features/library/repositories/guest_library_repository.dart`
- Create: `apps/mobile/lib/features/reader/repositories/guest_reading_progress_repository.dart`
- Test: `apps/mobile/test/features/library/local_library_dao_test.dart`
- Test: `apps/mobile/test/features/library/guest_library_repository_test.dart`

**Specifications:**
- `LocalLibraryDao`:
  - Đọc/ghi các bảng `local_library_bookmarks`, `local_reading_progress`, `local_reading_history`.
  - Mọi query đều nhận `ownerScope` làm điều kiện lọc bắt buộc (`WHERE owner_scope = ?`).
  - Hỗ trợ transaction `recordReadingSession(progress, history)` nguyên tử.
- `GuestLibraryRepository` & `GuestReadingProgressRepository`:
  - Triển khai interface tương thích với `LibraryRepository` và `ReadingProgressRepository` hiện hữu nhưng trỏ thẳng vào `LocalLibraryDao`.
  - Không gọi `ApiClient`, không chạm vào SharedPreferences legacy `anon`.

- [ ] **Step 1: Viết unit tests cho `LocalLibraryDao` với in-memory SQLite (sqflite_common_ffi)**
- [ ] **Step 2: Triển khai `LocalLibraryDao`**
- [ ] **Step 3: Triển khai `GuestLibraryRepository` và `GuestReadingProgressRepository`**
- [ ] **Step 4: Chạy `flutter test` xác nhận pass**
- [ ] **Step 5: Git commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): implement LocalLibraryDao and guest repositories on SQLite v3"
```

---

### Task 7A.6: Mobile Guest Navigation & Reader Integration (`apps/mobile`)

**Mục tiêu:** Thêm nút "Tiếp tục với tư cách Khách" (Continue as Guest) trên màn hình Login, mở khóa GoRouter cho Guest, và nối trình đọc Mobile vào `GuestReadingProgressRepository`.

**Files:**
- Modify: `apps/mobile/lib/features/auth/presentation/login_screen.dart`
- Modify: `apps/mobile/lib/app/router/app_router.dart`
- Modify: `apps/mobile/lib/features/reader/presentation/reader_screen.dart` (hoặc controller tương ứng)
- Test: `apps/mobile/test/features/auth/guest_navigation_test.dart`

**Specifications:**
- `login_screen.dart`: Bổ sung nút TextButton/OutlinedButton "Tiếp tục với tư cách Khách" (Continue as Guest).
- `app_router.dart`:
  - Cho phép truy cập `/home`, `/story/:id`, `/reader/:id`, `/library` khi `activeScope.isGuest`.
  - Chỉ chuyển hướng sang `/login` khi truy cập các tính năng bắt buộc tài khoản (như Wallet, Profile, Studio, Top-up).
- Reader Screen:
  - Khi `activeScope.isGuest`, nạp tiến độ từ `GuestReadingProgressRepository` và ghi nhận checkpoint cục bộ vào SQLite v3.
  - Vị trí đọc (`scrollPosition`, `pageIndex`, `anchorBlockId`, `textOffset`) được bảo toàn 100%.

- [ ] **Step 1: Viết widget test cho `login_screen` và router redirection ở chế độ Guest**
- [ ] **Step 2: Cập nhật `login_screen.dart` và `app_router.dart`**
- [ ] **Step 3: Cập nhật reader wiring cho Guest**
- [ ] **Step 4: Chạy `flutter test` xác nhận pass**
- [ ] **Step 5: Git commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): enable Continue as Guest navigation and wire reader to SQLite"
```

---

### Task 7A.7: Identity Isolation, Persistence, Crash & Acceptance Testing

**Mục tiêu:** Nghiệm thu toàn diện các bất biến định danh (P0 Invariants) trên Web và Mobile, đảm bảo 0% ô nhiễm dữ liệu, không rò rỉ network request, và phục hồi an toàn sau crash.

**Files:**
- Create: `apps/web/src/test/guest-identity-isolation.spec.ts`
- Create: `apps/mobile/test/features/library/guest_identity_isolation_test.dart`

**Bộ Tiêu Chí Nghiệm Thu (Acceptance Criteria):**
1. **Scenario 1 (Persistence & Offline Availability):**
   - Guest đọc truyện, bookmark truyện -> Tắt tab / Đóng app / Ngắt mạng hoàn toàn -> Mở lại app: Tiến độ, trang đọc, bookmark vẫn hiển thị đầy đủ và chính xác từ IndexedDB / SQLite.
2. **Scenario 2 (Zero Server Pollution & Zero Bearer Leakage):**
   - Giám sát toàn bộ network calls khi Guest đọc truyện và bookmark:
     - 0 requests gửi lên `/library/*` hoặc `/reading-progress`.
     - 0 Bearer tokens rác được đính kèm.
     - 0 bản ghi User hay Progress nặc danh sinh ra trong PostgreSQL.
3. **Scenario 3 (P0 Cross-Contamination Prevention):**
   - User A đăng nhập, có bookmark truyện X.
   - User A đăng xuất -> Hệ thống kích hoạt `onLogout()`:
     - Active scope chuyển thành `guest:<freshInstallationId>`.
     - Thư viện hiển thị rỗng hoàn toàn, không có truyện X.
   - Guest mới đọc truyện Y.
   - User B đăng nhập trên cùng máy -> User B chỉ thấy dữ liệu của B, không thấy truyện X của A và không thấy truyện Y của Guest (được cách ly trong quarantine).
4. **Scenario 4 (Cancel Claim Safety):**
   - Guest có 3 bookmarks -> Bấm đăng nhập -> Hộp thoại claim xuất hiện -> Người dùng bấm "Hủy / Để sau":
     - Dữ liệu 3 bookmarks của Guest không bị xóa (KHÔNG mutate).
     - Đưa vào storage quarantine an toàn.

- [ ] **Step 1: Viết test suites tích hợp bao phủ cả 4 kịch bản nghiệm thu trên Web**
- [ ] **Step 2: Viết test suites tích hợp bao phủ cả 4 kịch bản nghiệm thu trên Mobile**
- [ ] **Step 3: Chạy toàn bộ test suites và ghi nhận kết quả**
- [ ] **Step 4: Cập nhật ROADMAP.md và phase status**
- [ ] **Step 5: Git commit & push**

```bash
git add apps/web apps/mobile plans
git commit -m "test: comprehensive acceptance tests for guest identity isolation and storage resilience"
git push origin main
```

---

## 3. Rủi Ro Kỹ Thuật & Giải Pháp Phòng Ngừa (Risk Mitigation)

| Rủi Ro | Mức Độ | Giải Pháp Phòng Ngừa Trong Thiết Kế |
|---|---|---|
| **Regression Phase 5D Offline Engine** | P0 | Giữ nguyên schema v2 (`user_id`). Chỉ thêm bảng mới `local_*` với `owner_scope` trong migration v3. Không đụng đến DAO offline cũ. |
| **IndexedDB Quota / Private Browsing Error** | P1 | Bắt exception tại tầng `IndexedDbClient`, có graceful in-memory store fallback để tránh crash UI trình duyệt. |
| **Sai lệch vị trí đọc khi chuyển sang Phase 7C** | P1 | Đồng bộ canonical fields ngay từ Task 7A.2 (`anchorBlockId`, `textOffset`, `pageIndex`, `scrollPosition`). |
| **Ô nhiễm chéo dữ liệu khi logout** | P0 | Khóa cứng state machine: `onLogout()` bắt buộc cấp phát `freshInstallationId`, ngắt kết nối scope cũ. |

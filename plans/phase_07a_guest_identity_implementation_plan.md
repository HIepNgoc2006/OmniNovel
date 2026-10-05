# Phase 7A: Guest Local Runtime Engine Implementation Plan (Final Amended)

> **Trạng thái:** AMENDED & APPROVED FOR EXECUTION (Design Stopped & Frozen)  
> **Kiến trúc cơ sở:** Phase 7.0 Design Gate PASS ([identity_and_ownership_model.md](product/identity_and_ownership_model.md), [guest_to_account_claim_protocol.md](product/guest_to_account_claim_protocol.md), [unified_sync_protocol.md](product/unified_sync_protocol.md), [web_mobile_capability_matrix.md](product/web_mobile_capability_matrix.md)).  
> **Mục tiêu Phase 7A:** Thiết lập môi trường thực thi cục bộ (Local-First Runtime) cho Khách vãng lai (Guest) trên Web và Mobile. Cho phép đọc truyện, lưu tiến độ, lịch sử và đánh dấu trang hoàn toàn ngoại tuyến, không cần tài khoản, độc lập với JWT và tuyệt đối không tạo dữ liệu rác trong CSDL PostgreSQL.  
> **Giới hạn phạm vi (Boundary):** Phase 7A chỉ triển khai Local Engine & ActiveScope. Tuyệt đối **CHƯA triển khai Cloud Claim / Migration Endpoint** (thuộc Phase 7B) và **CHƯA triển khai Cloud Sync** (thuộc Phase 7C).

---

## 1. Các Quyết Định Kiến Trúc & Bất Biến Đã Khóa (Architectural Invariants)

Sau khi đối chiếu với codebase thực tế (`apps/mobile/lib/core/storage/offline_database.dart`, `apps/mobile/lib/features/library/repositories/library_repository.dart`, `apps/web/src/lib/reader/use-reading-progress.ts`, `apps/web/src/lib/auth/auth-context.tsx`), Phase 7A khóa 12 nguyên tắc thực thi sau:

1. **Tách biệt Stable `installationId` và Rotatable `guestProfileId` (P0.1 Resolution):**
   - `installationId`: Bền vững (stable), đại diện cho thiết bị / browser profile vật lý. Tồn tại đến khi uninstall hoặc clear site data. **Tuyệt đối KHÔNG reset khi logout**. Gắn với `device:<installationId>` (preferences, sync identity).
   - `guestProfileId`: Có thể luân chuyển (rotatable), đại diện cho một phiên hồ sơ khách cụ thể. Khi người dùng đăng xuất, gọi `rotateGuestProfileId()` để sinh fresh guest profile mới tinh.
   - Ba scopes chuẩn tắc:
     - `device:<installationId>`: Stable device settings.
     - `guest:<guestProfileId>`: Rotatable guest library.
     - `account:<userId>`: Authenticated user library.
2. **Khắc phục Auth Bootstrap Race — State Machine 4 Trạng Thái (P0.2 Resolution):**
   - `ActiveScopeCoordinator` quản lý 4 trạng thái: `BOOTSTRAPPING`, `GUEST`, `ACCOUNT`, `TRANSITIONING`.
   - Coordinator tiêu thụ trực tiếp `AuthStatus` (`initializing` | `authenticated` | `anonymous`), **TUYỆT ĐỐI KHÔNG tiêu thụ riêng boolean `isAuthenticated`**.
   - **P0 Invariant:** Trong trạng thái `BOOTSTRAPPING` (khi Web đang `/auth/refresh` hoặc Mobile đang đọc SecureStorage), **TUYỆT ĐỐI CẤM ghi persistent user-state** (chặn/hoãn write bookmark, progress, history). Reader có thể render public content nhưng write operations phải đợi active scope giải quyết xong.
3. **Phân định trách nhiệm Storage trên Mobile (SQLite v3 Expansion):**
   - Không tạo thêm physical DB mới (`omninovel_client.db`). Mở rộng database SQLite hiện hữu `omninovel_offline.db` từ **v2 lên v3**.
   - Bổ sung 3 bảng riêng biệt cho Local Library: `local_library_bookmarks`, `local_reading_progress`, `local_reading_history`.
   - Giữ nguyên vẹn 100% schema và logic của các bảng Offline Artifacts v2 (`offline_chapters`, `download_tasks`, `offline_deletion_tombstones`).
4. **Bảo toàn `user_id` hiện tại của Offline Engine (Tránh Regression Phase 5D):**
   - Tuyệt đối **không rename** cột `user_id` trong schema offline v2.
   - Các bảng mới của Local Library sử dụng cột `owner_scope TEXT NOT NULL` với format chuẩn: `guest:<guestProfileId>` hoặc `account:<userId>`.
   - Định nghĩa abstraction `LocalOwnerScope` tại application layer để điều phối, bảo vệ toàn bộ test suites và invariants của Phase 5D.
5. **Canonical Resume State đầy đủ cho Guest (`LocalReadingProgress`):**
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
     - `deviceTimestamp: number` (Unix epoch milliseconds — **diagnostic & local ordering only, tuyệt đối không dùng làm conflict authority**).
6. **Local Storage Contracts vs Network DTOs (P1.3 Resolution):**
   - Các interface định nghĩa trong `@omninovel/shared/src/types/local-library.ts` là **Local Storage Contracts / Client-side Cache Interfaces**, tuyệt đối không phải Network DTOs.
   - Bất biến: API endpoints không bao giờ nhận hoặc trả về các trường `ownerScope`, `title`, hay `coverUrl` từ client.
7. **Tách Web Repository Abstraction trước khi wiring Reader:**
   - Xây dựng abstraction `ReadingStateRepository` với hai implementations:
     - `GuestReadingStateRepository`: Giao tiếp độc quyền với IndexedDB (`omninovel_local_v2`), partition `guest:<guestProfileId>`, hoàn toàn không gọi network, không kích hoạt gamification.
     - `AccountReadingStateRepository`: Đọc/ghi cache cục bộ + đồng bộ server API + bảo vệ thưởng gamification khi thỏa điều kiện đọc thực.
   - Hook `useReadingProgress` và components phụ thuộc vào `ReadingStateRepository` thông qua `ActiveScopeCoordinator`.
8. **Non-Authoritative Local Presentation Cache:**
   - Local DB (IndexedDB / SQLite) được phép cache thêm: `title`, `slug`, `coverUrl`, `chapterTitle`, `chapterNumber` để hiển thị Thư viện và Lịch sử khi offline/guest.
   - **Quy tắc bắt buộc:** Khi gửi dữ liệu lên server trong Phase 7B Claim Protocol, client phải **strip bỏ toàn bộ các trường presentation này**, chỉ gửi canonical IDs (`storyId`, `chapterId`, `chapterVersionId`).
9. **Lịch sử đọc theo ngữ nghĩa Snapshot (Snapshot Semantics):**
   - Composite Primary Key: `(ownerScope, storyId, chapterId)`.
   - Mỗi chapter chỉ có một row duy nhất trong lịch sử đọc. Khi đọc lại, thực hiện `UPDATE lastReadAt, progressPercentage`, không append vô hạn các dòng log sự kiện.
10. **Hạ Tầng Cách Ly Guest Scope (Quarantine Primitive - P1.2 Resolution):**
    - Phase 7A.1 cung cấp primitive `quarantineGuestScope(guestProfileId)` và `listQuarantinedGuestScopes()`.
    - Khi người dùng đăng nhập tài khoản khác và hủy claim, guest scope cũ được chuyển vào storage quarantine an toàn, **tuyệt đối không bị xóa âm thầm**.
    - Toàn bộ orchestration logic của "Cancel Claim UI flow" do Phase 7B đảm nhiệm.
11. **Đăng xuất tạo Fresh Guest & Giữ Nguyên Device Identity:**
    - Khi người dùng đăng xuất: Giữ nguyên `installationId`, xoay `guestProfileId` mới tinh, chuyển active scope sang `guest:<newGuestProfileId>` (thư viện rỗng), ngăn chặn 0% rò rỉ dữ liệu tài khoản cũ.
12. **IndexedDB Versioning & Transactional Boundary ngay từ đầu:**
    - `DB_NAME = 'omninovel_local_v2'`, `DB_VERSION = 1`.
    - Định nghĩa upgrade callback, composite keys, transaction `readwrite` nguyên tử khi đồng thời lưu progress và history.
    - Xử lý triệt để: `QuotaExceededError`, graceful fallback khi IndexedDB bị tắt (Private Browsing), và SSR guards (`typeof window === 'undefined'`) cho Next.js 16 App Router.

---

## 2. Kế Hoạch Triển Khai 7 Sub-Tasks (7A.1 ➔ 7A.7)

```text
7A.1  Local Identity & ActiveScope Coordinator (Web & Mobile SSoT)
7A.2  Canonical Local Library Schema + Migration (IndexedDB v1, SQLite v3)
7A.3  Web Repository Layer + IndexedDB Implementation (omninovel_local_v2)
7A.4  Web Reader / Bookmark / History Integration (Repository Abstraction)
7A.5  Mobile Local Library Schema + Repository (SQLite v3 owner_scope)
7A.6  Mobile Guest Navigation + Reader Integration ("Continue as Guest")
7A.7  Identity Isolation / Persistence / Crash / Acceptance Verification
```

---

### Task 7A.1: Local Identity & ActiveScope Coordinator (Web & Mobile)

**Mục tiêu:** Xây dựng SSoT định danh thiết bị (`installationId`), định danh hồ sơ khách (`guestProfileId`), và bộ điều phối phạm vi người dùng (`ActiveScopeCoordinator`) với state machine 4 trạng thái chống auth bootstrap race.

**Files:**
- Web:
  - Create: `apps/web/src/lib/identity/installation-identity-provider.ts`
  - Create: `apps/web/src/lib/identity/guest-profile-identity-provider.ts`
  - Create: `apps/web/src/lib/identity/active-scope-coordinator.ts`
  - Test: `apps/web/src/test/active-scope-coordinator.spec.ts`
- Mobile:
  - Create: `apps/mobile/lib/core/identity/installation_identity_provider.dart`
  - Create: `apps/mobile/lib/core/identity/guest_profile_identity_provider.dart`
  - Create: `apps/mobile/lib/core/identity/active_scope_coordinator.dart`
  - Test: `apps/mobile/test/core/identity/active_scope_coordinator_test.dart`

**Contract & Specifications:**
- `InstallationIdentityProvider`:
  - `getOrCreateInstallationId(): Promise<string> / Future<String>`: Đọc UUIDv4 từ storage hoặc sinh mới và lưu vĩnh viễn trên thiết bị (`localStorage['omninovel_installation_id']` hoặc `FlutterSecureStorage`). **Không có hàm reset/logout**.
- `GuestProfileIdentityProvider`:
  - `getOrCreateGuestProfileId(): Promise<string> / Future<String>`: Lấy hoặc tạo UUIDv4 cho guest profile hiện hành.
  - `rotateGuestProfileId(): Promise<string> / Future<String>`: Sinh ID mới cho fresh guest profile (dùng khi logout).
  - `quarantineGuestScope(profileId: string): Promise<void> / Future<void>`: Đánh dấu guest profile vào danh sách cách ly an toàn.
  - `listQuarantinedGuestScopes(): Promise<string[]> / Future<List<String>>`: Truy vấn các guest profiles đã cách ly.
- `ActiveScopeCoordinator`:
  - `state`: `'BOOTSTRAPPING' | 'GUEST' | 'ACCOUNT' | 'TRANSITIONING'`
  - `activeScope`: Trả về `guest:<guestProfileId>` khi GUEST, `account:<userId>` khi ACCOUNT. Trả về `null` khi BOOTSTRAPPING hoặc TRANSITIONING.
  - `canMutateUserState`: `boolean` — Chỉ trả về `true` khi `state === 'GUEST' || state === 'ACCOUNT'`. Trả về `false` khi `BOOTSTRAPPING`.
  - `waitForResolvedScope(): Promise<string> / Future<String>`: Cho phép các tác vụ ghi đợi đến khi scope hoàn tất resolve từ BOOTSTRAPPING.
  - Transitions:
    - `onAuthStatusChanged(status: AuthStatus, userId?: string)`:
      - `initializing` ➔ `BOOTSTRAPPING`
      - `anonymous` ➔ `GUEST` (gán `activeScope = guest:<guestProfileId>`)
      - `authenticated` ➔ `ACCOUNT` (gán `activeScope = account:<userId>`)
    - `onLogout()`: Chuyển sang `TRANSITIONING` ➔ gọi `rotateGuestProfileId()` ➔ chuyển sang `GUEST` với fresh profile.

- [x] **Step 1: Viết unit tests cho `InstallationIdentityProvider`, `GuestProfileIdentityProvider` và `ActiveScopeCoordinator` (Web & Mobile)**
- [x] **Step 2: Triển khai Identity Providers và Coordinator trên Web (`apps/web`)**
- [x] **Step 3: Triển khai Identity Providers và Coordinator trên Mobile (`apps/mobile`)**
- [x] **Step 4: Chạy test xác nhận pass 100% (bao gồm kịch bản bootstrap race)**
- [x] **Step 5: Git commit**

```bash
git add apps/web apps/mobile
git commit -m "feat(identity): implement InstallationIdentityProvider, GuestProfileIdentityProvider, and ActiveScopeCoordinator"
```

---

### Task 7A.2: Canonical Local Library Schema & Migration Definitions

**Mục tiêu:** Định nghĩa các Local Storage Contracts trong `@omninovel/shared` (tách bạch khỏi Network DTOs) và nâng cấp `omninovel_offline.db` từ v2 lên v3 trên Mobile.

**Files:**
- Shared:
  - Create/Modify: `packages/shared/src/types/local-library.ts`
  - Modify: `packages/shared/src/index.ts`
- Mobile:
  - Modify: `apps/mobile/lib/core/storage/offline_database.dart`
  - Test: `apps/mobile/test/core/storage/offline_database_v3_migration_test.dart`

**Specifications:**
- **Shared Local Storage Contracts (`local-library.ts`):**
  - Ghi chú rõ ràng: `// CLIENT-SIDE LOCAL STORAGE CONTRACTS ONLY. DO NOT USE AS NETWORK DTO.`
  - `LocalBookmark`: `{ ownerScope: string; storyId: string; title: string; slug?: string; coverUrl?: string; createdAt: string; }`
  - `LocalReadingProgress`: `{ ownerScope: string; storyId: string; chapterId: string; chapterVersionId?: string | null; readingMode: string; progressPercentage: number; scrollPosition: number; pageIndex: number; anchorBlockId?: string | null; textOffset?: number | null; updatedAt: string; deviceTimestamp: number; }`
    - Ghi chú: `deviceTimestamp: number; // Diagnostic / local ordering only. Never use as conflict authority in 7B/7C.`
  - `LocalReadingHistory`: `{ ownerScope: string; storyId: string; chapterId: string; chapterVersionId?: string | null; storyTitle: string; storySlug?: string; storyCoverUrl?: string; chapterNumber: string | number; chapterTitle?: string; progressPercentage: number; lastReadAt: string; }`
- **Mobile SQLite v3 Schema (`OfflineDatabase`):**
  - Nâng `databaseVersion = 3`. Giữ nguyên 100% logic v2.
  - Bổ sung 3 bảng: `local_library_bookmarks`, `local_reading_progress`, `local_reading_history` với cột `owner_scope TEXT NOT NULL`.
  - Tạo các index `idx_local_bookmarks_owner`, `idx_local_progress_owner`, `idx_local_history_owner_time`.

- [x] **Step 1: Khai báo Local Storage Contracts trong `packages/shared`**
- [x] **Step 2: Viết migration test v2 ➔ v3 cho `OfflineDatabase` kiểm tra bảo toàn dữ liệu v2**
- [x] **Step 3: Cập nhật `OfflineDatabase` lên v3 với 3 bảng local library mới**
- [x] **Step 4: Chạy test xác nhận migration pass và không chạm vào tables v2**
- [x] **Step 5: Git commit**

```bash
git add packages/shared apps/mobile
git commit -m "feat(storage): define local storage contracts and bump OfflineDatabase to v3"
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
  - Stores: `bookmarks` `['ownerScope', 'storyId']`, `progress` `['ownerScope', 'storyId']`, `history` `['ownerScope', 'storyId', 'chapterId']`.
  - Atomic transaction: `recordReadingSession(progress, history)` ghi cả 2 store trong 1 `readwrite` transaction.
  - Bắt `QuotaExceededError`, graceful fallback cho Private Browsing, SSR guards (`typeof window === 'undefined'`).
- `GuestReadingStateRepository`:
  - `getProgress(storyId: string): Promise<LocalReadingProgress | null>`
  - `saveProgress(progress: LocalReadingProgress): Promise<void>` (chỉ ghi vào partition `guest:<guestProfileId>`, không network).
  - `getReadChapterIds(storyId: string): Promise<string[]>`
- `GuestLibraryRepository`:
  - Quản lý bookmarks và history của guest profile hiện hành.

- [x] **Step 1: Viết unit tests cho `IndexedDbClient` và Guest Repositories (fake-indexeddb)**
- [x] **Step 2: Triển khai `indexed-db-client.ts` với đầy đủ transaction boundary và SSR guards**
- [x] **Step 3: Triển khai `guest-reading-state-repository.ts` và `guest-library-repository.ts`**
- [x] **Step 4: Chạy test xác nhận pass 100%**
- [x] **Step 5: Git commit**

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
- Modify: `apps/web/src/components/story/bookmark-button.tsx`
- Modify: `apps/web/src/app/(public)/library/page.tsx`
- Test: `apps/web/src/test/guest-reader-integration.spec.ts`

**Key Invariants:**
- `useReadingProgress` tiêu thụ `ActiveScopeCoordinator`:
  - Nếu `BOOTSTRAPPING`: Chờ `coordinator.waitForResolvedScope()` trước khi ghi; không bao giờ optimistic write nhầm scope.
  - Nếu `GUEST`: Dùng `GuestReadingStateRepository`. Không gọi API, không gamification.
  - Nếu `ACCOUNT`: Dùng `AccountReadingStateRepository`.
- Nút Bookmark: Guest click -> lưu/xóa trong IndexedDB ngay lập tức, không redirect sang Login, không 401.
- Trang Thư viện: Hiển thị danh sách truyện từ IndexedDB kèm presentation metadata (`title`, `coverUrl`).

- [x] **Step 1: Viết test cho `useReadingProgress` ở chế độ Guest và Account**
- [x] **Step 2: Refactor `use-reading-progress.ts` sử dụng `ReadingStateRepository`**
- [x] **Step 3: Tích hợp Bookmark button và Library page với Guest Store**
- [x] **Step 4: Chạy test xác nhận pass**
- [x] **Step 5: Git commit**

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
  - Mọi query đều lọc theo `owner_scope = ?`.
  - Hỗ trợ atomic transaction `recordReadingSession(progress, history)`.
- `GuestLibraryRepository` & `GuestReadingProgressRepository`:
  - Triển khai interface tương thích với `LibraryRepository` và `ReadingProgressRepository` hiện hữu nhưng trỏ thẳng vào `LocalLibraryDao`.

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
- Modify: `apps/mobile/lib/features/reader/presentation/reader_screen.dart`
- Test: `apps/mobile/test/features/auth/guest_navigation_test.dart`

**Specifications:**
- `login_screen.dart`: Bổ sung nút TextButton/OutlinedButton "Tiếp tục với tư cách Khách" (Continue as Guest).
- `app_router.dart`: Cho phép truy cập `/home`, `/story/:id`, `/reader/:id`, `/library` khi `activeScope.isGuest`.
- Reader Screen: Khi Guest đọc truyện, nạp và lưu tiến độ vào SQLite v3 partition `guest:<guestProfileId>`.

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
   - 0 requests gửi lên `/library/*` hoặc `/reading-progress`.
   - 0 Bearer tokens rác được đính kèm.
   - 0 bản ghi User hay Progress nặc danh sinh ra trong PostgreSQL.
3. **Scenario 3 (P0 Cross-Contamination Prevention):**
   - User A đăng nhập, có bookmark truyện X.
   - User A đăng xuất -> `onLogout()` xoay `guestProfileId` mới -> active scope thành `guest:<newGuestProfileId>`.
   - Thư viện hiển thị rỗng hoàn toàn, không có truyện X.
   - Guest mới đọc truyện Y.
   - User B đăng nhập trên cùng máy -> User B chỉ thấy dữ liệu của B, không thấy truyện X của A và không thấy truyện Y của Guest.
4. **Scenario 4 (Auth Bootstrap Race Prevention):**
   - Khởi động app với auth ở trạng thái `BOOTSTRAPPING`: Reader tải trang nhưng ghi tiến độ bị giữ lại cho đến khi auth hydrate xong. Không xảy ra việc ghi nhầm tiến độ User A vào guest partition.

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

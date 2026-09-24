# Kế hoạch Triển khai Patch Hoàn tất Phase 5C.5 (Items A - F)

> **Mục tiêu:** Khắc phục triệt để 5 gap audit được phát hiện sau commit `dc9d770`, đưa Phase 5C.5 đạt chuẩn **Full Baseline Acceptance**, đồng bộ Git và đóng Issue #201 trên GitHub.

## Tóm tắt 6 Hạng mục Patch (A – F)

- **Item A:** Revalidation confirmed-success trong `GamificationRepository.checkIn()` và `claimLevelReward()` → Trả về success, không rethrow; nhận diện đầy đủ `TIMEOUT`, `NETWORK_ERROR`, và `*_IN_FLIGHT`.
- **Item B:** Countdown về 0 trong `DailyCheckinDialog` → Gọi `getProgression(forceRefresh: true)`, cập nhật `hasCheckedInToday = false`, mở khóa nút check-in qua ngày mới.
- **Item C:** Wire production lifecycle và midnight timer vào `ReadingProgressCoordinator` để `updateServerDateVN()` tự động kích hoạt ngoài đời thực, xóa suppression khi sang ngày mới.
- **Item D:** Hoàn tất migration `AppColors.primary` và `primaryLight` sang token động `context.primaryColor` và `context.primaryLightColor` trên toàn bộ acceptance surfaces (`HomeScreen`, `LibraryScreen`, Home widgets, `WebtoonReaderView`, `MangaPagedReaderView`, `ReaderScreen`, `StoryDetailScreen`, `SearchScreen`).
- **Item E:** Chuẩn hóa exception phía Backend sang structured object `{ code: 'CHECKIN_REQUEST_IN_FLIGHT', message: '...' }`, bổ sung unit test cho `GlobalExceptionFilter`.
- **Item F:** Đính chính tài liệu walkthrough Redis TTL 10s → 120s, chạy toàn bộ regression test suite, commit & push git, tích chọn acceptance criteria và đóng Issue #201 qua `gh` CLI.

---

### Task 1: Revalidation Confirmed-Success & Error Mapping (Item A)
- **Mã nguồn:** `apps/mobile/lib/features/gamification/repositories/gamification_repository.dart`
- **Kiểm thử:** `apps/mobile/test/features/gamification/gamification_repository_test.dart`
- [x] Bổ sung hàm nhận diện `_isUncertainOutcomeError(ApiError e, String inFlightCode)`.
- [x] Trong `checkIn()`: khi bắt gặp uncertain outcome, revalidate `getProgression(forceRefresh: true)`. Nếu `refreshed.hasCheckedInToday == true`, reconcile thành SUCCESS (trả về `CheckinResult`), chỉ rethrow khi DB chưa commit.
- [x] Trong `claimLevelReward()`: khi bắt gặp uncertain outcome, revalidate `getLevelRewards(forceRefresh: true)`. Nếu `claimedReward.isClaimed == true`, reconcile thành SUCCESS (hoàn thành bình thường), chỉ rethrow khi DB chưa commit.
- [x] Viết test mô phỏng uncertain outcome (Timeout / In-flight) với kết quả revalidation thành công và thất bại.

### Task 2: Countdown Midnight Rollover trong DailyCheckinDialog (Item B)
- **Mã nguồn:** `apps/mobile/lib/features/gamification/presentation/daily_checkin_dialog.dart`
- **Kiểm thử:** `apps/mobile/test/features/gamification/daily_checkin_dialog_test.dart`
- [x] Khi bộ đếm monotonic về 0 (`elapsed >= _initialSecondsRemaining`), hủy ticker và kích hoạt `_handleMidnightRollover()`.
- [x] Trong `_handleMidnightRollover()`: gọi `repository.getProgression(forceRefresh: true)`, cập nhật `_hasCheckedInToday`, reset stopwatch và cập nhật UI sang trạng thái sẵn sàng điểm danh ngày mới.
- [x] Viết widget test kiểm tra kịch bản countdown về 0 tự động chuyển đổi UI sang ngày mới.

### Task 3: Production Wiring cho Reader serverDateVN Rollover (Item C)
- **Mã nguồn:** `apps/mobile/lib/features/reader/presentation/reading_progress_coordinator.dart`
- **Kiểm thử:** `apps/mobile/test/features/reader/reading_progress_coordinator_reward_test.dart`
- [x] Bổ sung `_scheduleMidnightCheck()` tính toán thời gian tới 00:00:01 múi giờ Việt Nam (UTC+7) và đặt `Timer` tự động kiểm tra rollover khi đang đọc.
- [x] Trong `didChangeAppLifecycleState(AppLifecycleState.resumed)`: tự động kiểm tra và gọi `_checkAndHandleDateRollover()`.
- [x] Trong `_evaluateReadingReward()`: kiểm tra ngày VN hiện tại; nếu khác với `_dailyReadCapReachedDate` thì tự động gọi `updateServerDateVN(clientDateVN)` để xóa suppression ngay lập tức.
- [x] Viết unit test Gate 9C chứng minh production wiring kích hoạt rollover và xóa daily cap suppression khi qua ngày mới.

### Task 4: Dynamic Theme Tokens Migration cho Acceptance Surfaces (Item D)
- **Mã nguồn:**
  - `apps/mobile/lib/core/theme/theme_tokens.dart`
  - `apps/mobile/lib/features/home/presentation/home_screen.dart`
  - `apps/mobile/lib/features/home/presentation/widgets/home_ranking_section.dart`
  - `apps/mobile/lib/features/home/presentation/widgets/home_latest_section.dart`
  - `apps/mobile/lib/features/home/presentation/widgets/home_carousel_banner.dart`
  - `apps/mobile/lib/features/library/presentation/library_screen.dart`
  - `apps/mobile/lib/features/reader/presentation/webtoon_reader_view.dart`
  - `apps/mobile/lib/features/reader/presentation/manga_paged_reader_view.dart`
  - `apps/mobile/lib/features/reader/presentation/reader_screen.dart`
  - `apps/mobile/lib/features/story/presentation/story_detail_screen.dart`
  - `apps/mobile/lib/features/search/presentation/search_screen.dart`
- [x] Bổ sung `context.primaryLightColor` vào `BuildContextThemeExtension`.
- [x] Rà soát và thay thế toàn bộ `AppColors.primary` và `AppColors.primaryLight` trên các surface sang `context.primaryColor` và `context.primaryLightColor`.

### Task 5: Backend Structured BadRequestException & Filter Tests (Item E)
- **Mã nguồn:**
  - `services/api/src/modules/gamification/gamification.service.ts`
  - `services/api/src/common/filters/http-exception.filter.spec.ts`
  - `services/api/src/modules/gamification/test/gamification.spec.ts`
- [x] Chuyển các ngoại lệ in-flight và validation sang object: `new BadRequestException({ code: 'CHECKIN_REQUEST_IN_FLIGHT', message: '...' })`.
- [x] Thêm unit test cho `GlobalExceptionFilter` đảm bảo mã lỗi `error.code` được giữ nguyên từ object response.
- [x] Cập nhật unit test `gamification.spec.ts` để kiểm tra structured error code.

### Task 6: Đính chính Tài liệu Walkthrough, Regression, Git Push & Đóng Issue #201 (Item F)
- [x] Cập nhật báo cáo walkthrough và docs: đính chính TTL safety net 10s → 120s.
- [x] Chạy kiểm thử toàn diện:
  - Backend API: `npm test` (26/26 suites passed, 334/334 tests passed)
  - Mobile Flutter: `flutter test` (160/160 tests passed) & `flutter analyze` (0 issues)
- [x] Thực hiện `git commit` và `git push` lên `origin/main`.
- [x] Sử dụng `gh issue edit 201` tick toàn bộ checkboxes và `gh issue close 201` với comment nghiệm thu chi tiết.

# Kế Hoạch Triển Khai Phase 5D.7: Studio Quick-Approval Action Sheet & Coherent Apply Protocol

- **Tên Phase:** Phase 5D.7 — Studio Quick-Approval Action Sheet (Polish - Mobile)
- **Tracking Issue:** [Issue #207](https://github.com/HIepNgoc2006/OmniNovel/issues/207)
- **Living Master Tracker:** [Issue #192](https://github.com/HIepNgoc2006/OmniNovel/issues/192)
- **Baseline Tham Chiếu:** Commit [`b999e6e`](https://github.com/HIepNgoc2006/OmniNovel/commit/b999e6e) (Offline Storage Engine Frozen-Final)

---

## 1. TỔNG QUAN & PHẠM VI NGHIỆP VỤ

### 1.1. Mục tiêu
Cung cấp cho biên tập viên và chủ tác phẩm (**OWNER**, **EDITOR**, **ADMIN**) một giao diện kiểm duyệt nhanh trên ứng dụng di động Flutter (`apps/mobile/lib/features/studio`), cho phép:
1. So sánh trực quan kết quả dịch AI (ảnh Manga/Webtoon ghép cặp hoặc đoạn văn Novel song ngữ).
2. Kiểm tra thẩm quyền duyệt máy chủ (**Server-Authoritative Permission Gate**).
3. Xuất bản chính thức bản dịch mới theo giao thức bất biến (Idempotent Apply Protocol & Ambiguity Recovery), kế thừa đầy đủ các tiêu chuẩn đã đóng băng ở Web Studio Phase 4.
4. Gợi ý cập nhật bản offline thông minh theo cơ chế nhận biết phiên bản (**Version-Aware Offline Refresh**), bảo vệ nguyên vẹn Offline Engine 5D.3–5D.6.

### 1.2. Giới hạn phạm vi (Strict Non-Scope)
- **Read-Only Review & Apply Only:** Tuyệt đối **không** triển khai tính năng chỉnh sửa phân đoạn (Segment Editing, PATCH segment, OCC locking, re-render materialization) trên mobile. Các tác vụ can thiệp sâu thuộc về Web Studio.
- **Không phát sinh API mới:** Sử dụng 100% các endpoint hiện hữu của Backend `/api/v1/ai/...`.
- **Zero Mutation vào Offline Engine Baseline:** Không sửa đổi logic core của `OfflineStorageEngine`, `BundleInstaller`, hay `DownloadQueueManager`.

---

## 2. 6 BẤT BIẾN KIẾN TRÚC & QUY CHUẨN ĐÓNG BĂNG (PHASE 4 PARITY)

### Bất biến 1: Canonical API Contract Parity (Zero Transport Invention)
Mobile DTOs trong `apps/mobile/lib/features/studio/models/studio_models.dart` phải ánh xạ chính xác 1:1 các interface từ `@omninovel/shared`:
- `GET /api/v1/ai/jobs/:id` ➔ `TranslationJobReviewDetailResponse` (job metadata, context, reviewSummary, permissions, glossarySnapshot).
- `GET /api/v1/ai/jobs/:id/previews` ➔ `TranslationJobPreviewsResponse` (`sourceAssets: ReviewAssetDto[]`, `resultAssets: ReviewAssetDto[]`).
  - *Lưu ý:* Mobile tạo View Model tầng Presentation để ghép cặp theo `pageNumber`, không coi view model ghép cặp này là contract của server.
- `GET /api/v1/ai/jobs/:id/segments` ➔ `TranslationJobSegmentsResponse` (`data: TranslationSegmentDto[]`, `total`, `page`, `limit`, `totalPages`, `workspaceRevision`). Segment canonical dùng các trường: `rawText`, `translatedText`, `isHumanVerified`, `anchorBlockId`, `sortOrder`.
- `POST /api/v1/ai/jobs/:id/apply` ➔ `ApplyTranslationJobRequest` (`mode: ApplyTranslationMode`), Header `Idempotency-Key: <UUID-v4>`, phản hồi `ApplyTranslationJobResponse` (`chapterId`, `activeVersionId`, `targetVersionId`, `versionNumber`, `versionType`, `isAlreadyApplied`).

### Bất biến 2: Server-Authoritative Permission Gate
- Cấm suy diễn quyền từ `User.role` cục bộ (vì `User.role` là global role, trong khi quyền biên tập truyện là `StoryMemberRole` theo từng truyện).
- UI nút bấm Publish chỉ được kích hoạt khi:
  ```dart
  jobDetail.permissions.canApply == true && jobDetail.permissions.applyBlockReason == null
  ```
- Nếu `canApply == false`, hiển thị thông báo lý do chặn rõ ràng (ví dụ: `INSUFFICIENT_ROLE`).

### Bất biến 3: Idempotency Protocol & Ambiguity Recovery
- Không sinh UUID khi mở sheet. UUID-v4 chỉ được tạo tại thời điểm người dùng bắt đầu nhấn nút "Xuất bản".
- Đóng băng bất biến cặp `{ idempotencyKey, submittedMode }`.
- Nếu xảy ra timeout, mất mạng hoặc lỗi không xác định (SocketException, 502/504):
  - Chuyển sang trạng thái `SUBMISSION_OUTCOME_UNKNOWN`.
  - Thực hiện tái đối soát (`RECONCILING`) bằng cách gọi `GET /api/v1/ai/jobs/:id`.
  - Cấm cho phép người dùng thay đổi `mode` trong quá trình retry khi chưa đối soát xong.

```
+--------+     Bấm "Xuất bản"     +--------------+
|  IDLE  | ---------------------> |  SUBMITTING  |
+--------+                        +--------------+
                                         |
                       +-----------------+-----------------+
                       |                                   |
                  Network OK                          Timeout / Ambiguity
                       v                                   v
             +--------------------+            +-------------------------------+
             | POST 200 Received  |            |  SUBMISSION_OUTCOME_UNKNOWN   |
             +--------------------+            +-------------------------------+
                       |                                   |
                       | Refetch GET /jobs/:id             | Refetch GET /jobs/:id
                       v                                   v
             +--------------------+            +-------------------------------+
             |    RECONCILING     | <--------- |          RECONCILING          |
             +--------------------+            +-------------------------------+
                       |
         +-------------+-------------+
         |                           |
   Status=APPLIED             Status!=APPLIED
         v                           v
+------------------+        +------------------+
|    SUCCEEDED     |        |      FAILED      |
+------------------+        +------------------+
```

### Bất biến 4: Authoritative Post-Apply Coherence Check
- Phản hồi `HTTP 200` từ `POST /apply` chưa được coi là publish hoàn tất ở UI.
- Client bắt buộc thực hiện refetch authoritative job detail (`GET /api/v1/ai/jobs/:id`) và xác minh bộ 3 điều kiện nhất quán:
  1. `job.status === TranslationJobStatus.APPLIED`
  2. `context.targetVersion.id == applyResponse.targetVersionId`
  3. `job.workspaceRevision > initialWorkspaceRevision`
- Sau khi xác minh toàn vẹn thành công, UI mới phát sinh sự kiện làm mới danh sách chapter trong `StoryDetailScreen`.

### Bất biến 5: Clean Non-Invasive Entry Points (Zero Pseudo-Fields)
- Không thêm field giả `completedTranslationJobId` vào Story / Chapter model.
- Truy vấn danh sách các job sẵn sàng duyệt của truyện qua:
  ```http
  GET /api/v1/ai/jobs?storyId={storyId}&status=READY_FOR_REVIEW
  ```
- Tạo bảng tra cứu trong RAM: `Map<String, String> chapterJobMap` (ánh xạ `chapterId ➔ jobId`).
- Chỉ hiển thị badge `[Duyệt AI]` trên chapter tile khi `chapterJobMap.containsKey(chapter.id)`. Khi bấm vào badge, mới gọi fetch chi tiết `GET /api/v1/ai/jobs/:id`.

### Bất biến 6: Version-Aware Offline Refresh
- Phân biệt rõ ranh giới ngữ nghĩa của 2 chế độ Apply:
  - `OVERWRITE_ACTIVE_VERSION`: `activeVersionId` của chapter thay đổi sang `targetVersionId`.
  - `CREATE_ALTERNATE_VERSION`: `activeVersionId` của chapter **giữ nguyên**, tạo thêm một version phụ.
- Khi kiểm tra với Offline Engine (`OfflineContentResolver` / `DownloadedChapter`):
  - Nếu chapter đang có bản tải ngoại tuyến cục bộ: so sánh `offline.chapterVersionId` với `targetVersionId` / `activeVersionId`.
  - Nếu `OVERWRITE_ACTIVE_VERSION` thành công và `offline.chapterVersionId != response.targetVersionId`: hiển thị nút CTA gợi ý *"Đã có bản dịch mới (v{versionNumber}). Nhấn để cập nhật bản tải offline"*.
  - Tuyệt đối không tự động xóa hay mutate bundle offline cũ. Việc tải bản mới do người dùng chủ động kích hoạt.

---

## 3. THIẾT KẾ CẤU TRÚC MÔ-ĐUN (`apps/mobile/lib/features/studio`)

```
apps/mobile/lib/features/studio/
├── models/
│   ├── studio_models.dart             # Mirror 1:1 @omninovel/shared DTOs & Enums
│   └── studio_presentation_models.dart # Presentation Pair Model cho Manga previews
├── repositories/
│   └── studio_repository.dart         # Dio Client tích hợp /ai/jobs, previews, segments, apply
└── presentation/
    ├── studio_quick_approval_sheet.dart # DraggableScrollableSheet 2 Tabs (So sánh & Duyệt)
    ├── widgets/
    │   ├── manga_preview_comparison_view.dart # Toggle Trước/Sau + InteractiveViewer zoom
    │   ├── novel_segment_comparison_view.dart  # Paginated bilingual list (rawText vs translatedText)
    │   └── studio_apply_form_view.dart        # Explicit Mode Selector & Ambiguity-Safe CTA
    └── controllers/
        └── studio_approval_controller.dart    # State Machine: Idempotency, Ambiguity, Coherence
```

---

## 4. MA TRẬN 10 ACCEPTANCE GATES (VERIFICATION CRITERIA)

| Gate | Tiêu Chí Kiểm Tra (Acceptance Criteria) | Phương Pháp Xác Minh |
| :--- | :--- | :--- |
| **Gate 1: Canonical Contract Parity** | DTOs phản ánh 100% `@omninovel/shared`: `rawText`, `translatedText`, `isHumanVerified`, `sourceAssets[]`, `resultAssets[]`, `ReviewSummaryDto`. Không có field giả. | Unit Test Serialization |
| **Gate 2: Server-Authoritative Permission Gate** | Nút Publish bị disable khi `permissions.canApply == false`. Hiển thị tooltip/banner `INSUFFICIENT_ROLE`. Không dựa vào `user.role` cục bộ. | Widget Test Mock Permissions |
| **Gate 3: Bounded Previews & Segments** | Manga ghép cặp đúng `pageNumber`, hỗ trợ nút gạt Trước/Sau và `InteractiveViewer`. Novel hiển thị danh sách đối chiếu song ngữ phân trang. | Widget Test Visual Rendering |
| **Gate 4: Apply Fail-Closed Gate** | Chặn submit nếu job không ở trạng thái `READY_FOR_REVIEW` hoặc dữ liệu artifact bị stale (`409 ARTIFACT_STALE`). | State Machine Test |
| **Gate 5: Explicit Mode Selection** | Nút Xuất bản bị disable cho đến khi người dùng chọn rõ ràng giữa `OVERWRITE_ACTIVE_VERSION` và `CREATE_ALTERNATE_VERSION`. Không có default mode ngầm định. | UI Form Interaction Test |
| **Gate 6: Frozen Idempotency & Ambiguity Recovery** | Sinh UUID-v4 khi bấm submit. Giả lập timeout/lỗi mạng: hệ thống retry với đúng `{idempotencyKey, mode}` cũ, cấm đổi mode trong lúc chờ đối soát. | Integration Test Mock Dio |
| **Gate 7: Authoritative Post-Apply Coherence** | Sau `POST /apply` thành công, gọi `GET /jobs/:id` xác nhận `status == APPLIED`, `targetVersion.id` khớp, và `workspaceRevision` đã tiến. | Controller Integration Test |
| **Gate 8: Non-Invasive Entry Point Wiring** | `StoryDetailScreen` và `ReaderScreen` lấy danh sách job từ `GET /api/v1/ai/jobs?storyId=...&status=READY_FOR_REVIEW`, map theo `chapterId`. Không sửa đổi Story DB schema. | Screen Integration Test |
| **Gate 9: Version-Aware Offline Refresh** | So sánh `offline.chapterVersionId` với phiên bản mới. Chỉ hiện gợi ý cập nhật khi `OVERWRITE_ACTIVE_VERSION`. Zero mutation vào bundle offline cũ. | Resolver Integration Test |
| **Gate 10: Zero Regression & Full Test Suite** | Toàn bộ unit/widget tests của Studio PASS; 291/291 offline tests hiện có PASS 100%; `flutter analyze` 0 issues. | Full Test Runner |

---

## 5. KẾ HOẠCH TRIỂN KHAI TỪNG BƯỚC

1. **Bước 1: Data Contracts & Repository (`features/studio/models`, `repositories`)**
   - Viết `studio_models.dart` bám sát `@omninovel/shared`.
   - Viết `studio_repository.dart` gọi các endpoint `/api/v1/ai/...`.
   - Viết unit test cho repository và DTO parsing (Gate 1).
2. **Bước 2: State Machine Controller (`features/studio/presentation/controllers`)**
   - Triển khai `StudioApprovalController` quản lý vòng đời Idempotency, Frozen Mode, Ambiguous Network Recovery, và Post-Apply Coherence Check (Gate 4, 5, 6, 7).
3. **Bước 3: Giao Diện So Sánh Trực Quan (`features/studio/presentation/widgets`)**
   - Triển khai `MangaPreviewComparisonView` (ghép cặp source/result assets, toggle Trước/Sau, InteractiveViewer) (Gate 3).
   - Triển khai `NovelSegmentComparisonView` (phân đoạn song ngữ, badge human-verified) (Gate 3).
   - Triển khai `StudioApplyFormView` (Explicit Mode Selector, Server Permission Guard) (Gate 2, 5).
4. **Bước 4: Action Sheet Hoàn Chỉnh (`StudioQuickApprovalSheet`)**
   - Ráp DraggableScrollableSheet kết nối Controller và 2 Tabs.
5. **Bước 5: Entry Points Wiring & Version-Aware Offline Hint**
   - Tích hợp vào `StoryDetailScreen` qua `GET /api/v1/ai/jobs?storyId=...` (Gate 8).
   - Tích hợp vào menu `ReaderControlOverlay` (Gate 8).
   - Tích hợp Version-Aware Offline Hint khi phát hiện chapter đã tải offline (Gate 9).
6. **Bước 6: Kiểm thử toàn diện & Đóng gói Baseline**
   - Chạy `flutter test` toàn bộ suite.
   - Chạy `flutter analyze` xác nhận 0 warnings, 0 errors.
   - Cập nhật Issue #207 và Living Tracker #192. Commit & Push lên `main`.

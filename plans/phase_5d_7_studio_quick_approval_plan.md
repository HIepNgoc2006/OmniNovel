# Kế Hoạch Triển Khai Phase 5D.7: Studio Quick-Approval Action Sheet & Coherent Apply Protocol

- **Tên Phase:** Phase 5D.7 — Studio Quick-Approval Action Sheet (Polish - Mobile)
- **Tracking Issue:** [Issue #207](https://github.com/HIepNgoc2006/OmniNovel/issues/207)
- **Living Master Tracker:** [Issue #192](https://github.com/HIepNgoc2006/OmniNovel/issues/192)
- **Baseline Tham Chiếu:** Commit [`b999e6e`](https://github.com/HIepNgoc2006/OmniNovel/commit/b999e6e) (Offline Storage Engine Frozen-Final)

---

## 1. TỔNG QUAN & PHẠM VI NGHIỆP VỤ

### 1.1. Mục tiêu
Cung cấp cho biên tập viên và chủ tác phẩm (**OWNER**, **EDITOR**, **ADMIN**) một giao diện kiểm duyệt nhanh trên ứng dụng di động Flutter (`apps/mobile/lib/features/studio`), cho phép:
1. So sánh trực quan kết quả dịch AI (ảnh Manga/Webtoon ghép cặp theo lazy window hoặc đoạn văn Novel song ngữ).
2. Kiểm tra thẩm quyền duyệt máy chủ (**Server-Authoritative Permission Gate**).
3. Khóa chặt tính tươi mới dữ liệu (**Canonical Freshness Gate**) trước khi gửi request.
4. Xuất bản chính thức bản dịch mới theo giao thức bất biến (Idempotent Apply Protocol & Ambiguity Recovery), kế thừa đầy đủ các tiêu chuẩn đã đóng băng ở Web Studio Phase 4.
5. Gợi ý cập nhật bản offline thông minh theo cơ chế nhận biết phiên bản (**Version-Aware Offline Refresh**), bảo vệ nguyên vẹn Offline Engine 5D.3–5D.6.

### 1.2. Giới hạn phạm vi (Strict Non-Scope)
- **Read-Only Review & Apply Only:** Tuyệt đối **không** triển khai tính năng chỉnh sửa phân đoạn (Segment Editing, PATCH segment, OCC locking, re-render materialization) trên mobile. Các tác vụ can thiệp sâu thuộc về Web Studio.
- **Không phát sinh API mới:** Sử dụng 100% các endpoint hiện hữu của Backend `/api/v1/ai/...`.
- **Zero Mutation vào Offline Engine Baseline:** Không sửa đổi logic core của `OfflineStorageEngine`, `BundleInstaller`, hay `DownloadQueueManager`.

---

## 2. 7 BẤT BIẾN KIẾN TRÚC & QUY CHUẨN ĐÓNG BĂNG (PHASE 4 PARITY)

### Bất biến 1: Canonical API Contract Parity (Zero Transport Invention)
Mobile DTOs trong `apps/mobile/lib/features/studio/models/studio_models.dart` phải ánh xạ chính xác 1:1 các interface từ `@omninovel/shared`:
- `GET /api/v1/ai/jobs/:id` ➔ `TranslationJobReviewDetailResponse` (job metadata, context, reviewSummary, permissions, glossarySnapshot).
- `GET /api/v1/ai/jobs/:id/previews` ➔ `TranslationJobPreviewsResponse` (`sourceAssets: ReviewAssetDto[]`, `resultAssets: ReviewAssetDto[]`).
  - *Lưu ý:* Mobile tạo View Model tầng Presentation để ghép cặp theo `pageNumber` và tải theo lazy window, không coi view model ghép cặp này là contract của server.
- `GET /api/v1/ai/jobs/:id/segments` ➔ `TranslationJobSegmentsResponse` (`data: TranslationSegmentDto[]`, `total`, `page`, `limit`, `totalPages`, `workspaceRevision`). Segment canonical dùng các trường: `rawText`, `translatedText`, `isHumanVerified`, `anchorBlockId`, `sortOrder`.
- `POST /api/v1/ai/jobs/:id/apply` ➔ `ApplyTranslationJobRequest` (`mode: ApplyTranslationMode`), Header `Idempotency-Key: <UUID-v4>`, phản hồi `ApplyTranslationJobResponse` (`chapterId`, `activeVersionId`, `targetVersionId`, `versionNumber`, `versionType`, `isAlreadyApplied`).

### Bất biến 2: Server-Authoritative Permission Gate
- Cấm suy diễn quyền từ `User.role` cục bộ (vì `User.role` là global role, trong khi quyền biên tập truyện là `StoryMemberRole` theo từng truyện).
- UI nút bấm Publish chỉ được kích hoạt khi:
  ```dart
  jobDetail.permissions.canApply == true && jobDetail.permissions.applyBlockReason == null
  ```
- Nếu `canApply == false`, hiển thị thông báo lý do chặn rõ ràng (ví dụ: `INSUFFICIENT_ROLE`).

### Bất biến 3: Canonical Freshness Gate Trước Khi POST (Gate 4 Hardening)
- Client phải tính toán độ tươi mới canonical dựa trên snapshot `GET /jobs/:id`:
  ```dart
  final isFresh = jobDetail.job.reviewRevision == jobDetail.job.materializedRevision;
  ```
- Nút bấm Apply CTA chỉ được enable khi thỏa mãn đồng thời 6 điều kiện:
  1. `job.status == TranslationJobStatus.READY_FOR_REVIEW`
  2. `permissions.canApply == true`
  3. `permissions.applyBlockReason == null`
  4. `isFresh == true` (`reviewRevision == materializedRevision`)
  5. `mode != null` (người dùng đã chọn rõ ràng mode xuất bản)
  6. `applyLifecycle` không in-flight
- **Fail-closed:** Nếu `reviewRevision != materializedRevision`, giao diện hiển thị cảnh báo *"Bản dịch đang được cập nhật/materialize lại trên server"* và **vô hiệu hóa nút Apply, tuyệt đối không gửi bất kỳ POST `/apply` nào**. Xử lý `409 ARTIFACT_STALE` từ server là chốt chặn cuối cùng (race-defense), không phải freshness gate chính.

### Bất biến 4: Idempotency Protocol & Ambiguity Recovery State Machine
- Không sinh UUID khi mở sheet. UUID-v4 chỉ được tạo tại thời điểm người dùng bắt đầu nhấn nút "Xuất bản".
- Đóng băng bất biến cặp `{ idempotencyKey, submittedMode }`.
- Giao thức xử lý lỗi mạng & ambiguity chuẩn Phase 4:
  - Khi gửi request: chuyển sang `SUBMITTING`.
  - Nếu gặp timeout / lỗi mạng / HTTP 502/504: chuyển sang `SUBMISSION_OUTCOME_UNKNOWN`.
  - Vào trạng thái `RECONCILING` và gọi `GET /api/v1/ai/jobs/:id`:
    - **Nếu `GET` trả `status == APPLIED`:** Request có thể đã commit trên server. Thực hiện Coherence Check (so sánh `context.targetVersion.id` với `targetVersionId` hoặc lấy lại response từ idempotent replay). Nếu khớp ➔ chuyển `SUCCEEDED`. Nếu không khớp hoặc không thể xác minh ➔ chuyển `COMMITTED_RECONCILIATION_REQUIRED`.
    - **Nếu `GET` trả `status == READY_FOR_REVIEW`:** Bằng chứng có thẩm quyền (authoritative proof) xác nhận apply chưa commit! Lúc này hệ thống mới được phép giải phóng frozen identity hoặc cho phép người dùng đổi mode / thử lại ➔ chuyển về `IDLE` (hoặc `READY_FOR_RETRY`).
    - **Nếu `GET` bản thân bị timeout / network error:** Giữ nguyên trạng thái `SUBMISSION_OUTCOME_UNKNOWN` (chưa thể kết luận FAILED vì request trước đó có thể vẫn đang được xử lý).
    - **Nếu `GET` trả terminal status khác (`CANCELED`, `FAILED`, `EXPIRED`):** Chuyển sang `FAILED` kèm thông báo trạng thái tương ứng.
    - **Nếu `POST` ban đầu nhận mã lỗi 4xx/5xx rõ ràng (không phải timeout):** Chuyển sang `FAILED` kèm message lỗi từ server.

```
                  +-----------------------------------+
                  |               IDLE                |
                  +-----------------------------------+
                                    |
                           Bấm "Xuất bản"
                       Freeze {key, mode}
                                    v
                  +-----------------------------------+
                  |            SUBMITTING             |
                  +-----------------------------------+
                        /           |             \
             POST 200  /     Timeout|              \ POST 4xx/5xx
                      /      Network|               \ (trừ timeout)
                     v              v                v
             +--------------+  +--------------+  +--------------+
             | POST_200_OK  |  |  OUTCOME_    |  |    FAILED    |
             +--------------+  |   UNKNOWN    |  +--------------+
                     |         +--------------+
                     |                 |
                     | Refetch GET     | Refetch GET
                     v                 v
             +--------------------------------+
             |          RECONCILING           |
             +--------------------------------+
               /           |          \          \
              /            |           \          \
     APPLIED /   READY_FOR /   Terminal \          \ GET Timeout /
            /       REVIEW/       Other  \          \ Network Error
           v             v                v          v
   +---------------+ +------------+ +--------+ +--------------+
   | Coherence     | | Author-    | | FAILED | |   OUTCOME_   |
   | Verification  | | itative    | +--------+ |   UNKNOWN    |
   +---------------+ | Not Applied|            +--------------+
     /          \    | Reset key  |
Pass/            \   | -> IDLE    |
   v          Failv  +------------+
+-----------+ +----------------------------------+
| SUCCEEDED | | COMMITTED_RECONCILIATION_REQUIRED|
+-----------+ +----------------------------------+
```

### Bất biến 5: Authoritative Post-Apply Coherence Check
- Phản hồi `HTTP 200` từ `POST /apply` chưa được coi là publish hoàn tất ở UI.
- Client bắt buộc thực hiện refetch authoritative job detail (`GET /api/v1/ai/jobs/:id`) và xác minh bộ 3 điều kiện nhất quán:
  1. `job.status === TranslationJobStatus.APPLIED`
  2. `context.targetVersion.id == applyResponse.targetVersionId`
  3. `job.workspaceRevision > initialWorkspaceRevision`
- Sau khi xác minh toàn vẹn thành công, UI mới phát sinh sự kiện làm mới danh sách chapter trong `StoryDetailScreen`.

### Bất biến 6: Clean Non-Invasive Entry Points & Multi-Job Pagination
- Không thêm field giả `completedTranslationJobId` vào Story / Chapter model.
- Truy vấn danh sách các job sẵn sàng duyệt của truyện qua:
  ```http
  GET /api/v1/ai/jobs?storyId={storyId}&status=READY_FOR_REVIEW
  ```
- **Xử lý phân trang an toàn:** Repository thực hiện fetch đầy đủ (sử dụng `limit=100` và lặp cho đến `totalPages`).
- **Hỗ trợ Multi-Job per Chapter:** Nhóm các job thành:
  ```dart
  Map<String, List<TranslationJobSummaryDto>> jobsByChapterId;
  ```
  giữ nguyên thứ tự deterministic từ server (`createdAt DESC, id DESC`).
  - Nếu chapter có **1 job**: Mở trực tiếp `StudioQuickApprovalSheet`.
  - Nếu chapter có **nhiều job** (>1): Hiển thị modal chooser ngắn gọn liệt kê các job (ngôn ngữ đích `targetLanguage`, model AI, thời điểm hoàn tất) để người dùng chọn job cần duyệt.

### Bất biến 7: Version-Aware Offline Refresh
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
│   └── studio_presentation_models.dart # Presentation Pair Model cho Manga previews (lazy window)
├── repositories/
│   └── studio_repository.dart         # Dio Client tích hợp /ai/jobs (full pagination), previews, segments, apply
└── presentation/
    ├── studio_quick_approval_sheet.dart # DraggableScrollableSheet 2 Tabs (So sánh & Duyệt)
    ├── widgets/
    │   ├── manga_preview_comparison_view.dart # Toggle Trước/Sau + InteractiveViewer zoom (lazy window)
    │   ├── novel_segment_comparison_view.dart  # Paginated bilingual list (rawText vs translatedText)
    │   ├── studio_apply_form_view.dart        # Explicit Mode Selector & Freshness/Permission Guard
    │   └── studio_job_chooser_dialog.dart     # Chooser khi chapter có nhiều READY_FOR_REVIEW jobs
    └── controllers/
        └── studio_approval_controller.dart    # State Machine: Freshness, Idempotency, Ambiguity, Coherence
```

---

## 4. MA TRẬN 10 ACCEPTANCE GATES (VERIFICATION CRITERIA)

| Gate | Tiêu Chí Kiểm Tra (Acceptance Criteria) | Phương Pháp Xác Minh |
| :--- | :--- | :--- |
| **Gate 1: Canonical Contract Parity** | DTOs phản ánh 100% `@omninovel/shared`: `rawText`, `translatedText`, `isHumanVerified`, `sourceAssets[]`, `resultAssets[]`, `ReviewSummaryDto`. Không có field giả. | Unit Test Serialization |
| **Gate 2: Server-Authoritative Permission Gate** | Nút Publish bị disable khi `permissions.canApply == false`. Hiển thị tooltip/banner `INSUFFICIENT_ROLE`. Không dựa vào `user.role` cục bộ. | Widget Test Mock Permissions |
| **Gate 3: Bounded Previews & Segments** | Manga ghép cặp đúng `pageNumber` theo bounded/lazy window, hỗ trợ nút gạt Trước/Sau và `InteractiveViewer`. Novel hiển thị danh sách đối chiếu song ngữ phân trang. | Widget Test Visual Rendering |
| **Gate 4: Apply Fail-Closed & Canonical Freshness** | Nút Apply CTA bị vô hiệu hóa khi `reviewRevision != materializedRevision` (stale) hoặc `status != READY_FOR_REVIEW`. Không phát sinh bất kỳ request POST nào khi stale. | Controller State Machine Test |
| **Gate 5: Explicit Mode Selection** | Nút Xuất bản bị disable cho đến khi người dùng chọn rõ ràng giữa `OVERWRITE_ACTIVE_VERSION` và `CREATE_ALTERNATE_VERSION`. Không có default mode ngầm định. | UI Form Interaction Test |
| **Gate 6: Frozen Idempotency & Ambiguous Recovery** | Sinh UUID-v4 khi bấm submit. Giả lập timeout/lỗi mạng: hệ thống retry với đúng `{idempotencyKey, mode}` cũ; gọi GET đối soát: `APPLIED ➔ SUCCEEDED`, `READY_FOR_REVIEW ➔ Reset/IDLE`, timeout ➔ giữ nguyên `OUTCOME_UNKNOWN`. | Integration Test Mock Dio |
| **Gate 7: Authoritative Post-Apply Coherence** | Sau `POST /apply` thành công, gọi `GET /jobs/:id` xác nhận `status == APPLIED`, `targetVersion.id` khớp, và `workspaceRevision` đã tiến. Lỗi lệch ➔ `COMMITTED_RECONCILIATION_REQUIRED`. | Controller Integration Test |
| **Gate 8: Non-Invasive Entry Point & Multi-Job Chooser** | Lấy danh sách job từ `GET /api/v1/ai/jobs?storyId=...&status=READY_FOR_REVIEW` (có phân trang đầy đủ). Nhóm `jobsByChapterId`. Chapter 1 job ➔ mở sheet; Chapter >1 jobs ➔ mở chooser. | Screen Integration Test |
| **Gate 9: Version-Aware Offline Refresh** | So sánh `offline.chapterVersionId` với phiên bản mới. Chỉ hiện gợi ý cập nhật khi `OVERWRITE_ACTIVE_VERSION`. Zero mutation vào bundle offline cũ. | Resolver Integration Test |
| **Gate 10: Zero Regression & Full Test Suite** | Toàn bộ unit/widget tests của Studio PASS; 291/291 offline tests hiện có PASS 100%; `flutter analyze` 0 issues. | Full Test Runner |

---

## 5. LỘ TRÌNH TRIỂN KHAI TDD THEO THỨ TỰ ƯU TIÊN (EXECUTION PHASES)

> **Nguyên tắc cốt lõi:** Tuyệt đối không dựng giao diện UI trước khi Controller Protocol và State Machine đạt chuẩn. Correctness của Idempotency, Freshness và Reconciliation là trọng tâm hàng đầu.

- **Phase 1 (Gate 1 — Contracts & Repository):**
  - Viết `apps/mobile/lib/features/studio/models/studio_models.dart`.
  - Viết `apps/mobile/lib/features/studio/repositories/studio_repository.dart` kèm phân trang `getAllReadyForReviewJobs(storyId)`.
  - Viết bộ kiểm thử `test/features/studio/studio_repository_test.dart` (Gate 1).
- **Phase 2 (Gate 4, 5, 6, 7 — State Machine & Protocol Controller):**
  - Viết `apps/mobile/lib/features/studio/presentation/controllers/studio_approval_controller.dart`.
  - Triển khai toàn bộ State Machine: Freshness Gate, Frozen Idempotency `{key, mode}`, Ambiguity Recovery (`SUBMISSION_OUTCOME_UNKNOWN ➔ RECONCILING`), Coherence Check, `COMMITTED_RECONCILIATION_REQUIRED`.
  - Viết bộ kiểm thử `test/features/studio/studio_approval_controller_test.dart` chứng minh tất cả các kịch bản timeout, retry, stale guard, và mismatch (Gate 4, 5, 6, 7).
- **Phase 3 (Gate 2, 3, 5 — Presentation Components):**
  - Viết `MangaPreviewComparisonView` (bounded/lazy window, toggle Trước/Sau, InteractiveViewer).
  - Viết `NovelSegmentComparisonView` (paginated bilingual list, human-verified badge).
  - Viết `StudioApplyFormView` (Explicit Mode Selector, Server-Authoritative Permission Guard, Freshness Warning).
  - Viết `StudioJobChooserDialog` (Chooser khi chapter có nhiều job).
  - Viết `StudioQuickApprovalSheet` (DraggableScrollableSheet tích hợp).
  - Viết widget tests cho từng thành phần (Gate 2, 3, 5).
- **Phase 4 (Gate 8, 9 — Wiring Entry Points & Offline Refresh Hint):**
  - Tích hợp `StoryDetailScreen` (fetch jobs phân trang, hiển thị badge `[Duyệt AI]`, mở sheet hoặc chooser).
  - Tích hợp menu `ReaderControlOverlay`.
  - Tích hợp Version-Aware Offline Hint liên kết với `OfflineContentResolver`.
  - Viết tests cho entry point wiring và offline refresh hint (Gate 8, 9).
- **Phase 5 (Gate 10 — Verification & Freeze Baseline):**
  - Chạy `flutter test test/features/studio/` và toàn bộ test suite.
  - Chạy `flutter analyze`.
  - Cập nhật Issue #207 và Master Tracker #192. Commit & Push lên `main`.

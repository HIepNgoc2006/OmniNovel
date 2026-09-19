# Design Spec — Studio Dashboard & Realtime Job Monitor (#145)

## 1. Overview & Business Goal
- **Context:** Issue #145 ([Phase 4D][Web] Build Studio Dashboard with managed projects and realtime job monitor).
- **Mục tiêu:** Thay thế màn hình tạm `/studio` (hiện là trang WebSocket tester nhập Job UUID thủ công) bằng **Studio Dashboard thực tế** theo chuẩn WEB-011 / WEB-013.
- **Vai trò:** Là trung tâm điều phối (Hub) kết nối toàn bộ quy trình:
  - Xem danh sách truyện được quản lý (`GET /api/v1/studio/stories`).
  - Xem danh sách các dự án dịch thuật của truyện (`GET /api/v1/ai/projects?storyId=...`).
  - Xem và quản lý danh sách tiến trình dịch (`GET /api/v1/ai/jobs`) hỗ trợ multi-status filtering (`statuses`) và tìm kiếm (`search`).
  - Giám sát tiến độ realtime qua WebSocket `/ws/ai` với multi-job subscription persistence qua reconnect.
  - Điều hướng trực tiếp vào không gian duyệt truyện (Manga Review Studio `/studio/ai/jobs/:jobId` đã hoàn thành ở #149/#152 và Novel Review Studio ở #150).

---

## 2. Core Architectural Decisions & Invariants

### Invariant 1: REST là Authoritative SSoT — WebSocket là Realtime Acceleration & Invalidation
- **Nguyên tắc:** WebSocket `/ws/ai` tuyệt đối **không** được coi là nguồn dữ liệu duy nhất (không tin cậy tuyệt đối vào event cuối cùng hoặc thứ tự network socket).
- **Hành vi cụ thể:**
  1. Khi vào trang hoặc chuyển filter/trang: Luôn gọi REST API `GET /api/v1/ai/jobs` để lấy trạng thái authoritative từ database (kèm total count và pagination chính xác từ server).
  2. Khi nhận sự kiện `job_progress` qua `/ws/ai`: Cập nhật tiến độ phần trăm (`progressPercentage`) và trạng thái (`status`) của job tương ứng trong client state để giao diện mượt mà tức thì (realtime acceleration).
  3. Khi nhận sự kiện chuyển trạng thái quyết định (`job_ready_for_review`, `job_failed`, `job_canceled`): Kích hoạt authoritative refetch từ REST API để đồng bộ toàn diện dữ liệu phiên bản (`workspaceRevision`, `targetVersion`, v.v.).
  4. Khi WebSocket bị mất kết nối (disconnect) rồi kết nối lại (reconnect) hoặc khi Access Token xoay vòng (token rotation): Tự động resubscribe **toàn bộ tập hợp active jobs** (`Set<string>`) và kích hoạt authoritative REST refetch để đảm bảo không bỏ sót bất kỳ thay đổi nào trong lúc mất kết nối.

### Invariant 2: Không Có Pseudo-Status "PROCESSING" — Khóa Canonical Status Groups
Pipeline AI Translation của hệ thống sử dụng các trạng thái thực tế nghiêm ngặt, không có enum `PROCESSING`. Do đó, các tab bộ lọc trên Dashboard được định nghĩa dưới dạng **Status Groups**:
- **ACTIVE Group (Đang chạy):**
  `CREATED`, `VALIDATING`, `QUEUED`, `PREPROCESSING`, `OCR`, `TRANSLATING`, `INPAINTING`, `TYPESETTING`, `QUALITY_CHECK`
- **REVIEW Group (Chờ duyệt):**
  `READY_FOR_REVIEW`
- **APPLIED Group (Đã xuất bản):**
  `APPLIED`
- **PROBLEM Group (Sự cố / Thất bại / Hủy):**
  `FAILED`, `CANCELED`, `EXPIRED`
- **ALL Group (Tất cả):** Không truyền status filter.

Để đảm bảo pagination và tổng số lượng ở server-side luôn chính xác, backend `GET /api/v1/ai/jobs` được nâng cấp hỗ trợ `statuses?: TranslationJobStatus[]` (bên cạnh `status?: TranslationJobStatus` đơn lẻ để backward-compatible).

### Invariant 3: Canonical Managed Stories & Projects Hierarchy
- Không nhồi nhét thông tin truyện (title, slug, mediaFormat) vào `TranslationProjectSummaryDto` mà tận dụng chuẩn có sẵn:
  1. `GET /api/v1/studio/stories` → Lấy danh sách truyện quản lý (`ManagedStorySummaryDto`).
  2. `GET /api/v1/ai/projects?storyId=...` → Lấy các dự án dịch (`TranslationProjectSummaryDto`) thuộc truyện đang chọn.
  3. `GET /api/v1/ai/jobs?...` → Lấy danh sách các jobs (`TranslationJobSummaryDto`).

### Invariant 4: Required Identity Fields Trong `TranslationJobSummaryDto`
Vì `getJobs()` trong backend đã `innerJoin` từ project sang edition và sang story, các trường sau là **bắt buộc (required)**:
- `mediaFormat: MediaFormat` (COMIC | NOVEL)
- `storySlug: string`
- `heartbeatAt: IsoDateString | null` (cho phép tính toán thời gian hoạt động gần nhất của job đang chạy, thay vì dựa vào trường `updatedAt` không tồn tại trong entity).

### Invariant 5: Multi-Job Socket Subscription Persistence
`useTranslationSocket` được mở rộng để:
- Duy trì một `subscribedJobIdsRef: Set<string>`.
- Hỗ trợ `subscribeJobs(jobIds: string[])` và `unsubscribeJobs(jobIds: string[])`.
- Khi `socket.on('connect')`: Tự động gửi lại sự kiện `subscribe_job` cho **tất cả** các job ID trong Set, giải quyết triệt để vấn đề mất subscription khi reconnect hoặc token rotation.

---

## 3. UI Component Hierarchy & Design Architecture

Trang `/studio` được thiết kế theo phong cách Slate 900 / Vermillion Red:

```
apps/web/src/app/(site)/(studio)/studio/page.tsx
├── StudioHeader
│   ├── Breadcrumb: "AI Translation Studio — Bảng Điều Khiển"
│   ├── WebSocket Status Indicator (Pill: Đã kết nối / Đang kết nối / Mất kết nối)
│   └── CTA: "Tạo Bản Dịch Mới" (Chuẩn bị điểm kết nối cho #146)
├── StudioMetricCards (Thống kê 4 khối)
│   ├── Đang chạy (Active jobs count)
│   ├── Chờ duyệt (Ready for Review count)
│   ├── Đã xuất bản (Applied count)
│   └── Sự cố / Đã hủy (Problem count)
├── StudioManagedStorySelector (Selector / Tabs chọn truyện đang quản lý từ /studio/stories)
│   └── Quick dropdown / filter theo Story và Project
├── StudioJobFilterBar
│   ├── Status Group Tabs: [Tất Cả, Đang Chạy (Active), Chờ Duyệt (Review), Đã Xuất Bản (Applied), Sự Cố (Problem)]
│   └── Search Input: Tìm kiếm theo tên chương, tiêu đề hoặc tên truyện (gửi lên `search` query param)
├── StudioJobList (Bảng / Thẻ danh sách Job)
│   ├── JobCard / JobRow (Item)
│   │   ├── Media Format Badge (Manga / Novel)
│   │   ├── Chapter & Story Identity (Chương 1.00: Khởi đầu — One Piece)
│   │   ├── Status Badge (Màu sắc chuẩn hóa theo từng trạng thái thực)
│   │   ├── Live Progress Bar (% hoàn thành + stage hiện tại)
│   │   ├── AI Provider & Model (OpenAI / gpt-4o-mini)
│   │   ├── Time Indicator (Tạo lúc `createdAt`, heartbeat lúc `heartbeatAt` nếu đang active, hoặc `completedAt`)
│   │   └── Contextual CTA Button:
│   │       ├── READY_FOR_REVIEW (Manga) -> "Vào Duyệt Bản Dịch" (Link: /studio/ai/jobs/:jobId)
│   │       ├── APPLIED -> "Xem Bản Đã Áp Dụng" (Link: /studio/ai/jobs/:jobId)
│   │       ├── ACTIVE Group -> "Theo Dõi Tiến Trình" (Link: /studio/ai/jobs/:jobId)
│   │       └── PROBLEM Group -> "Chi Tiết Lỗi" (Link: /studio/ai/jobs/:jobId)
│   └── EmptyState & LoadingSkeleton
└── StudioPaginationBar (Server-side paginator: Prev, Next, Current/Total pages)
```

---

## 4. Testing & Quality Gate Strategy
1. **Shared & Backend Tests:**
   - Contract test kiểm tra `mediaFormat`, `storySlug`, `heartbeatAt` required.
   - Unit test `translation.service.spec.ts` cho `getJobs()` với `statuses` array filter, `search` query, và phân quyền.
2. **Web Unit & Component Tests:**
   - Client API methods: `fetchManagedStories`, `fetchTranslationProjects`, `fetchTranslationJobs`.
   - `useTranslationSocket` test: Multi-job subscription và automatic resubscribe on reconnect.
   - `useStudioDashboard` test: Filter group mapping, search debounce, socket acceleration, và authoritative refetch.
   - Component tests: Metric cards, Story selector, Filter bar, Job cards với dynamic CTAs.
   - Page route integration test: Render dashboard, auth check, empty state.
3. **Playwright E2E Tests:**
   - Flow 1: Tải Dashboard, lọc status group "Chờ duyệt", điều hướng thành công vào Manga Review Studio.
   - Flow 2: Live Socket Acceleration — Job active nhận tiến độ socket trực tiếp và cập nhật UI.
4. **CI 3 Gates:** Toàn bộ Core API, Web Client và AI Worker phải 100% Green.

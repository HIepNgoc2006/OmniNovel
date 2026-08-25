# 📋 Phase 3: AI Translation Worker & Image Processing Pipeline (phase_03_ai_worker.md)

- **Mục tiêu:** Xây dựng dịch vụ AI Worker (`services/ai-worker` bằng Python FastAPI / PyTorch) được điều phối qua **BullMQ & Redis Queue** từ NestJS Core API (`services/api/src/modules/translation`), thực hiện quy trình dịch thuật Manga & Novel khép kín với Japanese Manga-OCR (MVP), Inpainting tẩy chữ thoại, Machine Translation kèm Glossary Context, Typesetting chữ tiếng Việt, và hoàn thiện 2 chiến lược xuất bản: **Ghi đè (Overwrite)** và **Nhân bản Version (Duplicate)**.
- **Kiến Trúc Điều Phối & Tính Bất Biến (Architecture SSoT):**
  - **Single Queue Architecture:** NestJS Producer $\rightarrow$ Redis BullMQ Queue $\rightarrow$ NestJS BullMQ Consumer $\rightarrow$ HTTP REST call $\rightarrow$ Python FastAPI stateless AI Engine (Tuyệt đối không dùng Celery song song để tránh dư thừa 2 hệ thống hàng đợi).
  - **Storage Source:** AI Worker tải raw source package đã qua kiểm định an toàn từ `upload_sessions.final_key` (không tải từ quarantine prefix).
  - **State Machine Chuẩn SSoT (14 Trạng Thái):**
    $$\text{CREATED} \rightarrow \text{VALIDATING} \rightarrow \text{QUEUED} \rightarrow \text{PREPROCESSING} \rightarrow \text{OCR} \rightarrow \text{TRANSLATING} \rightarrow \text{INPAINTING} \rightarrow \text{TYPESETTING} \rightarrow \text{QUALITY\_CHECK} \rightarrow \text{READY\_FOR\_REVIEW} \rightarrow \text{APPLIED}$$
    *(Trạng thái kết thúc lỗi / hủy: `FAILED`, `CANCELED`, `EXPIRED`)*.
  - **Bảo Vệ Tính Bất Biến Của ChapterVersion:**
    - **Chiến lược 1 (Ghi đè - Overwrite):** Gán `chapter.active_version_id = translated_version.id`. Bản ghi ChapterVersion gốc vẫn giữ nguyên bất biến (`RAW_ORIGINAL`).
    - **Chiến lược 2 (Nhân bản - Duplicate):** Tạo bản ghi mới trong `chapter_versions` với `version_type = 'AI_TRANSLATED'`, giữ nguyên `active_version_id` trỏ vào bản gốc để biên tập viên review thủ công.
  - **Trọng tâm MVP Scope:** Tập trung chuyên sâu **Manga tiếng Nhật (Japanese Manga-OCR)** cho bản MVP. Ngôn ngữ Hàn (Manhwa) / Trung (Manhua) được thiết kế theo Interface Adapter mở rộng cho V1.
- **Trạng thái:** [/] Đang triển khai (Vertical Slice 1: Core Orchestration, State Machine, Watchdog, Fencing & Mock Contract: **100% HOÀN THÀNH**)

---

### Danh Sách Đầu Việc (Checklist):
- [x] **Vertical Slice 1: Khởi tạo Hạ tầng, Orchestration Contract & Toàn Diện Hardening**
  - [x] Thiết lập môi trường cục bộ cô lập `services/ai-worker` (`.venv` Python 3.10+ / requirements.txt / FastAPI skeleton)
  - [x] Migration 0003: TypeORM Migration thêm orchestration metadata, idempotency & fencing sequence
  - [x] Xây dựng BullMQ Producer & Consumer trong NestJS Core API (`services/api/src/modules/translation`) quản lý đúng 14 trạng thái của `TranslationJob`
  - [x] Xây dựng REST Worker Contract hai chiều giữa NestJS và Python FastAPI (`/internal/v1/ai/jobs/:id/events` có fencing token và safe buffer `timingSafeEqual`)
  - [x] Hardening State Machine: Enforce chặt 14 trạng thái, cho phép heartbeat progress `same-state`, chặn nhảy cóc bất hợp pháp
  - [x] Hardening Pessimistic Locking & Fencing: Lock `FOR UPDATE` trong giao dịch DB, kiểm tra HEAD MinIO non-blocking ngoài transaction
  - [x] Hardening Retry & Cancel Lifecycle: `abortAttempt` với reason `STALLED` / `CANCELED`, anti-resurrection guard chặn tái kích hoạt job đã hủy
  - [x] Two-Step Presigned Output Upload: Core API cấp Presigned PUT URLs, Worker upload WebP thật lên MinIO, Core verify object tồn tại trước khi duyệt `READY_FOR_REVIEW`
  - [x] Hardening Invariants & Fail-Fast Lifecycle:
    - Worker-Final Invariant (Retry & Failure Protection): `READY_FOR_REVIEW` từ chối mọi mutation / same-state callback, chặn processor reset về `PREPROCESSING`, và được bảo vệ tuyệt đối trong `handleJobFailure` không bị ghi đè sang `FAILED`.
    - Fail-Fast Python Error Propagation: Ném HTTP 502 khi presign, upload MinIO hoặc callback thất bại để BullMQ retry đúng nghĩa.
    - Accurate Bucket Resolution: Xác định bucket `manga-media` vs `novel-media` theo `fileType` và `mediaFormat`.
    - WebSocket Production Security: CORS hỗ trợ `WEB_BASE_URL` và lọc tài khoản `is_deleted`.
  - [x] Test Pyramid Toàn Diện Đạt 100% Green (Tổng 126/126 tests):
    - 22/22 Unit Tests (`state-machine.spec.ts`, `fencing.spec.ts`)
    - 4/4 WebSocket Security E2E Tests (`translation-websocket.e2e-spec.ts`)
    - 3/3 DB Concurrency Integration Tests (`translation-db.integration-spec.ts`)
    - 5/5 BullMQ Lifecycle, Cancel, Worker-Final Retry & Failure Tests (`translation-queue.integration-spec.ts`)
    - 2/2 Migration Integration Tests (`migration-0003.integration-spec.ts`)
    - 1/1 True Cross-Service End-to-End Orchestration Smoke Test (`translation-cross-service.integration-spec.ts`)
    - 80/80 Core API E2E Lifecycle Tests (`app.e2e-spec.ts`)
    - 9/9 Python FastAPI Pytest Cases (`test_endpoints.py`)
  - [x] **VERTICAL SLICE 1: FROZEN & 100% HOÀN TẤT**
- [/] **Vertical Slice 2: Japanese Manga-OCR & AI Processing Engine (PyTorch & Inpainting)**
  - [x] **Vertical Slice 2A: Japanese Manga-OCR Foundation (100% HOÀN TẤT):**
    - [x] Core Migration 0004: Drop default `confidence`, hỗ trợ nullable semantics cho OCR segments.
    - [x] Core API validation: `WorkerSegmentDto` kiểm tra toạ độ pixel (`INT >= 0`) và `confidence` nullable.
    - [x] Local Environment & Cache: Thiết lập tuyệt đối `HF_HOME` và `TORCH_HOME` vào `services/ai-worker/.cache/`.
    - [x] Package Extractor: Tải & thẩm định an toàn ZIP (100MB, 100:1 ratio, 500 entries, 200 pages, 4096px, traversal & magic header check).
    - [x] Bubble & Text Region Detector: OpenCV morphology contour extraction, xuất toạ độ pixel INT chuẩn xác.
    - [x] Reading Order Engine: Thuật toán sắp xếp Manga RTL / TTB deterministic 100%.
    - [x] ProgressSink & Heartbeat Emitter: Standalone execution không làm corrupt production TranslationJob, periodic keep-alive.
    - [x] MangaOcrEngine Singleton: Concurrency guard (`asyncio.Semaphore(1)`), lazy loading, thread-safe.
    - [x] Debug Preview Generator: Xuất ảnh WebP hiển thị bounding box và nhãn `#1`, `#2` (không phụ thuộc font hệ điều hành).
    - [x] Test Pyramid: 144/144 tests passing (117 NestJS Core + 27 Python Pytest bao gồm Real HuggingFace Model test).
  - [ ] **Vertical Slice 2B: Inpainting & Typesetting:**
    - [ ] Inpainting xóa thoại nguyên bản bằng LaMa / OpenCV inpaint.
    - [ ] Typesetting tự động: Wrap text tiếng Việt, chọn font Manga, tự động co giãn font theo khung bóng thoại.
- [ ] **Vertical Slice 3: Light Novel Pipeline Slice**
  - [ ] Text chunking & Segment alignment
  - [ ] Khớp từ điển thuật ngữ (`glossaries` table) chống sai lệch tên riêng/chiêu thức
  - [ ] Dịch văn phong tiểu thuyết qua LLM Adapter

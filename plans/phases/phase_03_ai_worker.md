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
- [x] **Vertical Slice 1: Khởi tạo Hạ tầng & Orchestration Contract**
  - [x] Thiết lập môi trường cục bộ cô lập `services/ai-worker` (`.venv` Python 3.10+ / requirements.txt / FastAPI skeleton)
  - [x] Migration 0003: TypeORM Migration thêm orchestration metadata, idempotency & fencing sequence
  - [x] Xây dựng BullMQ Producer & Consumer trong NestJS Core API (`services/api/src/modules/translation`) quản lý đúng 14 trạng thái của `TranslationJob`
  - [x] Xây dựng REST Worker Contract hai chiều giữa NestJS và Python FastAPI (`/internal/v1/ai/jobs/:id/events` có fencing token và safe buffer `timingSafeEqual`)
  - [x] Tích hợp Watchdog Reconciler (khôi phục `VALIDATING` stalled) và Heartbeat Watchdog (abort HTTP connection khi worker treo)
  - [x] Xây dựng WebSocket Gateway (`/ws/ai`) thông báo tiến trình đa kênh (`job_progress`, `job_ready_for_review`, `job_failed`, `job_canceled`)
  - [x] Xây dựng API Huỷ Job (`POST /api/v1/ai/jobs/:id/cancel`)
  - [x] Xây dựng 2 chiến lược xuất bản chuẩn immutable (`OVERWRITE_ACTIVE_VERSION` & `CREATE_ALTERNATE_VERSION`)
  - [x] Viết và hoàn thiện 21 E2E test cases (Describe 8) + 3 Python pytest cases (100% Green).
- [ ] **Vertical Slice 2: Japanese Manga-OCR & AI Processing Engine (PyTorch & Inpainting)**
  - [ ] Tải package an toàn từ `upload_sessions.final_key` trong MinIO
  - [ ] Text Bubble Detection (Contour / Bounding Box)
  - [ ] Japanese Manga-OCR (Manga-OCR PyTorch model tối ưu cho tiếng Nhật)
  - [ ] Inpainting xóa thoại nguyên bản bằng LaMa / OpenCV inpaint
  - [ ] Typesetting tự động: Wrap text tiếng Việt, chọn font Manga, tự động co giãn font theo khung bóng thoại
- [ ] **Vertical Slice 3: Light Novel Pipeline Slice**
  - [ ] Text chunking & Segment alignment
  - [ ] Khớp từ điển thuật ngữ (`glossaries` table) chống sai lệch tên riêng/chiêu thức
  - [ ] Dịch văn phong tiểu thuyết qua LLM Adapter

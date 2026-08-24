# 📋 Phase 3: AI Translation Worker & Image Processing Pipeline (phase_03_ai_worker.md)

- **Mục tiêu:** Xây dựng dịch vụ AI Worker (`services/ai-worker` bằng Python FastAPI / Celery / PyTorch) điều phối qua BullMQ & Redis Queue từ NestJS Core API, thực hiện quy trình dịch thuật Manga & Novel khép kín với Japanese Manga-OCR (MVP), Inpainting tẩy chữ thoại, Machine Translation kèm Glossary Context, Typesetting chữ tiếng Việt, và hoàn thiện 2 chiến lược xuất bản: **Ghi đè (Overwrite)** và **Nhân bản Version (Duplicate)**.
- **Trọng tâm MVP Scope (AI SSoT):** 
  - **Manga OCR:** Tập trung chuyên sâu **Manga tiếng Nhật (Japanese Manga-OCR)** cho bản MVP. Ngôn ngữ Hàn (Manhwa) / Trung (Manhua) được thiết kế theo Interface Adapter mở rộng cho V1.
  - **Lộ trình Vertical Slice:**
    1. BullMQ Queue & `TranslationJob` state machine (`QUEUED` $\rightarrow$ `PROCESSING` $\rightarrow$ `COMPLETED` / `FAILED`).
    2. Python FastAPI Worker internal contract & MinIO Quarantine fetch.
    3. Japanese Manga-OCR pipeline (Text bubble detection + OCR).
    4. One-page OCR pipeline test & verification.
    5. Glossary extraction & Translation adapter (OpenAI / Claude / Gemini / DeepL fallback).
    6. Inpainting text removal & Typesetting font render.
    7. 1 Chapter End-to-End translation pipeline.
    8. Áp dụng 2 chiến lược: Overwrite vs Duplicate ChapterVersion.
- **Trạng thái:** [ ] Sẵn sàng khởi động

---

### Danh Sách Đầu Việc (Checklist):
- [ ] Thiết lập môi trường cục bộ cô lập `services/ai-worker` (`.venv` Python 3.10+ / requirements.txt / FastAPI skeleton)
- [ ] Thiết lập BullMQ Queue & Worker State Machine trong NestJS Core API (`services/api/src/modules/translation`)
- [ ] Xây dựng REST Worker Contract giữa NestJS và Python FastAPI (`POST /internal/v1/jobs/process-manga`, `POST /internal/v1/jobs/process-novel`)
- [ ] Xây dựng Manga Pipeline Slice:
  - Text Bubble Detection (Contour / Bounding Box)
  - Japanese Manga-OCR (Manga-OCR PyTorch model tối ưu cho tiếng Nhật)
  - Inpainting xóa thoại nguyên bản bằng LaMa / OpenCV inpaint
  - Typesetting tự động: Wrap text tiếng Việt, chọn font Manga, tự động co giãn font theo khung bóng thoại
- [ ] Xây dựng Light Novel Pipeline Slice:
  - Text chunking & Segment alignment
  - Khớp từ điển thuật ngữ (`glossaries` table) chống sai lệch tên riêng/chiêu thức
  - Dịch văn phong tiểu thuyết qua LLM Adapter
- [ ] Xây dựng Logic 2 phương án lưu kết quả:
  - **Phương án 1 (Ghi đè - Overwrite):** Cập nhật trực tiếp `active_version_id` hoặc thay thế media assets của version hiện tại.
  - **Phương án 2 (Nhân bản - Duplicate):** Tạo bản ghi mới trong `chapter_versions` với `version_type = 'AI_TRANSLATED'`, giữ nguyên version gốc.
- [ ] Viết kiểm thử E2E / Integration xác minh luồng dịch hoàn chỉnh từ Upload raw $\rightarrow$ Worker xử lý $\rightarrow$ Promote MediaAsset / ChapterVersion.

# 📋 Phase 1: Setup & Architecture Baseline

- **Mục tiêu:** Thiết lập nền tảng dự án Monorepo, cấu hình môi trường, khởi tạo CodeGraph và CSDL PostgreSQL 16.
- **Trạng thái:** [/] Đang thực hiện

---

### Danh Sách Đầu Việc (Checklist):
- [x] Tạo cấu trúc thư mục Monorepo (`apps/`, `services/`, `packages/`, `deploy/`, `plans/`)
- [x] Khởi tạo CodeGraph knowledge map
- [x] Khởi tạo file cấu hình `.agents/AGENTS.md`, `.env.example` và `.env`
- [x] Thiết lập trung tâm tài liệu kế hoạch `plans/planning/` (24 tài liệu đặc tả chuẩn hóa) và `plans/phases/`
- [ ] Khởi tạo cụm Docker Compose nền tảng (PostgreSQL 16, Redis 7, MinIO S3)
- [ ] Khởi tạo CSDL PostgreSQL 16 (DDL 20+ bảng quan hệ từ `09_DATABASE_AND_STORAGE.md`)
- [ ] Khởi tạo MinIO Buckets (`manga-media`, `novel-media`)

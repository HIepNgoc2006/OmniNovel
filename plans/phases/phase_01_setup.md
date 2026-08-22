# 📋 Phase 1: Setup & Architecture Baseline

- **Mục tiêu:** Thiết lập nền tảng dự án Monorepo, cấu hình môi trường, khởi tạo CodeGraph và CSDL PostgreSQL 16.
- **Trạng thái:** [/] Đang thực hiện (85%)

---

### Danh Sách Đầu Việc (Checklist):
- [x] Tạo cấu trúc thư mục Monorepo (`apps/`, `services/`, `packages/`, `deploy/`, `plans/`)
- [x] Khởi tạo CodeGraph knowledge map
- [x] Khởi tạo file cấu hình `.agents/AGENTS.md`, `.env.example` và `.env`
- [x] Thiết lập trung tâm tài liệu kế hoạch `plans/planning/` (24 tài liệu đặc tả chuẩn hóa - Tag `planning-v1.0`) và `plans/phases/`
- [x] Khởi tạo cụm Docker Compose nền tảng (PostgreSQL 16, Redis 7, MinIO S3) tại `deploy/docker-compose.dev.yml`
- [x] Khởi tạo CSDL PostgreSQL 16 (DDL 27 bảng quan hệ và seed rank themes tại `deploy/init-db/01_init.sql`)
- [x] Cấu hình khởi tạo tự động MinIO Buckets (`manga-media`, `novel-media`) qua service `minio-init-buckets`
- [x] Khởi tạo và cấu hình build package `@omninovel/shared` (`packages/shared/tsconfig.json`)
- [ ] Chạy kiểm thử khói hạ tầng (Infrastructure Smoke Test: Docker Compose up, Postgres healthy, Redis ping, MinIO buckets verified)

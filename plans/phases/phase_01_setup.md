# 📋 Phase 1: Setup & Architecture Baseline

- **Mục tiêu:** Thiết lập nền tảng dự án Monorepo, cấu hình môi trường, khởi tạo CodeGraph và CSDL PostgreSQL 16.
- **Trạng thái:** [x] Đã hoàn thành (100% Phase 1 Baseline Verified)

---

### Danh Sách Đầu Việc (Checklist):
- [x] Tạo cấu trúc thư mục Monorepo (`apps/`, `services/`, `packages/`, `deploy/`, `plans/`)
- [x] Khởi tạo CodeGraph knowledge map
- [x] Khởi tạo file cấu hình `.agents/AGENTS.md`, `.env.example` và `.env`
- [x] Thiết lập trung tâm tài liệu kế hoạch `plans/planning/` (24 tài liệu đặc tả chuẩn hóa - Tag `planning-v1.0`) và `plans/phases/`
- [x] Khởi tạo cụm Docker Compose nền tảng (PostgreSQL 16, Redis 7, MinIO S3) tại `deploy/docker-compose.dev.yml`
- [x] Khởi tạo CSDL PostgreSQL 16 (DDL 27 bảng quan hệ và seed rank themes tại `deploy/init-db/01_init.sql`)
- [x] Cấu hình và thực thi khởi tạo tự động MinIO Buckets (`manga-media`, `novel-media`) qua service `minio-init-buckets`
- [x] Khởi tạo và biên dịch thành công package `@omninovel/shared` (`packages/shared/tsconfig.json`)
- [x] Chạy kiểm thử khói hạ tầng thực tế (Infrastructure Smoke Test Verified):
  * PostgreSQL 16: Up & Healthy, 27 bảng quan hệ khởi tạo chuẩn xác.
  * Redis 7: Up & Healthy, ping $\rightarrow$ `PONG`.
  * MinIO: Up & Healthy, buckets `manga-media` và `novel-media` đã sẵn sàng.
  * Same-chapter foreign key invariant (`fk_active_version_same_chapter`) hoạt động tin cậy.

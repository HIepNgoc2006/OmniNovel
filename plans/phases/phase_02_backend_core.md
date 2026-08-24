# 📋 Phase 2: Core Backend API, Database Migrations & Security (phase_02_backend_core.md)

- **Mục tiêu:** Xây dựng NestJS Core API, thiết lập Database Migration Layer (TypeORM - ADR-011), hệ thống Auth (Argon2id + JWT 15m + Refresh Rotation trên Redis) và phân quyền RBAC kép.
- **Tài liệu Kế hoạch Chi tiết:** Xem [plans/phases/phase_02_implementation_plan.md](file:///e:/Workspace%202/Doctruyen_project/plans/phases/phase_02_implementation_plan.md)
- **Trạng thái:** [/] Đang thực hiện (Core API & Auth Foundation 100% Verified)

---

### Danh Sách Đầu Việc (Checklist):
- [x] Khởi tạo NestJS Core API skeleton (`services/api`) với ConfigModule, CorrelationId (`x-request-id`), GlobalExceptionFilter (StandardErrorResponse JSON) và Health checks (`/health/live`, `/health/ready`)
- [x] Thiết lập TypeORM Migration Layer (`synchronize: false` - ADR-011) và migration khởi tạo `1700000000000-InitialDatabaseSchema.ts` (27 bảng CSDL, Composite Invariant FK, seed 6 rank themes)
- [x] Xây dựng Module Authentication: Mật khẩu băm bằng Argon2id, Access Token 15 phút, Refresh Token 7 ngày với cơ chế Rotation & Session Tracking trên Redis
- [x] Xây dựng Module Users & Hồ sơ tiến trình độc giả (User Progression, Rank Themes, Rank Levels)
- [x] Xây dựng Hệ thống Phân quyền kép (GlobalRolesGuard & StoryMembershipGuard - chống hoàn toàn IDOR)
- [x] Xây dựng Core API CRUD Bộ truyện (Stories), Thể loại (Genres), Tác giả (Creators) và Ấn bản (StoryEditions)
- [x] Xây dựng Core API Quản lý Tập truyện (Volumes), Chương truyện (Chapters) và Phiên bản Bất biến (ChapterVersions, same-chapter invariant)
- [x] Chạy kiểm thử tự động toàn diện (`npm run test:e2e` - 16/16 test cases pass 100%)
- [ ] Xây dựng Module Storage với MinIO (Strictly Private Buckets, Pre-signed Upload/Download URLs & Magic Bytes validation)
- [ ] Tích hợp Redis Caching nâng cao cho Top Rankings và Rate Limiting Anti-Leech

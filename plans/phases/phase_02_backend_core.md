# 📋 Phase 2: Core Backend API, Database Migrations & Security (phase_02_backend_core.md)

- **Mục tiêu:** Xây dựng NestJS Core API, thiết lập Database Migration Layer (TypeORM - ADR-011), hệ thống Auth (Argon2id + JWT 15m + Refresh Rotation trên Redis) và phân quyền RBAC kép.
- **Tài liệu Kế hoạch Chi tiết:** Xem [plans/phases/phase_02_implementation_plan.md](file:///e:/Workspace%202/Doctruyen_project/plans/phases/phase_02_implementation_plan.md)
- **Trạng thái:** [/] Đang thực hiện

---

### Danh Sách Đầu Việc (Checklist):
- [ ] Khởi tạo NestJS Core API skeleton (`services/api`) với ConfigModule, CorrelationId, GlobalExceptionFilter và Health checks
- [ ] Thiết lập TypeORM Migration Layer (`synchronize: false`) và migration khởi tạo `1700000000000-InitialDatabaseSchema.ts` (ADR-011)
- [ ] Xây dựng Module Authentication: Mật khẩu băm bằng Argon2id, Access Token 15 phút, Refresh Token 7 ngày với cơ chế Rotation & Session Tracking trên Redis
- [ ] Xây dựng Module Users & Hồ sơ tiến trình độc giả (User Progression)
- [ ] Xây dựng Hệ thống Phân quyền kép (GlobalRolesGuard & StoryMembershipGuard - chống hoàn toàn IDOR)
- [ ] Xây dựng Core API CRUD Bộ truyện (Stories), Thể loại (Genres), Tác giả (Creators) và Ấn bản (StoryEditions)
- [ ] Xây dựng Core API Quản lý Tập truyện (Volumes), Chương truyện (Chapters) và Phiên bản Bất biến (ChapterVersions)
- [ ] Xây dựng Module Storage với MinIO (Strictly Private Buckets, Pre-signed Upload/Download URLs & Magic Bytes validation)
- [ ] Tích hợp Redis Caching cho Featured Stories, Top Rankings và Rate Limiting
- [ ] Viết bộ kiểm thử tích hợp (Auth Integration, RBAC, Catalog CRUD, Chapter Invariant & MinIO Security)

# 📋 Phase 2: Core Backend API, Database Migrations & Security (phase_02_backend_core.md)

- **Mục tiêu:** Xây dựng NestJS Core API, thiết lập Database Migration Layer (TypeORM - ADR-011), hệ thống Auth (Argon2id + JWT 15m + Refresh Rotation & Token Family Revocation trên Redis), phân quyền RBAC kép chống IDOR, và bảo vệ Privacy/Hierarchy Invariants.
- **Tài liệu Kế hoạch Chi tiết:** Xem [plans/phases/phase_02_implementation_plan.md](file:///e:/Workspace%202/Doctruyen_project/plans/phases/phase_02_implementation_plan.md)
- **Trạng thái:** [/] Đang thực hiện (Core API, Auth, RBAC, Privacy & Hierarchy Foundation 100% Verified qua 28 E2E Test Cases)

---

### Danh Sách Đầu Việc (Checklist):
- [x] Khởi tạo NestJS Core API skeleton (`services/api`) với ConfigModule (Zod strict validation chặn production default secret), CorrelationId (`x-request-id`), GlobalExceptionFilter (StandardErrorResponse JSON) và Health checks (`/health/live`, `/health/ready`)
- [x] Thiết lập TypeORM Migration Layer (`synchronize: false` - ADR-011) và migration khởi tạo `1700000000000-InitialDatabaseSchema.ts` (27 bảng CSDL, Composite Invariant FK, seed 6 rank themes)
- [x] Xây dựng Module Authentication: Mật khẩu băm bằng Argon2id, Access Token 15 phút, Refresh Token 7 ngày với Token Family Reuse Detection & Session Revocation thực tế trên Redis (kiểm thử 401 khi reuse / sau logout)
- [x] Xây dựng Module Users & Hồ sơ tiến trình độc giả (User Progression tạo atomic trong transaction khi đăng ký)
- [x] Xây dựng Hệ thống Phân quyền kép chống IDOR (`GlobalRolesGuard` & `StoryMemberGuard` tự động truy vết hierarchy từ `storyId`, `editionId`, `volumeId`, `chapterId`, `versionId` về `story_members`)
- [x] Áp dụng Permission Matrix đã freeze: Kích hoạt Active Version chỉ cho phép `StoryMemberRole.EDITOR`, `StoryMemberRole.OWNER` hoặc `GlobalRole.ADMIN` (chặn role Story `TRANSLATOR` với 403 Forbidden)
- [x] Bảo vệ Privacy Policy: Story/Chapter `PRIVATE` yêu cầu xác thực và quyền Story Member/Admin (chặn anonymous và unauthorized reader với 403 Forbidden); Story `UNLISTED` cho phép truy cập direct URL
- [x] Bảo vệ Hierarchy & Concurrency Invariants: Kiểm tra tính trực thuộc giữa Volume và Edition (Hierarchy Invariant); Pessimistic lock khi cấp phát version number
- [x] Core API Catalog & Publishing: `GET /stories`, `GET /stories/featured`, `GET /stories/rankings`, `GET /stories/:slug`, `POST /studio/stories` (Transactional: Story + Owner + Default Edition), `POST /studio/stories/:id/editions`, `POST /studio/editions/:id/volumes`, `POST /studio/editions/:id/chapters`, `POST /studio/chapters/:id/versions`, `PATCH /studio/chapters/:id/active-version`, `PATCH /stories/:id/visibility`
- [x] Chạy kiểm thử tự động toàn diện (`npm run test:e2e` - **28/28 test cases pass 100%**)
- [ ] Xây dựng Module Storage với MinIO (Strictly Private Buckets, Pre-signed Upload/Download URLs & Magic Bytes validation)
- [ ] Tích hợp Redis Caching nâng cao cho Top Rankings và Rate Limiting Anti-Leech
- [ ] Xây dựng Module Gamification & Sổ cái Bất biến Reward Ledger

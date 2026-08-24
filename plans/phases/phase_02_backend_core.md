# 📋 Phase 2: Core Backend API, Database Migrations, MinIO Storage & Security (phase_02_backend_core.md)

- **Mục tiêu:** Xây dựng NestJS Core API, thiết lập Database Migration Layer (TypeORM - ADR-011), hệ thống Auth (Argon2id + JWT 15m + Refresh Rotation & Token Family Revocation trên Redis), phân quyền RBAC kép chống IDOR, bảo vệ Privacy/Hierarchy Invariants và MinIO Storage Upload Lifecycle an toàn (Quarantine -> Validate Magic Bytes -> Promote & Presigned URLs 15m).
- **Tài liệu Kế hoạch Chi tiết:** Xem [plans/phases/phase_02_implementation_plan.md](file:///e:/Workspace%202/Doctruyen_project/plans/phases/phase_02_implementation_plan.md)
- **Trạng thái:** [/] Đang thực hiện (Core API, Auth, RBAC, Privacy, Hierarchy & MinIO Storage 100% Verified qua 36 E2E Test Cases)

---

### Danh Sách Đầu Việc (Checklist):
- [x] Khởi tạo NestJS Core API skeleton (`services/api`) với ConfigModule (Zod strict validation chặn production default secret), CorrelationId (`x-request-id`), GlobalExceptionFilter (StandardErrorResponse JSON) và Health checks (`/health/live`, `/health/ready`)
- [x] Thiết lập TypeORM Migration Layer (`synchronize: false` - ADR-011), migration khởi tạo `1700000000000-InitialDatabaseSchema.ts` (27 bảng) và migration mới `1700000000001-CreateUploadSessionsTable.ts` (`upload_sessions` table)
- [x] Xây dựng Module Authentication: Mật khẩu băm bằng Argon2id, Access Token 15 phút, Refresh Token 7 ngày với Token Family Reuse Detection & Session Revocation thực tế trên Redis (kiểm thử 401 khi reuse / sau logout / whole family revocation)
- [x] Xây dựng Module Users & Hồ sơ tiến trình độc giả (User Progression tạo atomic trong transaction khi đăng ký)
- [x] Xây dựng `OptionalJwtAuthGuard` chuẩn xác thực Passport JwtStrategy, kiểm tra trạng thái active/deleted mà không bypass security
- [x] Xây dựng Hệ thống Phân quyền kép chống IDOR (`GlobalRolesGuard` & `StoryMemberGuard` tự động truy vết hierarchy từ `storyId`, `editionId`, `volumeId`, `chapterId`, `versionId` về `story_members`)
- [x] Áp dụng Permission Matrix đã freeze: Kích hoạt Active Version chỉ cho phép `StoryMemberRole.EDITOR`, `StoryMemberRole.OWNER` hoặc `GlobalRole.ADMIN` (chặn role Story `TRANSLATOR` với 403 Forbidden)
- [x] Bảo vệ Privacy Policy: Story/Chapter `PRIVATE` yêu cầu xác thực và quyền Story Member/Admin (chặn anonymous và unauthorized reader với 403 Forbidden); Story `UNLISTED` cho phép truy cập direct URL
- [x] Bảo vệ Hierarchy & Concurrency Invariants: Kiểm tra tính trực thuộc giữa Volume và Edition (Hierarchy Invariant); Pessimistic lock khi cấp phát version number
- [x] Core API Catalog & Publishing: `GET /stories`, `GET /stories/featured`, `GET /stories/rankings`, `GET /stories/:slug`, `POST /studio/stories` (Transactional: Story + Owner + Default Edition), `POST /studio/stories/:id/editions`, `POST /studio/editions/:id/volumes`, `POST /studio/editions/:id/chapters`, `POST /studio/chapters/:id/versions`, `PATCH /studio/chapters/:id/active-version`, `PATCH /stories/:id/visibility`
- [x] Xây dựng Module Storage với MinIO (`services/api/src/modules/storage`):
  - Buckets ở trạng thái **Strictly Private** (Anonymous GET bị từ chối 403)
  - Quy trình upload an toàn: **Quarantine Prefix $\rightarrow$ Presigned PUT $\rightarrow$ Finalize Validation $\rightarrow$ Promote**
  - Xác thực Magic Bytes thực tế (PNG, JPEG, WebP, ZIP, EPUB) chống giả mạo MIME type
  - Quét an ninh ZIP chống Path Traversal / Zip Slip (`../`) và Zip Bomb (> 500MB)
  - Cấp Presigned GET URL ngắn hạn 15 phút bảo vệ theo Privacy Model của Story & Chapter
- [x] Chạy kiểm thử tự động toàn diện (`npm run test:e2e` - **36/36 test cases pass 100%**)
- [ ] Tích hợp Redis Caching nâng cao cho Top Rankings và Rate Limiting Anti-Leech
- [ ] Xây dựng Module Gamification & Sổ cái Bất biến Reward Ledger

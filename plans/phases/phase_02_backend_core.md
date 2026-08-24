# 📋 Phase 2: Core Backend API, Database Migrations, MinIO Storage, Security & Gamification (phase_02_backend_core.md)

- **Mục tiêu:** Xây dựng NestJS Core API, thiết lập Database Migration Layer (TypeORM - ADR-011), hệ thống Auth (Argon2id + JWT 15m + Refresh Rotation & Token Family Revocation trên Redis), phân quyền RBAC kép chống IDOR, bảo vệ Privacy/Hierarchy Invariants, MinIO Storage Upload Lifecycle an toàn (Quarantine -> Validate Magic Bytes -> Promote & Presigned URLs 15m), hệ thống Rate Limiting Anti-Leech bằng Redis Sliding Window Lua script, và Hệ thống Gamification với Sổ Cái Bất Biến (Immutable Reward Ledger).
- **Tài liệu Kế hoạch Chi tiết:** Xem [plans/phases/phase_02_implementation_plan.md](file:///e:/Workspace%202/Doctruyen_project/plans/phases/phase_02_implementation_plan.md)
- **Trạng thái:** [x] Hoàn thành 100% (Core API, Auth, RBAC, Privacy, Hierarchy, MinIO Storage Hardening, Redis Rate Limiting & Gamification Immutable Ledger 100% Verified qua 52 E2E Test Cases)

---

### Danh Sách Đầu Việc (Checklist):
- [x] Khởi tạo NestJS Core API skeleton (`services/api`) với ConfigModule (Zod strict validation chặn production default secret), CorrelationId (`x-request-id`), GlobalExceptionFilter (StandardErrorResponse JSON) và Health checks (`/health/live`, `/health/ready`)
- [x] Thiết lập TypeORM Migration Layer (`synchronize: false` - ADR-011), migration khởi tạo `1700000000000-InitialDatabaseSchema.ts` (27 bảng) và migration mới `1700000000001-CreateUploadSessionsTable.ts` (`upload_sessions` table)
- [x] Xây dựng Module Authentication: Mật khẩu băm bằng Argon2id, Access Token 15 phút, Refresh Token 7 ngày với Token Family Reuse Detection & Session Revocation thực tế trên Redis (kiểm thử 401 khi reuse / sau logout / whole family revocation)
- [x] Xây dựng Module Users & Hồ sơ tiến trình độc giả (User Progression tạo atomic trong transaction khi đăng ký khớp chính xác SSoT)
- [x] Xây dựng `OptionalJwtAuthGuard` chuẩn xác thực Passport JwtStrategy, kiểm tra trạng thái active/deleted mà không bypass security
- [x] Xây dựng Hệ thống Phân quyền kép chống IDOR (`GlobalRolesGuard` & `StoryMemberGuard` tự động truy vết hierarchy từ `storyId`, `editionId`, `volumeId`, `chapterId`, `versionId` về `story_members`)
- [x] Áp dụng Permission Matrix đã freeze: Kích hoạt Active Version chỉ cho phép `StoryMemberRole.EDITOR`, `StoryMemberRole.OWNER` hoặc `GlobalRole.ADMIN` (chặn role Story `TRANSLATOR` với 403 Forbidden)
- [x] Bảo vệ Privacy Policy: Story/Chapter `PRIVATE` yêu cầu xác thực và quyền Story Member/Admin (chặn anonymous và unauthorized reader với 403 Forbidden); Story `UNLISTED` cho phép truy cập direct URL
- [x] Bảo vệ Hierarchy & Concurrency Invariants: Kiểm tra tính trực thuộc giữa Volume và Edition (Hierarchy Invariant); Pessimistic lock khi cấp phát version number
- [x] Core API Catalog & Publishing: `GET /stories`, `GET /stories/featured`, `GET /stories/rankings`, `GET /stories/:slug`, `POST /studio/stories` (Transactional: Story + Owner + Default Edition), `POST /studio/stories/:id/editions`, `POST /studio/editions/:id/volumes`, `POST /studio/editions/:id/chapters`, `POST /studio/chapters/:id/versions`, `PATCH /studio/chapters/:id/active-version`, `PATCH /stories/:id/visibility`
- [x] Xây dựng Module Storage với MinIO (`services/api/src/modules/storage`):
  - Buckets ở trạng thái **Private** (Anonymous GET bị từ chối 403)
  - Quy trình upload: **Quarantine Prefix $\rightarrow$ Presigned PUT $\rightarrow$ Finalize Validation $\rightarrow$ Promote**
  - **Khóa Atomic PENDING $\rightarrow$ VALIDATING sau khi đã xác thực quyền người dùng** (triệt tiêu hoàn toàn Authorization-triggered DoS)
  - **Khớp kích thước byte chính xác (exact `expectedSize`)** và giới hạn tối đa 100MB theo đúng Security SSoT
  - Xác thực Magic Bytes thực tế (PNG, JPEG, WebP, ZIP, EPUB) giảm thiểu rủi ro giả mạo MIME type
  - Quét an ninh ZIP chống Path Traversal / Zip Slip (`../`), kiểm tra tỷ lệ nén $< 100:1$ (chống Zip Bomb), và giới hạn $\le 500$ entries
  - Xác thực cấu trúc chuẩn EPUB (`mimetype: application/epub+zip`, `META-INF/container.xml`) và quét Stored XSS trong Markdown (`<script>`, `<iframe>`)
  - **Phân định rõ ràng**: File nén thô (ZIP/EPUB/MD) được lưu trữ làm Raw Source Package trong `upload_sessions` cho AI/Import pipeline, không ghi nhận sớm thành `MediaAsset` đơn lẻ render-ready
  - Cấp Presigned GET URL ngắn hạn 15 phút bảo vệ theo Privacy Model của Story & Chapter
- [x] Xây dựng Module Rate Limiting Anti-Leech bằng Redis Sliding Window Lua script:
  - Header chuẩn IETF: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (tính từ request cũ nhất trong sliding window)
  - Throttling `429 Too Many Requests` với `Retry-After` header khi vượt ngưỡng tần suất
  - Enforce đồng thời `IP_AND_USER` (cả IP bucket và User bucket) và ngăn chặn giả mạo IP `X-Forwarded-For`
  - Bảo vệ Auth (30 req/min/IP), Uploads (15 req/min/User), Reader Content & Signed Media URLs (60 req/min/IP/User)
- [x] Xây dựng Module Gamification & Sổ Cái Bất Biến (Reward Ledger):
  - **Sổ cái Bất biến `reward_transactions`**: Khóa trùng lặp `idempotency_key` duy nhất (`CHECKIN:userId:YYYY-MM-DD:EXP`, `READ:userId:chapterId:EXP`, `LEVEL_REWARD:userId:milestone:OMNICOIN`), không xóa/sửa dữ liệu ledger.
  - **Điểm danh hàng ngày (`POST /gamification/check-in`)**: Quản lý chuỗi ngày liên tục (`current_streak`, `max_streak`), thưởng EXP/Omnicoin và thưởng bonus mốc chuỗi 7/30 ngày. Đảm bảo tính Idempotent nếu gọi lại trong ngày.
  - **Thưởng EXP Đọc Truyện (`POST /gamification/read-chapter`)**: 1 reward/user/chapter, giới hạn trần chống cày farm 100 EXP/ngày.
  - **Công thức Cấp độ SSoT**: Level $L$ yêu cầu $100 \times (L - 1)^2$ Total EXP.
  - **Đổi Danh hiệu / Rank Themes (`POST /gamification/themes/:id/equip`)**: Hỗ trợ 5 chủ đề cấp bậc (Mặc Định, Tu Tiên, Game Thủ, Ma Vương, Pháp Sư, Tinh Không).
  - **Phần thưởng mốc Cấp độ (`POST /gamification/level-rewards/:milestone/claim`)**: Nhận Omnicoin khi đạt mốc level.
  - **Bảng xếp hạng Top độc giả (`GET /gamification/leaderboard`)** và **Lịch sử biến động sổ cái (`GET /gamification/history`)**.
- [x] Chạy kiểm thử tự động toàn diện (`npm run test:e2e` - **52/52 test cases pass 100%**)

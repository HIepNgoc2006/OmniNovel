# 📋 Kế Hoạch Triển Khai Kỹ Thuật Phase 2: Core Backend API, Database Migration Layer & Authentication (phase_02_implementation_plan.md)

Tài liệu này là **Bản Thiết Kế Triển Khai Kỹ Thuật (Technical Implementation Plan)** cho Phase 2 của dự án OmniNovel, đặc tả chi tiết kiến trúc NestJS Core API, chiến lược Database Migration với TypeORM (ADR-011), cơ chế bảo mật danh tính & phân quyền kép (Multi-level RBAC), và quy trình quản trị xuất bản truyện (Story/Edition/Volume/Chapter/Version).

---

## 1. MỤC TIÊU & PHẠM VI (SCOPE & OBJECTIVES)

1. **Khởi tạo Kiến trúc NestJS chuẩn mực (`services/api`)**:
   - Sử dụng Clean Architecture phân lớp: `Domain Entities`, `Data Access / Repositories`, `Application Services`, `Presentation Controllers`.
   - Chuẩn phản hồi lỗi toàn cục [`StandardErrorResponse`](file:///e:/Workspace%202/Doctruyen_project/packages/shared/src/index.ts) theo hợp đồng `10_API_AND_EVENT_CONTRACTS.md`.
   - Health check endpoints: `/health/live` và `/health/ready`.
   - Correlation ID middleware (`x-request-id`) để truy vết nhật ký kiểm toán.
2. **Xây dựng Database Migration System (TypeORM Migrations SSoT - ADR-011)**:
   - TypeORM DataSource với `synchronize: false` tuyệt đối.
   - Migration file timestamped là **Nguồn Sự Thật Duy Nhất (SSoT)** cho mọi tiến hóa CSDL từ Phase 2 trở đi.
   - Initial migration `1700000000000-InitialDatabaseSchema.ts` tạo trọn vẹn 27 bảng quan hệ, các composite constraints và seed 6 rank themes.
3. **Module Xác thực & Quản Lý Phiên (Auth & Session Security)**:
   - Mật khẩu người dùng được băm an toàn bằng thuật toán **Argon2id**.
   - **Access Token:** JWT thời hạn **15 phút** (NFR compliant), truyền qua header `Authorization: Bearer <token>`.
   - **Refresh Token:** JWT thời hạn **7 ngày**, lưu trữ trong `httpOnly + Secure + SameSite=Strict` Cookie trên Web và Secure Storage trên Mobile.
   - **Refresh Token Rotation & Session Tracking:** Quản lý phiên và token family trên Redis (`session:<user_id>:<jti>`); thu hồi toàn bộ token family nếu phát hiện hành vi tái sử dụng token cũ.
4. **Hệ thống Phân quyền Đa cấp độ (Multi-Level RBAC Guards)**:
   - `GlobalRolesGuard`: Kiểm soát quyền toàn cục (`ADMIN`, `TRANSLATOR`, `READER`).
   - `StoryMembershipGuard`: Kiểm soát quyền sở hữu ngữ cảnh bộ truyện (`OWNER`, `EDITOR`, `TRANSLATOR`, `UPLOADER`), chống hoàn toàn lỗ hổng IDOR.
5. **Core Catalog & Publishing Management API**:
   - Khám phá & Tra cứu truyện (`GET /stories`, `GET /stories/featured`, `GET /stories/rankings`, `GET /stories/:slug`).
   - Quản trị dòng xuất bản Studio (`POST /studio/stories`, `POST /studio/stories/:id/editions`, `POST /studio/editions/:id/volumes`, `POST /studio/volumes/:id/chapters`).
   - Điều khiển trạng thái hiển thị (`PATCH /stories/:id/visibility` với `PUBLIC | UNLISTED | PRIVATE`).
   - Quản lý phiên bản bất biến (`ChapterVersion`) và bảo vệ invariant `active_version_id` cùng chapter.

---

## 2. CẤU TRÚC THƯ MỤC CHUẨN (`services/api`)

```text
services/api/
├── src/
│   ├── config/               # Cấu hình biến môi trường & validation (Zod/class-validator)
│   │   ├── env.config.ts
│   │   └── env.validation.ts
│   ├── database/             # TypeORM DataSource, Migrations, Base Entities
│   │   ├── data-source.ts    # CLI TypeORM DataSource (synchronize: false)
│   │   ├── migrations/       # Timestamped migration files
│   │   │   └── 1700000000000-InitialDatabaseSchema.ts
│   │   └── base.entity.ts
│   ├── redis/                # Redis Module & Connection Pool (ioredis)
│   │   ├── redis.module.ts
│   │   └── redis.service.ts
│   ├── common/               # Middleware, Filters, Interceptors, Decorators, Guards
│   │   ├── filters/          # GlobalExceptionFilter (StandardErrorResponse)
│   │   ├── guards/           # JwtAuthGuard, GlobalRolesGuard, StoryMemberGuard
│   │   ├── decorators/       # CurrentUser, Roles, RequireStoryRole
│   │   └── middleware/       # CorrelationIdMiddleware
│   ├── modules/
│   │   ├── health/           # HealthController (/health/live, /health/ready)
│   │   ├── auth/             # AuthController, AuthService, JwtStrategy, RefreshStrategy
│   │   ├── users/            # UsersController, UsersService, UserEntity, ProgressionEntity
│   │   ├── stories/          # StoriesController, StoriesService, StoryEntity, StoryMemberEntity, GenreEntity
│   │   └── chapters/         # ChaptersController, ChaptersService, ChapterEntity, ChapterVersionEntity, MediaAssetEntity
│   ├── app.module.ts
│   └── main.ts
├── test/
│   ├── auth.e2e-spec.ts
│   ├── rbac.e2e-spec.ts
│   └── story-catalog.e2e-spec.ts
├── tsconfig.json
├── tsconfig.build.json
└── package.json
```

---

## 3. THỨ TỰ TRIỂN KHAI CHI TIẾT (IMPLEMENTATION SEQUENCE)

1. **NestJS Bootstrap & Core Infrastructure**:
   - `services/api/package.json`, `tsconfig.json`, `tsconfig.build.json`.
   - `ConfigModule` với strict env validation.
   - `GlobalExceptionFilter` ánh xạ mọi exception sang `StandardErrorResponse`.
   - `CorrelationIdMiddleware` gắn `x-request-id`.
   - `HealthModule` kiểm tra kết nối Postgres & Redis.
2. **Database Migration Layer (ADR-011)**:
   - Cấu hình `data-source.ts` với `synchronize: false`.
   - Viết migration `1700000000000-InitialDatabaseSchema.ts` (27 bảng, indexes, composite FK `ON DELETE SET NULL (active_version_id)`, seed 6 rank themes).
   - Kiểm thử `npm run migration:run` và `npm run migration:revert`.
3. **Identity & Authentication Module**:
   - Mật khẩu băm bằng `Argon2id`.
   - `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`.
   - Access Token (15m) + Refresh Token (7d) có rotation và session tracking trên Redis.
4. **Authorization & RBAC System**:
   - `GlobalRolesGuard` (`@Roles(GlobalRole.ADMIN, GlobalRole.TRANSLATOR)`).
   - `StoryMembershipGuard` (`@RequireStoryRole(StoryMemberRole.OWNER, StoryMemberRole.EDITOR)`).
5. **Catalog & Publishing Modules**:
   - Story CRUD, Genres, Creators, StoryEditions.
   - Volumes, Chapters, ChapterVersions (Immutable Model).
   - Visibility Controller (`PUBLIC | UNLISTED | PRIVATE`).
6. **Integration & E2E Verification**:
   - Kiểm thử toàn diện các luồng Auth, RBAC, IDOR Prevention và Chapter Version Invariant.

---

## 4. TIÊU CHUẨN NGHIỆM THU PHASE 2 (DEFINITION OF DONE - DoD)

Phase 2 chỉ được xác nhận hoàn thành khi đạt đủ các tiêu chí:
* [ ] Khởi tạo CSDL sạch $\rightarrow$ `migration:run` tạo thành công 27 bảng và seed dữ liệu.
* [ ] Kiểm tra rollback `migration:revert` và chạy lại `migration:run` hoạt động trơn tru.
* [ ] Auth Integration Tests: Đăng ký, Đăng nhập, Làm mới Token, Đăng xuất và Thu hồi phiên trên Redis pass 100%.
* [ ] Global RBAC: Người dùng không đủ quyền bị chặn với mã lỗi `403 Forbidden`.
* [ ] Story RBAC: Truy cập chéo bộ truyện không thuộc quyền sở hữu bị chặn với mã lỗi `403 Forbidden` (IDOR Prevention).
* [ ] Chapter Publishing Invariant: Thử gán `active_version_id` của Chapter B sang Chapter A bị CSDL chặn ngay lập tức.
* [ ] MinIO Private Access: Truy cập file nặc danh (anonymous) bị từ chối; chỉ mở khi có presigned URL hợp lệ.
* [ ] Toàn bộ test suites `npm test` và `npm run test:e2e` pass 100%.

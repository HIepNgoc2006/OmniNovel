# 📋 Phase 6: Triển Khai DevOps, Hạ Tầng Đám Mây & Nghiệm Thu 5 Môn

- **Mục tiêu:** Thiết lập hạ tầng triển khai thực tế đa môi trường (Local/CI vs Production Cloud), tự động hóa CI/CD, hệ thống giám sát và hồ sơ bảo vệ 5 môn học.
- **Trạng thái:** [ ] Phase 6.1: CONDITIONAL — Đã hoàn thành 100% code hardening & contracts; Gate R2 Live Lifecycle cần credentials thực để PASS toàn diện | Phase 6.2 (QUEUED 🟡)

---

## 1. KIẾN TRÚC HẠ TẦNG CHUẨN HÓA (SSoT ARCHITECTURE)

| Thành Phần (Component) | Môi Trường Local Dev / CI Runner | Môi Trường Production Cloud | Ghi Chú Kỹ Thuật & Boundary |
| :--- | :--- | :--- | :--- |
| **Database** | PostgreSQL 16 Alpine (Docker Compose) | **Supabase Managed PostgreSQL** | Direct `:5432` (IPv6) hoặc Supavisor Session Pooler `:5432` (IPv4). `synchronize: false`, TypeORM migrations là SSoT. Không dùng Transaction Pooler `:6543` làm ORM datasource. |
| **Object Storage** | MinIO S3 (Docker Compose) | **Cloudflare R2** (S3-Compatible) | Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, Region `auto`, `forcePathStyle: false`. Zero egress fees. Presigned PUT/GET hoạt động trên R2 S3 API domain (không qua custom domain). |
| **Authentication & RBAC** | Custom Auth (Argon2id + JWT + Redis) | **Custom Auth (Argon2id + JWT + Redis)** | **100% Custom Auth nội bộ**. Không dùng Supabase Auth. Không cấp anon/service-role key ra Web/Mobile. NestJS Core API là data & security boundary duy nhất. |
| **Compute & Services** | Local Node.js / Python / Docker | **VPS Docker Deployment** | Nginx Reverse Proxy (SSL, Cache, Rate Limit) + NestJS Core API + FastAPI AI Worker + Redis Cache/BullMQ. |
| **Clients** | Flutter Mobile + Next.js Web | Flutter Mobile + Next.js Web | Kết nối duy nhất vào NestJS Core API qua REST & WebSocket. |

---

## 2. NGUYÊN TẮC BẤT BIẾN TRIỂN KHAI (INVARIANTS)

1. **Provider-Neutral Storage Contract:**
   - Hỗ trợ 2 chế độ: `STORAGE_PROVIDER=minio` (Local/CI) và `STORAGE_PROVIDER=r2` (Production).
   - Biến môi trường chuẩn hóa: `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_MANGA`, `S3_BUCKET_NOVEL`, `S3_FORCE_PATH_STYLE`.
   - **Fail-Fast in Production:** Khi `NODE_ENV=production` hoặc `STORAGE_PROVIDER=r2`, nếu thiếu bất kỳ biến nào thì ứng dụng lập tức dừng boot (throw error), tuyệt đối không silent fallback về MinIO localhost.
2. **SSRF Provider & Bucket Isolation Invariant:**
   - Khi `STORAGE_PROVIDER=r2`, AI Worker tuyệt đối không thêm MinIO/localhost origins vào allowlist.
   - **Bucket Isolation (Hardening):** Khóa chặt cả virtual-hosted subdomain (`<bucket>.<account_id>.r2.cloudflarestorage.com`) lẫn path-style segment đầu (`/<bucket>/...`) vào chính xác allowlist `{S3_BUCKET_MANGA, S3_BUCKET_NOVEL}`. Mọi bucket lạ khác trong cùng account đều bị chặn ngay lập tức.
3. **Presigned URL Domain Integrity:**
   - Presigned URLs cấp phát cho người dùng tải/đọc ảnh phải giữ nguyên host từ S3 SDK (`*.r2.cloudflarestorage.com`), không rewrite sang Custom CDN host vì R2 không hỗ trợ presigned signature trên custom domain.
4. **Database Migration SSoT & Env Precedence:**
   - Không chỉnh sửa database bằng tay trên Supabase Studio Dashboard. Mọi thay đổi schema phải xuất phát từ TypeORM Migrations được version-control trong repo và chạy bằng migration runner chuyên dụng.
   - **Environment Precedence Chuẩn:** Tuân thủ thứ tự: `OS / Docker / CI injected env` (ưu tiên cao nhất, không bị ghi đè) → `explicit MIGRATION_ENV_FILE` (chỉ nạp khi được chỉ định) → `.env fallback` (chỉ điền biến còn thiếu) → `local defaults`. Bỏ hoàn toàn `override: true` trong `data-source.ts`.

---

## 3. DANH SÁCH ĐẦU VIỆC (CHECKLIST)

### A. Chuẩn Hóa Mã Nguồn & Cấu Hình Provider-Neutral (Phase 6.1 - CONDITIONAL 🟡)
- [x] Refactor `StorageService` (`services/api`) hỗ trợ `minio` và `r2` với fail-fast validation ở production và fail-fast enum.
- [x] Refactor `env.validation.ts` schema với đầy đủ `STORAGE_PROVIDER`, `S3_*`, `DATABASE_URL`, `DB_SSL` và production fail-fast guards.
- [x] **[P0 Sửa xong]** Hợp nhất cấu hình PostgreSQL qua `buildPostgresConnectionOptions` đảm bảo 100% parity giữa runtime (`DatabaseModule`) và migration CLI (`data-source.ts`). Bỏ hoàn toàn `{ override: true }`, bảo đảm biến môi trường OS/Docker/CI luôn có quyền ưu tiên cao nhất, hỗ trợ biến rõ ràng `MIGRATION_ENV_FILE`.
- [x] **[P0 & P1 Sửa xong]** Cách ly nghiêm ngặt SSRF Safe Downloader (`services/ai-worker`):
  - Provider isolation: Khi `STORAGE_PROVIDER=r2` ở production, tuyệt đối cấm thêm MinIO/localhost origin.
  - Bucket isolation: Khóa chặt virtual-hosted subdomain và path-style bucket vào exact allowlist `{S3_BUCKET_MANGA, S3_BUCKET_NOVEL}`.
- [x] **[P1 Sửa xong]** Cleanup `services/ai-worker/app/core/config.py`: Xóa bỏ trùng lặp khai báo `STORAGE_PROVIDER` và `S3_ENDPOINT`; áp dụng `Literal["minio", "r2"]` giúp fail-fast ngay khi boot nếu typo.
- [x] **[P0 Sửa xong]** Nâng cấp R2 Live Smoke Runner (`r2-live-smoke.ts`): Bổ sung chế độ nghiệm thu `R2_LIVE_SMOKE_REQUIRED=true` (thiếu credentials sẽ FAIL-FAST ngay, không skip). Chạy toàn diện chu trình (PUT presigned → HEAD → GET presigned → COPY/promote → DELETE) trên cả 2 buckets (`omninovel-manga` và `omninovel-novel`) với khối `finally` dọn dẹp chống rác dữ liệu.
- [x] Viết bộ kiểm thử hợp đồng (Contract Tests) chứng minh Cloudflare R2 config, Presigned URL generation, Supabase URL/SSL, environment precedence, và bảo toàn 100% MinIO local compatibility.
- [x] Khởi tạo 2 R2 buckets chuẩn hóa trên Cloudflare: `omninovel-manga` và `omninovel-novel` (Account `5647695aab5f1dfad2253715bf29531e`).
- [x] **[P1 Ghi rõ Provenance]** Chứng minh Migration Provenance & Parity:
  - Supabase PostgreSQL 17.6 (`sovdnipwoybywqorjvkt`): 33 tables ở schema `public`, 18 migrations (0000 -> 0017) ghi nhận đầy đủ trong bảng `migrations`.
  - Local PostgreSQL 16: **Local fixture cleanup** (dọn dẹp 15,211 legacy test rows do dữ liệu rác test cục bộ vi phạm unique invariant của 0017), chạy `npm run migration:run` thành công, kiểm tra `npm run migration:show` xác nhận toàn bộ 18 migrations hiển thị `[X]` applied.
- [x] Xác thực kiểm thử cục bộ (Locally Verified):
  - Backend NestJS: **388 passed, 1 skipped** (test mạng R2 live khi thiếu credentials, fail-fast mode đã verified) trên 32 test suites.
  - AI Worker: **322 passed, 0 failed** trên pytest.
- [ ] **[R2 Gate Chờ Credentials]** Thực thi R2 Live Lifecycle với real credentials để verify 100%:
  - Yêu cầu: `S3_ACCESS_KEY_ID` & `S3_SECRET_ACCESS_KEY` thật trên account Cloudflare.
  - Kỳ vọng: `omninovel-manga` ✅, `omninovel-novel` ✅, zero leaked objects ✅.

### B. Đóng Gói Docker & Reverse Proxy (Phase 6.2)
- [ ] Hoàn thiện `deploy/docker-compose.yml` cho Production VPS: gồm 4 container cốt lõi (`nginx`, `api`, `ai-worker`, `redis`).
- [ ] Duy trì `deploy/docker-compose.dev.yml` cho Local Dev / CI: bổ sung `postgres` và `minio`.
- [ ] Cấu hình Nginx Production: SSL (Let's Encrypt / Certbot), HTTP/2, Gzip/Brotli, Header Security, Rate Limiting.

### C. CI/CD Pipeline GitHub Actions (Phase 6.3)
- [ ] Workflow kiểm thử tự động: Backend NestJS (TypeORM + Postgres service container), AI Worker (Pytest), Mobile (Flutter analyze + test).
- [ ] Workflow build & scan bảo mật: Docker container security audit, secret scanning.
- [ ] Workflow deployment tự động lên VPS qua SSH / Docker Hub.

### D. Giám Sát, Đo Lường & Hồ Sơ 5 Môn Học (Phase 6.4)
- [ ] Thiết lập Prometheus metrics & Grafana Dashboard theo dõi API response time, BullMQ queue latency, Memory RSS.
- [ ] Tổng hợp hồ sơ kỹ thuật và slide thuyết trình phục vụ bảo vệ 5 môn học.

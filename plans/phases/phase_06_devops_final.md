# 📋 Phase 6: Triển Khai DevOps, Hạ Tầng Đám Mây & Nghiệm Thu 5 Môn

- **Mục tiêu:** Thiết lập hạ tầng triển khai thực tế đa môi trường (Local/CI vs Production Cloud), tự động hóa CI/CD, hệ thống giám sát và hồ sơ bảo vệ 5 môn học.
- **Trạng thái:** [ ] Đang chuẩn bị hạ tầng (IN PROGRESS 🟡)

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
2. **Presigned URL Domain Integrity:**
   - Presigned URLs cấp phát cho người dùng tải/đọc ảnh phải giữ nguyên host từ S3 SDK (`*.r2.cloudflarestorage.com`), không rewrite sang Custom CDN host vì R2 không hỗ trợ presigned signature trên custom domain.
3. **Database Migration SSoT:**
   - Không chỉnh sửa database bằng tay trên Supabase Studio Dashboard. Mọi thay đổi schema phải xuất phát từ TypeORM Migrations được version-control trong repo và chạy bằng migration runner chuyên dụng.

---

## 3. DANH SÁCH ĐẦU VIỆC (CHECKLIST)

### A. Chuẩn Hóa Mã Nguồn & Cấu Hình Provider-Neutral (Phase 6.1)
- [x] Refactor `StorageService` (`services/api`) hỗ trợ `minio` và `r2` với fail-fast validation ở production và fail-fast enum.
- [x] Refactor `env.validation.ts` schema với đầy đủ `STORAGE_PROVIDER`, `S3_*`, `DATABASE_URL`, `DB_SSL` và production fail-fast guards.
- [x] Hợp nhất cấu hình PostgreSQL qua `buildPostgresConnectionOptions` đảm bảo 100% parity giữa runtime (`DatabaseModule`) và migration CLI (`data-source.ts`).
- [x] Refactor SSRF Safe Downloader (`services/ai-worker`) hỗ trợ R2 endpoint domain & virtual-hosted subdomains.
- [x] Viết bộ kiểm thử hợp đồng (Contract Tests) chứng minh Cloudflare R2 config, Presigned URL generation, Supabase URL/SSL, và bảo toàn 100% MinIO local compatibility.
- [x] Chạy lại toàn bộ 384/384 tests Backend API và 322/322 tests AI Worker đạt 100% GREEN.

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

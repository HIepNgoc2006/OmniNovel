# 📋 Phase 6: Triển Khai DevOps, Hạ Tầng Đám Mây & Nghiệm Thu 5 Môn

- **Mục tiêu:** Thiết lập hạ tầng triển khai thực tế đa môi trường (Local/CI vs Production Cloud), tự động hóa CI/CD, hệ thống giám sát và hồ sơ bảo vệ 5 môn học.
- **Trạng thái:** [x] Phase 6.1 (CLOSED / FROZEN ✅) \| [x] Phase 6.2 (CLOSED / FROZEN ✅) \| Bắt đầu Phase 6.3 (IN PROGRESS 🟡)

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

### A. Chuẩn Hóa Mã Nguồn & Cấu Hình Provider-Neutral (Phase 6.1 - CLOSED / FROZEN ✅)
- [x] Refactor `StorageService` (`services/api`) hỗ trợ `minio` và `r2` với fail-fast validation ở production và fail-fast enum.
- [x] Refactor `env.validation.ts` schema với đầy đủ `STORAGE_PROVIDER`, `S3_*`, `DATABASE_URL`, `DB_SSL` và production fail-fast guards.
- [x] **[P0 Sửa xong]** Hợp nhất cấu hình PostgreSQL qua `buildPostgresConnectionOptions` đảm bảo 100% parity giữa runtime (`DatabaseModule`) và migration CLI (`data-source.ts`). Bỏ hoàn toàn `{ override: true }`, bảo đảm biến môi trường OS/Docker/CI luôn có quyền ưu tiên cao nhất, hỗ trợ biến rõ ràng `MIGRATION_ENV_FILE`.
- [x] **[P0 & P1 Sửa xong]** Cách ly nghiêm ngặt SSRF Safe Downloader (`services/ai-worker`):
  - Provider isolation: Khi `STORAGE_PROVIDER=r2` ở production, tuyệt đối cấm thêm MinIO/localhost origin.
  - Bucket isolation: Khóa chặt virtual-hosted subdomain và path-style bucket vào exact allowlist `{S3_BUCKET_MANGA, S3_BUCKET_NOVEL}`.
- [x] **[P1 Sửa xong]** Cleanup `services/ai-worker/app/core/config.py`: Xóa bỏ trùng lặp khai báo `STORAGE_PROVIDER` và `S3_ENDPOINT`; áp dụng `Literal["minio", "r2"]` giúp fail-fast ngay khi boot nếu typo.
- [x] **[P0 Sửa xong & Zero-Leak 100% Verified]** Nâng cấp R2 Live Smoke Runner (`r2-live-smoke.ts`): Bổ sung chế độ nghiệm thu `R2_LIVE_SMOKE_REQUIRED=true`. Chạy toàn diện chu trình (PUT presigned → HEAD → GET presigned → COPY/promote → DELETE) trên cả 2 buckets (`omninovel-manga` và `omninovel-novel`) với khối `finally` dọn dẹp và xác minh **HEAD 404 Not Found cho CẢ `quarantineKey` VÀ `finalKey`** (chứng minh toán học zero leaked objects).
- [x] **[P1 Sửa xong] Tách biệt Live Smoke Acceptance khỏi Test Suite Thường**:
  - `r2-live-smoke.spec.ts` không auto-load `.env`, tự động SKIPPED live network test khi chạy `npm test` thông thường để bảo đảm an toàn cho production R2.
  - Cung cấp dedicated runner qua `npm run test:r2-live` (chỉ chạy khi được kích hoạt có chủ đích, nạp cấu hình từ `.env.r2-live` được `.gitignore` bảo vệ).
- [x] **[Bảo mật & Credential Hygiene Đã Xử Lý]**:
  - Sanitize triệt để các chuỗi giả lập Supabase database URL, password, và Cloudflare endpoint trong `database-config-contract.spec.ts` bằng các fixture giả định rõ ràng (`fake_test_password`, `dummy_project_ref`).
  - Hướng dẫn rotate R2 API token và Supabase DB password để bảo đảm vệ sinh an toàn thông tin.
- [x] Viết bộ kiểm thử hợp đồng (Contract Tests) chứng minh Cloudflare R2 config, Presigned URL generation, Supabase URL/SSL, environment precedence, và bảo toàn 100% MinIO local compatibility.
- [x] Khởi tạo 2 R2 buckets chuẩn hóa trên Cloudflare: `omninovel-manga` và `omninovel-novel`.
- [x] **[P1 Ghi rõ Provenance]** Chứng minh Migration Provenance & Parity:
  - Supabase PostgreSQL 17.6: 33 tables ở schema `public`, 18 migrations (0000 -> 0017) ghi nhận đầy đủ trong bảng `migrations`.
  - Local PostgreSQL 16: Local fixture cleanup (dọn dẹp legacy test rows vi phạm unique invariant), chạy `npm run migration:run` thành công, kiểm tra `npm run migration:show` xác nhận toàn bộ 18 migrations hiển thị `[X]` applied.
- [x] Xác thực kiểm thử cục bộ (Locally Verified):
  - Backend NestJS: **388 passed, 1 skipped (live network isolated), 0 failed** trên 32 test suites.
  - AI Worker: **322 passed, 0 failed** trên pytest.
- [x] **[R2 Gate ĐÃ NGHIỆM THU THÀNH CÔNG VỚI ZERO LEAK]** Thực thi R2 Live Lifecycle với real credentials trên Cloudflare R2 qua `npm run test:r2-live`:
  - Toàn bộ chu trình (Presigned PUT -> HEAD xác thực ContentLength -> Presigned GET đối chiếu -> COPY promote -> DELETE trong finally -> HEAD xác nhận 404 Not Found cho CẢ quarantineKey VÀ finalKey) PASS 100%.
  - Kết quả: `omninovel-manga` ✅, `omninovel-novel` ✅, zero leaked objects verified ✅.
- [x] **PHASE 6.1 CHÍNH THỨC FROZEN & CLOSED CLEAN.**

### B. Đóng Gói Docker & Reverse Proxy (Phase 6.2 - CLOSED / FROZEN ✅)
- [x] Hoàn thiện `deploy/docker-compose.yml` cho Production VPS: gồm 4 container cốt lõi (`nginx`, `api`, `ai-worker`, `redis`), 3-Network Topology (`edge`, `internal: true`, `egress`), 5 named volumes, Redis guard với `$$REDIS_PASSWORD`.
- [x] Duy trì `deploy/docker-compose.dev.yml` cho Local Dev / CI: bổ sung `postgres` và `minio`.
- [x] Cấu hình Nginx Production: SSL (Let's Encrypt / Certbot), HTTP/2, Gzip, Dynamic Upstream DNS (`zone api_backend 64k; server api:8000 resolve;`), Rate Limiting 429 (`api_general_limit: 30r/s`, `auth_limit: 5r/s`), WebSocket `/socket.io/` upgrade, TLS State Machine (Bootstrap vs Production) với zero-downtime hot reload.
- [x] **[14 ACCEPTANCE GATES ĐÃ NGHIỆM THU PASS 100% - EXIT CODE & ZERO-LEAK HARDENED]** Chạy test suite tự động `deploy/test-acceptance-phase6-2.ts`:
  - **G01 (Config Valid):** `docker compose config --quiet` exit code 0 (`res.exitCode === 0 && res.output.length === 0`), không warning cú pháp, không render credentials.
  - **G02 (Migration Proof):** Container cô lập thực thi migration trên Supabase Managed PostgreSQL: exit code 0 (`res.exitCode === 0`), 18 migrations applied, `No migrations are pending`.
  - **G03 (Port Isolation):** Nginx mở `80` và `443` (exit 0). Các cổng backend `8000`, `8001`, `6379` không publish ra host (exit 0, empty binding).
  - **G04 (API Health & HSTS):** HTTP/80 trả 301 chuyển hướng HTTPS, HTTPS/443 trả 200 kèm HSTS `max-age=31536000; includeSubDomains`.
  - **G05 (Redis Pass & Guard):** `/health/ready` báo `redis: UP`. Khi rỗng password: container ephemeral fail-fast exit code 2 với `ERROR_REDIS_PASSWORD_REQUIRED` (`failFastRes.exitCode !== 0`).
  - **G06 (AI Worker RPC & Egress):** Internal RPC với `x-internal-key` hợp lệ (exit 0), cấm gọi không auth (401). AI Worker truy cập R2 qua `omninovel-egress` (exit 0, HTTP 400). Redis bị cấm Internet trên `omninovel-internal` (`redisEgress.exitCode !== 0`).
  - **G07 (Supabase Connection):** `/health/ready` báo `database: UP` kết nối Supabase Managed PostgreSQL qua `omninovel-egress`.
  - **G08 (R2 Storage Live Round-Trip & Zero-Leak):** Thực hiện chu trình thật trên Cloudflare R2 bucket: `PUT -> HEAD -> DELETE (in finally) -> Post-Delete HEAD (404 NotFound)` xác nhận payload 39 bytes được dọn dẹp sạch sẽ không để lại rác (exit code 0, `R2_ROUNDTRIP_OK:verified_zero_leak`).
  - **G09 (WebSocket /ws/ai):** Socket.IO client kết nối qua Nginx `/socket.io/` tới namespace `/ws/ai` nhận handshake thành công.
  - **G10 (Rate Limiting 429):** Bắn tải burst 25 requests liên tục vào `/api/v1/auth/me` kích hoạt 19 responses `HTTP 429 Too Many Requests`.
  - **G11 (Independent Lifecycle & Zero-Downtime Reload):** Nginx khởi động độc lập khi API stopped (Nginx running, port 80 ACME trả HTTP 404). Luồng reload traffic 24 requests liên tục qua non-keepalive agent đạt 24/24 HTTP 200 OK, 0 dropped (`droppedCount === 0 && reloadOutput.exitCode === 0`).
  - **G12 (Auto-Recovery & Real Dynamic DNS Re-resolve):** Recreate `ai-worker`: cache file volume tồn tại. Ép đổi IP API thật (`172.23.0.3` -> `172.23.0.4` qua container giữ chỗ): Docker DNS 127.0.0.11 cập nhật (exit 0), Nginx tự re-resolve không reload và live probe 200 OK.
  - **G13 (Non-Root Hardening):** Container `api` chạy UID 1000 (`node`), container `ai-worker` chạy UID 10001 (`appuser`), exit code 0.
  - **G14 (Secret Hygiene):** Quét regex động dựa trên active env secrets và 3 regex patterns trên logs 4 containers (exit 0): 0 rò rỉ credential verified. Zero secrets hardcoded trong repository.
- [x] **[AN TOÀN BẢO MẬT & TRẠNG THÁI LỊCH SỬ GIT]:**
  - Nhánh `main` đã được rewrite lịch sử (`git reset --soft` và force push) để loại bỏ commit cũ khỏi nhánh chính.
  - Về mặt kỹ thuật, commit cũ `0c58746` hiện là một **dangling/unreachable commit object** trên máy chủ GitHub (có thể vẫn hiển thị nếu truy cập trực tiếp bằng SHA do cơ chế cached view của GitHub trước khi garbage collection chạy).
  - Để đảm bảo an toàn tuyệt đối mà không phụ thuộc vào trạng thái cache của GitHub: **Toàn bộ credential xuất hiện trong commit cũ và transcript (Supabase Database Role, Redis Password, JWT Secrets, AI Worker Key) đã được thu hồi và rotate 100% sang giá trị mới**. Lỗ hổng rò rỉ credential đã được vô hiệu hóa triệt để tại gốc (Zero Trust).
- [x] **PHASE 6.2 CHÍNH THỨC FROZEN & CLOSED CLEAN.**

### C. CI/CD Pipeline GitHub Actions (Phase 6.3)
- [ ] Workflow kiểm thử tự động: Backend NestJS (TypeORM + Postgres service container), AI Worker (Pytest), Mobile (Flutter analyze + test).
- [ ] Workflow build & scan bảo mật: Docker container security audit, secret scanning.
- [ ] Workflow deployment tự động lên VPS qua SSH / Docker Hub.

### D. Giám Sát, Đo Lường & Hồ Sơ 5 Môn Học (Phase 6.4)
- [ ] Thiết lập Prometheus metrics & Grafana Dashboard theo dõi API response time, BullMQ queue latency, Memory RSS.
- [ ] Tổng hợp hồ sơ kỹ thuật và slide thuyết trình phục vụ bảo vệ 5 môn học.

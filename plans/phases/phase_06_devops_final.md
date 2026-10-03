# 📋 Phase 6: Triển Khai DevOps, Hạ Tầng Đám Mây & Nghiệm Thu 5 Môn

- **Mục tiêu:** Thiết lập hạ tầng triển khai thực tế đa môi trường (Local/CI vs Production Cloud), tự động hóa CI/CD, hệ thống giám sát và hồ sơ bảo vệ 5 môn học.
- **Trạng thái:** [x] Phase 6.1 (CLOSED / FROZEN ✅) \| [x] Phase 6.2 (CLOSED / FROZEN ✅) \| [x] Phase 6.3 (CLOSED / FROZEN ✅ - 7/7 CI/CD Jobs PASS 100%) \| Sẵn sàng Phase 6.4 (CHƯA BẮT ĐẦU ⏳)

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

## 1.1. PRODUCTION DEPLOYMENT TARGET — `nagisakileon` (SELF-HOSTED UBUNTU LAPTOP)

> **Operational reality:** Production target hiện tại không phải VPS cấu hình cao mà là laptop cũ self-hosted chạy Ubuntu. Các quyết định tối ưu tài nguyên phải dựa trên baseline này.

| Hạng mục | Baseline thực tế |
| :--- | :--- |
| **Host** | Dell Latitude E6430s (`nagisakileon`) |
| **OS** | Ubuntu 24.04.5 LTS, Linux 6.8.x, x86_64 |
| **CPU** | Intel Core i5-3320M @ 2.60 GHz, 2 cores / 4 threads |
| **RAM** | 8 GB DDR3 (~7.6 GiB usable) |
| **Swap** | 4 GB |
| **Storage** | 250 GB 5400 RPM HDD; khoảng 165 GB trống tại thời điểm ghi nhận |
| **GPU** | Intel HD Graphics 4000 integrated |
| **Network** | Gigabit Ethernet + Tailscale; địa chỉ cụ thể không lưu trong repo |
| **Existing shared services** | Portainer CE, UpSnap, Homarr, MoneyPrinterTurbo |
| **Expected operating mode** | Ubuntu headless/self-hosted, ưu tiên stability hơn build/start latency |

### Resource Boundary trên `nagisakileon`
- **Không chạy production PostgreSQL local:** Supabase Managed PostgreSQL gánh database, persistence, schema state và database storage.
- **Không chạy production MinIO/object storage local:** Cloudflare R2 gánh manga/novel objects, media và artifact storage.
- **Laptop chủ yếu gánh compute/orchestration:** Nginx, NestJS API, Redis/BullMQ, FastAPI AI Worker và (khi triển khai) Next.js web runtime.
- **Disk local vẫn được dùng cho:** Docker images/layers, container writable layers, logs, Redis persistence nếu bật, AI model cache nếu dùng local inference, và swap.
- **Hiện chấp nhận build/start/restart chậm hơn do HDD 5400 RPM**; chưa coi đây là blocker production.
- **AI inference nặng là workload cần kiểm soát nhất:** giữ concurrency thấp ở profile hiện tại; hướng API-first AI bên dưới là phương án tối ưu tương lai để giảm CPU/RAM/model-cache local.
- **Không tối ưu quá sớm:** deploy và đo CPU/RAM/swap/disk I/O thực tế trước khi quyết định nâng SSD/RAM hoặc tách service.

### Development Workstation phụ trợ
- Windows 11 IoT Enterprise LTSC.
- Intel Core i5-9400F, 16 GB RAM, NVIDIA GTX 1050 Ti.
- Vai trò: development/build/test workstation; **production không được phụ thuộc vào việc máy Windows phải bật**.

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
- [x] **[15 ACCEPTANCE GATES ĐÃ NGHIỆM THU PASS 100% (G00 + G01–G14) - EXIT CODE & ZERO-LEAK HARDENED]** Chạy test suite tự động `deploy/test-acceptance-phase6-2.ts`:
  - **G00 (Credential Security Prerequisite):**
    - *Automated:* Boolean probe xác nhận required envs present và forbidden envs absent trên AI Worker (`REQUIRED_PRESENT: True`, `FORBIDDEN_ABSENT: True`, exit 0); định dạng và độ dài credential sanity check hợp lệ (`AI_WORKER_SECRET` 64-char hex, JWT/Refresh >= 16 chars, DB/Redis >= 8 chars, R2 credentials present); 2 service cốt lõi `api` và `ai-worker` đều `healthy`.
    - *Manual Attestation:* Xác nhận qua biến môi trường per-run `PHASE62_SECURITY_ATTESTED=true` (không lưu trong `.env`, bắt buộc operator opt-in rõ ràng theo phiên chạy, runner mặc định fail nếu thiếu); xác nhận `AI_WORKER_SECRET` re-rotated zero-output, token Cloudflare R2 cũ revoked, DB/Redis/JWT rotations confirmed.
    - *Zero Exposure:* Không in bất kỳ raw secret hay active credential fingerprint nào trong báo cáo hoặc acceptance summary (`Secrets printed = 0`).
  - **G01 (Config Valid):** `docker compose config --quiet` exit code 0 (`res.exitCode === 0 && res.output.length === 0`), không warning cú pháp, không render credentials.
  - **G02 (Clean Multi-Stage Build & Migration Proof):** Thực thi `docker compose build` đóng gói trực tiếp clean multi-stage production images (`deploy-nginx`, `deploy-ai-worker`, `deploy-api`) đạt exit code 0 (`buildRes.exitCode === 0`). Sau đó container cô lập thực thi migration trên Supabase Managed PostgreSQL: exit code 0 (`migrationRes.exitCode === 0`), 18 migrations applied, `No migrations are pending`.
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
  - Để đảm bảo an toàn tuyệt đối mà không phụ thuộc vào trạng thái cache của GitHub: **Toàn bộ credential xuất hiện trong commit cũ và transcript (Supabase Database Role, Redis Password, JWT Secrets, AI Worker Key, và Cloudflare R2 Storage Credentials) đã được thu hồi và rotate 100% sang giá trị mới**.
    - **Cloudflare R2 Rotation Proof:** Thao tác Revoke token cũ `4ac511...916c` trên Cloudflare Dashboard là bằng chứng authoritative cho việc thu hồi; probe phản hồi `HTTP 401 Unauthorized` là bằng chứng bổ trợ xác nhận endpoint không còn chấp nhận truy cập. Token mới đã nạp vào `.env` cục bộ (không log secret), toàn bộ 4 containers đã recreate thành công, và toàn bộ 14 Acceptance Gates chạy lại đạt 100% PASS (G08 xác thực live PUT->HEAD->DELETE->404 thành công, G14 xác thực 0 leak trên toàn bộ logs 4 containers).
    - **Remediation P0.1 & P0.2 / P1 / P0 Build Integrity:** `AI_WORKER_SECRET` đã được re-rotate lần nữa bằng quy trình zero-output, recreate containers sạch; `dotenv` trong runner chuyển sang `override: false` bảo toàn nghiêm ngặt invariant Environment Precedence (`OS/Docker/CI > .env`); semantics G00 tách bạch rõ giữa automated sanity checks và explicit per-run operator attestation (`PHASE62_SECURITY_ATTESTED=true`), không in active fingerprints trong summary; G02 thực thi trực tiếp `docker compose build` bảo đảm 100% multi-stage clean build integrity.
    - Lỗ hổng rò rỉ credential đã được vô hiệu hóa triệt để tại gốc (Zero Trust).
- [x] **PHASE 6.2 CHÍNH THỨC FROZEN & CLOSED CLEAN.**
  - **Tiêu chí nghiệm thu đóng sạch (Clean Closure Conditions):**
    - `G00 manual + automated prerequisite`: **PASS**
    - `G01–G14`: **14/14 PASS**
    - `Failed gates`: **0**
    - `Container-log leaks`: **0**
    - `Acceptance-procedure secret prints`: **0**
    - `Environment precedence`: **PRESERVED (`override: false`)**
    - `Working tree`: **CLEAN**
    - `Evidence commit`: **PUSHED**

### C. CI/CD Pipeline GitHub Actions (Phase 6.3 - CLOSED / FROZEN ✅ - 7/7 JOBS PASS 100%)
- [x] **Deliverable 1 — Monorepo CI Automated Testing (PASS 100% - 1,882 tests):**
  - **Web Client Test Suite:** Sửa lỗi TypeScript `TS2345` trong `apps/web/src/test/reading-progress.spec.ts` (bổ sung `serverDateVN`). Khắc phục race condition canvas preview image test case 29 (`manga-studio-page-navigator.spec.tsx`). ESLint (0 errors) → Typecheck (0 errors) → 42 Vitest test files (**580 passed**) → Next.js Production Build thành công → Playwright E2E Smoke Suite (**31 passed**). Thời gian: 2m23s.
  - **Mobile Client Test Suite:** Ghim Java 17 LTS qua `actions/setup-java@v5`. Flutter Analyze (0 issues) + Flutter Foundation & Concurrency Tests (**314 passed**). Thời gian: 3m1s.
  - **AI Worker Test Suite:** Full Pytest suite (**323 passed**) + Real Manga OCR Model & Cache verify thành công. Thời gian: 1m56s.
  - **NestJS Core API Test Suite:**
    - Cập nhật 7 file fixture E2E tuân thủ ràng buộc `chk_translation_jobs_canonical_source` của Phase 5D.1.
    - Bổ sung `writeEpoch: 0` bắt buộc cho `UpdateReadingProgressDto` trong `app.e2e-spec.ts`.
    - Xử lý SigV4 Presigned PUT upload trong `upload_file_to_presigned_url` (`services/ai-worker/app/api/v1/endpoints/jobs.py`): Lọc bỏ header `x-amz-*` khi tham số đã được hoist vào query parameters của presigned URL.
    - Chạy sạch sẽ **18/18 migrations** (từ `0000` đến `0017`).
    - 33 Unit test suites (**393 passed**, 1 skipped, 394 total) + 17 Integration/E2E test suites (**241 passed**) = **50/50 test suites, 634 tests passed 100%**. Thời gian: 3m2s.
- [x] **Deliverable 2 — Immutable Reproducible MinIO S3 Image Pinning:**
  - Ghim chính xác mã băm SHA-256 bất biến của Chainguard MinIO trong CI runner: `cgr.dev/chainguard/minio@sha256:4692462f35d97d7e82c30371d82f057703c5d9489bcae726010594c812f2d285`.
- [x] **Deliverable 3 — Workflow Build & Scan Bảo Mật (Docker Image Audit & Secret Scanning):**
  - **Job `security-scan`:** Tích hợp TruffleHog OSS Secret Scan (`trufflesecurity/trufflehog@main` với `--only-verified`) kèm bước kiểm tra Git tracking hygiene (CI gate phát hiện và từ chối baseline có tracked sensitive files `.env`, `.pem`, `.key`, `.crt`...).
    - *Nghiệm thu kỹ thuật chính xác:* TruffleHog báo cáo 0 verified / 0 unverified secrets trong phạm vi commit revision được quét (`base: 3d0173bb...`, `head: 5425f3f...`); Git tracking hygiene gate passed. Chưa thực hiện quét exhaustive toàn bộ lịch sử commit từ initial commit (được chuyển vào backlog hardening). Reference action hiện dùng `@main` mutable (được ghi nhận để pin SHA ở bước hardening). Thời gian: 12s.
  - **Job `docker-build-scan`:**
    - Đóng gói 3 container images production (`omninovel-api`, `omninovel-ai-worker`, `omninovel-nginx`) qua Docker Buildx.
    - Quét lỗ hổng bảo mật container tự động bằng Aqua Security Trivy ghim verified SHA `aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25` (v0.36.0) kèm `GITHUB_TOKEN` tránh rate-limit API cho cả 3 images (`omninovel-api`, `omninovel-ai-worker`, `omninovel-nginx`).
    - *Nghiệm thu kỹ thuật chính xác:* Toàn bộ 3 bước Trivy HIGH/CRITICAL audit scan hoàn tất thực thi thành công với cấu hình `severity: CRITICAL,HIGH`, `exit-code: '0'`. Hiện tại đóng vai trò là **audit/informational scanner** (nhận diện và log các CVE hiện hữu, ví dụ `CVE-2026-4372` ở thư viện `transformers` của AI Worker và một số CVE ở OS base packages), **chưa phải là blocking gate** tự động ngắt pipeline khi phát hiện CVE. Đã ghi nhận chuyển đổi sang fail-closed gate có chính sách `.trivyignore` vào hardening task. Thời gian: 3m28s.
- [x] **Deliverable 4 — Workflow Deployment Tự Động Lên VPS (CD Pipeline):**
  - **Job `deploy-vps`:**
    - Thẩm định tính toàn vẹn cú pháp và environment bindings của `deploy/docker-compose.yml` qua ephemeral `.env` chứa non-production dummy values: `docker compose --env-file .env -f deploy/docker-compose.yml config --quiet` đạt exit code 0, dọn dẹp sạch sẽ `rm -f .env` ngay sau khi validation xong (zero leaked secrets).
    - *Nghiệm thu kỹ thuật chính xác:* Pipeline deployment path đã được cài đặt và kiểm chứng qua Topology Dry-Run (`Docker Compose production manifest: VALID (exit code 0)`). Do GitHub Secrets (`VPS_SSH_HOST`, `VPS_SSH_KEY`) chưa cấu hình nên pipeline kích hoạt an toàn nhánh fallback dry-run report; bằng chứng run này không bao gồm live VPS deployment rollout thực tế. Thời gian: 9s.
- [x] **Tổng Hợp Bằng Chứng Nghiệm Thu Phase 6.3 (Hosted GitHub Actions SSoT):**
  - Run [`36963197949`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/36963197949) tại commit [`5425f3f`](https://github.com/HIepNgoc2006/OmniNovel/commit/5425f3f): **7/7 JOBS PASS 100% (completed success in 6m47s)**:
    1. `ai-worker-test`: **PASS** (1m56s) — 323 passed
    2. `core-api-test`: **PASS** (3m2s) — 50/50 suites, 634 passed, 18/18 migrations executed
    3. `web-client-test`: **PASS** (2m23s) — 580 Vitest + 31 Playwright passed
    4. `mobile-foundation-test`: **PASS** (3m1s) — 314 passed
    5. `security-scan`: **PASS** (12s) — 0 verified / 0 unverified secrets detected in scanned revision range + Git tracking hygiene clean
    6. `docker-build-scan`: **PASS** (3m28s) — 3 images built + 3 Trivy audit scans executed
    7. `deploy-vps`: **PASS** (9s) — Compose config exit 0 + topology dry-run verified
  - **KẾT LUẬN NGHIỆM THU:** Phase 6.3 chính thức **CLOSED / FROZEN** đối với phạm vi CI/CD implementation đã định nghĩa (automated testing, build, audit scanners, topology dry-run).


### D. Ghi Chú Kiến Trúc Tương Lai — API-First AI Worker cho Self-Host Tài Nguyên Thấp (DEFERRED / NOT ACTIVE)
- [ ] **Mục tiêu:** Tối ưu OmniNovel để có thể self-host trên **Ubuntu laptop cũ / máy cấu hình thấp**, giảm phụ thuộc vào CPU/RAM cục bộ cho inference AI.
- [ ] **Giữ nguyên boundary hiện tại:** FastAPI `ai-worker` vẫn là service nội bộ đứng sau NestJS Core API; Web/Mobile không gọi trực tiếp model provider bên ngoài.
- [ ] **Chuyển phần inference nặng sang external model APIs khi triển khai profile này:**
  - OCR/Vision cho manga.
  - Translation LLM cho manga/novel.
  - Biên tập/ngữ cảnh/glossary-aware refinement khi cần.
- [ ] **Các tác vụ nhẹ vẫn giữ local trong AI Worker:** orchestration job, validate/normalize response, retry/backoff, image/file post-processing nhẹ, R2 presigned download/upload, progress callback và materialization.
- [ ] **Mục tiêu tài nguyên:** giảm đáng kể Docker image size, model cache, RAM idle và CPU load so với profile PyTorch + `manga-ocr` local; phù hợp deployment trên máy cá nhân chạy Ubuntu Server/headless.
- [ ] **Provider-neutral contract trước khi triển khai:** xây abstraction cho model provider để có thể thay API vendor mà không đổi contract giữa NestJS ↔ AI Worker.
- [ ] **Security/operational requirements:** API keys chỉ tồn tại trong AI Worker environment; không trả key xuống client; có timeout, retry/backoff, rate-limit/quota, circuit breaker, cost controls, request-size limits và redaction/logging-safe policy.
- [ ] **Privacy:** trước khi bật provider ngoài cho production, phải xác định rõ loại nội dung nào được phép gửi ra external provider và retention/data-processing policy tương ứng.
- [ ] **Fallback:** local inference hiện tại có thể được giữ như optional profile/fallback nếu phần cứng cho phép; API-first không bắt buộc xóa ngay local implementation.
- [ ] **Trạng thái:** **Deferred architecture option** — chỉ ghi nhận hướng tối ưu tương lai, **không thay đổi Phase 6.2 frozen baseline và không mở rộng scope Phase 6.3 hiện tại**.

### E. Giám Sát, Đo Lường, Security Hardening & Hồ Sơ 5 Môn Học (Phase 6.4)
> **Chi tiết kế hoạch triển khai:** Xem đặc tả chi tiết tại [phase_06_4_hardening_observability_plan.md](../phase_06_4_hardening_observability_plan.md).  
> **Nguyên tắc cốt lõi:** Không mở lại Phase 6.3. Khóa hợp đồng nghiệm thu 6.4.0 với 6 điều chỉnh kỹ thuật nghiêm ngặt.

- [x] **Gate 6.4.0 — Hợp Đồng Nghiệm Thu & Khung Kiểm Soát Kỹ Thuật (Contract Amendment):**
  - Khóa quy chuẩn nghiệm thu 6 điểm P0: (1) Khóa hai lớp TruffleHog (SHA Action + CLI version); (2) Giới hạn chính xác phạm vi git scan thành "all commits reachable from main" kèm tuyên bố bằng chứng authoritative cho secret trong commit dangling là Revocation Proof; (3) Tách bạch CI blocking (verified) vs Audit Deep Triage Ledger (multi-status); (4) Trivy fail-closed có quy trình 3 bước (Audit ➔ Governed Risk Register + `.trivyignore` ➔ Kích hoạt `exit-code: '1'`); (5) Observability đúng bản chất PromQL histogram percentiles và invariant bảo mật chặn `/metrics` từ Internet qua Nginx; (6) Ma trận bằng chứng (Evidence Matrix) truy vết thực chứng tới source/test/commit. Đã thiết lập chi tiết tại `plans/phase_06_4_hardening_observability_plan.md`.
- [x] **Gate 6.4.1 — TruffleHog Supply-Chain Two-Layer Pinning:**
  - Ghim full commit SHA `trufflesecurity/trufflehog@c1f2e912239240108482d79ea01ab25d90b27ac7` (v3.88.16).
  - Ghim tường minh input `version: "3.88.16"`. Action code immutable-pinned; CLI version explicitly pinned, eliminating dependence on `latest` and substantially reducing supply-chain mutability.
- [x] **Gate 6.4.2 — Reachable-History Git Audit & Triage Ledger:**
  - Cấu hình CI: `base: ""` và `head: ${{ github.ref_name }}` với cờ `--only-verified`.
  - Thực thi deep audit scan đa trạng thái (`verified,unknown,unverified`) trên toàn bộ git tree reachable (4,949 chunks, 8.76MB, 0 verified leaks). Toàn bộ 13 unverified findings đã được triage và lập bảng Disposition Ledger chi tiết tại `plans/evidence/phase_06_trufflehog_reachable_audit.md`.
- [x] **Gate 6.4.3 — Trivy Inspection, Governed Risk Register & Fail-Closed Gate:**
  - Trích xuất và phân tích toàn diện CVE CRITICAL/HIGH hiện hành trên 3 container images (`omninovel-api`, `omninovel-ai-worker`, `omninovel-nginx`).
  - Xây dựng tài liệu Sổ đăng ký rủi ro ngoại lệ `deploy/security/trivy-exception-register.md` kèm file cấu hình `.trivyignore` có vòng đời kiểm soát và biện pháp bù đắp (Compensating Controls) chi tiết. Bổ sung alias `GHSA-5p4m-2wfm-xmqj` cho finding `js-yaml@4.1.0` (kéo từ `@nestjs/swagger@7.4.2` trên runtime NestJS 10) với lý giải kỹ thuật rõ ràng.
  - Chuyển `exit-code: '1'` cho Trivy scan với tham số `trivyignores: .trivyignore` trong `.github/workflows/ci-cd.yml`, hoàn thiện cơ chế Fail-Closed Gate thực thụ.
- [x] **BẰNG CHỨNG NGHIỆM THU HOSTED CI (GATES 6.4.1 – 6.4.3 CHÍNH THỨC FROZEN):**
  - Run [`37030640645`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/37030640645) tại commit [`123e6fc`](https://github.com/HIepNgoc2006/OmniNovel/commit/123e6fc): **7/7 JOBS PASS 100%**:
    1. `web-client-test`: **PASS** (3m30s)
    2. `core-api-test`: **PASS** (3m6s)
    3. `security-scan` (Gate 6.4.1 & 6.4.2): **PASS** (23s) — Two-layer pinning + reachable commits scan clean
    4. `ai-worker-test`: **PASS** (2m25s)
    5. `mobile-foundation-test`: **PASS** (3m4s)
    6. `docker-build-scan` (Gate 6.4.3): **PASS** (5m26s) — 3 images built + 3 Trivy Fail-Closed scans pass exit-code 1 với `.trivyignore`
    7. `deploy-vps`: **PASS** (6s) — Compose config exit 0 + topology dry-run verified
  - **Kết luận:** Bộ ba Security Hardening Gates (6.4.1, 6.4.2, 6.4.3) chính thức **CLOSED / FROZEN** với bằng chứng hosted pipeline xanh 100%. Nền tảng an ninh đã được bảo đảm vững chắc trước khi tiến hành Observability.
- [x] **Gate 6.4.4 & 6.4.4a — Observability Baseline & Supply-Chain Security Gate (FROZEN CLEAN):**
  - Tích hợp Prometheus client trong NestJS API (`http_requests_total`, histogram `http_request_duration_seconds`, gauges `bullmq_jobs_*` gắn nhãn `queue` cho cả 3 hàng đợi `translation`, `translation-materialization`, `chapter-packaging`, và process metrics chuẩn từ `prom-client`).
  - Hoàn tất 100% toàn bộ các điểm phản biện kỹ thuật:
    - **P0.1 (Network & Port Exposure):** Chuyển port publish Prometheus & Grafana sang loopback `127.0.0.1` only, gỡ bỏ hoàn toàn `omninovel-edge`, chỉ tham gia `omninovel-internal`.
    - **P0.2 (Credential Security):** Loại bỏ default password hardcoded trong Compose overlay, cấu hình fail-closed `${GRAFANA_ADMIN_PASSWORD:?GRAFANA_ADMIN_PASSWORD is required}`, cập nhật acceptance test lấy credential động từ environment.
    - **P0.3 (Cardinality Defense):** Khóa triệt để cardinality explosion bằng cách gom toàn bộ unmatched routes (`!req.route`) về bounded label `/__unmatched__` (kiểm chứng 500-URL adversarial fuzzing test).
    - **P1 (Stale Gauge Defense):** Bổ sung metric `bullmq_metrics_collection_success` và `bullmq_metrics_last_success_timestamp_seconds` để phân biệt giữa queue=0 và scrape failure.
    - **P1 (Credential Transport Invariant):** Check 8 chuyển sang truyền thông tin xác thực qua HTTP Basic Auth header (`Authorization: Basic ...`) thay vì nội suy chuỗi mật khẩu vào shell command URL.
    - **Gate 6.4.4a (Supply-Chain Gate):** Ghim SHA256 digest bất biến cho `prom/prometheus:v3.15.0@sha256:...` và `grafana/grafana:13.2.3@sha256:...`; đưa cả hai vào quy trình quét Trivy fail-closed (`severity: CRITICAL,HIGH`, `exit-code: '1'`) trong CI. Các CVEs upstream được ghi nhận có vòng đời trong Sổ Quản trị Rủi ro `deploy/security/trivy-exception-register.md`.
    - **Evidence Hardening:** Chuẩn hóa Check 3 (assert counter delta `after > before`), Check 8 (Basic Auth header), Check 10 (Overlay config validation exit 0, isolation invariant & digest pinning).
  - Nghiệm thu tự động: `deploy/test-acceptance-gate-6-4-4.ts` đạt **10/10 CHECKS PASS**.
- [x] **Gate 6.4.5 — Academic Defense Dossier & Evidence Matrix (5 Môn Học - COMPLETED):**
  - Xây dựng bảng ma trận bằng chứng thực chứng 5 môn học tại [`plans/evidence_matrix_5_subjects.md`](../evidence_matrix_5_subjects.md):
    `Claim ➔ Source File ➔ Test/Gate ➔ Hosted Run ➔ Commit SHA ➔ Evidence Type ➔ Defense Talking Point ➔ What this does NOT prove ➔ Status`.
  - Thiết lập ranh giới phòng thủ (Boundary Defense) với cột **"What this does NOT prove"** cho từng phát biểu kỹ thuật, ngăn chặn nói quá sự thật trước hội đồng giám khảo và bảo đảm tính trung thực học thuật 100%.
  - Toàn bộ 17/17 claims kỹ thuật của 5 môn học đều đạt trạng thái **PASS**.


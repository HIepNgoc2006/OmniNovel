# 🧪 Phase 7B.4: Comprehensive Test Suite, Crash Acceptance Matrix & Zero-Gamification Verification

> **Trạng thái:** `[x] Đã Hoàn Thành & Nghiệm Thu Toàn Diện (CLOSED / FROZEN CLEAN - Hosted CI 7/7 Run #40541661660, Commit 526574b)`  
> **Mục tiêu:** Kiểm chứng toàn diện 11 kịch bản sự cố, bảo vệ tính toàn vẹn kinh tế ảo (Zero Gamification), ma trận phục hồi sau sự cố (Crash Matrix), vá bảo mật dependencies Trivy Docker API, và khóa cứng cổng kiểm soát không thoái lui (Zero Regression Gate) trên toàn bộ hệ thống Web, Mobile và Core API.

---

## 🏛️ 1. Danh Mục Các Hạng Mục Kiểm Thử & Remediation

### 1.0. Trivy Security Remediation, Test Isolation & Topology Gate (P0 & P1 Remediation)
- [x] **P0 - Vá 3 CVEs trên Core API Docker Image (`omninovel-api`):**
  - `body-parser`: Nâng cấp từ `1.20.4` lên `1.20.9` (khắc phục `CVE-2026-111181`).
  - `multer`: Nâng cấp từ `2.0.2` lên `2.5.0` (khắc phục `CVE-2026-113872`).
  - `zod`: Nâng cấp từ `3.25.76` lên `4.6.7` (khắc phục `CVE-2023-54404`).
  - Đã cấu hình npm `overrides` trong root `package.json` và đồng bộ `package-lock.json`. Đã build Docker image cục bộ và xác nhận Trivy Core API image scan PASS trên Hosted CI Run #40515739299, Run #40530990139 và Run #40541661660.
- [x] **P0 - Vá 27 CVEs trên AI Worker Docker Image (`omninovel-ai-worker`):**
  - `pillow`: Nâng cấp từ `11.3.0` lên `13.0.0` trong `requirements-prod-cpu.txt`, `requirements.txt` và `requirements.lock` (khắc phục triệt để toàn bộ 27 CVEs: `CVE-2026-112390`, `CVE-2026-112392`, `CVE-2026-112393`, `CVE-2026-112397`, `CVE-2026-112398`, `CVE-2026-112399`, `CVE-2026-112400`, `CVE-2026-112402`, `CVE-2026-112403`, `CVE-2026-112404`, `CVE-2026-112406`, `CVE-2026-112892`, `CVE-2026-112893`, `CVE-2026-112900`, `CVE-2026-96639`,...).
  - Đã build image Docker cục bộ và xác nhận `import PIL; print(PIL.__version__)` = `13.0.0`, kiểm thử Pytest & OCR pass 100%. Xác nhận scan Trivy AI Worker Image PASS trên Hosted CI Run #40521030994, Run #40530990139 và Run #40541661660.
- [x] **P0 - Vá 3 CVEs trên Nginx Docker Image (`omninovel-nginx`):**
  - Nâng cấp base image `deploy/nginx/Dockerfile` từ `nginx:1.30.5-alpine` lên `nginx:1.30.6-alpine` (khắc phục triệt để 3 CVEs mức HIGH: `CVE-2026-15176`, `CVE-2026-93479`, `CVE-2026-97205` đã được vá trong `nginx 1.30.6-r0`).
  - Scan Trivy Nginx Image PASS trên Hosted CI Run #40524208193, Run #40530990139 và Run #40541661660 (0 findings).
- [x] **P1 - Quản Trị Ngoại Lệ Lỗ Hổng Go Runtime & Alpine Base Utilities Mới Trên Hạ Tầng Observability:**
  - `CVE-2026-111943` phát sinh trong Go `stdlib` (crypto/x509) của image bên thứ 3 bất biến `prom/prometheus:v3.15.0` (Go 1.27.1) và `grafana/grafana:13.2.3` (Go 1.26.6). Xác nhận Prometheus scan PASS trên Hosted CI Run #40528862086, Run #40530990139 và Run #40541661660.
  - `CVE-2026-111497` (`brotli-libs`) và `CVE-2026-92392` (`curl`, `libcurl`) phát sinh trong Alpine packages của image bất biến `grafana/grafana:13.2.3`.
  - Đã cập nhật Sổ Quản trị Ngoại lệ Rủi ro (`deploy/security/trivy-exception-register.md`), đồng bộ scoped ignore files (`prometheus.trivyignore`, `grafana.trivyignore`) và kiểm chứng qua 12/12 kịch bản negative & integration tests của `validate-trivy-exceptions.py`. Toàn bộ 186/186 findings được xác nhận binding hợp lệ trên Hosted CI Run #40530990139 và Run #40541661660.
  - **Lịch review định kỳ vòng đời ngoại lệ rủi ro:** Đợt 1 vào `01/11/2026` và Đợt 2 vào `01/12/2026`.
- [x] **P1 - Khóa Chặt Bảo Vệ Cách Ly Kiểm Thử DB (Fail-Closed Test Isolation Guard):**
  - Xây dựng module bảo vệ độc lập `services/api/src/common/guards/test-isolation-guard.ts` với whitelist host nghiêm ngặt (`127.0.0.1`, `localhost`, `::1`, `postgres`, `omninovel-dev-postgres`) và danh sách đen cấm tuyệt đối các cloud/remote database hosts (`supabase.co`, `supabase.com`, `aws.com`, `neon.tech`, connection poolers) cũng như tên production DB (`omninovel_prod`, `omninovel_live`,...).
  - Chuẩn hóa `services/api/test/setup-e2e.ts`: Loại bỏ hoàn toàn nhánh bypass `if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = ...`. Mọi cấu hình kết nối bắt buộc phải đi qua `validateTestDatabaseTarget()` trước khi khởi tạo kết nối.
  - Bộ 12/12 unit tests (`test-isolation-guard.spec.ts`) và 2/2 integration tests (`test-isolation-guard.integration-spec.ts`) kiểm chứng chặn fail-closed 100% trên Hosted CI Run #40541661660.
- [x] **P1 - Khóa Cứng Ràng Buộc Topo VPS & Docker Compose (Topology Assertion Gate):**
  - Xây dựng công cụ kiểm toán topo `deploy/validate-compose-topology.py` không phụ thuộc thư viện ngoài (zero-dependency).
  - Kiểm tra tự động 4 bất biến topo:
    1. Chuẩn hóa đúng 3 networks: `omninovel-edge`, `omninovel-internal` (bắt buộc `internal: true`), `omninovel-egress`.
    2. Phân vùng network thành viên chính xác từng service (`nginx` edge-only, `api` 3 networks, `ai-worker` internal+egress, `redis` internal-only, `prometheus` internal-only, `grafana` internal-only).
    3. Kiểm soát cổng phơi nhiễm: Chỉ `nginx` mở cổng public (80/443); backend nội bộ (`api`, `ai-worker`, `redis`) cấm mở cổng host; observability (`prometheus`, `grafana`) bắt buộc bind loopback `127.0.0.1`.
    4. Cố định digest bất biến SHA256 cho Prometheus và Grafana.
  - Tích hợp 7/7 negative & positive unit tests matrix (`--test`) và pipe trực tiếp `docker compose config --format json` vào validator trong CI workflow `.github/workflows/ci-cd.yml`. Toàn bộ 7/7 tests và 6 services / 3 networks passed trên Hosted CI Run #40541661660.

---

## 🏛️ 1.1. Core API E2E & Integration Lifecycle (`services/api`)
File kiểm thử toàn diện: `services/api/test/guest-claim-lifecycle.e2e-spec.ts`:
- [x] **Kịch bản 1 (Input Boundaries & DTO Validation):**
  - Chặn `pageIndex < 1` (1-based index invariant).
  - Chặn `readingMode` không thuộc `WEBTOON | PAGED | NOVEL`.
  - Chặn payload danh sách vượt quá 500 mục.
  - Chặn chapter chưa xuất bản (`UNPUBLISHED`).
- [x] **Kịch bản 2 (Mode-Aware Conflict Detection):**
  - Thẩm định so sánh xung đột theo từng chế độ đọc chuyên biệt (PAGED dùng `pageIndex`, WEBTOON dùng `scrollPosition` + `progressPercentage`, NOVEL dùng `anchorBlockId` + `textOffset`).
- [x] **Kịch bản 3 (Tombstone Anti-Resurrection Invariant):**
  - Đảm bảo truyện có tombstone bị chặn triệt để, không cho phép hồi sinh read states hoặc progress vào PostgreSQL.
- [x] **Kịch bản 4 (Commit Idempotency First):**
  - Gọi commit lần 1 thành công -> Gọi commit lần 2 trả ngay 200 OK từ ledger `guest_claims`, không duplicate insert, không thay đổi số liệu, bất kể quá hạn TTL 15 phút.
- [x] **Kịch bản 5 (Redis Loss Fallback Simulation):**
  - Mô phỏng kịch bản Redis lock gặp lỗi/timeout -> Cơ chế fallback commit vẫn hoàn tất an toàn nhờ hàng phòng ngự khóa hàng PostgreSQL row lock (`SELECT FOR UPDATE`). *(Lưu ý ranh giới kỹ thuật: kiểm thử chứng minh fallback logic hoạt động đúng trong kịch bản lỗi được mô phỏng).*
- [x] **Kịch bản 6 (TOCTOU Protection & Stale Fingerprint Detection):**
  - Dữ liệu Cloud thay đổi giữa thời điểm `prepare` và `commit` -> Commit phát hiện fingerprint sai lệch và trả về `409 Conflict (CLAIM_STALE_REPREPARE)`.
- [x] **Kịch bản 7 (Security Ownership Enforcement):**
  - User B dùng token của mình gọi commit `claimId` do User A prepare -> Chặn đứng bằng `403 Forbidden`.
- [x] **Kịch bản 8 (Expired Session Handshake):**
  - Gọi commit claim ở trạng thái `PREPARED` sau khi đã quá hạn 15 phút -> Chuyển trạng thái sang `EXPIRED` và trả về `410 Gone`.
- [x] **Kịch bản 9 (Crash Recovery via Status Polling):**
  - Endpoint `GET /status` trả đầy đủ trạng thái và `finalization_data` chứng minh API cung cấp đủ dữ liệu cho client đối soát và phục hồi. User khác gọi status bị chặn `403 Forbidden`.
- [x] **Kịch bản 10 (Zero-Gamification Verification - Invariant Bắt Buộc):**
  - Snapshot bảng thực tế `user_progression` trước và sau commit (`total_exp`, `omnicoin_balance`, `current_streak`, `max_streak`) -> Khẳng định $\Delta = 0$ trên toàn bộ các chỉ số progression được kiểm tra.
- [x] **Kịch bản 11 (Two-Phase Deletion & Account Lifecycle Coherence):**
  - Day 0 Soft delete bảo tồn nguyên vẹn quyền tác giả và ledger (`guest_claims`, `reward_transactions`).
  - Reactivate Account phân xử đúng 3 nhánh.
  - Day 30 Purge dùng Node.js SHA-256 ẩn danh hóa ledgers và kích hoạt cascade dọn sạch private data.

---

## 🏛️ 1.2. Web Client Crash Recovery & Transitioning Lock (`apps/web`)
- [x] Xác nhận 50/50 test files, 657/657 tests Vitest và 31/31 Playwright E2E tests bao phủ trọn vẹn:
  - Khóa `TRANSITIONING` ngăn chặn triệt để account mutation khi đang xử lý claim.
  - Marker Quarantine: bấm Skip thì đánh dấu marker, bảo toàn partition vật lý `guest:<id>`.
  - Rebind & Purge: commit thành công thì sáp nhập vào IndexedDB account và dọn dẹp partition khách.
  - Crash recovery via `pendingClaimId` tri-state (`NONE`, `RESOLVED`, `PENDING_UNAVAILABLE`).

---

## 🏛️ 1.3. Mobile Client Crash Matrix & Transactional Merge (`apps/mobile`)
- [x] Xác nhận toàn bộ 19/19 Acceptance Criteria tests và 500/500 Mobile Flutter tests:
  - Quét đúng SQLite partition `guest:<id>`.
  - Transactional local merge không xung đột Primary Key `[ownerScope, storyId]`.
  - Marker quarantine khi Skip.
  - Khôi phục an toàn sau crash qua `pending_claim_id`.

---

## 🏛️ 1.4. Cổng Kiểm Soát Không Thoái Lui Toàn Hệ Thống (Regression Gate)
- [x] NestJS Core API: Unit tests (476/476 passed, 1 skipped) & E2E/Integration tests (277/277 passed).
- [x] Web Client: Lint, Typecheck, Vitest (657/657 tests passed) & Playwright E2E (31/31 tests passed).
- [x] Mobile Client: Flutter analyze 0 errors & 500/500 Flutter tests passed.
- [x] AI Worker: Pytest suite (323/323 tests passed).
- [x] Security Audit: TruffleHog + P1 Trivy Governance 12/12 scenarios passed.
- [x] Docker Build & Trivy Image Scans: 5/5 Trivy image scans pass (Core API, AI Worker, Nginx, Prometheus, Grafana) trên Hosted CI Run #40541661660 (186/186 bindings verified).
- [x] VPS Deployment & Topology Verification: 7/7 unit tests & 6-service 3-network topology assertion verified (Run #40541661660). *(Lưu ý: Job VPS deployment trên CI hiện đóng vai trò Topology Dry-Run Verification, phân biệt rõ ràng với Production Live VPS Deployment).*
- [x] Hosted CI: 7/7 jobs SUCCESS trên Hosted CI Run #40541661660 (Commit `526574b`).

---

## 📅 2. Bảng Theo Dõi Tiến Độ Thực Thi

| Bước | Nội Dung | Trạng Thái |
| :---: | :--- | :---: |
| **Bước 1** | Xây dựng bộ test E2E `guest-claim-lifecycle.e2e-spec.ts` cho Core API bao phủ 11 kịch bản | `[x] Hoàn thành` |
| **Bước 2** | Chạy kiểm thử cục bộ NestJS Test Suite & sửa lỗi phát sinh (Migration + E2E pass 16/16) | `[x] Hoàn thành` |
| **Bước 3** | Rà soát và hoàn thiện ma trận Crash Matrix trên Web & Mobile Client | `[x] Hoàn thành` |
| **Bước 4** | Chạy kiểm thử toàn bộ hệ thống (Web 657 tests, Mobile 500 tests, AI Worker 323 tests, Core API) | `[x] Hoàn thành` |
| **Bước 5** | Vá 3 CVEs Trivy Docker API, chuẩn hóa cách ly test DB, commit & push kích hoạt CI 7/7 | `[x] Hoàn thành (Hosted CI 7/7 Run #40530990139, Commit 4892dd2)` |
| **Bước 6** | Hardening bảo vệ cách ly test DB & topo VPS assertions, kiểm chứng CI 7/7 và ký đóng FROZEN CLEAN Phase 7B.4 | `[x] Hoàn thành (FROZEN CLEAN / CLOSED - Hosted CI 7/7 Run #40541661660, Commit 526574b)` |

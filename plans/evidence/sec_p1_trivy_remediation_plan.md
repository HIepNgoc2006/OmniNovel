# Kế Hoạch Xử Lý 102 Ngoại Lệ Trivy & Đề Xuất Branch Protection (SEC-P1 Governance)

> **Mã tài liệu:** SEC-P1-TRIVY-GOV  
> **Phạm vi kiểm toán:** Toàn bộ **102 scoped entries** (`ai-worker`: 57, `api`: 34, `grafana`: 7, `nginx`: 3, `prometheus`: 1 — tương ứng **99 mã advisory duy nhất** trong `.trivyignore` root).  
> **Hạn rà soát bắt buộc:** **`2026-12-01`** (đối chiếu thực chứng trực tiếp trên Trivy `v0.76.0` JSON reports của CI Run `#42636532910` và build Docker kiểm chứng cục bộ).  
> **Nguyên tắc quản trị:** Không gia hạn hàng loạt thiếu rà soát; không tự ý chỉnh sửa GitHub Branch Protection.

---

## 1. Tổng Quan Phân Loại 102 Ngoại Lệ (Baseline 2026-11-09)

Tổng hợp thực nghiệm từ báo cáo Trivy thô (`--scanners vuln --ignorefile=""`) trên 5 container images:

| Container Image | Active Scoped Entries | Đã Vá Trong Image Hiện Tại (`0` raw -> Gỡ bỏ) | Upstream Patch Available (Vá trực tiếp / Chờ image) | No Fix Upstream (`Accepted Risk` có bù đắp) | Raw Findings Trong CI Run #42636532910 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `omninovel-nginx` | 3 | 3 | 0 | 0 | 0 |
| `prom/prometheus:v3.16.0` | 1 | 0 | 1 *(dep fixed, chờ image > v3.16.0)* | 0 | 2 |
| `grafana/grafana:13.3.0` | 7 | 0 | 7 *(dep fixed, chờ image > 13.3.0)* | 0 | 54 |
| `omninovel-api` | 34 | 18 | 16 *(vá trực tiếp npm / Dockerfile)* | 0 | 18 |
| `omninovel-ai-worker` | 57 | 21 | 9 *(vá trực tiếp PyPI / multi-stage)* | 27 *(1 Python + 26 Debian 13 OS)* | 76 |
| **Tổng cộng** | **102** | **42** | **33** *(25 vá trực tiếp + 8 chờ image 3rd-party)* | **27** | **150** *(khớp 100% `ai-worker 76`, `api 18`, `grafana 54`, `nginx 0`, `prometheus 2`)* |

> **Lưu ý quan trọng về 42 mục `Already Resolved` (`0` raw):** Đây là các CVE đã biến mất khỏi image build hiện tại (nhờ nâng cấp Alpine 3.24, npm overrides `multer@2.5.0` / `body-parser@1.20.9`, gỡ `npm` global trong stage runner API, và nâng cấp `Pillow>=13.0.0`). Tuy nhiên không được phép giữ thụ động sang chu kỳ mới: **bắt buộc dọn sạch toàn bộ 42 dòng khỏi `*.trivyignore` và cập nhật `trivy-exception-register.md` thành `ĐÃ GIẢI QUYẾT` trước `2026-12-01`**.

---

## 2. Ma Trận Xử Lý Đầy Đủ 102 Ngoại Lệ (Trước `2026-12-01`)

### 2.1. `omninovel-nginx` (3 entries — 100% Đã giải quyết trong image hiện tại)

| Advisory ID | Package Dự kiến | Raw Hiện Tại | Trạng thái & Phân loại | Hành động Trước `2026-12-01` | Chủ quản |
| :--- | :--- | :---: | :--- | :--- | :---: |
| `CVE-2024-21538` | base/utils (`nginx`) | 0 | **Already Resolved (0 raw)** | Gỡ khỏi `nginx.trivyignore`, chuyển `RESOLVED` | DevOps |
| `CVE-2026-103111` | `pcre2` | 0 | **Already Resolved (0 raw)** | Gỡ khỏi `nginx.trivyignore`, chuyển `RESOLVED` | DevOps |
| `CVE-2026-93990` | `libexpat` | 0 | **Already Resolved (0 raw)** | Gỡ khỏi `nginx.trivyignore`, chuyển `RESOLVED` | DevOps |

### 2.2. `prom/prometheus:v3.16.0` (1 entry — Third-Party Immutable Image)

| Advisory ID | Package (Installed) | FixedVersion Upstream | Raw Hiện Tại | Phân loại | Rủi ro & Kiểm soát Bù đắp / Kế hoạch | Chủ quản |
| :--- | :--- | :--- | :---: | :--- | :--- | :---: |
| `CVE-2026-78661` | `golang.org/x/net` (`v0.61.0`) | `0.62.0` (dep Go) | 2 | **Upstream Patch Available (Dep) / Accepted Risk (Image)** | Image `v3.16.0` đóng băng của vendor chưa bump `x/net`. Chỉ mở loopback `127.0.0.1:9090` trên `omninovel-internal`, zero public ingress, không parse untrusted HTML. Kiểm tra tag `prom/prometheus > v3.16.0` trước `2026-12-01`; chỉ gia hạn nếu có biên bản rà soát mới. | DevOps |

### 2.3. `grafana/grafana:13.3.0` (7 entries — Third-Party Immutable Image)

| Advisory ID | Package (Installed) | FixedVersion Upstream | Raw | Phân loại | Kiểm soát Bù đắp & Kế hoạch Trước `2026-12-01` | Chủ quản |
| :--- | :--- | :--- | :---: | :--- | :--- | :---: |
| `CVE-2026-111943` | `stdlib` (`v1.26.7`) | `1.26.10` / `1.27.3` | 16 | **Upstream Patch Available (Dep) / Accepted Risk (Image)** | Bind loopback `127.0.0.1:3001`, không qua Nginx public edge, non-root `UID 472`. Theo dõi bản `grafana/grafana > 13.3.0` build bằng Go >= `1.27.3`. | DevOps |
| `CVE-2026-78667` | `stdlib` (`v1.26.7`) | `1.26.9` / `1.27.2` | 16 | **Upstream Patch Available (Dep) / Accepted Risk (Image)** | Nt. (Go `crypto/x509` / stdlib trong upstream binary `grafana`). | DevOps |
| `CVE-2026-78669` | `stdlib` (`v1.26.7`) | `1.26.9` / `1.27.2` | 16 | **Upstream Patch Available (Dep) / Accepted Risk (Image)** | Nt. (Go `stdlib`, tách biệt mạng nội bộ). | DevOps |
| `CVE-2026-97031` | `stdlib` (`v1.26.7`) | `1.26.9` / `1.27.2` | 2 | **Upstream Patch Available (Dep) / Accepted Risk (Image)** | Nt. (Go `stdlib` TLS/HTTP2, không tiếp xúc internet công cộng). | DevOps |
| `CVE-2026-78661` | `golang.org/x/net` (`v0.60.0` / `v0.61.0` / `v0.58.0`) | `0.62.0` | 2 | **Upstream Patch Available (Dep) / Accepted Risk (Image)** | Nt. Không mở đăng ký/anonymous (`GF_AUTH_ANONYMOUS_ENABLED=false`). | DevOps |
| `CVE-2026-21728` | `github.com/grafana/tempo` (`v1.5.1-...`) | `2.8.4` / `2.9.2` / `2.10.2` | 1 | **Upstream Patch Available (Dep) / Accepted Risk (Image)** | OmniNovel chỉ provision duy nhất datasource Prometheus nội bộ; Tempo datasource **không kích hoạt**. | DevOps |
| `CVE-2026-28377` | `github.com/grafana/tempo` (`v1.5.1-...`) | `2.10.3` | 1 | **Upstream Patch Available (Dep) / Accepted Risk (Image)** | Nt. (Tempo datasource disabled). | DevOps |

### 2.4. `omninovel-api` (34 entries = 16 Active Patchable + 18 Already Resolved)

#### Nhóm A — 16 Active CVEs (`Upstream Patch Available` — Bắt buộc xử lý đợt vá trước `2026-12-01`)

| Package (Installed -> Fixed) | Advisory IDs | Mức độ / Số lượng | Đường phụ thuộc & Hành động Khắc phục Đề xuất | Chủ quản |
| :--- | :--- | :---: | :--- | :---: |
| `tar` (`6.2.1` -> `7.5.3`..`7.5.21`) | `CVE-2026-59873` (**CRITICAL**), `CVE-2026-23745`, `CVE-2026-23950`, `CVE-2026-24842`, `CVE-2026-26960`, `CVE-2026-29786`, `CVE-2026-31802`, `CVE-2026-59874`, `CVE-2026-73566` | **9 CVEs** (1 CRIT, 8 HIGH) | Phụ thuộc bắt cầu từ `argon2@0.31.2` -> `@mapbox/node-pre-gyp` -> `tar` (chỉ phục vụ build/install native binding). **Giải pháp Wave 1:** nâng cấp `argon2` lên phiên bản mới dùng `node-pre-gyp`/`tar >= 7.5.21` hoặc dọn thư mục `@mapbox/node-pre-gyp` build-helper không dùng tại Stage runner của `services/api/Dockerfile` sau khi compile xong `.node` binary (kèm kiểm thử argon2 smoke test!). | Backend / DevOps |
| `brace-expansion` (`1.1.18` -> `1.1.19+`, `2.1.4` -> `2.1.5+`) | `CVE-2026-102276`, `CVE-2026-102278` | **2 CVEs** (4 raw findings) | Cập nhật `package-lock.json` / cấu hình `overrides` cho `brace-expansion` trong monorepo. | Backend |
| `engine.io` (`6.6.9` -> `6.6.10`) | `CVE-2026-102599` | **1 CVE** | Phụ thuộc của `socket.io@4.8.3`. Cập nhật `socket.io` / `engine.io >= 6.6.10` qua `npm update` / `overrides` và chạy lại WebSocket E2E. | Backend |
| `js-yaml` (`4.1.0` -> `4.3.0`..`4.3.2`) | `CVE-2026-59869`, `CVE-2026-84375`, `GHSA-5p4m-2wfm-xmqj` | **3 CVEs/GHSAs** | Ghim bởi `@nestjs/swagger@7.4.2`. Kiểm thử tương thích `overrides` `js-yaml@^4.3.2` với Swagger OpenAPI generation hoặc nâng `@nestjs/swagger` tương thích NestJS 10; kiểm chứng toàn bộ API unit + E2E. | Backend |
| `lodash` (`4.17.21` -> `4.18.0`) | `CVE-2026-4800` | **1 CVE** | Nâng lên `lodash >= 4.18.0` qua `overrides` và chạy lại `core-api-test`. | Backend |

#### Nhóm B — 18 Inactive CVEs (`Already Resolved` — `0` raw trong CI)

- **Danh sách dọn sạch trước `2026-12-01`:** `CVE-2025-64756`, `CVE-2026-13149`, `CVE-2026-14257`, `CVE-2026-2359`, `CVE-2026-26996`, `CVE-2026-27903`, `CVE-2026-27904`, `CVE-2026-3304`, `CVE-2026-3520`, `CVE-2026-48815`, `CVE-2026-5079`, `CVE-2026-59870`, `CVE-2026-69152`, `CVE-2026-69192`, `CVE-2026-77078`, `CVE-2026-82333`, `CVE-2026-93748`, `CVE-2026-9496`.
- **Hành động:** Gỡ toàn bộ 18 mã khỏi `deploy/security/trivy/api.trivyignore` và cập nhật trạng thái `ĐÃ GIẢI QUYẾT` trong `trivy-exception-register.md`.

### 2.5. `omninovel-ai-worker` (57 entries = 9 Python Patchable + 27 No-Fix Accepted Risk + 21 Already Resolved)

#### Nhóm A — 9 Active Python CVEs (`Upstream Patch Available`)

| Package (Installed -> Fixed) | Advisory IDs | Hành động & Kiểm soát Regression | Chủ quản |
| :--- | :--- | :--- | :---: |
| `starlette` (`0.48.0` -> `0.49.1` / `1.1.0` / `1.3.1`) | `CVE-2025-62727`, `CVE-2026-48818`, `CVE-2026-54283` | **Wave 1 (Ưu tiên cao):** Kiểm thử nâng cấp `fastapi` + `starlette >= 1.3.1` trong `requirements-prod-cpu.txt` & `requirements-ci-cpu.txt`, xác minh Pytest `ai-worker-test`. | AI Team |
| `jaraco.context` (`5.3.0` -> `6.1.0`) | `CVE-2026-23949` | **Wave 1:** Upgrade `jaraco.context>=6.1.0` hoặc tách multi-stage build cho `omninovel-ai-worker` để loại bỏ build/packaging metadata dư thừa khỏi runtime image. | AI Team / DevOps |
| `wheel` (`0.45.1` -> `0.46.2`) | `CVE-2026-24049` | **Wave 1:** Upgrade `wheel>=0.46.2` trong image builder hoặc dùng multi-stage copy virtualenv sạch (gỡ `wheel` khỏi final runtime stage nếu không cần). | AI Team / DevOps |
| `torch` (`2.6.0+cpu` -> `2.10.0`) | `CVE-2026-24747` | **Wave 2 (Cần thử nghiệm OCR thật):** Mở khóa giới hạn `<2.7.0`, nâng `torch>=2.10.0` (CPU wheel) và chạy full `manga-ocr==0.1.16` real-inference regression benchmark (so sánh latency/RAM/kết quả OCR). | AI Team |
| `transformers` (`4.57.6` -> `5.3.0` / `5.5.0` / `5.10.0`) | `CVE-2026-4372`, `CVE-2026-5241`, `CVE-2026-9856` | **Wave 2 (Cần thử nghiệm OCR thật):** Mở khóa `<5.0.0`, kiểm tra tương thích với `manga-ocr==0.1.16` khi nâng lên `transformers >= 5.10.0` (lưu ý `CVE-2026-80047` chưa có bản vá trên `4.57.6`, cần kiểm tra trạng thái trên nhánh `5.10.x`). | AI Team |

#### Nhóm B — 27 Active CVEs (`No Fix Upstream` -> `Accepted Risk` có kiểm soát bù đắp)

| Nhóm Package (Installed) | Advisory IDs | Tổng | Kiểm soát Bù đắp & Đánh giá Rà soát Trước `2026-12-01` | Chủ quản |
| :--- | :--- | :---: | :--- | :---: |
| `transformers` (`4.57.6`) | `CVE-2026-80047` | 1 | `trust_remote_code=False`, chỉ nạp `manga-ocr-base` từ cache cục bộ, không tải weights từ user, cô lập trong `omninovel-internal`. | AI Team |
| `libxml2` (`Debian 13 Trixie`) | `CVE-2026-6653` (**CRITICAL**), `CVE-2026-74860`, `CVE-2026-86138`, `CVE-2026-86139`, `CVE-2026-86140`, `CVE-2026-86142`, `CVE-2026-86143`, `CVE-2026-86144` | 8 | Zero public ingress, API chặn SVG/XML bằng Magic-Bytes (chỉ nhận JPEG/PNG/WebP), `ai-worker` không parse XML. Theo dõi Debian security tracker `trixie-security`; nếu chưa có vá Debian trước hạn -> rà soát riêng từng CVE (xem xét khả năng bỏ `libxml2` nếu không phải hard dependency bắt buộc hoặc ký gia hạn có điều kiện kèm bằng chứng `apt-cache policy`). | DevOps |
| `libexpat1` (`2.9.0-1~deb13u1`) | `CVE-2026-113351`, `CVE-2026-115506`, `CVE-2026-117610`, `CVE-2026-118370` | 4 | Không parse XML/DTD, API Magic-Bytes lọc định dạng ảnh, non-root `UID 10001`. | AI Team / DevOps |
| `util-linux` / `bsdutils` / `mount` / `libblkid1` / `liblastlog2-2` / `libmount1` / `libsmartcols1` / `libuuid1` / `login` | `CVE-2026-76642`, `CVE-2026-78408`, `CVE-2026-78409`, `CVE-2026-78410` | 4 *(15 raw pkgs)* | Không có `CAP_SYS_ADMIN`, UID `10001`, seccomp/apparmor chặn mount/namespace syscalls. | DevOps |
| `libsqlite3-0` (`3.46.1-7+deb13u2`) | `CVE-2026-119373`, `CVE-2026-119374`, `CVE-2026-119379` | 3 | Không dùng SQLite hay nạp file `.db`/changeset (dùng PostgreSQL + Redis + R2). | DevOps |
| `curl` / `libcurl4t64` | `CVE-2026-12064`, `CVE-2026-8458` | 2 | Chỉ dùng `curl` cho local loopback `HEALTHCHECK`; tải ảnh qua `httpx`/`aiohttp` có SSRF guard tới R2. (Ghi chú: có thể thay `HEALTHCHECK` dùng Python `urllib` để gỡ hẳn gói `curl` CLI nếu cần giảm bề mặt OS). | DevOps |
| `ncurses` (`libncursesw6`, `libtinfo6`, `ncurses-*`) | `CVE-2025-69720` | 1 | Headless FastAPI, không khởi tạo TUI/terminal. | DevOps |
| `libsystemd0` / `libudev1` | `CVE-2026-16742` | 1 | Không chạy systemd (`PID 1 = uvicorn`), không dùng `systemd-homed`. | DevOps |
| `libacl1` | `CVE-2026-54369` | 1 | Container non-root `UID 10001`, không chạy đặc quyền filesystem ACL tools. | DevOps |
| `libx11-6` / `libx11-data` | `CVE-2026-88806` | 1 | Phụ thuộc của `libgl1`, OpenCV chạy headless in-memory, không mở X11 socket. | DevOps |
| `perl-base` | `CVE-2026-9538` | 1 | Runtime Python thuần túy, không gọi Perl CLI giải nén archive. | DevOps |

#### Nhóm C — 21 Inactive CVEs (`Already Resolved` — `0` raw trong CI)

- **Danh sách dọn sạch trước `2026-12-01`:** `CVE-2024-21538`, 13 Pillow CVEs (`CVE-2026-25990`, `CVE-2026-40192`, `CVE-2026-42311`, `CVE-2026-54058`, `CVE-2026-54059`, `CVE-2026-54060`, `CVE-2026-55379`, `CVE-2026-55380`, `CVE-2026-59197`, `CVE-2026-59199`, `CVE-2026-59200`, `CVE-2026-59204`, `CVE-2026-59205`), `CVE-2026-66046`, `CVE-2026-76956`, `CVE-2026-76957`, `CVE-2026-77214`, `CVE-2026-8286`, `CVE-2026-8927`, `CVE-2026-93990`.
- **Hành động:** Gỡ khỏi `deploy/security/trivy/ai-worker.trivyignore` và cập nhật trạng thái `ĐÃ GIẢI QUYẾT` trong `trivy-exception-register.md`.

---

## 3. Lộ Trình Thực Thi Trước Hạn `2026-12-01` (Không Gia Hạn Hàng Loạt)

| Giai đoạn | Thời hạn mục tiêu | Nội dung công việc cụ thể | Tiêu chí hoàn thành (Gate) |
| :--- | :---: | :--- | :--- |
| **Wave 0 — Prune 42 mục `0` raw** | `2026-11-16` | Gỡ sạch 42 CVE không còn tồn tại trong build hiện tại (`nginx` 3, `api` 18, `ai-worker` 21), đồng bộ root `.trivyignore` và `trivy-exception-register.md`. | `validate-trivy-exceptions.py --enforce-reports` PASS; tổng exceptions giảm từ `102 -> 60`. |
| **Wave 1 — Vá ngay 19 CVE chi phí thấp (`api` + `ai-worker` infra)** | `2026-11-22` | Xử lý `tar@6.2.1` (bao gồm `CVE-2026-59873` CRITICAL), `brace-expansion`, `engine.io`, `js-yaml`, `lodash` (`api` 16 CVEs); nâng `starlette`, `jaraco.context`, `wheel` (`ai-worker` 5 CVEs). Đánh giá bỏ `curl` CLI ở `ai-worker` bằng Python stdlib healthcheck. | Toàn bộ `core-api-test`, `ai-worker-test`, `docker-build-scan` PASS; exceptions giảm tiếp `60 -> 39` (và xóa sạch CRITICAL npm `tar`). |
| **Wave 2 — Kiểm thử tương thích OCR (`torch`/`transformers`) & Upstream 3rd-party** | `2026-11-27` | Kiểm thử `manga-ocr 0.1.16` với `torch >= 2.10.0` và `transformers >= 5.10.0` (xử lý 4 Python CVEs); kiểm tra bản mới nhất của `prom/prometheus`, `grafana/grafana`, và `apt-get upgrade` Debian 13 `trixie-security`. | Kết quả benchmark OCR + Playwright/API regression PASS trên CI. |
| **Wave 3 — Rà soát cá thể từng ngoại lệ `No Fix` còn lại** | `2026-11-29` .. `2026-11-30` | Chỉ những CVE thực sự có bằng chứng **`apt-cache policy` / PyPI / upstream image chưa phát hành bản vá** mới được phê duyệt gia hạn từng mục (kèm ngày rà soát mới, tối đa 60–90 ngày). Tuyệt đối **cấm sửa ngày đồng loạt `sed 's/2026-12-01/.../'`** thiếu review từng CVE. | `validate-trivy-exceptions.py` có audit log & bằng chứng exploitability riêng cho từng CVE gia hạn. |

---

## 4. Đề Xuất GitHub Branch Protection — Required Status Checks (6 Jobs)

> **Lưu ý tuân thủ:** Đề xuất cấu hình dưới đây để người quản trị repository phê duyệt và áp dụng trên GitHub UI/Settings cho nhánh `main`. **Chưa tự động thay đổi Branch Protection trong đợt P1 này.**

### Danh sách 6 Required Status Checks (Tên Check Context chính xác trong `.github/workflows/ci-cd.yml`)

| # | Job Key | Tên Check Context Chính Xác (Required Status Check) | Vai trò Bảo vệ |
| :---: | :--- | :--- | :--- |
| 1 | `ai-worker-test` | `AI Worker Test Suite (Pytest & Real OCR Model)` | Đảm bảo toàn vẹn logic worker & OCR (`323+` pytest) |
| 2 | `core-api-test` | `NestJS Core API Test Suite (Jest Unit & E2E)` | Đảm bảo Core API Unit & Integration/E2E + DB Isolation Guard |
| 3 | `web-client-test` | `Web Client Test Suite (Lint, Typecheck, Vitest & Playwright E2E)` | Đảm bảo Lint, Typecheck, Build, Vitest & Playwright E2E |
| 4 | `mobile-foundation-test` | `Mobile Client Test Suite (Phase 5A Foundation)` | Đảm bảo `flutter analyze` (0 errors) & Flutter tests |
| 5 | `security-scan` | `Security Audit & Secret Scanning` | Cổng fail-closed Git hygiene, TruffleHog Pass 1 + Pass 2 P1 Scoped, và Trivy governance |
| 6 | `docker-build-scan` | `Docker Images Build & Security Scan` | Build 3 images, trích xuất Trivy raw JSON + `--enforce-reports` + fail-closed `exit-code: '1'` |

### Quy tắc Loại trừ Quan trọng
- **KHÔNG đưa `VPS Production Deployment & Topology Verification` (`deploy-vps`) vào danh sách Required Status Checks** cho PR merge gate: job này có điều kiện `if: github.ref == 'refs/heads/main' && github.event_name == 'push'`, nên luôn ở trạng thái **`SKIPPED`** trên `pull_request` (như quan sát trên Hosted CI `#42636532910`: `6 SUCCESS + 1 SKIPPED`). Nếu đặt `deploy-vps` là Required, mọi PR vào `main` sẽ bị kẹt vĩnh viễn.
- **Khuyến nghị bổ sung khi quản trị viên bật Branch Protection trên `main`:**
  - Bật *Require a pull request before merging* (tối thiểu 1 approval review).
  - Bật *Require status checks to pass before merging* + *Require branches to be up to date before merging* với đúng 6 check contexts nêu trên.
  - Bật *Do not allow bypassing the above settings* cho toàn bộ contributor.

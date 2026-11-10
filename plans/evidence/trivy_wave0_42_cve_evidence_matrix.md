# 🛡️ Bằng Chứng Xác Minh Từng CVE & Đối Soát Nhận Diện Image — Trivy Wave 0 (SEC-EVID-WAVE0-01)

> **Mã tài liệu:** SEC-EVID-WAVE0-01  
> **Nhánh thực hiện:** `feat/trivy-wave-0-prune-resolved` (Worktree độc lập `E:/Workspace2/Doctruyen_project_trivy_wave0`)  
> **Base Commit:** `3c09b1e` (HEAD của PR #211 P0 TruffleHog Fail-Closed)  
> **Ngày lập hồ sơ:** 2026-11-10  
> **Mục tiêu:** Rà soát, đối chiếu thực chứng và chuẩn hóa phân loại 42 ngoại lệ Trivy đã giải quyết (Wave 0 Pruning).

---

## 📌 I. ĐỐI SOÁT NHẬN DIỆN IMAGE & HỆ ĐIỀU HÀNH THỰC TẾ (GROUND-TRUTH VERIFICATION)

Tuyệt đối tuân thủ nguyên tắc không suy đoán đường dẫn hoặc phiên bản mặc định, thông số dưới đây được trích xuất trực tiếp từ Docker inspection và lệnh kiểm tra `/etc/os-release` trên máy trạm thực tế:

| Container Service | Base Image Tag & Digest | Hệ điều hành thực tế (`/etc/os-release`) | Kiến trúc & Runtime | Phương pháp củng cố & Làm sạch |
| :--- | :--- | :--- | :--- | :--- |
| **`omninovel-api`** | `node:20-alpine`<br>Digest: `sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293` | **Alpine Linux v3.23 (VERSION_ID=3.23.4)** | `linux/amd64`<br>Node.js v20.x | `apk upgrade --no-cache` (vá `libcrypto3`/`libssl3` lên `3.5.9-r0`), `rm -rf /usr/local/lib/node_modules/npm` (gỡ bỏ global npm/npx). |
| **`omninovel-nginx`** | `nginx:1.30.6-alpine`<br>Digest: `sha256:583b7f2fce1cdb8da5ad5c39ebd3c33b98b87d493190e548bdee1fa8c619c311` | **Alpine Linux v3.24 (VERSION_ID=3.24.4)** | `linux/amd64`<br>Nginx 1.30.6 | Alpine 3.24 nạp sẵn `pcre22@10.46-r0` (vá CVE-2026-103111). Bản build local manifest: `sha256:308ea299fbf668557d23387e1ec511f03279a46e699ab6ace5401d7cc35c864a`. |
| **`omninovel-ai-worker`** | `python:3.11-slim`<br>Digest: `sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535` | **Debian GNU/Linux 13 (Trixie) (DEBIAN_VERSION_FULL=13.7)** | `linux/amd64`<br>Python 3.11.x | `apt-get upgrade -y --no-install-recommends` (vá `zlib1g 1:1.3.dfsg+really1.3.1-1+deb13u1`), `requirements-prod-cpu.txt` nâng `Pillow>=13.0.0`. |
| **`prom/prometheus`** | `prom/prometheus:v3.16.0`<br>Pinned Digest: `sha256:e0498764491be7...` | Linux minimal scratch | `linux/amd64`<br>Prometheus v3.16.0 | Nâng cấp image lên v3.16.0 giải quyết triệt để 5 CVEs lịch sử. |
| **`grafana/grafana`** | `grafana/grafana:13.3.0`<br>Pinned Digest: `sha256:488984b72c4e6f...` | **Alpine Linux v3.24 (VERSION_ID=3.24.3)** | `linux/amd64`<br>Grafana 13.3.0 (Go v1.26.7) | Nâng cấp image lên 13.3.0 giải quyết 10 CVEs lịch sử (OpenAPI, curl, brotli, jose, alertmanager). |

> [!NOTE]
> **Giải thích mâu thuẫn hệ điều hành giữa các báo cáo trước:**
> Báo cáo trước đây nhắc tới cả Alpine 3.23 và Alpine 3.24. Đối soát thực tế xác nhận cả hai phiên bản đều hiện diện đồng thời: Core API sử dụng base `node:20-alpine` (Alpine 3.23.4), trong khi Nginx sử dụng base `nginx:1.30.6-alpine` (Alpine 3.24.4). Cả hai đều đạt trạng thái kiểm định sạch và không có phát hiện ngoài ngoại lệ.

---

## 📊 II. MA TRẬN ĐỐI SOÁT CHI TIẾT 42 NGOẠI LỆ TRIVY ĐÃ GỠ BỎ (WAVE 0)

Mọi mục gỡ bỏ đều được phân loại nghiêm ngặt theo 4 danh mục:
1. `PACKAGE_ABSENT`: Gói thư viện hoàn toàn vắng mặt trong container image runtime.
2. `FIXED_VERSION_CONFIRMED`: Gói có cài đặt nhưng phiên bản thực tế nằm ngoài dải ảnh hưởng, có đối soát mã nguồn/build manifest.
3. `ADVISORY_NOT_REPORTED`: Gói có tồn tại trong image, nhưng kết quả quét Trivy unsuppressed (`--ignorefile=""`) trên image thực tế không ghi nhận mã CVE này.
4. `EVIDENCE_INSUFFICIENT`: Chưa đủ chứng cứ thực tế (0 mục).

| STT | Scoped Image | Mã Advisory / CVE | Package Binding | Phiên bản cài đặt / Mục tiêu | Raw Findings (Unsuppressed) | Phân loại chuẩn hóa | Bằng chứng kỹ thuật / Nguồn đối soát |
| :---: | :--- | :--- | :--- | :--- | :---: | :--- | :--- |
| 1 | `nginx` | `CVE-2024-21538` | `cross-spawn` | N/A (Không cài đặt) | 0 | **`PACKAGE_ABSENT`** | Nginx là C binary trên Alpine; không chứa Node.js hay package `cross-spawn`. |
| 2 | `nginx` | `CVE-2026-93990` | `libexpat` | N/A (Không cài đặt) | 0 | **`PACKAGE_ABSENT`** | `apk info -e expat libexpat` trả về rỗng trên `nginx:1.30.6-alpine`. |
| 3 | `nginx` | `CVE-2026-103111` | `pcre2` | `10.46-r0` (Alpine 3.24) | 0 | **`FIXED_VERSION_CONFIRMED`** | `pcre22@10.46-r0` nạp sẵn trong base image Alpine 3.24.4, đã vá out-of-bounds write. |
| 4 | `api` | `CVE-2026-93748` | `http-cache-semantics` | N/A (Đã strip) | 0 | **`PACKAGE_ABSENT`** | Runner stage Dockerfile thực thi `rm -rf /usr/local/lib/node_modules/npm`; gói hoàn toàn bị xóa khỏi final image. |
| 5 | `api` | `CVE-2026-2359` | `multer` / `busboy` | `multer@2.5.0`, `busboy@1.0.8` | 0 | **`FIXED_VERSION_CONFIRMED`** | Root `package.json` cấu hình overrides `multer: "2.5.0"`, `busboy: "1.0.8"`. |
| 6 | `api` | `CVE-2026-3304` | `multer` / `busboy` | `multer@2.5.0`, `busboy@1.0.8` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `multer@2.5.0` và `busboy@1.0.8`. |
| 7 | `api` | `CVE-2026-3520` | `multer` / `busboy` | `multer@2.5.0`, `busboy@1.0.8` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `multer@2.5.0` và `busboy@1.0.8`. |
| 8 | `api` | `CVE-2026-5079` | `multer` / `busboy` | `multer@2.5.0`, `busboy@1.0.8` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `multer@2.5.0` và `busboy@1.0.8`. |
| 9 | `api` | `CVE-2026-77078` | `multer` / `busboy` | `multer@2.5.0`, `busboy@1.0.8` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `multer@2.5.0` và `busboy@1.0.8`. |
| 10 | `api` | `CVE-2026-82333` | `multer` / `busboy` | `multer@2.5.0`, `busboy@1.0.8` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `multer@2.5.0` và `busboy@1.0.8`. |
| 11 | `api` | `CVE-2025-64756` | `multer` / `busboy` | `multer@2.5.0`, `busboy@1.0.8` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `multer@2.5.0` và `busboy@1.0.8`. |
| 12 | `api` | `CVE-2026-9496` | `multer` / `busboy` | `multer@2.5.0`, `busboy@1.0.8` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `multer@2.5.0` và `busboy@1.0.8`. |
| 13 | `api` | `CVE-2026-13149` | `multer` / `busboy` | `multer@2.5.0`, `busboy@1.0.8` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `multer@2.5.0` và `busboy@1.0.8`. |
| 14 | `api` | `CVE-2026-14257` | `multer` / `busboy` | `multer@2.5.0`, `busboy@1.0.8` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `multer@2.5.0` và `busboy@1.0.8`. |
| 15 | `api` | `CVE-2026-26996` | `tar` (node-tar) | `tar@6.2.1` | 0 | **`ADVISORY_NOT_REPORTED`** | `tar@6.2.1` tồn tại trong runner qua `@mapbox/node-pre-gyp@1.0.11`; Trivy v0.76.0 không báo cáo mã CVE này trên `tar@6.2.1`. |
| 16 | `api` | `CVE-2026-27903` | `tar` (node-tar) | `tar@6.2.1` | 0 | **`ADVISORY_NOT_REPORTED`** | `tar@6.2.1` tồn tại trong runner; Trivy v0.76.0 không báo cáo mã CVE này trên `tar@6.2.1`. |
| 17 | `api` | `CVE-2026-27904` | `tar` (node-tar) | `tar@6.2.1` | 0 | **`ADVISORY_NOT_REPORTED`** | `tar@6.2.1` tồn tại trong runner; Trivy v0.76.0 không báo cáo mã CVE này trên `tar@6.2.1`. |
| 18 | `api` | `CVE-2026-48815` | `tar` (node-tar) | `tar@6.2.1` | 0 | **`ADVISORY_NOT_REPORTED`** | `tar@6.2.1` tồn tại trong runner; Trivy v0.76.0 không báo cáo mã CVE này trên `tar@6.2.1`. |
| 19 | `api` | `CVE-2026-69152` | `tar` (node-tar) | `tar@6.2.1` | 0 | **`ADVISORY_NOT_REPORTED`** | `tar@6.2.1` tồn tại trong runner; Trivy v0.76.0 không báo cáo mã CVE này trên `tar@6.2.1`. |
| 20 | `api` | `CVE-2026-69192` | `tar` (node-tar) | `tar@6.2.1` | 0 | **`ADVISORY_NOT_REPORTED`** | `tar@6.2.1` tồn tại trong runner; Trivy v0.76.0 không báo cáo mã CVE này trên `tar@6.2.1`. |
| 21 | `api` | `CVE-2026-59870` | `js-yaml` | `js-yaml@4.1.0` | 0 | **`ADVISORY_NOT_REPORTED`** | `js-yaml@4.1.0` có trong runner (qua `@nestjs/swagger@7.4.2`); Trivy v0.76.0 báo cáo CVE-2026-59869 và CVE-2026-84375, không báo cáo CVE-2026-59870. |
| 22 | `ai-worker` | `CVE-2024-21538` | `cross-spawn` | N/A (Không cài đặt) | 0 | **`PACKAGE_ABSENT`** | Python runtime (`python:3.11-slim`) không chứa hệ sinh thái npm hay `cross-spawn`. |
| 23 | `ai-worker` | `CVE-2026-93990` | `libexpat` | `2.9.0-1~deb13u1` (`libexpat1`) | 0 | **`ADVISORY_NOT_REPORTED`** | `libexpat1` cài trên Debian 13; Trivy unsuppressed scan không ghi nhận CVE này cho Debian 13. |
| 24 | `ai-worker` | `CVE-2026-59197` | `Pillow` | `13.0.0` | 0 | **`FIXED_VERSION_CONFIRMED`** | `services/ai-worker/requirements-prod-cpu.txt` nâng `Pillow>=13.0.0`. |
| 25 | `ai-worker` | `CVE-2026-59199` | `Pillow` | `13.0.0` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `Pillow>=13.0.0`. |
| 26 | `ai-worker` | `CVE-2026-59200` | `Pillow` | `13.0.0` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `Pillow>=13.0.0`. |
| 27 | `ai-worker` | `CVE-2026-59204` | `Pillow` | `13.0.0` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `Pillow>=13.0.0`. |
| 28 | `ai-worker` | `CVE-2026-59205` | `Pillow` | `13.0.0` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `Pillow>=13.0.0`. |
| 29 | `ai-worker` | `CVE-2026-25990` | `Pillow` | `13.0.0` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `Pillow>=13.0.0`. |
| 30 | `ai-worker` | `CVE-2026-40192` | `Pillow` | `13.0.0` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `Pillow>=13.0.0`. |
| 31 | `ai-worker` | `CVE-2026-42311` | `Pillow` | `13.0.0` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `Pillow>=13.0.0`. |
| 32 | `ai-worker` | `CVE-2026-54058` | `Pillow` | `13.0.0` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `Pillow>=13.0.0`. |
| 33 | `ai-worker` | `CVE-2026-54059` | `Pillow` | `13.0.0` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `Pillow>=13.0.0`. |
| 34 | `ai-worker` | `CVE-2026-54060` | `Pillow` | `13.0.0` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `Pillow>=13.0.0`. |
| 35 | `ai-worker` | `CVE-2026-55379` | `Pillow` | `13.0.0` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `Pillow>=13.0.0`. |
| 36 | `ai-worker` | `CVE-2026-55380` | `Pillow` | `13.0.0` | 0 | **`FIXED_VERSION_CONFIRMED`** | Đã vá triệt để qua `Pillow>=13.0.0`. |
| 37 | `ai-worker` | `CVE-2026-77214` | `libexpat1` | `2.9.0-1~deb13u1` | 0 | **`FIXED_VERSION_CONFIRMED`** | Heap buffer over-read đã vá trong upstream package `libexpat1 2.9.0-1~deb13u1` của Debian 13. |
| 38 | `ai-worker` | `CVE-2026-8286` | `curl`, `libcurl4t64` | `8.11.0-1` | 0 | **`FIXED_VERSION_CONFIRMED`** | Proxy disclosure flaw đã vá trong upstream package `curl 8.11.0-1` của Debian 13. |
| 39 | `ai-worker` | `CVE-2026-8927` | `curl`, `libcurl4t64` | `8.11.0-1` | 0 | **`FIXED_VERSION_CONFIRMED`** | TLS session reuse flaw đã vá trong upstream package `curl 8.11.0-1` của Debian 13. |
| 40 | `ai-worker` | `CVE-2026-66046` | `util-linux`, `bsdutils`, `mount` | `2.41.5-0+deb13u1` | 0 | **`ADVISORY_NOT_REPORTED`** | `util-linux` có trong Debian slim; Trivy v0.76.0 unsuppressed scan không ghi nhận CVE này trên Debian 13. |
| 41 | `ai-worker` | `CVE-2026-76956` | `util-linux`, `bsdutils`, `mount` | `2.41.5-0+deb13u1` | 0 | **`ADVISORY_NOT_REPORTED`** | `util-linux` có trong Debian slim; Trivy v0.76.0 unsuppressed scan không ghi nhận CVE này trên Debian 13. |
| 42 | `ai-worker` | `CVE-2026-76957` | `util-linux`, `bsdutils`, `mount` | `2.41.5-0+deb13u1` | 0 | **`ADVISORY_NOT_REPORTED`** | `util-linux` có trong Debian slim; Trivy v0.76.0 unsuppressed scan không ghi nhận CVE này trên Debian 13. |

---

## 📈 III. TỔNG HỢP SỐ LIỆU & ĐIỀU KIỆN TIẾP TỤC DUY TRÌ

- **Tổng số mục đề xuất gỡ bỏ:** **42 scoped entries**
- **Số mục đủ điều kiện gỡ bỏ (Eligible):** **42 / 42 (100%)**
- **Số mục không đủ điều kiện (Ineligible):** **0**
- **Phân bổ theo nhóm phân loại:**
  - `PACKAGE_ABSENT`: **4 mục**
  - `FIXED_VERSION_CONFIRMED`: **27 mục**
  - `ADVISORY_NOT_REPORTED`: **11 mục**
  - `EVIDENCE_INSUFFICIENT`: **0 mục**
- **Phân bổ ngoại lệ còn hiệu lực sau Wave 0 (Hạn rà soát bắt buộc: 2026-12-01):**
  - `omninovel-ai-worker`: **36 entries**
  - `omninovel-api`: **16 entries**
  - `grafana/grafana`: **7 entries**
  - `omninovel-nginx`: **0 entries**
  - `prom/prometheus`: **1 entry**
  - **Tổng cộng còn lại:** **60 scoped entries** (tương đương **59 unique security advisory IDs** trong root `.trivyignore`).
- **Ngoại lệ TruffleHog Secret Scanning:** **115 approved allowlist entries** trong `deploy/security/trufflehog/trufflehog-allowlist.json`, hạn rà soát tương ứng `2026-12-01`.

---

## 🚀 IV. CHIẾN LƯỢC XỬ LÝ NỢ BẢO MẬT MỨC ĐỘ CAO (WAVE 1 ROADMAP)

Mục tiêu ưu tiên của Wave 1 là triệt tiêu các lỗ hổng CRITICAL còn lại trong runtime, đặc biệt là `tar@6.2.1` trên `omninovel-api`:

1. **Lỗ hổng trọng tâm:**
   - Mã CVE: **`CVE-2026-59873` (CRITICAL)** trong thư viện `tar@6.2.1`.
   - Nguồn gốc: Phụ thuộc bắt cầu từ `argon2@0.31.2` $\rightarrow$ `@mapbox/node-pre-gyp@1.0.11` $\rightarrow$ `tar@^6.1.11` (resolve thành `6.2.1`).
   - Nguy cơ: Ghi đè file tùy ý qua archive injection (Arbitrary File Overwrite).
   - Đánh giá hiện tại: Rất thấp do API không mở endpoint giải nén file tar, nhưng đây là lỗ hổng CRITICAL cần xóa bỏ hoàn toàn.
2. **Phương án kỹ thuật Wave 1:**
   - **Phương án A (Ưu tiên):** Khảo sát nâng cấp `argon2` lên bản mới không còn phụ thuộc `@mapbox/node-pre-gyp` hoặc cấu hình `npm overrides` cho `tar: ">=7.5.9"` (cần thẩm định tương thích vì `tar@7` chuyển sang pure ESM).
   - **Phương án B:** Nâng cấp `@nestjs/swagger` để loại bỏ `js-yaml@4.1.0` (`CVE-2026-59869`).
3. **Quy trình triển khai an toàn:**
   - Triển khai trên worktree/branch độc lập `feat/security-wave1-tar-remediation`.
   - Thực hiện kiểm thử khép kín:
     - Auth Smoke Test: Đảm bảo việc hash và verify mật khẩu người dùng bằng `argon2` không bị hồi quy.
     - Multipart File Upload Test: Kiểm tra bộ lọc MIME/Magic-Bytes.
     - Toàn bộ 50 unit test suites và 23 E2E test suites của API phải PASS.
     - CI Docker Scan Trivy xác nhận 0 findings trên `tar`.

# OmniNovel — Security P1 Kerberos Remediation Dossier & Supply-Chain Audit

> **Target Service:** `omninovel-ai-worker` (`services/ai-worker/Dockerfile`)  
> **Classification:** Security P1 / Trivy Fail-Closed Gate Failure  
> **Initial Trigger:** Hosted CI Run `#42798303782` (PR #217) failed at `Trivy Vulnerability Scan (AI Worker Image)`  
> **Findings Count:** 16 HIGH vulnerabilities across 4 Kerberos packages  
> **Remediation Strategy:** Priority 2 — Eliminate Unneeded Dependency (`curl` and downstream Kerberos tree)  
> **PR Classification:** Standalone Clean Extraction directly from `origin/main` (PR #219 stacked branch is BLOCKED from direct merge)  
> **Final Status:** KRB5 REMEDIATED (Package Absence Verified, Zero Krb5 Findings, Fail-Closed CI Gate Green)

---

## 1. Executive Summary & Incident Context

Trong Hosted CI run `#42798303782` của PR #217 (nhánh `feat/trivy-wave-0-prune-resolved` tại commit `ae05d10`), bước kiểm tra bảo mật `Trivy Vulnerability Scan (AI Worker Image)` đã bị chặn dừng với exit code 1 (`fail-closed`).

### 1.1. Chi tiết 16 HIGH Findings:
Trivy Scanner v0.76.0 (với DB cập nhật lúc 2026-11-10T14:04Z) phát hiện 16 lỗ hổng HIGH trên 4 packages thuộc Debian 13 (Trixie):
- `libgssapi-krb5-2` (`1.21.3-5+deb13u1`)
- `libk5crypto3` (`1.21.3-5+deb13u1`)
- `libkrb5-3` (`1.21.3-5+deb13u1`)
- `libkrb5support0` (`1.21.3-5+deb13u1`)

Phân bổ theo 4 CVEs:
1. `CVE-2026-112321` (Severity: HIGH)
2. `CVE-2026-112322` (Severity: HIGH)
3. `CVE-2026-112323` (Severity: HIGH)
4. `CVE-2026-119079` (Severity: HIGH)

Mỗi CVE được ghi nhận trên cả 4 binary packages thuộc hệ sinh thái MIT Kerberos $\rightarrow 4 \times 4 = 16$ unsuppressed findings.

### 1.2. Đính chính Commit SHA Cũ & Quản trị Nhánh Stacked PR #219
- **Đính chính Commit SHA cũ:** Commit remediation ban đầu trên nhánh stacked `fix/ai-worker-krb5-remediation` có full SHA thực tế là `c5df27212076c84ef6fbed77ffe57c96f6a46a46` (đã đính chính, không dùng chuỗi hash ghi nhận nhầm trước đó).
- **Trạng thái PR #219 (Stacked):** PR #219 chứa cả các commit thuộc Security P0 (PR #211) và Trivy Wave 0 (PR #217). **PR #219 BỊ ĐÁNH DẤU KHÔNG ĐƯỢC MERGE TRỰC TIẾP VÀO MAIN** khi Security P0 và Wave 0 chưa hoàn tất landing.
- **Giải pháp:** Trích xuất một PR Standalone sạch hoàn toàn, chỉ phân nhánh từ `origin/main`, chỉ chứa 2 files (`services/ai-worker/Dockerfile` và hồ sơ evidence này).

---

## 2. Task A — Phân tích Nguyên nhân Gốc (Root Cause Analysis)

### 2.1. Nguồn gốc của Package Kerberos
Tiến hành kiểm tra phân tầng Docker image:
1. **Base Image `python:3.11-slim`:**
   - Chạy lệnh kiểm tra: `docker run --rm python:3.11-slim dpkg -l | grep -E "krb|curl"`
   - Kết quả: **TRỐNG (0 kết quả)**. Base image Debian 13 không hề chứa curl hay Kerberos.
2. **Runtime Graphics Dependencies (`libgl1`, `libglib2.0-0`):**
   - Chạy lệnh kiểm tra: Cài đặt độc lập `libgl1` và `libglib2.0-0` trên `python:3.11-slim`.
   - Kết quả: **`CLEAN_NO_KRB_NO_CURL`**. Các thư viện đồ họa này phụ thuộc vào Mesa, X11, Wayland, libexpat, nhưng không phụ thuộc vào Kerberos hay curl.
3. **Trigger thực tế trong Dockerfile:**
   - Dòng 14–18 `services/ai-worker/Dockerfile`:
     ```dockerfile
     RUN apt-get update && apt-get upgrade -y --no-install-recommends && apt-get install -y --no-install-recommends \
         curl \
         libgl1 \
         libglib2.0-0 \
         && rm -rf /var/lib/apt/lists/*
     ```
   - Lệnh `apt-cache depends` bóc tách cây phụ thuộc thực tế trên Debian 13:
     ```
     curl
       └── Depends: libcurl4t64
             └── Depends: libgssapi-krb5-2
                   ├── Depends: libkrb5-3
                   ├── Depends: libk5crypto3
                   └── Depends: libkrb5support0
     ```

### 2.2. Khảo sát Tình trạng Upstream Debian & Bản vá (Priority 1 Check)
- Candidate hiện tại trong Debian 13 Trixie: `krb5` version `1.21.3-5+deb13u1`.
- Debian Security Tracker & Upstream MITRE:
  - `CVE-2026-112321`, `CVE-2026-112322`, `CVE-2026-112323`: Lỗ hổng quản lý bộ nhớ / giải mã gói tin trong Kerberos Key Distribution Center (KDC) và dịch vụ quản trị `kadmind`.
  - `CVE-2026-119079`: Lỗ hổng đàm phán ngữ cảnh SPNEGO trong thư viện GSS-API.
  - Trạng thái Debian 13: `unfixed` / `vulnerable`. Upstream Debian chưa phát hành package vá cho Trixie.
- **Kết luận:** Phương án Ưu tiên 1 (Nâng cấp package/base image lên bản vá) là **KHÔNG THỂ THỰC HIỆN ĐƯỢC** tại thời điểm này.

### 2.3. Đánh giá Khả năng Khai thác (Exploitability Analysis)
- Dịch vụ AI Worker (`omninovel-ai-worker`) hoạt động hoàn toàn như một worker xử lý OCR & dịch thuật, không chạy dịch vụ máy chủ Kerberos (`kdc`, `kadmind`), không mở port 88 hay 749.
- Ứng dụng Python (`FastAPI`, `PaddleOCR`, `transformers`, `torch`) sử dụng thư viện `httpx` và `aiohttp` để giao tiếp nội bộ và kết nối tới Cloudflare R2 qua HTTPS (OpenSSL native TLS), hoàn toàn không gọi `curl` hay `libcurl`.
- Tuy nhiên, tuân thủ nguyên tắc an toàn thông tin: *"Không coi package không được gọi trực tiếp là bằng chứng chắc chắn không thể khai thác"*. Sự hiện diện của các binary Kerberos không cần thiết trong container vi phạm nguyên tắc tối thiểu hóa bề mặt tấn công (Least Attack Surface).

---

## 3. Task B — Triển khai Phương án Khắc phục (Remediation)

### Quyết định Kỹ thuật (Priority 2):
Thay vì tìm cách xin ngoại lệ bảo mật (Priority 3 - Exception Dossier), chúng tôi thực hiện triệt để **Phương án Ưu tiên 2: Loại bỏ hoàn toàn dependency không cần thiết (`curl`)**:
1. **Gỡ bỏ `curl` khỏi Dockerfile:**
   - Xóa `curl \` khỏi danh sách `apt-get install` trong `services/ai-worker/Dockerfile`.
   - Kết quả: `curl`, `libcurl4t64`, và toàn bộ 4 package `krb5` (`libgssapi-krb5-2`, `libk5crypto3`, `libkrb5-3`, `libkrb5support0`) bị gỡ bỏ hoàn toàn (`PACKAGE_ABSENT`).
2. **Chuyển đổi Container HEALTHCHECK sang Python Native:**
   - Thay thế:
     ```dockerfile
     HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
       CMD curl -f http://127.0.0.1:8001/internal/v1/jobs/health || exit 1
     ```
   - Bằng:
     ```dockerfile
     HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
       CMD python3 -c "import urllib.request, sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8001/internal/v1/jobs/health', timeout=5).getcode() == 200 else 1)"
     ```
   - Thư viện `urllib.request` nằm sẵn trong Python 3 Standard Library, không yêu cầu thêm bất kỳ package bên ngoài hay thư viện OS nào.

---

## 4. Task C — Bằng chứng Thực nghiệm & Xác minh Toàn diện (Verification Matrix)

| STT | Bước kiểm thử / Xác minh | Lệnh thực hiện | Kết quả thực tế | Trạng thái |
|:---:|:---|:---|:---|:---:|
| 1 | **Docker Build Cleanliness** | `docker build -t omninovel-ai-worker:remediation-test -f services/ai-worker/Dockerfile .` | Build thành công 9/9 layers, không lỗi. | **PASS** |
| 2 | **Audit Package Thực tế (DPKG)** | `docker run --rm omninovel-ai-worker:remediation-test dpkg -l \| grep -E "krb\|curl"` | **0 kết quả** (Không tồn tại bất kỳ krb hay curl package nào). | **PASS** |
| 3 | **Runtime Healthcheck Test** | `docker run -d --name test-ai-worker-health -p 8001:8001 -e AI_WORKER_SECRET=... omninovel-ai-worker:remediation-test`<br>`docker inspect --format="{{.State.Health.Status}}"` | Status: **`healthy`**.<br>Log uvicorn: `200 OK` cho GET `/internal/v1/jobs/health`. | **PASS** |
| 4 | **Unsuppressed Fresh Trivy Scan** | `aquasec/trivy:0.76.0 image --scanners vuln --ignorefile="" --severity CRITICAL,HIGH omninovel-ai-worker:remediation-test` | **0 findings** cho mọi package `krb` và `curl`. Tất cả 16 HIGH findings bị triệt tiêu hoàn toàn. | **PASS** |
| 5 | **Suppressed Trivy Fail-Closed Gate** | `aquasec/trivy:0.76.0 image --scanners vuln --severity CRITICAL,HIGH --ignorefile deploy/security/trivy/ai-worker.trivyignore --exit-code 1 omninovel-ai-worker:remediation-test` | **Exit code 0**. Không có unhandled CRITICAL/HIGH findings. | **PASS** |
| 6 | **Governance Test Suite (12 Tests)** | `python deploy/security/validate-trivy-exceptions.py --test` | **12/12 negative tests PASS**. Hạn dùng 2026-12-01 hợp lệ, zero stale suppressions. | **PASS** |
| 7 | **Secret Scanner Integrity** | Kiểm tra file cấu hình TruffleHog | File cấu hình bí mật hoàn toàn nguyên vẹn, không suy yếu. | **PASS** |

---

## 5. Đánh giá Rủi ro Dư thừa (Residual Risk) & Phân định Ranh giới An ninh

Cần phân định rành mạch giữa **Sự vắng mặt của package (Package Absence)**, **Khắc phục lỗ hổng (Vulnerability Mitigation)** và **An ninh toàn diện của ứng dụng (Full Application Security)**:

1. **Package Absence vs. Vulnerability Mitigation:**
   - Các gói `libgssapi-krb5-2`, `libk5crypto3`, `libkrb5-3`, `libkrb5support0` và `curl`/`libcurl4t64` được chứng minh là **vắng mặt hoàn toàn** (`PACKAGE_ABSENT`) khỏi hệ thống tệp của container.
   - 16 phát hiện HIGH thuộc 4 CVEs Kerberos được giải quyết bằng việc triệt tiêu package mang lỗ hổng, do đó các vector tấn công cục bộ hoặc lợi dụng binary Kerberos là không còn điểm neo trên container AI Worker.
2. **Không tuyên bố 0% Rủi ro Toàn diện (Residual Risk Contextualization):**
   - **Tuyệt đối không tuyên bố "0% rủi ro cho toàn bộ ứng dụng"**. AI Worker vẫn tồn tại bề mặt rủi ro dư thừa từ:
     - Các thư viện Python Machine Learning (`torch`, `transformers`, `opencv-python-headless`) với các CVEs đã được ghi nhận trong Risk Register có thời hạn rà soát.
     - Các gói hệ điều hành nền tảng Debian 13 (`glibc`, `libexpat1`, `libssl3t64`, `util-linux`).
     - Tương tác RPC nội bộ và giao tiếp mạng HTTPS ra ngoài tới Cloudflare R2.
   - Việc gỡ bỏ `curl` và `krb5` đã loại bỏ thành công bề mặt tấn công không cần thiết, đưa hệ thống về đúng nguyên tắc Tối thiểu hóa Đặc quyền và Tối thiểu hóa Bề mặt Tấn công (Least Attack Surface).
3. **Ảnh hưởng ứng dụng:** **0% gián đoạn chức năng**. FastAPI, PaddleOCR, Transformers và các luồng giao tiếp R2/Internal RPC đều hoạt động dựa trên Python native network stack (`httpx`, `aiohttp`, OpenSSL), không có bất kỳ phụ thuộc nào vào `curl`.

---

## 6. Kết luận & Phán quyết Cổng Kiểm soát (Gate Verdict)

- **Biện pháp khắc phục:** Loại bỏ hoàn toàn `curl` và Kerberos runtime dependency tree; chuyển container healthcheck sang Python native `urllib.request`.
- **Phán quyết An ninh:** **KRB5 STANDALONE HOSTED GATE READY**
  - Nhánh standalone sạch hoàn toàn khỏi các commit của Security P0 (PR #211) và Trivy Wave 0 (PR #217).
  - Sẵn sàng đẩy lên thành Draft PR độc lập vào `main` để kiểm chứng Hosted CI.

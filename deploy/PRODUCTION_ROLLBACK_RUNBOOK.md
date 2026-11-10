# OmniNovel — Production Deployment & Rollback Runbook (P1.1 Remediation)

> **Document Version:** 2.1 (P1.1 Remediation & Ground-Truth Verification)  
> **Target Baseline SHA:** `a695a1eb2d12038c0e27fc2d9611dc3b3dc66c01`  
> **Status:** DRAFT / PENDING REVIEW (Ground-Truth Audited)  
> **Applies to:** Production VPS Single-Node Docker Compose Deployment (`deploy/docker-compose.yml`)

---

## 1. Kiểm toán Thực tế Kiến trúc & Khoảng trống Lưu giữ Image (Gap Analysis)

### 1.1. Thực trạng Khai báo trong `deploy/docker-compose.yml`
Quá trình kiểm tra thực tế file cấu hình triển khai `deploy/docker-compose.yml` ghi nhận:
- Ba dịch vụ ứng dụng nội bộ (`nginx`, `api`, `ai-worker`) chỉ khai báo chỉ thị `build:`, **hoàn toàn KHÔNG khai báo chỉ thị `image:` với tag cố định hoặc SHA256 digest**:
  - `nginx`: Build từ `./nginx/Dockerfile`
  - `api`: Build từ `services/api/Dockerfile`
  - `ai-worker`: Build từ `services/ai-worker/Dockerfile`
  - Chỉ có `redis` là sử dụng image cố định từ upstream (`redis:7-alpine`).
- Trong pipeline CI/CD hiện tại (`.github/workflows/ci-cd.yml`, job `deploy-vps`), các lệnh triển khai thực thi qua SSH là:
  ```bash
  cd /opt/omninovel || cd ~/omninovel
  git pull origin main
  docker compose -f deploy/docker-compose.yml build
  docker compose -f deploy/docker-compose.yml up -d --remove-orphans
  ```

### 1.2. Khoảng trống Kỹ thuật & Tuyên bố Trạng thái (Mandatory Notice)
> [!CRITICAL]
> **EMERGENCY ROLLBACK BẰNG IMMUTABLE IMAGE: NOT YET SUPPORTED TRONG CI/CD TOPOLOGY HIỆN TẠI**
>
> 1. Do hiện tại hệ thống **chưa tích hợp Container Registry từ xa (như GHCR hay Docker Hub)** và không có cơ chế gán nhãn immutable image tag theo commit SHA trên VPS, các image được build cục bộ tại chỗ và tự động gán tag mặc định `latest`.
> 2. Nếu Maintainer thực hiện `git checkout <old-sha>` rồi chạy `docker compose up -d --no-deps api` mà không có image cũ được lưu giữ, Docker daemon sẽ tiếp tục chạy container từ image `latest` hiện có (vốn là build của release lỗi vừa triển khai).
> 3. Do đó, **phương án Rollback DUY NHẤT hiện tại được hỗ trợ đầy đủ và an toàn là: GitOps Forward Revert** (PR revert được merge vào `main`, sau đó CI/CD tự động kéo mã nguồn sạch về và rebuild).

---

## 2. Thiết kế Mô hình Mục tiêu: Release Manifest & Fail-Closed Image Verification

Để hỗ trợ rollback bằng Immutable Image trong tương lai mà không cần chờ build lại mã nguồn, hạ tầng cần áp dụng kiến trúc **Release Manifest** như sau:

### 2.1. Cấu trúc `deploy/release-manifest.json`
Mỗi khi một bản release được xuất xưởng từ CI, một manifest ghi lại image digest bất biến tương ứng sẽ được phát hành:
```json
{
  "release_sha": "a695a1eb2d12038c0e27fc2d9611dc3b3dc66c01",
  "built_at": "2026-11-10T14:48:03Z",
  "services": {
    "api": {
      "image": "ghcr.io/hiepngoc2006/omninovel-api",
      "tag": "a695a1e",
      "digest": "sha256:4f8a9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a"
    },
    "ai-worker": {
      "image": "ghcr.io/hiepngoc2006/omninovel-ai-worker",
      "tag": "a695a1e",
      "digest": "sha256:9a3e2f5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f"
    },
    "nginx": {
      "image": "ghcr.io/hiepngoc2006/omninovel-nginx",
      "tag": "a695a1e",
      "digest": "sha256:1b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c"
    }
  }
}
```

### 2.2. Kiểm tra Image Identity Fail-Closed
Khi kích hoạt rollback khẩn cấp bằng image, script kiểm soát bắt buộc phải đối soát SHA256 digest thực tế của container:
```bash
RUNNING_IMAGE_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' omninovel-prod-api 2>/dev/null || docker inspect --format='{{.Image}}' omninovel-prod-api)
EXPECTED_DIGEST=$(jq -r '.services.api.digest' deploy/release-manifest.json)

if [ -z "$RUNNING_IMAGE_DIGEST" ] || [ "$RUNNING_IMAGE_DIGEST" != *"$EXPECTED_DIGEST"* ]; then
  echo "[CRITICAL FAIL-CLOSED] Image digest mismatch! Container is NOT running verified release image."
  echo "Expected: ${EXPECTED_DIGEST}"
  echo "Actual:   ${RUNNING_IMAGE_DIGEST}"
  exit 1
fi
echo "[VERIFIED] Container is running immutable release image matching release-manifest.json"
```

---

## 3. Kiến trúc Hạ tầng Triển khai 4 Tầng

```
[ External Layer ]
  - Managed PostgreSQL (DATABASE_URL) -> Có WAL archiving & Point-In-Time-Recovery (PITR)
  - Cloudflare R2 Object Storage     -> Có Object Versioning & Lifecycle Rules

[ Host VPS Layer: deploy/docker-compose.yml ]
  - Ingress:   nginx (omninovel-prod-nginx)       [:80, :443 TLS Ingress]
  - Core API:  api (omninovel-prod-api)           [:8000 internal network only, NO host port]
  - AI Engine: ai-worker (omninovel-prod-ai-worker) [:8001 internal network only, NO host port]
  - Cache/Job: redis (omninovel-prod-redis)       [:6379 internal protected mode]

[ Persistent Named Volumes Layer (Host Disk) ]
  - omninovel_redis_prod_data      -> Dữ liệu AOF/RDB BullMQ jobs & cache
  - omninovel_ai_model_cache       -> Trọng số mô hình PaddleOCR
  - omninovel_certbot_acme_data    -> ACME challenge data
  - omninovel_nginx_ssl_certs      -> Active TLS Certificates
  - omninovel_nginx_runtime_config -> Runtime dynamic Nginx reverse-proxy configuration
```

---

## 4. Quy trình Rollback Chuẩn (GitOps Forward Revert)

> [!IMPORTANT]
> **Quy tắc Vàng GitOps:**
> - Mọi thao tác rollback phải được thực hiện thông qua **Pull Request (GitOps Forward Revert)** được merge vào `main`.
> - **CẤM tuyệt đối push trực tiếp lên nhánh `main`** (`git push origin main` bị chặn bởi branch protection).
> - **CẤM sử dụng `git checkout -B main`** hoặc duy trì detached HEAD trên VPS làm giải pháp lâu dài.

### 4.1. Phân biệt Cú pháp Revert: Merge Commit vs. Squash Commit

Git đòi hỏi cú pháp revert khác nhau tùy thuộc vào số lượng parent commit:

1. **Đối với Merge Commit (Commit có 2 cha - thường thấy khi merge branch via PR):**
   - Bắt buộc phải có cờ `-m 1` (chỉ định giữ lại trạng thái nhánh chính `main` trước merge).
   - Cú pháp: `git revert -m 1 <MERGE_COMMIT_SHA>`
   - *Lưu ý:* Nếu không truyền `-m 1`, Git sẽ báo lỗi: `error: commit <sha> is a merge but no -m option was given.`

2. **Đối với Squash & Merge hoặc Single Commit (Commit có 1 cha):**
   - Tuyệt đối **không dùng** cờ `-m 1`.
   - Cú pháp: `git revert <COMMIT_SHA>`
   - *Lưu ý:* Nếu truyền `-m 1`, Git sẽ báo lỗi: `error: option -m is only for merge commits, and <sha> was not a merge commit.`

### 4.2. Kịch bản Tự động Xác định và Thực thi GitOps Revert

```bash
# 1. Fetch main mới nhất
git fetch origin main
HOTFIX_BRANCH="revert/hotfix-rollback-$(date +%s)"
git checkout -b "$HOTFIX_BRANCH" origin/main

TARGET_COMMIT="<BAD_COMMIT_SHA>"

# 2. Tự động kiểm tra số lượng parent commit bằng git rev-parse:
# Nếu lệnh rev-parse <commit>^2 thành công -> Merge Commit (dùng -m 1)
# Nếu thất bại -> Single / Squash Commit (không dùng -m)
if git rev-parse -q --verify "${TARGET_COMMIT}^2" >/dev/null 2>&1; then
  echo "[INFO] Phát hiện MERGE COMMIT (2 parents). Áp dụng: git revert -m 1 ${TARGET_COMMIT}"
  git revert -m 1 "${TARGET_COMMIT}" --no-edit
else
  echo "[INFO] Phát hiện SQUASH / SINGLE COMMIT (1 parent). Áp dụng: git revert ${TARGET_COMMIT}"
  git revert "${TARGET_COMMIT}" --no-edit
fi

# 3. Push nhánh hotfix lên origin (tuyệt đối không push lên main)
git push origin "$HOTFIX_BRANCH"

# 4. Tạo Pull Request để duyệt và kích hoạt CI/CD
gh pr create \
  --title "revert: rollback release ${TARGET_COMMIT}" \
  --body "Automated forward revert to restore production stability. Closes incident." \
  --base main \
  --head "$HOTFIX_BRANCH"

# 5. Sau khi PR được Review & Merge, GitHub Actions sẽ tự động kích hoạt deploy bản sạch.
```

---

## 5. Can thiệp Khẩn cấp trên VPS & Khôi phục Nhánh `main` (Reconciliation)

Trong trường hợp hệ thống gặp sự cố tê liệt khẩn cấp mà không thể chờ PR merge:

### 5.1. Quy trình Can thiệp Khẩn cấp Cục bộ
```bash
cd /opt/omninovel || cd ~/omninovel

# Bước 1: Tạo nhánh tạm để cách ly, KHÔNG làm việc trên detached HEAD
git checkout -b emergency-rollback a695a1eb2d12038c0e27fc2d9611dc3b3dc66c01

# Bước 2: Tái xây dựng có kiểm soát từ commit đã kiểm chứng (KHÔNG xóa volume dữ liệu)
docker compose -f deploy/docker-compose.yml build api ai-worker nginx
docker compose -f deploy/docker-compose.yml up -d --no-deps api ai-worker nginx

# Bước 3: Xác minh container đang hoạt động
docker compose -f deploy/docker-compose.yml ps
```

### 5.2. BẮT BUỘC: Khôi phục Trạng thái Tracking Branch `main` (Reconciliation)
Ngay sau khi PR GitOps Forward Revert đã được merge vào `origin/main` trên GitHub, Maintainer **BẮT BUỘC** phải đưa VPS trở về đồng bộ hoàn toàn với `origin/main`:
```bash
# Trở về tracking branch main và reset theo origin/main sạch
git checkout main
git fetch origin main
git reset --hard origin/main
git branch -D emergency-rollback
echo "[RECONCILE] VPS tracking branch restored to origin/main successfully."
```

---

## 6. Xác minh Sức khỏe Dịch vụ (Healthcheck & Ingress Verification)

> [!WARNING]
> **Đính chính Cổng Mạng:** Dịch vụ `api` trong `deploy/docker-compose.yml` **KHÔNG mở cổng 8000 ra host**. Mọi lệnh `curl http://localhost:8000/...` trên host đều thất bại do cơ chế bảo vệ an ninh chống rò rỉ cổng mạng nội bộ (test case `TOP-02`).

### 6.1. HTTP Readiness Probe qua Ingress Nginx trên Host (Cổng 443 HTTPS)
Nginx expose cổng 443 và reverse-proxy đường dẫn `/health/ready` tới upstream nội bộ `api:8000`.  
Cờ `-k` được sử dụng để kiểm tra tính sẵn sàng của ứng dụng ngay cả khi truy cập qua loopback IP:
```bash
HTTP_STATUS=$(curl -k -s -o /dev/null -w "%{http_code}" https://127.0.0.1/health/ready)
if [ "$HTTP_STATUS" = "200" ]; then
  echo "[PASS] Ingress HTTP Readiness Probe SUCCESS (HTTP 200)"
else
  echo "[FAIL] Ingress HTTP Readiness Probe FAILED (HTTP ${HTTP_STATUS})"
  exit 1
fi
```

### 6.2. Xác minh Độc lập Chứng chỉ TLS / SSL (Certificate Validity & SAN)
> [!NOTE]
> Việc `curl -k` trả về HTTP 200 chỉ chứng minh ứng dụng đang phản hồi; nó **KHÔNG** chứng minh chứng chỉ TLS còn hạn hoặc hợp lệ. Bắt buộc phải kiểm tra chứng chỉ x509 độc lập:
```bash
echo | openssl s_client -connect 127.0.0.1:443 -servername "${DOMAIN:-localhost}" 2>/dev/null \
  | openssl x509 -noout -dates -subject -issuer

# Kiểm tra ngày hết hạn còn tối thiểu 7 ngày:
openssl s_client -connect 127.0.0.1:443 -servername "${DOMAIN:-localhost}" </dev/null 2>/dev/null \
  | openssl x509 -checkend 604800 -noout
if [ $? -eq 0 ]; then
  echo "[PASS] TLS Certificate is valid for at least 7 more days."
else
  echo "[WARN] TLS Certificate expires in less than 7 days or is invalid!"
fi
```

### 6.3. Healthcheck Trực tiếp trong Mạng Nội bộ Container
Kiểm tra vòng lặp nội bộ của process NestJS để loại trừ lỗi cấu hình Nginx:
```bash
docker exec omninovel-prod-api node -e "
  require('http').get('http://127.0.0.1:8000/health/ready', (res) => {
    console.log('API Internal Status:', res.statusCode);
    process.exit(res.statusCode === 200 ? 0 : 1);
  });
"
```

### 6.4. Healthcheck Redis Native
```bash
REDIS_STATUS=$(docker inspect --format='{{json .State.Health.Status}}' omninovel-prod-redis)
echo "Redis Health Status: ${REDIS_STATUS}" # Kỳ vọng: "healthy"
```

---

## 7. An ninh SSH & Cấu hình GitHub Environment Approval Gate

### 7.1. Rà soát Lỗ hổng `StrictHostKeyChecking=no` & Ghim Host Key (Known Hosts Pinning)
Sử dụng `StrictHostKeyChecking=no` trong CI/CD tiềm ẩn rủi ro Man-In-The-Middle (MITM).  
**Quy trình chuẩn ghim Host Key:**
1. Lấy và kiểm tra fingerprint public key của VPS một cách độc lập:
   ```bash
   ssh-keyscan -H <VPS_IP> > vps_known_hosts
   ssh-keygen -lf vps_known_hosts
   ```
2. Lưu toàn bộ nội dung của `vps_known_hosts` vào GitHub Secret: `VPS_SSH_KNOWN_HOSTS`.
3. Trong workflow CI/CD:
   ```bash
   mkdir -p ~/.ssh
   echo "$VPS_SSH_KNOWN_HOSTS" > ~/.ssh/known_hosts
   chmod 644 ~/.ssh/known_hosts
   echo "$VPS_KEY" > ~/.ssh/id_rsa
   chmod 600 ~/.ssh/id_rsa
   ssh -o StrictHostKeyChecking=yes -o BatchMode=yes "${VPS_USER:-root}@$VPS_HOST" "..."
   ```

### 7.2. Khóa Cổng Triển khai bằng GitHub Environment Approval Gate
Trước khi đưa VPS SSH secrets vào sử dụng thực tế:
1. Tạo GitHub Environment tên `production` tại: **Repository Settings -> Environments**.
2. Kích hoạt **Required reviewers** và gán Maintainer phê duyệt trước mỗi lần deploy.
3. Khai báo `environment: production` tại job `deploy-vps` trong `.github/workflows/ci-cd.yml`.

---

## 8. Schema Compatibility Matrix & Đánh giá Rủi ro Dữ liệu

| Loại Migration | Tính Tương thích | Hành động Khi Rollback | Đánh giá An toàn Dữ liệu (Data Safety) |
| :--- | :---: | :--- | :--- |
| **Additive / Expand**<br>(Thêm bảng mới, thêm cột nullable) | Tương thích ngược | **KHÔNG REVERT DATABASE**. Chỉ rollback phiên bản code ứng dụng. | **An toàn cao (Không làm mất dữ liệu người dùng).** |
| **Breaking Non-Destructive**<br>(Thêm ràng buộc CHECK/UNIQUE, tạo index mới) | Không tương thích code cũ | Đánh giá dữ liệu mới phát sinh. Chỉ revert migration nếu không vi phạm toàn vẹn ràng buộc. | **Rủi ro trung bình (Cần kiểm tra trước khi rollback DB).** |
| **Destructive Breaking**<br>(Xóa cột, đổi kiểu dữ liệu, truncate dữ liệu) | Mất tương thích hoàn toàn | **CẤM TỰ Ý CHẠY `migration:revert`**. Chạy `down()` sẽ xóa vĩnh viễn dữ liệu người dùng mới sinh.<br>Phải áp dụng quy trình **Point-In-Time-Recovery (PITR)**. | **Rủi ro cực kỳ cao (Nguy cơ thất thoát dữ liệu nghiêm trọng).** |

### Preflight Kiểm tra PITR Database Trước Khi Thực hiện Rollback:
```bash
# 1. Xác minh sao lưu tự động và WAL archiving trên Cloud Managed PostgreSQL đang hoạt động.
# 2. Tạo một Manual Snapshot / Backup trước khi thực hiện bất kỳ thay đổi nào.
# 3. Ghi nhận mốc thời gian (LSCN / Timestamp) ngay trước thời điểm release gặp sự cố.
```

---

## 9. Đánh giá Thực tế về Thời gian Gián đoạn Dịch vụ (Downtime Analysis)

Thời gian gián đoạn dịch vụ khi thực hiện recreate container bằng Docker Compose **không phải là con số cố định** mà phụ thuộc vào các yếu tố runtime thực tế:
1. **Graceful Shutdown Duration:** Docker gửi `SIGTERM` và chờ ứng dụng giải phóng tài nguyên (`stop_grace_period`, mặc định 10s đối với NestJS và Python worker).
2. **Container Cold Start Latency:**
   - NestJS API: Thời gian khởi động Node.js process, nạp metadata reflection, và thiết lập TypeORM database connection pool (~2 - 6 giây).
   - AI Worker: Thời gian khởi động Python interpreter và import PaddleOCR/PyTorch runtime (~5 - 15 giây).
3. **Redis Reconnection & Handshake:** Thời gian BullMQ worker kết nối lại hàng đợi Redis (~1 - 2 giây).
4. **Ingress Rerouting:** Nginx tự động phát hiện upstream sẵn sàng sau khi pass healthcheck.

---

## 10. Phân biệt Rạch ròi 4 Cấp độ Kiểm chứng Hệ thống

| Tiêu chí | 1. CI Topology Validation | 2. Container Runtime Health | 3. Live Production Deployment | 4. Recovery / Rollback Acceptance |
| :--- | :--- | :--- | :--- | :--- |
| **Môi trường** | GitHub Actions Runner (`ubuntu-latest`) | Mạng nội bộ Docker Host | VPS Production Thực tế | Hệ thống Production sau khắc phục sự cố |
| **Mục tiêu** | Kiểm tra tĩnh manifest Compose, chặn rò rỉ port nội bộ (`TOP-01..17`). | Đảm bảo app bootstrap thành công, kết nối DB/Redis thông suốt. | Cập nhật phiên bản, phục vụ traffic độc giả thật qua Ingress TLS. | Phục hồi phiên bản ổn định, bảo toàn dữ liệu persistent volumes. |
| **Thời gian gián đoạn**| 0 giây | Phụ thuộc cold start & connection pool | Gián đoạn ngắn theo chu kỳ recreate container | Tùy phương án (In-place: phụ thuộc cold start; PITR: theo snapshot restore) |

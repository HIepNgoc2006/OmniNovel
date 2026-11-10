# OmniNovel — Production Deployment & Rollback Runbook (P1 Final Closure)

> **Document Version:** 2.0 (Post-P1 Remediation)  
> **Target Baseline SHA:** `a695a1eb2d12038c0e27fc2d9611dc3b3dc66c01`  
> **Status:** APPROVED & LOCKED  
> **Applies to:** Production VPS Single-Node Docker Compose Deployment (`deploy/docker-compose.yml`)

---

## 1. Kiến trúc Hạ tầng Triển khai 4 Tầng

Hệ thống OmniNovel Production vận hành theo mô hình 4 tầng độc lập:

```
[ External Layer ]
  - Managed PostgreSQL (DATABASE_URL) -> Có WAL-G / PITR độc lập
  - Cloudflare R2 Object Storage     -> Có versioning / retention độc lập

[ Host VPS Layer: deploy/docker-compose.yml ]
  - Ingress:   nginx (omninovel-prod-nginx)       [:80, :443 TLS]
  - Core API:  api (omninovel-prod-api)           [:8000 internal only, NO host port]
  - AI Engine: ai-worker (omninovel-prod-ai-worker) [:8001 internal only, NO host port]
  - Cache/Job: redis (omninovel-prod-redis)       [:6379 internal protected]

[ Persistent Named Volumes Layer (Host Disk) ]
  - omninovel_redis_prod_data   -> Dữ liệu AOF/RDB BullMQ & Session
  - omninovel_ai_model_cache    -> Cache trọng số PaddleOCR
  - omninovel_certbot_acme_data -> ACME Challenge Let's Encrypt
  - omninovel_nginx_ssl_certs   -> Active TLS Certificates
  - omninovel_nginx_runtime_config -> Runtime dynamic Nginx configuration
```

---

## 2. Quy trình Rollback Chuẩn (GitOps Forward Revert)

> [!IMPORTANT]
> **Quy tắc Vàng GitOps:** Mọi rollback trên môi trường production phải là một thao tác **FORWARD REVERT** được merge vào `main` thông qua Pull Request, tuyệt đối **không push trực tiếp lên main** và **không sử dụng `git checkout -B` hoặc detached HEAD làm giải pháp rollback mặc định**.

### 2.1. Phân biệt Cú pháp Revert: Merge Commit vs. Squash Commit

Git đòi hỏi cú pháp revert khác nhau tùy thuộc vào số lượng parent commit:

1. **Đối với Merge Commit (Commit có 2 cha):**
   - Bắt buộc phải có cờ `-m 1` (chỉ định revert theo nhánh chính `main`).
   - Cú pháp: `git revert -m 1 <MERGE_COMMIT_SHA>`
   - *Lưu ý:* Nếu không truyền `-m 1`, Git sẽ báo lỗi: `error: commit <sha> is a merge but no -m option was given.`

2. **Đối với Squash & Merge hoặc Single Commit (Commit có 1 cha):**
   - Tuyệt đối **không dùng** cờ `-m 1`.
   - Cú pháp: `git revert <COMMIT_SHA>`
   - *Lưu ý:* Nếu truyền `-m 1`, Git sẽ báo lỗi: `error: option -m is only for merge commits, and <sha> was not a merge commit.`

### 2.2. Lệnh Xác định Tự động và Thực thi Revert

```bash
# 1. Fetch main mới nhất
git fetch origin main
git checkout -b revert/hotfix-rollback-$(date +%s) origin/main

TARGET_COMMIT="<BAD_COMMIT_SHA>"

# 2. Tự động kiểm tra số lượng parent commit:
# Nếu lệnh rev-parse <commit>^2 thành công -> Merge Commit (dùng -m 1)
# Nếu thất bại -> Single / Squash Commit (không dùng -m)
if git rev-parse -q --verify "${TARGET_COMMIT}^2" >/dev/null 2>&1; then
  echo "[INFO] Phát hiện MERGE COMMIT (2 parents). Áp dụng git revert -m 1..."
  git revert -m 1 "${TARGET_COMMIT}" --no-edit
else
  echo "[INFO] Phát hiện SQUASH / SINGLE COMMIT (1 parent). Áp dụng git revert..."
  git revert "${TARGET_COMMIT}" --no-edit
fi

# 3. Push nhánh hotfix lên origin và tạo Pull Request (KHÔNG push trực tiếp main)
git push origin HEAD
gh pr create --title "revert: rollback release ${TARGET_COMMIT}" --body "Automated forward revert to restore production stability."
# 4. Sau khi PR được review và merge vào main, pipeline CI/CD sẽ tự động triển khai bản revert lên VPS.
```

---

## 3. Emergency Rollback trên VPS (Khi Dịch vụ Cần Phục hồi Ngay Lập tức)

Trong tình huống khẩn cấp, khi hệ thống production gặp sự cố nghiêm trọng và không thể chờ đợi chu trình PR GitOps hoàn tất, Maintainer có thể thực hiện can thiệp khẩn cấp có kiểm soát trên VPS.

### 3.1. Nguyên tắc Bất biến
1. **Không dùng `docker compose up --build` cho rollback:**
   - Lệnh `--build` sẽ biên dịch lại từ source tree hiện tại, có thể kéo theo các package mới ngoài ý muốn và phá vỡ tính bất biến (immutability).
2. **Sử dụng Immutable Image Identity:**
   - Container production phải được khởi chạy từ image tag hoặc digest bất biến đã được kiểm chứng (ví dụ tag commit SHA trước đó: `omninovel-api:a695a1e` hoặc image digest SHA256).

### 3.2. Quy trình Emergency Rollback & Khôi phục Nhánh `main`

```bash
cd /opt/omninovel || cd ~/omninovel

# Bước 1: Tạo nhánh rollback riêng biệt (BẢO VỆ tracking branch main, KHÔNG dùng detached HEAD lâu dài)
git checkout -b emergency-rollback a695a1eb2d12038c0e27fc2d9611dc3b3dc66c01

# Bước 2: Tái khởi động container bằng image ổn định đã kiểm chứng (KHÔNG xóa volumes)
docker compose -f deploy/docker-compose.yml up -d --no-deps api ai-worker nginx

# Bước 3: Xác minh Image Identity thực tế đang chạy trong container
API_RUNNING_IMAGE=$(docker inspect --format='{{.Image}}' omninovel-prod-api)
API_IMAGE_NAME=$(docker inspect --format='{{.Config.Image}}' omninovel-prod-api)
echo "[VERIFY] Running Image ID: ${API_RUNNING_IMAGE}"
echo "[VERIFY] Image Reference: ${API_IMAGE_NAME}"

# Bước 4: Thực hiện Healthcheck xác nhận dịch vụ đã sẵn sàng (xem Mục 4)
curl -k -f -s -o /dev/null -w "%{http_code}\n" https://127.0.0.1/health/ready

# Bước 5: BẮT BUỘC — Khôi phục trạng thái deploy về tracking branch main (Reconciliation)
# Ngay sau khi PR revert trên GitHub đã được merge vào origin/main:
git checkout main
git fetch origin main
git reset --hard origin/main
git branch -D emergency-rollback
echo "[RECONCILE] VPS tracking branch restored to origin/main successfully."
```

---

## 4. Xác minh Sức khỏe Dịch vụ (Healthcheck & Ingress Verification)

> [!WARNING]
> **Đính chính Cổng Dịch vụ:** Dịch vụ `api` trong `deploy/docker-compose.yml` **KHÔNG mở cổng 8000 ra host**. Mọi lệnh `curl http://localhost:8000/...` trên host đều thất bại do cơ chế bảo vệ an ninh chống rò rỉ cổng mạng nội bộ (test case `TOP-02`).

### 4.1. Healthcheck qua Ingress Nginx trên Host (Cổng 443 HTTPS)
Nginx expose cổng 443 và reverse-proxy đường dẫn `/health/ready` tới upstream `api:8000`:
```bash
# Kiểm tra Ingress Readiness (dùng cờ -k để chấp nhận cert nội bộ/self-signed)
HTTP_STATUS=$(curl -k -s -o /dev/null -w "%{http_code}" https://127.0.0.1/health/ready)
if [ "$HTTP_STATUS" = "200" ]; then
  echo "[PASS] Ingress Healthcheck READY (HTTP 200)"
else
  echo "[FAIL] Ingress Healthcheck FAILED (HTTP ${HTTP_STATUS})"
  exit 1
fi
```

### 4.2. Healthcheck Trực tiếp trong Mạng Container
Kiểm tra trực tiếp loopback nội bộ của ứng dụng NestJS:
```bash
docker exec omninovel-prod-api node -e "
  require('http').get('http://127.0.0.1:8000/health/ready', (res) => {
    console.log('API Direct Status:', res.statusCode);
    process.exit(res.statusCode === 200 ? 0 : 1);
  });
"
```

### 4.3. Kiểm tra Healthcheck Redis Native
```bash
REDIS_STATUS=$(docker inspect --format='{{json .State.Health.Status}}' omninovel-prod-redis)
echo "Redis Health Status: ${REDIS_STATUS}" # Kỳ vọng: "healthy"
```

### 4.4. Xác minh Chứng chỉ TLS / SSL
```bash
# Kiểm tra thời hạn chứng chỉ và Domain Subject
echo | openssl s_client -connect 127.0.0.1:443 -servername "${DOMAIN:-localhost}" 2>/dev/null \
  | openssl x509 -noout -dates -subject
```

---

## 5. An ninh SSH & Cấu hình GitHub Environment Approval Gate

### 5.1. Rà soát Lỗ hổng `StrictHostKeyChecking=no`
Việc sử dụng `-o StrictHostKeyChecking=no` khi SSH tiềm ẩn rủi ro tấn công Man-In-The-Middle (MITM).  
**Giải pháp ghim Host Key (Known Hosts Pinning):**
1. Lấy public key fingerprint của VPS:
   ```bash
   ssh-keyscan -H <VPS_IP> | tee vps_known_hosts
   ssh-keygen -lf vps_known_hosts
   ```
2. Lưu nội dung `vps_known_hosts` vào GitHub Repository Secret: `VPS_SSH_KNOWN_HOSTS`.
3. Trong workflow CI/CD:
   ```bash
   mkdir -p ~/.ssh
   echo "$VPS_SSH_KNOWN_HOSTS" > ~/.ssh/known_hosts
   chmod 644 ~/.ssh/known_hosts
   echo "$VPS_KEY" > ~/.ssh/id_rsa
   chmod 600 ~/.ssh/id_rsa
   ssh -o StrictHostKeyChecking=yes -o BatchMode=yes "${VPS_USER:-root}@$VPS_HOST" "..."
   ```

### 5.2. Khóa Cổng Triển khai bằng GitHub Environment Approval Gate
Trước khi thêm bất kỳ SSH secret nào vào GitHub:
1. Vào **GitHub Repository Settings -> Environments -> New environment**: Tạo environment tên `production`.
2. Bật tùy chọn **Required reviewers** và gán Maintainer có thẩm quyền.
3. Trong `.github/workflows/ci-cd.yml`, khai báo `environment: production` tại job `deploy-vps`:
   ```yaml
   deploy-vps:
     name: VPS Production Deployment & Topology Verification
     environment: production
     needs: [docker-build-scan, security-scan]
     runs-on: ubuntu-latest
     if: github.ref == 'refs/heads/main' && github.event_name == 'push'
   ```

---

## 6. Schema Compatibility Matrix & PITR Recovery Preflight

| Loại Migration | Tính Tương thích | Hành động Khi Rollback | Nguy cơ Mất Dữ liệu |
| :--- | :---: | :--- | :---: |
| **Additive / Expand**<br>(Tạo bảng mới, thêm cột nullable) | Tương thích ngược 100% | **KHÔNG REVERT DATABASE**. Chỉ rollback code ứng dụng. | **ZERO** |
| **Breaking Non-Destructive**<br>(Thêm ràng buộc CHECK/UNIQUE, index mới) | Không tương thích code cũ | Đánh giá dữ liệu mới. Chỉ revert migration nếu không vi phạm toàn vẹn. | **THẤP** |
| **Destructive Breaking**<br>(Xóa cột, đổi kiểu dữ liệu, truncate) | Mất tương thích | **CẤM TỰ Ý CHẠY `migration:revert`**. Chạy `down()` sẽ xóa vĩnh viễn dữ liệu người dùng mới sinh.<br>Thực hiện phục hồi theo **Point-In-Time-Recovery (PITR)**. | **CỰC KỲ CAO** |

### Preflight Kiểm tra PITR Database Trước Khi Can Thiệp:
```bash
# 1. Kiểm tra trạng thái replication/backup gần nhất của Cloud Managed PostgreSQL
# 2. Tạo bản sao lưu nhanh (Manual Snapshot) trước khi thực hiện bất kỳ thao tác rollback nào
# 3. Xác định mốc thời gian (LSCN / Timestamp) ngay trước thời điểm xảy ra sự cố release lỗi
```

---

## 7. Phân biệt Rạch ròi 4 Cấp độ Kiểm chứng Hệ thống

| Tiêu chí | 1. CI Topology Validation | 2. Container Runtime Health | 3. Live Production Deployment | 4. Recovery / Rollback Acceptance |
| :--- | :--- | :--- | :--- | :--- |
| **Môi trường** | GitHub Actions Runner (`ubuntu-latest`) | Mạng nội bộ Docker Host | VPS Production Thực tế | Hệ thống Production sau khắc phục sự cố |
| **Mục tiêu** | Kiểm tra tĩnh manifest Compose, chặn rò rỉ port nội bộ (`TOP-01..17`). | Đảm bảo app bootstrap thành công, kết nối DB/Redis thông suốt. | Cập nhật phiên bản, phục vụ traffic độc giả thật qua Ingress TLS. | Phục hồi phiên bản ổn định, bảo toàn 100% dữ liệu persistent. |
| **Thời gian gián đoạn**| 0 giây | 2 - 5 giây (khi container `api` restart) | Gián đoạn ngắn theo chu kỳ recreate | Tùy phương án (In-place: ~3s; PITR: theo snapshot) |

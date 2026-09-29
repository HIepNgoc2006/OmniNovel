# Đặc Tả Kỹ Thuật: Hạ Tầng Production Docker Compose & Nginx (Phase 6.2)

- **Trạng thái:** APPROVED WITH REQUIRED AMENDMENTS (REVISION 2 - FINAL CANDIDATE)
- **Ngày lập:** 2026-09-29 (Cập nhật Revision 2: 2026-09-29)
- **Tác giả:** Antigravity Engineering
- **Quyết định kiến trúc (ADR Phase 6.2):** 
  > 3-Network Production Topology (`edge`, `internal`, `egress`) + Root-Context Multi-stage Monorepo Builds (dựa trên root `package-lock.json`) + CPU-Only AI Worker (tách riêng `requirements-prod-cpu.txt`) + Nginx Ingress Độc Quyền (khởi động độc lập `service_started`) + Redis Container-Side Secret Expansion + Outbound Egress Cho Supabase/R2 + Fail-Safe Atomic TLS Symlink Bootstrap/Renewal + Explicit Production Migration Script.

---

## 1. TỔNG QUAN & BỐI CẢNH (EXECUTIVE SUMMARY)

Phase 6.1 đã hoàn tất và đóng băng sạch (`CLOSED / FROZEN CLEAN`) tầng lưu trữ Cloudflare R2 với zero-leak verification trên cả hai bucket và vệ sinh HEAD credentials. Bước tiếp theo — **Phase 6.2** — hoàn thiện tầng triển khai Production trên máy chủ VPS Linux thông qua cụm 4 container cốt lõi:
1. `nginx`: Ingress gateway duy nhất, đón nhận và phân luồng traffic Internet, quản lý SSL/TLS và rate limiting. Khởi động độc lập (`service_started`) để luôn sẵn sàng phục vụ ACME challenge.
2. `api`: NestJS Core Backend API, phục vụ nghiệp vụ, xác thực JWT, kết nối Supabase Postgres và điều phối hàng đợi BullMQ.
3. `ai-worker`: Python FastAPI AI Translation Engine, chạy suy luận CPU (manga-ocr), tải và xử lý media từ R2 qua mạng egress.
4. `redis`: Bộ nhớ đệm (Cache) và quản lý hàng đợi tác vụ dịch thuật (BullMQ), bảo vệ bằng container-side secret expansion.

**Nguyên tắc Bất Biến Ranh Giới (Single Source of Truth - SSoT):**
- **Cơ sở dữ liệu:** Supabase Managed PostgreSQL nằm **hoàn toàn bên ngoài VPS**. Không triển khai container PostgreSQL trong production compose.
- **Lưu trữ Object:** Cloudflare R2 nằm **hoàn toàn bên ngoài VPS**. Không triển khai container MinIO trong production compose.
- **Frontend Web & Mobile:** Truy cập NestJS API và WebSocket duy nhất qua cổng an toàn của Nginx.

---

## 2. RANH GIỚI MẠNG & AN TOÀN THÔNG TIN (3-NETWORK TOPOLOGY)

Để giải quyết triệt để vấn đề cô lập dịch vụ nội bộ nhưng vẫn đảm bảo AI Worker và Core API có thể kết nối ra các dịch vụ Cloud bên ngoài (Supabase Postgres & Cloudflare R2), hệ thống áp dụng cấu trúc **3 mạng Docker độc lập**:

```text
                                Internet
                                   │
                           Cổng 80 / 443 (Host)
                                   ▼
                     ┌───────────────────────────┐
                     │       Nginx Ingress       │
                     └─────────────┬─────────────┘
                                   │ (Mạng omninovel-edge)
                                   ▼
                     ┌───────────────────────────┐
                     │   NestJS Core API (:8000) │ ──(Mạng egress)──► Supabase Postgres (:5432)
                     └──────┬─────────────┬──────┘ ──(Mạng egress)──► Cloudflare R2 S3 API
                            │             │
    (Mạng omninovel-internal│             │(Mạng omninovel-internal, internal: true)
             internal: true)│             │
                            ▼             ▼
              ┌──────────────────┐   ┌───────────────────────────┐
              │ Redis 7 (:6379)  │   │     AI Worker (:8001)     │ ──(Mạng egress)──► R2
              │ (internal only)  │   │ (non-root CPU, no ports)  │
              └──────────────────┘   └───────────────────────────┘
```

### 2.1. Phân Vùng Mạng Chi Tiết

| Tên Mạng Docker | Thuộc Tính | Các Container Tham Gia | Mục Đích & Ranh Giới An Ninh |
| :--- | :--- | :--- | :--- |
| `omninovel-edge` | `driver: bridge` | `nginx`, `api` | Mạng biên (Edge). Duy nhất `nginx` bind cổng host (`80:80`, `443:443`). `api` nhận reverse proxy nhưng **không có host port**. |
| `omninovel-internal` | `driver: bridge`<br>`internal: true` | `api`, `ai-worker`, `redis` | Mạng cô lập nội bộ. **Không có default gateway ra Internet**. Dành riêng cho RPC nội bộ giữa API ↔ AI Worker và kết nối API ↔ Redis. Ngăn chặn tuyệt đối mọi truy cập trái phép từ bên ngoài. |
| `omninovel-egress` | `driver: bridge`<br>*(no published ports)* | `api`, `ai-worker` | Mạng xuất phát kết nối ra ngoài (Outbound WAN). Cho phép API truy vấn Supabase Postgres / Cloudflare R2 và AI Worker tải ảnh gốc từ R2 qua Presigned URL. |

### 2.2. Ma Trận Công Bố Cổng (Port Exposure Policy)

- `nginx`: `ports: ["80:80", "443:443"]` (Cổng vào duy nhất).
- `api`: `ports: []` (Không expose cổng host `8000`).
- `ai-worker`: `ports: []` (Không expose cổng host `8001`).
- `redis`: `ports: []` (Không expose cổng host `6379`, chỉ kết nối duy nhất vào `omninovel-internal`).

### 2.3. Quy Định Bí Mật Môi Trường & Container-Side Expansion (Secret Hygiene)

1. **Không duplicate biến bí mật trong YAML:** Tránh việc dùng `${REDIS_PASSWORD}` hay `${AI_WORKER_SECRET}` trực tiếp trong thuộc tính `environment:` vì shell host có thể ghi đè rỗng.
2. **Container-side expansion cho Redis:**
   - Redis được gắn `env_file: ../.env`.
   - Command chạy qua shell bọc: `sh -c 'exec redis-server --appendonly yes --protected-mode yes --requirepass "$$REDIS_PASSWORD"'` (sử dụng cú pháp `$$` để Docker Compose không nội suy trên host mà để subshell trong container tự đọc biến từ `.env`).
   - Healthcheck: `CMD-SHELL redis-cli -a "$$REDIS_PASSWORD" ping`.
3. **Cú pháp thực thi chuẩn SSoT:**
   Mọi lệnh vận hành compose đều dùng cú pháp nạp file môi trường tường minh:
   ```bash
   docker compose --env-file ../.env -f deploy/docker-compose.yml <command>
   ```

---

## 3. THIẾT KẾ DOCKERFILE (MONOREPO MULTI-STAGE BUILDS)

### 3.1. Backend API (`services/api/Dockerfile`)

Kho mã nguồn là một **npm workspace monorepo** với một file khóa duy nhất tại gốc: [package-lock.json](file:///e:/Workspace%202/Doctruyen_project/package-lock.json). Không có file lock riêng tại `services/api/` hay `packages/shared/`. Vì vậy, Dockerfile phải lấy ngữ cảnh build từ thư mục gốc (`context: ..`) và tận dụng cơ chế cài đặt của npm workspace.

```dockerfile
# ==========================================
# STAGE 1: Monorepo Workspace Builder
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /app

# Cài đặt build tools cần thiết cho native modules (argon2)
RUN apk add --no-cache python3 make g++

# 1. Copy root package manifest và lockfile SSoT
COPY package.json package-lock.json ./

# 2. Copy manifests của các workspaces liên quan
COPY packages/shared/package.json ./packages/shared/
COPY services/api/package.json ./services/api/

# 3. Cài đặt toàn bộ dependencies theo đúng root lockfile
RUN npm ci --workspace=@omninovel/shared --workspace=@omninovel/api --include-workspace-root

# 4. Copy mã nguồn
COPY packages/shared ./packages/shared
COPY services/api ./services/api

# 5. Biên dịch TypeScript theo thứ tự phụ thuộc
RUN npm run build --workspace=@omninovel/shared
RUN npm run build --workspace=@omninovel/api

# 6. Cắt tỉa devDependencies chỉ giữ lại runtime packages
RUN npm prune --omit=dev --workspace=@omninovel/shared --workspace=@omninovel/api

# ==========================================
# STAGE 2: Production Runner
# ==========================================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8000

# Copy node_modules gốc (đã prune) và symlinks workspace
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json

COPY --from=builder /app/services/api/dist ./services/api/dist
COPY --from=builder /app/services/api/node_modules ./services/api/node_modules
COPY --from=builder /app/services/api/package.json ./services/api/package.json

WORKDIR /app/services/api

# Chạy dưới user không đặc quyền (Security Hardening)
USER node

# Healthcheck nội bộ
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8000/health/live || exit 1

EXPOSE 8000

CMD ["node", "dist/main"]
```

### 3.2. Script Production Migration (`services/api/package.json`)

Để lệnh migration chạy thành công trên production runner (nơi không còn `ts-node` và `src/`), bổ sung script sau vào `services/api/package.json`:

```json
"scripts": {
  "migration:run:prod": "typeorm migration:run -d dist/database/data-source.js"
}
```

*Lưu ý:* `typeorm` nằm trong `dependencies` thông thường của API, do đó tồn tại sẵn trong `node_modules` production sau lệnh `npm prune --omit=dev`.

### 3.3. Tách Biệt Dependencies AI Worker (`requirements-prod-cpu.txt`)

Để loại bỏ `pytest` và `pytest-asyncio` khỏi image production, chia tách dependencies của `ai-worker` thành 2 file:
1. `services/ai-worker/requirements-prod-cpu.txt`:
   ```text
   --extra-index-url https://download.pytorch.org/whl/cpu
   torch>=2.2.0,<2.7.0
   fastapi>=0.115.0,<0.120.0
   uvicorn>=0.30.0,<0.35.0
   pydantic>=2.8.0,<2.11.0
   pydantic-settings>=2.4.0,<2.8.0
   httpx>=0.27.0,<0.29.0
   transformers>=4.45.0,<5.0.0
   manga-ocr==0.1.16
   Pillow>=10.0.0,<12.0.0
   numpy>=1.26.0,<2.3.0
   opencv-python-headless>=4.9.0,<5.0.0
   ```
2. `services/ai-worker/requirements-ci-cpu.txt`:
   ```text
   -r requirements-prod-cpu.txt
   pytest>=8.0.0,<9.0.0
   pytest-asyncio>=0.23.0,<0.26.0
   ```

### 3.4. AI Worker Dockerfile (`services/ai-worker/Dockerfile`)

```dockerfile
# ==========================================
# Production AI Worker (Python 3.11 CPU)
# ==========================================
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    OCR_FORCE_CPU=true \
    OCR_MAX_CONCURRENT_INFERENCES=1 \
    AI_WORKER_PORT=8001 \
    HF_HOME=/home/appuser/.cache/huggingface \
    TORCH_HOME=/home/appuser/.cache/torch

# Cài đặt thư viện hệ thống tối thiểu cho OpenCV và healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Tạo user không đặc quyền
RUN groupadd -g 10001 appuser && \
    useradd -u 10001 -g appuser -m -s /bin/bash appuser

# Cài đặt Python dependencies từ requirements-prod-cpu.txt
COPY services/ai-worker/requirements-prod-cpu.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy mã nguồn dịch vụ
COPY services/ai-worker/app ./app
COPY services/ai-worker/main.py ./main.py

# Chuẩn bị thư mục cache và phân quyền cho appuser
RUN mkdir -p /home/appuser/.cache/huggingface /home/appuser/.cache/torch && \
    chown -R appuser:appuser /home/appuser /app

USER appuser

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://127.0.0.1:8001/internal/v1/jobs/health || exit 1

EXPOSE 8001

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
```

### 3.5. Sửa Đổi Cấu Hình Python Cache (`services/ai-worker/app/core/config.py`)

Cập nhật `config.py` sử dụng `os.environ.setdefault` để biến môi trường từ Dockerfile/Compose được tôn trọng tuyệt đối:

```python
_AI_WORKER_DIR = Path(__file__).resolve().parent.parent.parent
_CACHE_DIR = _AI_WORKER_DIR / ".cache"

_HF_HOME = os.environ.get("HF_HOME") or str(_CACHE_DIR / "huggingface")
_TORCH_HOME = os.environ.get("TORCH_HOME") or str(_CACHE_DIR / "torch")

Path(_HF_HOME).mkdir(parents=True, exist_ok=True)
Path(_TORCH_HOME).mkdir(parents=True, exist_ok=True)

os.environ.setdefault("HF_HOME", _HF_HOME)
os.environ.setdefault("TORCH_HOME", _TORCH_HOME)
```

---

## 4. CẤU TRÚC FILE COMPOSE (`deploy/docker-compose.yml`)

```yaml
version: '3.8'

services:
  # 1. Nginx Reverse Proxy & TLS Ingress
  nginx:
    image: nginx:1.27-alpine
    container_name: omninovel-prod-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      - DOMAIN=${DOMAIN:-localhost}
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      - ./nginx/entrypoint.sh:/entrypoint.sh:ro
      - certbot_acme_data:/var/www/certbot:ro
      - nginx_ssl_certs:/etc/nginx/ssl
    networks:
      - omninovel-edge
    depends_on:
      api:
        condition: service_started
    entrypoint: ["/bin/sh", "/entrypoint.sh"]

  # 2. NestJS Core Backend API
  api:
    build:
      context: ..
      dockerfile: services/api/Dockerfile
    container_name: omninovel-prod-api
    restart: unless-stopped
    env_file:
      - ../.env
    environment:
      - NODE_ENV=production
      - PORT=8000
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - AI_WORKER_BASE_URL=http://ai-worker:8001
    networks:
      - omninovel-edge
      - omninovel-internal
      - omninovel-egress
    depends_on:
      redis:
        condition: service_healthy
      ai-worker:
        condition: service_healthy

  # 3. Python FastAPI AI Translation Worker Engine (CPU Inference)
  ai-worker:
    build:
      context: ..
      dockerfile: services/ai-worker/Dockerfile
    container_name: omninovel-prod-ai-worker
    restart: unless-stopped
    env_file:
      - ../.env
    environment:
      - ENV=production
      - OCR_FORCE_CPU=true
      - OCR_MAX_CONCURRENT_INFERENCES=1
      - AI_WORKER_PORT=8001
      - CORE_API_INTERNAL_URL=http://api:8000
    volumes:
      - ai_model_cache:/home/appuser/.cache
    networks:
      - omninovel-internal
      - omninovel-egress

  # 4. Redis 7 (Cache & BullMQ Job Queue)
  redis:
    image: redis:7-alpine
    container_name: omninovel-prod-redis
    restart: unless-stopped
    env_file:
      - ../.env
    entrypoint: >
      /bin/sh -c '
      exec redis-server
      --appendonly yes
      --protected-mode yes
      --requirepass "$$REDIS_PASSWORD"
      '
    volumes:
      - redis_prod_data:/data
    networks:
      - omninovel-internal
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a \"$$REDIS_PASSWORD\" ping"]
      interval: 5s
      timeout: 3s
      retries: 5

networks:
  omninovel-edge:
    name: omninovel-edge
    driver: bridge
  omninovel-internal:
    name: omninovel-internal
    driver: bridge
    internal: true
  omninovel-egress:
    name: omninovel-egress
    driver: bridge

volumes:
  redis_prod_data:
    name: omninovel_redis_prod_data
  ai_model_cache:
    name: omninovel_ai_model_cache
  certbot_acme_data:
    name: omninovel_certbot_acme_data
  nginx_ssl_certs:
    name: omninovel_nginx_ssl_certs
```

---

## 5. THIẾT KẾ NGINX & QUY TRÌNH CHUYỂN ĐỔI TLS (NGINX/TLS LIFECYCLE)

### 5.1. Kiến Trúc Atomic Symlink (`/etc/nginx/ssl/current/`)

Để Nginx có thể khởi động ngay từ ngày đầu tiên mà không bị lỗi syntax chứng chỉ, cấu hình Nginx trỏ vào một đường dẫn cố định duy nhất:
```nginx
ssl_certificate /etc/nginx/ssl/current/fullchain.pem;
ssl_certificate_key /etc/nginx/ssl/current/privkey.pem;
```

Cơ chế điều phối qua symlink:
```text
/etc/nginx/ssl/current/
   │
   ├── [Bootstrap State]  ──► /etc/nginx/ssl/dummy/ (Self-signed 30 days)
   │                          * Port 80 mở /.well-known/acme-challenge/
   │                          * KHÔNG bật HSTS
   │
   └── [Production State] ──► /etc/nginx/ssl/live/${DOMAIN}/ (Let's Encrypt thật)
                              * Port 80 redirect 301 sang HTTPS
                              * KÍCH HOẠT HSTS 1 năm
```

### 5.2. Script Khởi Động Nginx (`deploy/nginx/entrypoint.sh`)

```bash
#!/bin/sh
set -e

DOMAIN="${DOMAIN:-localhost}"
CERT_DIR="/etc/nginx/ssl"
DUMMY_DIR="${CERT_DIR}/dummy"
LIVE_DIR="${CERT_DIR}/live/${DOMAIN}"
CURRENT_DIR="${CERT_DIR}/current"

mkdir -p "${DUMMY_DIR}" "${CURRENT_DIR}"

# 1. Sinh chứng chỉ Bootstrap nếu chưa có
if [ ! -f "${DUMMY_DIR}/cert.pem" ] || [ ! -f "${DUMMY_DIR}/key.pem" ]; then
  echo "[Nginx Entrypoint] Đang sinh chứng chỉ Self-Signed Bootstrap..."
  openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
    -keyout "${DUMMY_DIR}/key.pem" \
    -out "${DUMMY_DIR}/cert.pem" \
    -subj "/CN=${DOMAIN}"
fi

# 2. Kiểm tra nếu đã có cert Let's Encrypt thật cho DOMAIN
if [ -f "${LIVE_DIR}/fullchain.pem" ] && [ -f "${LIVE_DIR}/privkey.pem" ]; then
  echo "[Nginx Entrypoint] Đã phát hiện chứng chỉ Let's Encrypt thật cho ${DOMAIN}."
  ln -sfn "${LIVE_DIR}/fullchain.pem" "${CURRENT_DIR}/fullchain.pem"
  ln -sfn "${LIVE_DIR}/privkey.pem" "${CURRENT_DIR}/privkey.pem"
else
  echo "[Nginx Entrypoint] Sử dụng chứng chỉ Bootstrap tạm thời."
  ln -sfn "${DUMMY_DIR}/cert.pem" "${CURRENT_DIR}/fullchain.pem"
  ln -sfn "${DUMMY_DIR}/key.pem" "${CURRENT_DIR}/privkey.pem"
fi

exec nginx -g "daemon off;"
```

### 5.3. Cấu Hình Nginx (`deploy/nginx/conf.d/omninovel.conf`)

- **DNS Resolver:**
  Sử dụng DNS nội bộ của Docker để Nginx phân giải động IP của container `api` khi container được recreate mà không bị stale IP:
  ```nginx
  resolver 127.0.0.11 valid=10s ipv6=off;
  ```
- **Định tuyến API chuẩn (Preserve URI):**
  - `location /api/v1/`: Sử dụng `proxy_pass http://api:8000;` để chuyển tiếp nguyên vẹn đường dẫn.
  - Tuyệt đối **không bật `proxy_cache`** cho `/api/v1/` vì API chứa logic auth/user state và R2 presigned URLs đi trực tiếp Cloudflare R2.
- **WebSocket Upgrade:**
  - `location /socket.io/`: Cung cấp HTTP/1.1 WebSocket Upgrade headers để phục vụ Socket.IO namespace `/ws/ai`.
- **Health Probes:**
  - `location = /health/live` và `location = /health/ready`: Chuyển tiếp sang `http://api:8000;`.
- **Chặn Đường Dẫn Nội Bộ:**
  - `location /internal/ { return 403; }`: Chặn mọi truy cập vào endpoint nội bộ.
- **Rate Limiting:**
  - API thông thường: Giới hạn `30r/s`, burst `20 nodelay`.
  - Auth nhạy cảm (`/api/v1/auth/`): Giới hạn `5r/s`, burst `5 nodelay`.

### 5.4. Quy Trình Cấp Phát & Gia Hạn Chứng Chỉ (One-Off & Renewal)

1. **Cấp phát lần đầu (Initial Issuance):**
   ```bash
   docker run --rm -it \
     -v omninovel_certbot_acme_data:/var/www/certbot \
     -v omninovel_nginx_ssl_certs:/etc/letsencrypt \
     certbot/certbot certonly --webroot \
     -w /var/www/certbot \
     -d yourdomain.com \
     --email admin@yourdomain.com --agree-tos --no-eff-email
   ```
2. **Kích hoạt cert thật sau khi cấp:**
   ```bash
   docker compose --env-file ../.env -f deploy/docker-compose.yml exec nginx sh -c '
     ln -sfn /etc/nginx/ssl/live/${DOMAIN}/fullchain.pem /etc/nginx/ssl/current/fullchain.pem &&
     ln -sfn /etc/nginx/ssl/live/${DOMAIN}/privkey.pem /etc/nginx/ssl/current/privkey.pem &&
     nginx -t && nginx -s reload
   '
   ```
3. **Gia hạn định kỳ (Scheduled Renewal):**
   Thiết lập cron job hoặc systemd timer trên máy chủ VPS:
   ```bash
   0 3 * * 1 docker run --rm -v omninovel_certbot_acme_data:/var/www/certbot -v omninovel_nginx_ssl_certs:/etc/letsencrypt certbot/certbot renew --webroot -w /var/www/certbot --quiet && docker compose --env-file /path/to/.env -f /path/to/deploy/docker-compose.yml exec nginx sh -c "nginx -t && nginx -s reload"
   ```

---

## 6. QUY TRÌNH VẬN HÀNH MIGRATION & DEPLOYMENT (EXPLICIT RELEASE)

Nhằm ngăn ngừa rủi ro tranh chấp lock hoặc tự ý thay đổi CSDL khi container restart ngoài ý muốn, **tuyệt đối không chạy tự động TypeORM migrations trong entrypoint của `api`**.

### Quy Trình Deploy Chuẩn 4 Bước

```bash
# Bước 1: Build images từ clean checkout
docker compose --env-file ../.env -f deploy/docker-compose.yml build

# Bước 2: Thực thi Database Migration độc lập (Explicit Migration Gate)
docker compose --env-file ../.env -f deploy/docker-compose.yml run --rm api npm run migration:run:prod

# Bước 3: Khởi động cụm containers
docker compose --env-file ../.env -f deploy/docker-compose.yml up -d

# Bước 4: Kiểm tra trạng thái sức khỏe
docker compose --env-file ../.env -f deploy/docker-compose.yml ps
curl -k https://localhost/health/ready
```

---

## 7. CÁC TIÊU CHÍ NGHIỆM THU (ACCEPTANCE GATES)

### Tiền Đề An Toàn Thông Tin Trước Triển Khai (Pre-Deployment Gate)

| Gate | Tên Tiêu Chí | Điều Kiện Nghiệm Thu Cụ Thể (Pass Criteria) |
| :---: | :--- | :--- |
| **G00** | `Credential Rotation Prerequisite` | R2 API Token cũ (từng xuất hiện trong chat history) đã được thu hồi và thay thế bằng cặp Key mới trên Cloudflare Dashboard. Supabase Database Password cũ (từng nằm trong lịch sử git) đã được reset trên Supabase Dashboard. Biến môi trường mới đã cập nhật vào file `.env` cục bộ (tuyệt đối không in giá trị bí mật ra log/spec). Trạng thái: **SẴN SÀNG / ĐÃ XÁC NHẬN VẬN HÀNH**. |

---

### Danh Sách 14 Tiêu Chí Nghiệm Thu Kỹ Thuật (G01 - G14)

| STT | Tên Tiêu Chí (Gate) | Điều Kiện Nghiệm Thu Cụ Thể (Pass Criteria) | Phương Pháp Kiểm Tra |
| :---: | :--- | :--- | :--- |
| **G01** | `Compose Config Valid` | `docker compose --env-file ../.env -f deploy/docker-compose.yml config` hợp lệ, cú pháp chuẩn, không hardcode credentials trong file. | `docker compose config` |
| **G02** | `Clean Multi-Stage Build & Migration Proof` | Build thành công cả 2 Dockerfile từ clean checkout (root lockfile). Lệnh `run --rm api npm run migration:run:prod` chạy thành công và báo không còn pending migration trên Supabase. | `docker compose build` & `run --rm api npm run migration:run:prod` |
| **G03** | `Strict Port Isolation` | Chỉ duy nhất host ports `80` và `443` mở. Các cổng `8000`, `8001`, `6379` hoàn toàn không lắng nghe trên host interface. | `netstat -tuln` / `Test-NetConnection` |
| **G04** | `Nginx API Health Pass` | `GET http://localhost/health/live` và `/health/ready` qua Nginx trả về `HTTP 200` và JSON `{"status": "UP"}`. | `curl -i http://localhost/health/ready` |
| **G05** | `API ↔ Redis Pass` | API kết nối thành công tới Redis có mật khẩu qua `omninovel-internal`. Healthcheck ready báo `redis: UP`. | Kiểm tra log API & `/health/ready` |
| **G06** | `API ↔ AI Worker Authenticated RPC & Egress` | API gửi RPC tới AI Worker qua `omninovel-internal` với `x-internal-key` thành công. Gọi không có key bị trả về `401/403`. AI Worker thực hiện tải thành công presigned URL từ R2 qua `omninovel-egress`. | Integration script |
| **G07** | `API ↔ Supabase Connection Pass` | API kết nối thành công tới Supabase PostgreSQL qua `omninovel-egress`. Healthcheck ready báo `database: UP`. | Kiểm tra log API & `/health/ready` |
| **G08** | `API ↔ R2 Signed Storage Pass` | API gọi R2 cấp Presigned URL thành công. | Endpoint upload media smoke |
| **G09** | `WebSocket Socket.IO /ws/ai Upgrade Pass` | Client `socket.io-client` kết nối tới path `/socket.io/` tại namespace `/ws/ai` qua Nginx, nhận handshake và trao đổi event thành công. | Node.js Socket.IO acceptance runner |
| **G10** | `Rate Limiting & Throttling Pass` | Gửi request liên tục vượt 30 req/s vào API hoặc 5 req/s vào auth endpoints bị Nginx chặn với mã `429 Too Many Requests`. | Kịch bản bắn tải wrk / ab / curl loop |
| **G11** | `TLS Bootstrap & Zero Downtime Transition` | Nginx boot thành công với self-signed cert (không có HSTS). Chuyển sang cert thật và reload không gây gián đoạn dịch vụ; sau đó HSTS mới được kích hoạt. | Kiểm tra TLS handshake & reload |
| **G12** | `Auto-Recovery, Cache Persistence & DNS Re-resolve` | Thực thi `docker compose up -d --force-recreate ai-worker`: model cache trong named volume `omninovel_ai_model_cache` vẫn nguyên vẹn, không tải lại. Recreate `api`: Nginx tự động phân giải lại IP mới mà không bị lỗi 502 stale IP. | `docker compose up -d --force-recreate` |
| **G13** | `Non-Root Container Hardening` | Container `api` chạy dưới user `node` (UID 1000); container `ai-worker` chạy dưới `appuser` (UID 10001). | `docker compose exec ... id` |
| **G14** | `Secret Hygiene in Logs` | Logs của toàn bộ 4 container tuyệt đối không in ra DB password, R2 secret access key, hoặc JWT secrets. | `docker compose logs` regex scan |

---

## 8. THỨ TỰ THI CÔNG TRONG IMPLEMENTATION PLAN

Để loại bỏ hoàn toàn nguy cơ tắc nghẽn kỹ thuật, kế hoạch triển khai (Implementation Plan) sẽ bắt đầu bằng:
1. **Task 1 (Spike & Build Proof):** Xây dựng `services/api/Dockerfile` trên root context + root `package-lock.json`, chứng minh layout `node_modules/@omninovel/shared` và kiểm tra lệnh `npm run migration:run:prod` chạy thành công.
2. **Task 2 (AI Worker Image):** Tách `requirements-prod-cpu.txt`, sửa `config.py` với `os.environ.setdefault`, xây dựng `services/ai-worker/Dockerfile` non-root.
3. **Task 3 (Nginx & TLS Bootstrap):** Viết `deploy/nginx/entrypoint.sh` (atomic symlink), cấu hình `deploy/nginx/nginx.conf` và `omninovel.conf` (DNS resolver, rate limit, WebSocket `/socket.io`).
4. **Task 4 (Compose Integration):** Tạo `deploy/docker-compose.yml` với 3-network topology và container-side expansion cho Redis.
5. **Task 5 (Acceptance Verification):** Thực thi toàn bộ 14 Acceptance Gates (từ G01 đến G14) kèm bằng chứng kiểm thử thực tế.

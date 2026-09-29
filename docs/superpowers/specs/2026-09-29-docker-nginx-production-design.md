# Đặc Tả Kỹ Thuật: Hạ Tầng Production Docker Compose & Nginx (Phase 6.2)

- **Trạng thái:** APPROVED WITH REQUIRED AMENDMENTS (REVISION 3 - FINAL CANDIDATE)
- **Ngày lập:** 2026-09-29 (Cập nhật Revision 3: 2026-09-29)
- **Tác giả:** Antigravity Engineering
- **Quyết định kiến trúc (ADR Phase 6.2):** 
  > 3-Network Production Topology (`edge`, `internal`, `egress`) + Root-Context Multi-stage Monorepo Builds (dựa trên root `package-lock.json`) + CPU-Only AI Worker (`requirements-prod-cpu.txt`) + Nginx Ingress Độc Quyền (Custom Alpine Image với OpenSSL, Pin >= 1.27.3 kèm Dynamic DNS Resolver `zone api_backend 64k; server api:8000 resolve;`, `service_started`) + Redis Container-Side Secret Expansion & Production Password Guard + Outbound Egress Cho Supabase/R2 + Hai Trạng Thái TLS/HSTS Độc Lập Qua Runtime State Files (`tls-mode.conf`, `port80-mode.conf`) + Explicit Production Migration Script.

---

## 1. TỔNG QUAN & BỐI CẢNH (EXECUTIVE SUMMARY)

Phase 6.1 đã hoàn tất và đóng băng sạch (`CLOSED / FROZEN CLEAN`) tầng lưu trữ Cloudflare R2 với zero-leak verification trên cả hai bucket và vệ sinh HEAD credentials. Bước tiếp theo — **Phase 6.2** — hoàn thiện tầng triển khai Production trên máy chủ VPS Linux thông qua cụm 4 container cốt lõi:
1. `nginx`: Ingress gateway duy nhất, đón nhận và phân luồng traffic Internet, quản lý SSL/TLS và rate limiting. Khởi động độc lập (`service_started`), hỗ trợ Dynamic Upstream DNS qua Docker embedded DNS resolver.
2. `api`: NestJS Core Backend API, phục vụ nghiệp vụ, xác thực JWT, kết nối Supabase Postgres và điều phối hàng đợi BullMQ.
3. `ai-worker`: Python FastAPI AI Translation Engine, chạy suy luận CPU (manga-ocr), tải và xử lý media từ R2 qua mạng egress.
4. `redis`: Bộ nhớ đệm (Cache) và quản lý hàng đợi tác vụ dịch thuật (BullMQ), bảo vệ bằng container-side secret expansion và fail-fast password guard.

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

### 2.3. Quy Định Bí Mật Môi Trường & Working Directory SSoT

1. **Khóa một convention thực thi CLI duy nhất:**
   Toàn bộ lệnh `docker compose` **bắt buộc chạy từ Repository Root**:
   ```bash
   docker compose --env-file .env -f deploy/docker-compose.yml <command>
   ```
   *Lý do kỹ thuật:* Cờ CLI `--env-file` được Docker phân giải tương đối theo Current Working Directory của shell (nên khi đứng tại repo root, trỏ `.env` là chính xác). Trong khi đó, thuộc tính `env_file:` bên trong file YAML được Compose phân giải theo vị trí của file compose (`deploy/`), do đó trong YAML giữ đúng `env_file: - ../.env`.
2. **Container-side expansion cho Redis & Production Password Guard:**
   - Redis được nạp `env_file: ../.env`.
   - Entrypoint Redis kiểm tra biến bắt buộc trước khi start và dùng shell expansion nội bộ (cú pháp `$$` tránh Compose nội suy trên host):
     ```bash
     : "${REDIS_PASSWORD:?ERROR: REDIS_PASSWORD is required and cannot be empty}"
     exec redis-server --appendonly yes --protected-mode yes --requirepass "$$REDIS_PASSWORD"
     ```
   - Healthcheck: `CMD-SHELL redis-cli -a "$$REDIS_PASSWORD" ping`.
   - Trong `services/api/src/config/env.validation.ts`: Bổ sung kiểm tra fail-fast ở production: khi `NODE_ENV === 'production'`, `REDIS_PASSWORD` **bắt buộc phải có giá trị và không được để trống**.

---

## 3. THIẾT KẾ DOCKERFILE (MONOREPO MULTI-STAGE BUILDS)

### 3.1. Backend API (`services/api/Dockerfile`)

Kho mã nguồn là một **npm workspace monorepo** với một file khóa duy nhất tại gốc: [package-lock.json](file:///e:/Workspace%202/Doctruyen_project/package-lock.json). Không có file lock riêng tại `services/api/` hay `packages/shared/`. Vì vậy, Dockerfile lấy ngữ cảnh build từ thư mục gốc (`context: ..`) và tận dụng cơ chế cài đặt của npm workspace.

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

## 4. THIẾT KẾ NGINX IMAGE, DYNAMIC DNS RESOLVER & TLS STATE MACHINE

### 4.1. Nginx Custom Dockerfile (`deploy/nginx/Dockerfile`)

Do base image Alpine chính thức của Nginx không cài sẵn OpenSSL CLI trong runtime, hệ thống tạo custom image nhẹ được pin phiên bản **Nginx 1.27.4-alpine** (>= 1.27.3 để hỗ trợ upstream dynamic resolution):

```dockerfile
FROM nginx:1.27.4-alpine

# Cài đặt OpenSSL CLI cho script bootstrap self-signed certificate
RUN apk add --no-cache openssl

COPY nginx.conf /etc/nginx/nginx.conf
COPY conf.d/ /etc/nginx/conf.d/
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
```

### 4.2. Cấu Hình Nginx Dynamic DNS Resolver (`deploy/nginx/conf.d/omninovel.conf`)

Để ngăn chặn lỗi `502 Bad Gateway` khi container `api` bị recreate và nhận IP nội bộ mới trong mạng Docker, cấu hình sử dụng tính năng **Upstream Zone & Dynamic Resolve** chính thức từ Nginx OSS 1.27.3+:

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;

upstream api_backend {
    zone api_backend 64k;
    server api:8000 resolve;
}

server {
    listen 80;
    listen [::]:80;
    server_name _;

    # Nơi ACME challenge được phục vụ bởi Certbot
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # Trạng thái Port 80 được điều khiển độc lập qua file runtime
    include /etc/nginx/runtime/port80-mode.conf;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name _;

    # Chứng chỉ SSL trỏ vào đường dẫn symlink cố định
    ssl_certificate /etc/nginx/ssl/current/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/current/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384";

    # Chính sách HSTS được điều khiển độc lập qua file runtime
    include /etc/nginx/runtime/tls-mode.conf;

    # Rate Limiting
    limit_req zone=api_general_limit burst=20 nodelay;

    # Core Backend API (Preserve URI)
    location /api/v1/ {
        proxy_pass http://api_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Auth Limiting Riêng Biệt
    location /api/v1/auth/ {
        limit_req zone=auth_limit burst=5 nodelay;
        proxy_pass http://api_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket Socket.IO (Namespace /ws/ai)
    location /socket.io/ {
        proxy_pass http://api_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Health Probes
    location = /health/live {
        proxy_pass http://api_backend;
    }

    location = /health/ready {
        proxy_pass http://api_backend;
    }

    # Chặn đứng các đường dẫn nội bộ
    location /internal/ {
        return 403;
    }
}
```

### 4.3. Máy Trạng Thái TLS (TLS State Machine: Bootstrap ➔ Production)

Thay vì chỉ symlink file cert, hệ thống điều khiển **đồng thời cả 3 thành phần**: (1) Chứng chỉ SSL, (2) Chính sách HSTS, và (3) Hành vi Port 80 thông qua 2 file runtime state: `/etc/nginx/runtime/tls-mode.conf` và `/etc/nginx/runtime/port80-mode.conf`.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ TRẠNG THÁI 1: BOOTSTRAP (Lần đầu khởi động, chưa có Let's Encrypt cert)     │
│ 1. Symlink: current/* ──► dummy/* (Self-signed certificate)                 │
│ 2. /etc/nginx/runtime/tls-mode.conf: Trống (# HSTS Disabled)                │
│ 3. /etc/nginx/runtime/port80-mode.conf: proxy_pass http://api_backend       │
│    (Cho phép truy cập HTTP trực tiếp để kiểm thử, không force HTTPS)        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       │ Quản trị viên chạy Certbot cấp cert thật
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ TRẠNG THÁI 2: PRODUCTION (Đã có chứng chỉ Let's Encrypt thật)               │
│ 1. Symlink: current/* ──► live/${DOMAIN}/* (Real Let's Encrypt cert)        │
│ 2. /etc/nginx/runtime/tls-mode.conf:                                        │
│    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";│
│ 3. /etc/nginx/runtime/port80-mode.conf: return 301 https://$host$request_uri│
│ 4. Kiểm tra cấu hình và reload: nginx -t && nginx -s reload (Zero downtime) │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.4. Script Entrypoint Nginx (`deploy/nginx/entrypoint.sh`)

```bash
#!/bin/sh
set -e

DOMAIN="${DOMAIN:-localhost}"
CERT_DIR="/etc/nginx/ssl"
DUMMY_DIR="${CERT_DIR}/dummy"
LIVE_DIR="${CERT_DIR}/live/${DOMAIN}"
CURRENT_DIR="${CERT_DIR}/current"
RUNTIME_DIR="/etc/nginx/runtime"

mkdir -p "${DUMMY_DIR}" "${CURRENT_DIR}" "${RUNTIME_DIR}"

# 1. Sinh chứng chỉ Bootstrap nếu chưa có
if [ ! -f "${DUMMY_DIR}/cert.pem" ] || [ ! -f "${DUMMY_DIR}/key.pem" ]; then
  echo "[Nginx Entrypoint] Đang sinh chứng chỉ Self-Signed Bootstrap..."
  openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
    -keyout "${DUMMY_DIR}/key.pem" \
    -out "${DUMMY_DIR}/cert.pem" \
    -subj "/CN=${DOMAIN}"
fi

# 2. Thiết lập trạng thái ban đầu dựa trên sự tồn tại của cert thật
if [ -f "${LIVE_DIR}/fullchain.pem" ] && [ -f "${LIVE_DIR}/privkey.pem" ]; then
  echo "[Nginx Entrypoint] Kích hoạt PRODUCTION TLS State cho domain: ${DOMAIN}."
  ln -sfn "${LIVE_DIR}/fullchain.pem" "${CURRENT_DIR}/fullchain.pem"
  ln -sfn "${LIVE_DIR}/privkey.pem" "${CURRENT_DIR}/privkey.pem"

  cat << 'EOF' > "${RUNTIME_DIR}/tls-mode.conf"
# PRODUCTION MODE: HSTS enabled
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
EOF

  cat << 'EOF' > "${RUNTIME_DIR}/port80-mode.conf"
# PRODUCTION MODE: Redirect all HTTP to HTTPS
location / {
    return 301 https://$host$request_uri;
}
EOF

else
  echo "[Nginx Entrypoint] Kích hoạt BOOTSTRAP TLS State (Self-signed, No HSTS)."
  ln -sfn "${DUMMY_DIR}/cert.pem" "${CURRENT_DIR}/fullchain.pem"
  ln -sfn "${DUMMY_DIR}/key.pem" "${CURRENT_DIR}/privkey.pem"

  cat << 'EOF' > "${RUNTIME_DIR}/tls-mode.conf"
# BOOTSTRAP MODE: HSTS is disabled to prevent browser pinning
EOF

  cat << 'EOF' > "${RUNTIME_DIR}/port80-mode.conf"
# BOOTSTRAP MODE: Allow direct HTTP proxy during setup
location / {
    proxy_pass http://api_backend;
}
EOF
fi

# 3. Test config trước khi chạy daemon
nginx -t

exec nginx -g "daemon off;"
```

---

## 5. CẤU TRÚC FILE COMPOSE (`deploy/docker-compose.yml`)

```yaml
version: '3.8'

services:
  # 1. Nginx Reverse Proxy & TLS Ingress (Custom image pin 1.27.4 kèm OpenSSL)
  nginx:
    build:
      context: ./nginx
      dockerfile: Dockerfile
    container_name: omninovel-prod-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      - DOMAIN=${DOMAIN:-localhost}
    volumes:
      - certbot_acme_data:/var/www/certbot:ro
      - nginx_ssl_certs:/etc/nginx/ssl
      - nginx_runtime_config:/etc/nginx/runtime
    networks:
      - omninovel-edge
    depends_on:
      api:
        condition: service_started

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
      : "$${REDIS_PASSWORD:?ERROR: REDIS_PASSWORD is required and cannot be empty}"
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
  nginx_runtime_config:
    name: omninovel_nginx_runtime_config
```

---

## 6. QUY TRÌNH VẬN HÀNH MIGRATION & DEPLOYMENT (EXPLICIT RELEASE)

Nhằm ngăn ngừa rủi ro tranh chấp lock hoặc tự ý thay đổi CSDL khi container restart ngoài ý muốn, **tuyệt đối không chạy tự động TypeORM migrations trong entrypoint của `api`**.

### Quy Trình Deploy Chuẩn 4 Bước (Chạy Tại Repository Root)

```bash
# Bước 1: Build images từ clean checkout
docker compose --env-file .env -f deploy/docker-compose.yml build

# Bước 2: Thực thi Database Migration độc lập (Explicit Migration Gate)
docker compose --env-file .env -f deploy/docker-compose.yml run --rm api npm run migration:run:prod

# Bước 3: Khởi động cụm containers
docker compose --env-file .env -f deploy/docker-compose.yml up -d

# Bước 4: Kiểm tra trạng thái sức khỏe
docker compose --env-file .env -f deploy/docker-compose.yml ps
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
| **G01** | `Compose Config Valid` | `docker compose --env-file .env -f deploy/docker-compose.yml config` hợp lệ, cú pháp chuẩn, không hardcode credentials trong file. | `docker compose config` |
| **G02** | `Clean Multi-Stage Build & Migration Proof` | Build thành công cả 2 Dockerfile từ clean checkout (root lockfile). Lệnh `run --rm api npm run migration:run:prod` chạy thành công và báo không còn pending migration trên Supabase. | `docker compose build` & `run --rm api npm run migration:run:prod` |
| **G03** | `Strict Port Isolation` | Chỉ duy nhất host ports `80` và `443` mở. Các cổng `8000`, `8001`, `6379` hoàn toàn không lắng nghe trên host interface. | `netstat -tuln` / `Test-NetConnection` |
| **G04** | `Nginx API Health Pass` | `GET http://localhost/health/live` và `/health/ready` qua Nginx trả về `HTTP 200` và JSON `{"status": "UP"}`. | `curl -i http://localhost/health/ready` |
| **G05** | `API ↔ Redis Pass & Guard` | API kết nối thành công tới Redis có mật khẩu qua `omninovel-internal`. Healthcheck ready báo `redis: UP`. Nếu `REDIS_PASSWORD` rỗng ở production, Redis fail-fast không start. | Kiểm tra log API & `/health/ready` |
| **G06** | `API ↔ AI Worker Authenticated RPC & Egress` | API gửi RPC tới AI Worker qua `omninovel-internal` với `x-internal-key` thành công. Gọi không có key bị trả về `401/403`. AI Worker thực hiện tải thành công presigned URL từ R2 qua `omninovel-egress`. | Integration script |
| **G07** | `API ↔ Supabase Connection Pass` | API kết nối thành công tới Supabase PostgreSQL qua `omninovel-egress`. Healthcheck ready báo `database: UP`. | Kiểm tra log API & `/health/ready` |
| **G08** | `API ↔ R2 Signed Storage Pass` | API gọi R2 cấp Presigned URL thành công. | Endpoint upload media smoke |
| **G09** | `WebSocket Socket.IO /ws/ai Upgrade Pass` | Client `socket.io-client` kết nối tới path `/socket.io/` tại namespace `/ws/ai` qua Nginx, nhận handshake và trao đổi event thành công. | Node.js Socket.IO acceptance runner |
| **G10** | `Rate Limiting & Throttling Pass` | Gửi request liên tục vượt 30 req/s vào API hoặc 5 req/s vào auth endpoints bị Nginx chặn với mã `429 Too Many Requests`. | Kịch bản bắn tải wrk / ab / curl loop |
| **G11** | `TLS Bootstrap & Atomic Transition` | Nginx boot thành công với self-signed cert (không có HSTS). Chuyển sang cert thật và reload cập nhật đồng bộ cả cert, HSTS và port 80 redirect không gián đoạn dịch vụ. | Kiểm tra TLS handshake & reload |
| **G12** | `Auto-Recovery, Cache Persistence & DNS Re-resolve` | Thực thi `docker compose --env-file .env -f deploy/docker-compose.yml up -d --force-recreate ai-worker`: model cache trong named volume `omninovel_ai_model_cache` vẫn nguyên vẹn. Recreate `api`: Nginx tự động phân giải lại IP mới qua `upstream ... resolve` mà không bị lỗi 502. | `docker compose up -d --force-recreate` |
| **G13** | `Non-Root Container Hardening` | Container `api` chạy dưới user `node` (UID 1000); container `ai-worker` chạy dưới `appuser` (UID 10001). | `docker compose exec ... id` |
| **G14** | `Secret Hygiene in Logs` | Logs của toàn bộ 4 container tuyệt đối không in ra DB password, R2 secret access key, hoặc JWT secrets. | `docker compose logs` regex scan |

---

## 8. THỨ TỰ THI CÔNG TRONG IMPLEMENTATION PLAN

Kế hoạch triển khai (Implementation Plan) sẽ bắt đầu bằng:
1. **Task 1 (Spike & Build Proof):** Xây dựng `services/api/Dockerfile` trên root context + root `package-lock.json`, bổ sung `migration:run:prod` và `env.validation.ts` Redis guard, chứng minh layout `node_modules/@omninovel/shared` và kiểm tra lệnh `npm run migration:run:prod` chạy thành công.
2. **Task 2 (AI Worker Image):** Tách `requirements-prod-cpu.txt`, sửa `config.py` với `os.environ.setdefault`, xây dựng `services/ai-worker/Dockerfile` non-root.
3. **Task 3 (Nginx Image, Dynamic Upstream & TLS State Machine):** Tạo `deploy/nginx/Dockerfile` (Nginx 1.27.4-alpine + OpenSSL), viết `entrypoint.sh` (quản lý symlink, `tls-mode.conf`, `port80-mode.conf`), cấu hình `nginx.conf` và `omninovel.conf` (Dynamic Upstream Resolve `zone api_backend 64k`, rate limit, WebSocket `/socket.io`).
4. **Task 4 (Compose Integration):** Tạo `deploy/docker-compose.yml` với 3-network topology, container-side expansion và Redis password guard.
5. **Task 5 (Acceptance Verification):** Thực thi toàn bộ 14 Acceptance Gates (từ G01 đến G14) kèm bằng chứng kiểm thử thực tế.

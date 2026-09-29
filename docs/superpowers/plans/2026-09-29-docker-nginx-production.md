# Kế Hoạch Triển Khai: Hạ Tầng Production Docker Compose & Nginx (Phase 6.2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây dựng, đóng gói và nghiệm thu hoàn chỉnh cụm hạ tầng Production VPS gồm 4 containers (`nginx`, `api`, `ai-worker`, `redis`) theo kiến trúc 3-Network Topology, Dynamic Upstream DNS, TLS State Machine và Multi-stage Builds monorepo, đạt toàn bộ 14 Acceptance Gates.

**Architecture:** Mạng phân vùng 3 lớp (`omninovel-edge` chỉ mở cổng 80/443 qua Nginx; `omninovel-internal` có `internal: true` cho RPC nội bộ và Redis; `omninovel-egress` cho phép API và AI Worker kết nối ra Supabase Managed Postgres và Cloudflare R2 bên ngoài VPS). Nginx khởi động độc lập (`service_started`), hỗ trợ Dynamic Upstream DNS (`zone api_backend 64k; server api:8000 resolve;`), rate-limit trả về mã lỗi 429 và máy trạng thái TLS 2 chế độ (Bootstrap vs Production) qua atomic symlinks và runtime config.

**Tech Stack:** Docker, Docker Compose, Nginx 1.30.5-alpine (với OpenSSL), Node.js 20 Alpine (NestJS 10, TypeORM, BullMQ), Python 3.11-slim (FastAPI, PyTorch CPU, manga-ocr), Redis 7 Alpine.

## Global Constraints

- **Execution Working Directory SSoT:** Toàn bộ lệnh Docker Compose phải chạy từ Repository Root: `docker compose --env-file .env -f deploy/docker-compose.yml <command>`.
- **Zero Host Exposure Cho Backend:** Chỉ duy nhất container `nginx` publish cổng host `80:80` và `443:443`. Các cổng `8000`, `8001`, `6379` tuyệt đối không được mở ra host.
- **External Data SSoT:** Supabase PostgreSQL và Cloudflare R2 nằm hoàn toàn ngoài VPS; không tạo container Postgres hay MinIO trong production compose.
- **Monorepo Build SSoT:** Build API từ ngữ cảnh repository root (`context: ..`) sử dụng root `package-lock.json` duy nhất; runner không copy `services/api/node_modules` cục bộ.
- **Explicit Isolated Migration:** Database migration production chạy độc lập qua `docker compose --env-file .env -f deploy/docker-compose.yml run --rm --no-deps api npm run migration:run:prod`. Không chạy auto-migration khi container API khởi động.
- **Nginx Ingress Independence:** Nginx không khai báo `depends_on: api` để đảm bảo cổng 80 ACME challenge luôn hoạt động độc lập.

---

### Task 1: API Monorepo Multi-Stage Dockerfile, Production Migration Script & Build Spike

**Files:**
- Create: `services/api/Dockerfile`
- Modify: `services/api/package.json:14-25`
- Modify: `services/api/src/config/env.validation.ts:62-78`

**Interfaces:**
- Consumes: Root `package.json`, root `package-lock.json`, `packages/shared`, `services/api/src/database/data-source.ts`.
- Produces: Docker image `omninovel-api:test`, script `npm run migration:run:prod` biên dịch và thực thi migrations từ `dist/database/data-source.js`, fail-fast validation khi thiếu `REDIS_PASSWORD` ở production.

- [x] **Step 1: Bổ sung script migration production trong `services/api/package.json`**

Thêm script `"migration:run:prod": "typeorm migration:run -d dist/database/data-source.js"` vào `scripts` của [services/api/package.json](file:///e:/Workspace%202/Doctruyen_project/services/api/package.json):

```json
    "start:prod": "node dist/main",
    "migration:run:prod": "typeorm migration:run -d dist/database/data-source.js",
    "typeorm": "typeorm-ts-node-commonjs",
```

- [x] **Step 2: Thêm Production Fail-Fast Guard cho `REDIS_PASSWORD` trong `env.validation.ts`**

Trong [services/api/src/config/env.validation.ts](file:///e:/Workspace%202/Doctruyen_project/services/api/src/config/env.validation.ts), bổ sung kiểm tra bắt buộc `REDIS_PASSWORD` không được rỗng khi `NODE_ENV === 'production'`:

```typescript
      if (data.NODE_ENV === 'production') {
        const isDefaultJwt = data.JWT_SECRET.includes('super_secret');
        const isDefaultRefresh = data.JWT_REFRESH_SECRET.includes('super_secret');
        const isDefaultAiSecret = data.AI_WORKER_SECRET.includes('internal_ai_worker_secret');
        const isMissingRedisPassword = !data.REDIS_PASSWORD || data.REDIS_PASSWORD.trim().length === 0;

        if (isDefaultJwt || isDefaultRefresh || isDefaultAiSecret || isMissingRedisPassword) {
          return false;
        }
      }
```
Và thông báo lỗi rõ ràng:
```typescript
      message:
        'CẢNH BÁO AN NINH: Không được phép sử dụng JWT_SECRET, JWT_REFRESH_SECRET, AI_WORKER_SECRET mặc định hoặc để trống REDIS_PASSWORD trên môi trường Production.',
```

- [x] **Step 3: Tạo `services/api/Dockerfile` với Monorepo Root Context**

Tạo file [services/api/Dockerfile](file:///e:/Workspace%202/Doctruyen_project/services/api/Dockerfile):

```dockerfile
# ==========================================
# STAGE 1: Monorepo Workspace Builder
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/api/package.json ./services/api/

RUN npm ci --workspace=@omninovel/shared --workspace=@omninovel/api --include-workspace-root

COPY packages/shared ./packages/shared
COPY services/api ./services/api

RUN npm run build --workspace=@omninovel/shared
RUN npm run build --workspace=@omninovel/api

RUN npm prune --omit=dev --workspace=@omninovel/shared --workspace=@omninovel/api

# ==========================================
# STAGE 2: Production Runner
# ==========================================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8000

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json

COPY --from=builder /app/services/api/dist ./services/api/dist
COPY --from=builder /app/services/api/package.json ./services/api/package.json

WORKDIR /app/services/api

USER node

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8000/health/live || exit 1

EXPOSE 8000

CMD ["node", "dist/main"]
```

- [x] **Step 4: Chạy Build Spike xác minh Image API Monorepo**

Chạy từ thư mục gốc repository:
```bash
docker build -f services/api/Dockerfile -t omninovel-api:test .
```
Kỳ vọng: Build thành công qua cả 2 stages mà không gặp lỗi thiếu lockfile hay thiếu thư mục node_modules.

- [x] **Step 5: Kiểm tra Runtime Boot & Migration Spike trên Container Test**

Chạy container test kiểm tra lệnh node dist/main khởi động:
```bash
docker run --rm -e NODE_ENV=production -e JWT_SECRET=prod_secret_123456789 -e JWT_REFRESH_SECRET=prod_refresh_secret_123456789 -e AI_WORKER_SECRET=prod_ai_secret_123456789 -e REDIS_PASSWORD=prod_redis_pass_123 omninovel-api:test node -e "console.log('API Runner Node.js Boot OK')"
```
Kiểm tra cú pháp của lệnh migration production:
```bash
docker run --rm omninovel-api:test npm run migration:run:prod -- --help
```
Kỳ vọng: Lệnh typeorm CLI phản hồi `typeorm migration:run` thành công, chứng minh `dist/database/data-source.js` tồn tại và chạy tốt.

- [x] **Step 6: Commit**

```bash
git add services/api/package.json services/api/src/config/env.validation.ts services/api/Dockerfile
git commit -m "feat(api): implement monorepo multi-stage Dockerfile and production migration script"
git push origin main
```

---

### Task 2: AI Worker CPU Production Image, Dependencies & Cache Path

**Files:**
- Create: `services/ai-worker/requirements-prod-cpu.txt`
- Modify: `services/ai-worker/requirements-ci-cpu.txt`
- Modify: `services/ai-worker/app/core/config.py:6-17`
- Create: `services/ai-worker/Dockerfile`

**Interfaces:**
- Consumes: `services/ai-worker/app`, `services/ai-worker/main.py`.
- Produces: Docker image `omninovel-ai-worker:test`, CPU PyTorch inference không chứa pytest, `os.environ.setdefault` cho cache model volume.

- [x] **Step 1: Tạo `services/ai-worker/requirements-prod-cpu.txt`**

Tạo file [services/ai-worker/requirements-prod-cpu.txt](file:///e:/Workspace%202/Doctruyen_project/services/ai-worker/requirements-prod-cpu.txt):

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

- [x] **Step 2: Cập nhật `services/ai-worker/requirements-ci-cpu.txt`**

Cập nhật [services/ai-worker/requirements-ci-cpu.txt](file:///e:/Workspace%202/Doctruyen_project/services/ai-worker/requirements-ci-cpu.txt) kế thừa từ file production:

```text
-r requirements-prod-cpu.txt
pytest>=8.0.0,<9.0.0
pytest-asyncio>=0.23.0,<0.26.0
```

- [x] **Step 3: Cập nhật `services/ai-worker/app/core/config.py` dùng `os.environ.setdefault`**

Sửa đổi đoạn cấu hình cache trong [services/ai-worker/app/core/config.py](file:///e:/Workspace%202/Doctruyen_project/services/ai-worker/app/core/config.py):

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

- [x] **Step 4: Tạo `services/ai-worker/Dockerfile` CPU Non-Root**

Tạo file [services/ai-worker/Dockerfile](file:///e:/Workspace%202/Doctruyen_project/services/ai-worker/Dockerfile):

```dockerfile
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

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 10001 appuser && \
    useradd -u 10001 -g appuser -m -s /bin/bash appuser

COPY services/ai-worker/requirements-prod-cpu.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/ai-worker/app ./app
COPY services/ai-worker/main.py ./main.py

RUN mkdir -p /home/appuser/.cache/huggingface /home/appuser/.cache/torch && \
    chown -R appuser:appuser /home/appuser /app

USER appuser

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://127.0.0.1:8001/internal/v1/jobs/health || exit 1

EXPOSE 8001

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
```

- [x] **Step 5: Chạy Build Test Image AI Worker**

Chạy từ thư mục gốc repository:
```bash
docker build -f services/ai-worker/Dockerfile -t omninovel-ai-worker:test .
```
Kỳ vọng: Image build thành công, cài đặt đúng Torch CPU wheel và cấu hình `appuser` non-root.

- [x] **Step 6: Chạy thử Container và Kiểm tra Healthcheck**

```bash
docker run --rm -d --name test-ai-worker -e AI_WORKER_SECRET=test_secret omninovel-ai-worker:test
docker exec test-ai-worker curl -f http://127.0.0.1:8001/internal/v1/jobs/health
docker stop test-ai-worker
```
Kỳ vọng: Trả về JSON `{"status": "healthy", "service": "omninovel-ai-worker"}`.

- [x] **Step 7: Commit**

```bash
git add services/ai-worker/requirements-prod-cpu.txt services/ai-worker/requirements-ci-cpu.txt services/ai-worker/app/core/config.py services/ai-worker/Dockerfile
git commit -m "feat(ai-worker): add CPU production requirements, setdefault cache and Dockerfile"
git push origin main
```

---

### Task 3: Nginx Custom Image, Dynamic Upstream, Rate Limiting & TLS State Machine

**Files:**
- Create: `deploy/nginx/Dockerfile`
- Create: `deploy/nginx/nginx.conf`
- Create: `deploy/nginx/conf.d/omninovel.conf`
- Create: `deploy/nginx/entrypoint.sh`
- Create: `deploy/nginx/activate-production-tls.sh`

**Interfaces:**
- Consumes: Nginx 1.30.5-alpine, OpenSSL CLI.
- Produces: Custom Nginx image `omninovel-nginx`, dynamic upstream resolve `zone api_backend 64k; server api:8000 resolve;`, rate limit status 429, runtime TLS state coordination.

- [ ] **Step 1: Tạo `deploy/nginx/Dockerfile`**

Tạo file [deploy/nginx/Dockerfile](file:///e:/Workspace%202/Doctruyen_project/deploy/nginx/Dockerfile):

```dockerfile
FROM nginx:1.30.5-alpine

RUN apk add --no-cache openssl

COPY nginx.conf /etc/nginx/nginx.conf
COPY conf.d/ /etc/nginx/conf.d/
COPY entrypoint.sh /entrypoint.sh
COPY activate-production-tls.sh /activate-production-tls.sh

RUN chmod +x /entrypoint.sh /activate-production-tls.sh

ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
```

- [ ] **Step 2: Tạo `deploy/nginx/nginx.conf`**

Tạo file [deploy/nginx/nginx.conf](file:///e:/Workspace%202/Doctruyen_project/deploy/nginx/nginx.conf) với đầy đủ `limit_req_zone` và `limit_req_status 429`:

```nginx
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    access_log /var/log/nginx/access.log main;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json application/javascript application/rss+xml application/atom+xml image/svg+xml;

    limit_req_zone $binary_remote_addr zone=api_general_limit:10m rate=30r/s;
    limit_req_zone $binary_remote_addr zone=auth_limit:10m rate=5r/s;
    limit_req_status 429;

    include /etc/nginx/conf.d/*.conf;
}
```

- [ ] **Step 3: Tạo `deploy/nginx/conf.d/omninovel.conf`**

Tạo file [deploy/nginx/conf.d/omninovel.conf](file:///e:/Workspace%202/Doctruyen_project/deploy/nginx/conf.d/omninovel.conf) với Dynamic DNS Upstream và các proxy locations:

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

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    include /etc/nginx/runtime/port80-mode.conf;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name _;

    ssl_certificate /etc/nginx/ssl/current/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/current/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384";

    include /etc/nginx/runtime/tls-mode.conf;

    limit_req zone=api_general_limit burst=20 nodelay;

    location /api/v1/ {
        proxy_pass http://api_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/v1/auth/ {
        limit_req zone=auth_limit burst=5 nodelay;
        proxy_pass http://api_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /socket.io/ {
        proxy_pass http://api_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location = /health/live {
        proxy_pass http://api_backend;
    }

    location = /health/ready {
        proxy_pass http://api_backend;
    }

    location /internal/ {
        return 403;
    }
}
```

- [ ] **Step 4: Tạo `deploy/nginx/entrypoint.sh`**

Tạo file [deploy/nginx/entrypoint.sh](file:///e:/Workspace%202/Doctruyen_project/deploy/nginx/entrypoint.sh):

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

if [ ! -f "${DUMMY_DIR}/cert.pem" ] || [ ! -f "${DUMMY_DIR}/key.pem" ]; then
  echo "[Nginx Entrypoint] Đang sinh chứng chỉ Self-Signed Bootstrap..."
  openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
    -keyout "${DUMMY_DIR}/key.pem" \
    -out "${DUMMY_DIR}/cert.pem" \
    -subj "/CN=${DOMAIN}"
fi

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

nginx -t

exec nginx -g "daemon off;"
```

- [ ] **Step 5: Tạo `deploy/nginx/activate-production-tls.sh`**

Tạo file [deploy/nginx/activate-production-tls.sh](file:///e:/Workspace%202/Doctruyen_project/deploy/nginx/activate-production-tls.sh):

```bash
#!/bin/sh
set -e

DOMAIN="${DOMAIN:-localhost}"
CERT_DIR="/etc/nginx/ssl"
LIVE_DIR="${CERT_DIR}/live/${DOMAIN}"
CURRENT_DIR="${CERT_DIR}/current"
RUNTIME_DIR="/etc/nginx/runtime"

if [ ! -f "${LIVE_DIR}/fullchain.pem" ] || [ ! -f "${LIVE_DIR}/privkey.pem" ]; then
  echo "ERROR: Không tìm thấy chứng chỉ Let's Encrypt tại ${LIVE_DIR}"
  exit 1
fi

echo "Đang kích hoạt chứng chỉ Production Let's Encrypt cho domain: ${DOMAIN}..."

ln -sfn "${LIVE_DIR}/fullchain.pem" "${CURRENT_DIR}/fullchain.pem"
ln -sfn "${LIVE_DIR}/privkey.pem" "${CURRENT_DIR}/privkey.pem"

cat << 'EOF' > "${RUNTIME_DIR}/tls-mode.conf"
# PRODUCTION MODE: HSTS enabled
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
EOF

cat << 'EOF' > "${RUNTIME_DIR}/port80-mode.conf"
# PRODUCTION MODE: Redirect all HTTP to HTTPS (trừ ACME challenge)
location / {
    return 301 https://$host$request_uri;
}
EOF

nginx -t
nginx -s reload

echo "Kích hoạt Production TLS thành công không gián đoạn dịch vụ!"
```

- [ ] **Step 6: Build và Kiểm tra Syntax Image Nginx**

Chạy từ thư mục gốc repository:
```bash
docker build -t omninovel-nginx:test deploy/nginx
docker run --rm omninovel-nginx:test nginx -v
```
Kỳ vọng: Nginx phiên bản 1.30.5 được hiển thị và OpenSSL có sẵn trong container.

- [ ] **Step 7: Commit**

```bash
git add deploy/nginx/Dockerfile deploy/nginx/nginx.conf deploy/nginx/conf.d/omninovel.conf deploy/nginx/entrypoint.sh deploy/nginx/activate-production-tls.sh
git commit -m "feat(deploy): implement custom Nginx image with OpenSSL, dynamic DNS, rate limiting and TLS state machine"
git push origin main
```

---

### Task 4: Production Docker Compose Integration (3-Network Topology, Redis Guard & Ingress Independence)

**Files:**
- Create: `deploy/docker-compose.yml`

**Interfaces:**
- Consumes: Images từ Task 1, 2, 3; `.env` file; 3 mạng Docker; 4 named volumes cố định.
- Produces: Production stack hoàn chỉnh, lệnh config `--quiet` hợp lệ không lộ credentials, Redis guard chống mật khẩu rỗng.

- [ ] **Step 1: Tạo `deploy/docker-compose.yml`**

Tạo file [deploy/docker-compose.yml](file:///e:/Workspace%202/Doctruyen_project/deploy/docker-compose.yml):

```yaml
version: '3.8'

services:
  # 1. Nginx Reverse Proxy & TLS Ingress (Khởi động hoàn toàn độc lập, không depends_on api)
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

- [ ] **Step 2: Chạy kiểm tra cú pháp Compose bằng lệnh Secret-Safe**

Chạy từ thư mục gốc repository:
```bash
docker compose --env-file .env -f deploy/docker-compose.yml config --quiet
```
Kỳ vọng: Lệnh thoát với exit code `0`, không có output lỗi và không in credentials ra terminal.

- [ ] **Step 3: Commit**

```bash
git add deploy/docker-compose.yml
git commit -m "feat(deploy): implement production docker-compose.yml with 3-network topology and independent Nginx"
git push origin main
```

---

### Task 5: 14 Acceptance Gates Verification & Final Sign-Off

**Files:**
- Create: `deploy/test-acceptance-phase6-2.ts`
- Modify: `plans/phases/phase_06_devops_final.md`

**Interfaces:**
- Consumes: Production Docker Compose stack, curl, socket.io-client.
- Produces: Bằng chứng kiểm thử tự động toàn diện G01 -> G14, cập nhật trạng thái Phase 6.2 hoàn thành.

- [ ] **Step 1: Viết Script Runner Nghiệm Thu `deploy/test-acceptance-phase6-2.ts`**

Tạo runner kiểm tra tự động các gates quan trọng (G01 config, G03 port isolation, G04 Nginx API health, G05 Redis connection, G09 WebSocket Socket.IO `/ws/ai` namespace, G10 Rate Limit 429, G12 Container recreation & DNS re-resolve).

- [ ] **Step 2: Thực thi Build & Chạy Migration Độc Lập (G02 Proof)**

```bash
docker compose --env-file .env -f deploy/docker-compose.yml build
docker compose --env-file .env -f deploy/docker-compose.yml run --rm --no-deps api npm run migration:run:prod
```
Kỳ vọng: Toàn bộ container build thành công; migration báo không còn migration nào đang pending.

- [ ] **Step 3: Khởi động Stack và Kiểm tra Port Isolation (G03)**

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d
docker compose --env-file .env -f deploy/docker-compose.yml ps
```
Kỳ vọng: Cả 4 container healthy. Chỉ có Nginx publish cổng host 80 và 443. Các cổng 8000, 8001, 6379 không xuất hiện trong cột PORTS dạng `0.0.0.0:*`.

- [ ] **Step 4: Chạy Acceptance Tests (G04 - G14)**

Thực thi runner kiểm tra:
- G04: Probe HTTP và HTTPS liveness/readiness endpoint.
- G09: Socket.IO client kết nối vào `/ws/ai` qua transport path `/socket.io/` nhận handshake thành công.
- G10: Gửi 35 requests liên tục kiểm tra Nginx trả về mã lỗi 429.
- G12: Chạy `docker compose --env-file .env -f deploy/docker-compose.yml up -d --force-recreate ai-worker` và recreate `api` xác nhận model cache volume giữ nguyên và Nginx re-resolve IP mới thành công.

- [ ] **Step 5: Dọn dẹp test environment và cập nhật tài liệu Phase 6.2**

Cập nhật [plans/phases/phase_06_devops_final.md](file:///e:/Workspace%202/Doctruyen_project/plans/phases/phase_06_devops_final.md): Đánh dấu Phase 6.2 hoàn thành với toàn bộ 14 tiêu chí nghiệm thu PASS.

- [ ] **Step 6: Commit & Push Final Evidence**

```bash
git add deploy/test-acceptance-phase6-2.ts plans/phases/phase_06_devops_final.md
git commit -m "chore(phase6.2): complete production Docker & Nginx acceptance verification"
git push origin main
```

# Đặc Tả Kỹ Thuật: Hạ Tầng Production Docker Compose & Nginx (Phase 6.2)

- **Trạng thái:** DRAFT / PENDING USER APPROVAL
- **Ngày lập:** 2026-09-29
- **Tác giả:** Antigravity Engineering
- **Quyết định kiến trúc (ADR Phase 6.2):** 3-Network Production Topology + Root-Context Multi-stage Builds + CPU-Only AI Worker + Nginx Ingress Duy Nhất + Internal Redis/AI Services + Egress Cho Supabase/R2 + Fail-Safe ACME/TLS Bootstrap. Không chạy tự động DB migration khi ứng dụng khởi động.

---

## 1. TỔNG QUAN & BỐI CẢNH (EXECUTIVE SUMMARY)

Phase 6.1 đã nghiệm thu đóng băng (`CLOSED / FROZEN CLEAN`) tầng lưu trữ Cloudflare R2 với bằng chứng toán học zero-leak và vệ sinh bảo mật thông tin đăng nhập. Bước tiếp theo — **Phase 6.2** — hoàn thiện tầng triển khai Production trên máy chủ VPS Linux thông qua cụm 4 container cốt lõi:
1. `nginx`: Ingress gateway duy nhất, đón nhận và phân luồng traffic Internet, quản lý SSL/TLS và rate limiting.
2. `api`: NestJS Core Backend API, phục vụ nghiệp vụ, xác thực JWT, kết nối Supabase Postgres và điều phối hàng đợi BullMQ.
3. `ai-worker`: Python FastAPI AI Translation Engine, chạy suy luận CPU (manga-ocr), tải và xử lý media từ R2.
4. `redis`: Bộ nhớ đệm (Cache) và quản lý hàng đợi tác vụ dịch thuật (BullMQ).

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

### 2.3. Xác Thực Nội Bộ (Defense-in-Depth)

- `api` ↔ `redis`: Cấu hình Redis `--protected-mode yes` và yêu cầu xác thực bằng `--requirepass ${REDIS_PASSWORD}`.
- `api` ↔ `ai-worker`: Mọi HTTP call nội bộ sang AI Worker bắt buộc đính kèm header `x-internal-key: ${AI_WORKER_SECRET}`. Fail-fast ngay lập tức nếu secret là giá trị mặc định khi `NODE_ENV=production`.

---

## 3. THIẾT KẾ DOCKERFILE (MONOREPO MULTI-STAGE BUILDS)

### 3.1. Backend API (`services/api/Dockerfile`)

Do `@omninovel/api` phụ thuộc cục bộ vào thư viện monorepo (`@omninovel/shared = file:../../packages/shared`), Docker build context bắt buộc đặt tại thư mục gốc repository (`.`).

```dockerfile
# ==========================================
# STAGE 1: Builder (Biên dịch TypeScript)
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /app

# Cài đặt build tools cần thiết cho native modules (argon2)
RUN apk add --no-cache python3 make g++

# 1. Copy root package files
COPY package*.json pnpm-workspace.yaml* ./

# 2. Copy và build package shared trước
COPY packages/shared ./packages/shared
RUN cd packages/shared && npm ci && npm run build

# 3. Copy và build core API
COPY services/api ./services/api
RUN cd services/api && npm ci && npm run build

# 4. Cắt tỉa devDependencies chỉ giữ production dependencies
RUN cd services/api && npm prune --omit=dev

# ==========================================
# STAGE 2: Production Runner
# ==========================================
FROM node:20-alpine AS runner

WORKDIR /app/services/api

ENV NODE_ENV=production \
    PORT=8000

# Copy compiled shared package
COPY --from=builder /app/packages/shared/dist /app/packages/shared/dist
COPY --from=builder /app/packages/shared/package.json /app/packages/shared/package.json

# Copy compiled API dist và production node_modules
COPY --from=builder /app/services/api/dist ./dist
COPY --from=builder /app/services/api/node_modules ./node_modules
COPY --from=builder /app/services/api/package.json ./package.json

# Chạy dưới user không đặc quyền (Security Hardening)
USER node

# Healthcheck nội bộ
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8000/health/live || exit 1

EXPOSE 8000

CMD ["node", "dist/main"]
```

### 3.2. Script Production Migration (`services/api/package.json`)

Để lệnh migration tương thích hoàn toàn với image runner (không có `ts-node` và không có thư mục `src/`), bổ sung script chuyên dụng trong `services/api/package.json`:

```json
"scripts": {
  "migration:run:prod": "typeorm migration:run -d dist/database/data-source.js"
}
```

*Lưu ý:* `typeorm` nằm trong `dependencies` thông thường của API, do đó tồn tại sẵn trong `node_modules` production sau lệnh `npm prune --omit=dev`.

### 3.3. AI Worker (`services/ai-worker/Dockerfile`)

AI Worker chạy trên môi trường CPU, tải model manga-ocr và giữ cache trên volume cố định.

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

# Cài đặt Python dependencies CPU
COPY services/ai-worker/requirements-ci-cpu.txt ./requirements.txt
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

### 3.4. Sửa Đổi Cấu Hình Python Cache (`services/ai-worker/app/core/config.py`)

Để biến môi trường Docker `HF_HOME` và `TORCH_HOME` có hiệu lực và không bị code Python ghi đè về thư mục local, cập nhật `config.py` sử dụng `os.environ.setdefault`:

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

File triển khai Production khóa đúng 4 container chạy dài hạn (long-running services):

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
        condition: service_healthy
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
      - REDIS_PASSWORD=${REDIS_PASSWORD}
      - AI_WORKER_BASE_URL=http://ai-worker:8001
      - AI_WORKER_SECRET=${AI_WORKER_SECRET}
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
      - AI_WORKER_SECRET=${AI_WORKER_SECRET}
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
    command: >
      redis-server
      --appendonly yes
      --protected-mode yes
      --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis_prod_data:/data
    networks:
      - omninovel-internal
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

networks:
  omninovel-edge:
    driver: bridge
  omninovel-internal:
    driver: bridge
    internal: true
  omninovel-egress:
    driver: bridge

volumes:
  redis_prod_data:
  ai_model_cache:
  certbot_acme_data:
  nginx_ssl_certs:
```

---

## 5. THIẾT KẾ NGINX & QUY TRÌNH CHUYỂN ĐỔI TLS (NGINX/TLS LIFECYCLE)

### 5.1. Hai Trạng Thái Chuyển Đổi Chứng Chỉ (Bootstrap ➔ Production)

Để đảm bảo Nginx có thể boot thành công và phục vụ healthcheck ngay cả khi VPS mới dựng chưa trỏ domain DNS, hệ thống thiết kế cơ chế 2 trạng thái:

```text
[TRẠNG THÁI 1: BOOTSTRAP] (Lần đầu khởi động, chưa có chứng chỉ Let's Encrypt)
├── File entrypoint.sh kiểm tra /etc/nginx/ssl/live/fullchain.pem
├── Chưa tồn tại: Tự động sinh self-signed certificate tại /etc/nginx/ssl/dummy/
├── Nginx cấu hình port 443 dùng self-signed cert
├── Port 80 phục vụ ACME challenge tại /.well-known/acme-challenge/
└── TUYỆT ĐỐI KHÔNG BẬT HSTS (Tránh browser bị ghim certificate tự ký lỗi)

                     │
                     │ (Quản trị viên chạy lệnh Certbot lấy cert thật)
                     ▼

[TRẠNG THÁI 2: PRODUCTION] (Đã có chứng chỉ Let's Encrypt hợp lệ)
├── Nginx trỏ ssl_certificate vào /etc/nginx/ssl/live/fullchain.pem
├── Port 80: HTTP 301 Redirect toàn bộ sang HTTPS (trừ /.well-known/acme-challenge/)
├── KÍCH HOẠT HSTS: add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
└── Nginx reload mượt mà: docker compose exec nginx nginx -s reload (Zero downtime)
```

### 5.2. Script Khởi Động Nginx (`deploy/nginx/entrypoint.sh`)

```bash
#!/bin/sh
set -e

CERT_DIR="/etc/nginx/ssl"
DUMMY_DIR="${CERT_DIR}/dummy"
LIVE_CERT="${CERT_DIR}/live/fullchain.pem"
LIVE_KEY="${CERT_DIR}/live/privkey.pem"

mkdir -p "${DUMMY_DIR}"

if [ ! -f "${LIVE_CERT}" ] || [ ! -f "${LIVE_KEY}" ]; then
  echo "[Nginx Entrypoint] Không tìm thấy chứng chỉ Let's Encrypt thật."
  if [ ! -f "${DUMMY_DIR}/cert.pem" ] || [ ! -f "${DUMMY_DIR}/key.pem" ]; then
    echo "[Nginx Entrypoint] Đang sinh chứng chỉ Self-Signed Bootstrap tạm thời..."
    openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
      -keyout "${DUMMY_DIR}/key.pem" \
      -out "${DUMMY_DIR}/cert.pem" \
      -subj "/CN=omninovel-bootstrap"
  fi
fi

exec nginx -g "daemon off;"
```

### 5.3. Cấu Hình Nginx (`deploy/nginx/conf.d/omninovel.conf`)

- **Định tuyến chuẩn giữ nguyên URI:**
  - `location /api/v1/`: Sử dụng `proxy_pass http://api:8000;` để bảo toàn nguyên vẹn URI, không dùng regex rewrite gây phức tạp kiểm toán.
  - Không bật `proxy_cache` cho `/api/v1/` vì API chứa session/auth state; media presigned URLs đi thẳng tới Cloudflare R2.
- **WebSocket Upgrade:**
  - `location /socket.io/`: Cấu hình đầy đủ HTTP/1.1 và `Upgrade / Connection` headers chuyển tiếp sang `http://api:8000;`.
- **Health Monitoring:**
  - `location = /health/live` và `location = /health/ready`: Chuyển tiếp sang `http://api:8000;` phục vụ probe giám sát liveness/readiness.
- **Chặn Cổng & Đường Dẫn Nội Bộ (Security Hardening):**
  - `location /internal/ { return 403; }`: Chặn đứng mọi nỗ lực gọi vào các API nội bộ từ Internet.
- **Rate Limiting:**
  - API thông thường: Giới hạn `30r/s`, burst `20`.
  - Auth nhạy cảm (`/api/v1/auth/`): Giới hạn `5r/s`, burst `5`.

### 5.4. Vận Hành Cấp Chứng Chỉ Certbot (One-Off Operation)

Certbot **không** chạy như một daemon container dài hạn mà là một lệnh release/admin độc lập:

```bash
docker run --rm -it \
  -v omninovel_certbot_acme_data:/var/www/certbot \
  -v omninovel_nginx_ssl_certs:/etc/letsencrypt \
  certbot/certbot certonly --webroot \
  -w /var/www/certbot \
  -d yourdomain.com \
  --email admin@yourdomain.com --agree-tos --no-eff-email
```

Sau khi cert được ghi vào volume, thực hiện lệnh reload Nginx:
```bash
docker compose -f deploy/docker-compose.yml exec nginx nginx -s reload
```

---

## 6. QUY TRÌNH VẬN HÀNH MIGRATION & DEPLOYMENT (EXPLICIT RELEASE)

Nhằm ngăn ngừa rủi ro tranh chấp lock hoặc tự ý thay đổi CSDL khi container restart ngoài ý muốn, **tuyệt đối không chạy tự động TypeORM migrations trong entrypoint của `api`**.

### Quy Trình Deploy Chuẩn 4 Bước

```bash
# Bước 1: Build hoặc Pull images mới nhất
docker compose -f deploy/docker-compose.yml build

# Bước 2: Thực thi Database Migration độc lập (Explicit Migration Gate)
docker compose -f deploy/docker-compose.yml run --rm api npm run migration:run:prod

# Bước 3: Khởi động hoặc cập nhật cụm containers
docker compose -f deploy/docker-compose.yml up -d

# Bước 4: Kiểm tra trạng thái sức khỏe
docker compose -f deploy/docker-compose.yml ps
curl -k https://localhost/health/ready
```

---

## 7. 14 TIÊU CHÍ NGHIỆM THU (ACCEPTANCE GATES)

| STT | Tên Tiêu Chí (Gate) | Điều Kiện Nghiệm Thu Cụ Thể (Pass Criteria) | Phương Pháp Kiểm Tra |
| :---: | :--- | :--- | :--- |
| **G01** | `Compose Config Valid` | `docker compose -f deploy/docker-compose.yml config` hợp lệ, cú pháp chuẩn, không hardcode credentials trong file. | `docker compose config` |
| **G02** | `Clean Multi-Stage Build & Migration` | Build thành công cả 2 Dockerfile từ clean checkout. Lệnh `run --rm api npm run migration:run:prod` chạy thành công trên image production. | `docker compose build` & `run --rm migration:run:prod` |
| **G03** | `Strict Port Isolation` | Chỉ duy nhất host ports `80` và `443` mở. Các cổng `8000`, `8001`, `6379` hoàn toàn không lắng nghe trên host interface. | `netstat` / `Test-NetConnection` |
| **G04** | `Nginx API Health Pass` | `GET http://localhost/health/live` và `/health/ready` qua Nginx trả về `HTTP 200` và JSON `{"status": "UP"}`. | `curl -i http://localhost/health/ready` |
| **G05** | `API ↔ Redis Pass` | API kết nối thành công tới Redis có mật khẩu qua `omninovel-internal`. Healthcheck ready báo `redis: UP`. | Kiểm tra log API & `/health/ready` |
| **G06** | `API ↔ AI Worker Authenticated RPC` | API gửi RPC tới AI Worker qua `omninovel-internal` với `x-internal-key` thành công. Gọi không có key bị trả về `401/403`. AI Worker ra được R2 qua `omninovel-egress`. | Integration script |
| **G07** | `API ↔ Supabase Connection Pass` | API kết nối thành công tới Supabase PostgreSQL qua `omninovel-egress`. Healthcheck ready báo `database: UP`. | Kiểm tra log API & `/health/ready` |
| **G08** | `API ↔ R2 Signed Storage Pass` | API gọi R2 cấp Presigned URL thành công. | Gọi endpoint upload media |
| **G09** | `WebSocket Upgrade Pass` | Nginx reverse proxy thành công kết nối WebSocket Socket.IO `/socket.io/` với status code `101 Switching Protocols`. | Script test wscat / socket.io-client |
| **G10** | `Rate Limiting & Throttling Pass` | Gửi request liên tục vượt 30 req/s vào API hoặc 5 req/s vào auth endpoints bị Nginx chặn với mã `429 Too Many Requests`. | Kịch bản bắn tải wrk / ab / curl loop |
| **G11** | `TLS Bootstrap & Zero Downtime Transition` | Nginx boot thành công với self-signed cert (không có HSTS). Chuyển sang cert thật và reload không gây gián đoạn dịch vụ. | Kiểm tra TLS handshake & reload |
| **G12** | `Auto-Recovery & Cache Persistence` | Reboot hoặc restart containers (`docker compose restart`): stack tự phục hồi trạng thái healthy; model cache trong named volume không bị tải lại. | Kiểm tra `docker compose ps` & log AI Worker |
| **G13** | `Non-Root Container Hardening` | Container `api` chạy dưới user `node` (UID 1000); container `ai-worker` chạy dưới `appuser` (UID 10001). | `docker compose exec ... id` |
| **G14** | `Secret Hygiene in Logs` | Logs của toàn bộ 4 container tuyệt đối không in ra DB password, R2 secret access key, hoặc JWT secrets. | `docker compose logs` regex scan |

---

## 8. BƯỚC TIẾP THEO

Sau khi tài liệu thiết kế này được phê duyệt:
1. Chuyển sang skill `writing-plans` để lập kế hoạch chi tiết từng bước triển khai kỹ thuật (Implementation Plan).
2. Hiện thực hóa các Dockerfile, cấu hình Nginx, docker-compose.yml và các script liên quan.
3. Chạy kiểm thử xác thực toàn diện 14 Acceptance Gates.

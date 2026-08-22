# 🚀 18. Hạ Tầng Triển Khai Docker, CI/CD, Giám Sát & Kế Hoạch Ứng Cứu Sự Cố (DevOps, Observability & DR)

Tài liệu này đặc tả cấu hình triển khai cụm Container theo từng Profile, pipeline CI/CD GitHub Actions, hệ thống giám sát Prometheus/Grafana và kế hoạch sao lưu phục hồi dữ liệu (**Disaster Recovery**).

---

## 1. CÁC HỒ SƠ TRIỂN KHAI HẠ TẦNG (DEPLOYMENT PROFILES)

1. **Local Development Profile:** Chạy đồng bộ **7 Containers** trên máy lập trình viên (bao gồm cả `ai-worker` xử lý giả lập/cục bộ).
2. **Academic Deployment Profile:** Chạy **6 Containers Cốt Lõi** trên VPS Linux (Web, API, Postgres, Redis, MinIO, Nginx), riêng `ai-worker` chạy trên **Máy tính phát triển cục bộ có GPU (hoặc GPU Server rời)** kết nối qua API.
3. **Production Scale Profile:** Cụm Multi-Node High Availability với Load Balancer độc lập và GPU Worker Cluster.

---

## 2. CẤU HÌNH DOCKER COMPOSE MÔI TRƯỜNG PHÁT TRIỂN (LOCAL DEV 7 SERVICES)

```yaml
version: '3.8'

services:
  # 1. Nginx Reverse Proxy & Static Cache
  nginx:
    image: nginx:alpine
    container_name: omninovel-nginx
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./deploy/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - web
      - api
    restart: unless-stopped

  # 2. Web Client (Next.js SSR)
  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    container_name: omninovel-web
    environment:
      - NODE_ENV=production
      - NEXT_PUBLIC_API_URL=/api # Đường dẫn trình duyệt gọi qua Nginx
      - API_INTERNAL_URL=http://api:8000 # Đường dẫn Next.js Server-Side gọi nội bộ
    restart: unless-stopped

  # 3. Core Backend API (NestJS)
  api:
    build:
      context: .
      dockerfile: services/api/Dockerfile
    container_name: omninovel-api
    environment:
      - PORT=8000
      - DB_HOST=postgres
      - DB_PORT=5432
      - DB_USER=${DB_USER}
      - DB_PASSWORD=${DB_PASSWORD}
      - DB_NAME=${DB_NAME}
      - REDIS_HOST=redis
      - MINIO_ENDPOINT=minio
      - MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY}
      - MINIO_SECRET_KEY=${MINIO_SECRET_KEY}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  # 4. AI Translation Worker Engine (Python FastAPI)
  ai-worker:
    build:
      context: .
      dockerfile: services/ai-worker/Dockerfile
    container_name: omninovel-ai-worker
    environment:
      - MINIO_ENDPOINT=minio
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    depends_on:
      - minio
    restart: unless-stopped

  # 5. Database PostgreSQL 16
  postgres:
    image: postgres:16-alpine
    container_name: omninovel-postgres
    environment:
      - POSTGRES_USER=${DB_USER}
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=${DB_NAME}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER} -d ${DB_NAME}"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  # 6. Redis 7 (Cache, Session & Queue)
  redis:
    image: redis:7-alpine
    container_name: omninovel-redis
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  # 7. MinIO Object Storage (S3-Compatible)
  minio:
    image: minio/minio:latest
    container_name: omninovel-minio
    command: server /data --console-address ":9001"
    environment:
      - MINIO_ROOT_USER=${MINIO_ACCESS_KEY}
      - MINIO_ROOT_PASSWORD=${MINIO_SECRET_KEY}
    volumes:
      - minio_data:/data
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
  minio_data:
```

---

## 3. PIPELINE CI/CD TỰ ĐỘNG HÓA (GITHUB ACTIONS)

```
[Push code / PR vào main]
          │
          ▼
[1. Lint & Format Check (ESLint, Prettier, Dart Analyze)]
          │
          ▼
[2. Automated Testing (Unit Tests NestJS + Pytest + Flutter Tests)]
          │
          ▼
[3. Security Scan (Trivy Container Scan & Snyk Dependency Scan)]
          │
          ▼
[4. Build Docker Images & Push to Container Registry]
          │
          ▼
[5. Auto-Deploy qua SSH Webhook tới VPS Staging/Production]
```

---

## 4. GIÁM SÁT HỆ THỐNG & METRICS (OBSERVABILITY BASELINE)

* **Prometheus Metrics Endpoints:**
  * `http_requests_total`: Số lượng request theo mã trạng thái HTTP (2xx, 4xx, 5xx).
  * `http_request_duration_seconds`: Phân bổ thời gian phản hồi (p50, p95, p99).
  * `bullmq_jobs_active` / `bullmq_jobs_failed`: Giám sát sức khỏe hàng đợi AI Worker.
* **Grafana Dashboard:** Hiển thị trực quan CPU/RAM container, số lượng độc giả online đồng thời và tỷ lệ lỗi API theo thời gian thực.

---

## 5. KẾ HOẠCH SAO LƯU & PHỤC HỒI DỮ LIỆU (DISASTER RECOVERY & BACKUP)

### 5.1. Mục Tiêu Phục Hồi Thực Tế Cho Đồ Án (Academic Demo Disaster Recovery):
* **RPO (Recovery Point Objective):** **$\le 24$ giờ** (với kịch bản sao lưu CSDL và MinIO hàng ngày).
* **RTO (Recovery Time Objective):** **$\le 4$ giờ** (khôi phục từ bản dump và khởi động lại container).
* **Kịch bản Sao lưu Kép (Database + MinIO Objects):**
  * Cronjob chạy mỗi ngày lúc 02:00 sáng tự động dump CSDL: `pg_dump -U postgres omninovel_db | gzip > /backups/db_$(date +%F).sql.gz`.
  * Đồng bộ sao lưu kho lưu trữ MinIO qua công cụ mirror: `mc mirror minio/ remote-backup/minio_$(date +%F)/`.

### 5.2. Mục Tiêu Thiết Kế Mở Rộng (Production Target):
* Sử dụng PostgreSQL WAL Archiving / Streaming Replication và S3 Cross-Region Replication hướng tới RPO $\le 1$ giờ và RTO $\le 15$ phút.

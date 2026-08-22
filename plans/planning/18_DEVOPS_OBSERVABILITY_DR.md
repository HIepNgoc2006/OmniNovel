# 🚀 18. Triển Khai DevOps, Cấu Hình 7 Container, Giám Sát & Phục Hồi Thảm Họa (DR)

Tài liệu này đặc tả toàn bộ hạ tầng 7 Container Docker, Nginx Caching Proxy, Prometheus/Grafana Observability và kế hoạch Disaster Recovery (RPO = 24h, RTO = 4h).

---

## 1. CẤU HÌNH DOCKER COMPOSE ĐẦY ĐỦ (7 CONTAINERS)

```yaml
version: '3.8'

services:
  nginx:
    image: nginx:alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./deploy/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./deploy/nginx/cache:/var/cache/nginx
    depends_on: [web, api, minio]

  web:
    build: { context: ./apps/web, dockerfile: Dockerfile }
    ports: ["3000:3000"]
    environment: [NODE_ENV=production]

  api:
    build: { context: ./services/api, dockerfile: Dockerfile }
    ports: ["8000:8000"]
    depends_on: [postgres, redis, minio]

  ai-worker:
    build: { context: ./services/ai-worker, dockerfile: Dockerfile }
    ports: ["8001:8001"]
    depends_on: [redis, minio]

  postgres:
    image: postgres:16-alpine
    environment: [POSTGRES_DB=omninovel_db, POSTGRES_PASSWORD=postgres_secure]
    volumes: [pgdata:/var/lib/postgresql/data]

  redis:
    image: redis:7.0-alpine
    volumes: [redisdata:/data]

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    ports: ["9000:9000", "9001:9001"]
    volumes: [miniodata:/data]

volumes:
  pgdata:
  redisdata:
  miniodata:
```

---

## 2. KẾ HOẠCH PHỤC HỒI THẢM HỌA (DISASTER RECOVERY - DR)
* **RPO (Recovery Point Objective):** **24 giờ** (Mất mát dữ liệu tối đa không quá 24h thông qua Daily Snapshot).
* **RTO (Recovery Time Objective):** **4 giờ** (Hệ thống phục hồi hoàn toàn sau sự cố sập server trong vòng 4h).
* **Offsite Backup:** Dữ liệu backup được mã hóa và đồng bộ tự động sang Cloudflare R2 / AWS S3 riêng biệt ngoài VPS.

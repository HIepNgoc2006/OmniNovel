# Cấu hình Dự án OmniNovel (Đọc truyện Đa phương thức & AI Translation Hub)

## 1. Thông tin chung
- **Tên dự án:** OmniNovel (MangaVerse)
- **Mục tiêu:** Nền tảng Đọc truyện Đa phương thức (Webtoon, Manga, Light Novel / Truyện chữ) tích hợp Studio Dịch truyện tự động bằng AI (OCR, Inpainting, Translation, Glossary).
- **Phục vụ đồ án 5 môn:**
  1. Kỹ năng lập trình nâng cao (Clean Architecture, Worker Queue, Redis Multi-level Caching, Full-Text Search).
  2. Phát triển ứng dụng di động (Flutter / React Native, Webtoon & Light Novel Reader, Offline Caching, AI Action Popup).
  3. Triển khai phần mềm (Docker Compose Multi-Container, Nginx Caching Proxy, CI/CD GitHub Actions).
  4. An toàn thông tin (Anti-Leech Bot, Rate Limiting, File Upload Malware/MIME Scan, RBAC, JWT Rotation).
  5. Quản lý dự án CNTT (Agile/Scrum, WBS, Gantt Chart, Phân tích rủi ro & Chi phí AI/S3).

## 2. Quy chuẩn kiến trúc & Mã nguồn
- **Monorepo Structure:**
  - `apps/web`: Ứng dụng Web Đọc truyện & Studio (Next.js / React).
  - `apps/mobile`: Ứng dụng Di động iOS/Android (Flutter / React Native).
  - `services/api`: Backend Core API (NestJS / Go).
  - `services/ai-worker`: Dịch vụ xử lý ảnh & AI Translation Worker (Python FastAPI / Celery).
  - `packages/shared`: Kiểu dữ liệu, DTOs, utilities dùng chung.
  - `deploy`: Dockerfile, Docker Compose, Nginx config, CI/CD workflows.
  - `plans`: Tài liệu kế hoạch, roadmap, theo dõi tiến độ.
- **Tiêu chuẩn Code:** Clean Architecture, KISS & YAGNI, không tạo tầng trừu tượng dư thừa.
- **Quản lý biến môi trường:** Mọi secret, key AI, DB credentials đều đặt trong `.env`, không commit `.env` lên git.

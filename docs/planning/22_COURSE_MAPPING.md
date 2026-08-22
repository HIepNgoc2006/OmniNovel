# 🎓 22. Bằng Chứng Kỹ Thuật Nghiệm Thu 5 Môn Học Chuyên Ngành

Tài liệu này cung cấp bảng tổng hợp bằng chứng kỹ thuật cụ thể (Code Symbols, Design Patterns, Test Cases và Demo) để bảo vệ đồ án trước hội đồng chấm thi của 5 môn học.

---

## 1. MÔN 1: KỸ NĂNG LẬP TRÌNH NÂNG CAO
* **Clean Architecture:** Phân tách 4 tầng độc lập trong `services/api/src/`.
* **Design Patterns:**
  * *Strategy Pattern:* `ReaderRenderingStrategy` (`WebtoonStrategy`, `MangaStrategy`, `NovelStrategy`).
  * *Factory Pattern:* `ChapterMediaFactory` xử lý đa dạng media input.
  * *Observer Pattern:* `EventEmitter2` & Redis Pub/Sub đồng bộ tiến độ dịch qua WebSocket.
* **Concurrency & Queue:** `BullMQ` tích hợp Redis điều phối 5 Worker Jobs song song.
* **Multi-level Cache:** L1 In-Memory LRU $\rightarrow$ L2 Redis $\rightarrow$ L3 MinIO/PostgreSQL.

---


* **Event-Driven Gamification Architecture:**
  * *Observer Pattern:* `ChapterCompletedEvent`, `TranslationApprovedEvent` được phát ra bất đồng bộ và được `GamificationEventHandler` tiêu thụ để tính toán cấp độ mà không gây nghẽn luồng đọc.
  * *Strategy Pattern:* `RewardRuleStrategy` xử lý linh hoạt nhiều loại phần thưởng (EXP, OmniCoin, Cosmetic, Badge) và dễ dàng mở rộng.
  * *Transactional Consistency:* Đảm bảo tính toàn vẹn dữ liệu kép giữa Sổ cái giao dịch `wallet_transactions` và Số dư `wallets`.

## 2. MÔN 2: PHÁT TRIỂN ỨNG DỤNG DI ĐỘNG (FLUTTER)
* **High Refresh Rate Rendering:** Tối ưu hóa đạt 60fps/120Hz trên màn hình ProMotion, Frame Budget $< 8.33ms$.
* **Virtualized List Memory Eviction (LRU):** Quản lý bộ nhớ RAM $< 150MB$ khi cuộn 100+ ảnh 4K.
* **Offline-First Reading:** CSDL SQLite cục bộ kết hợp mã hóa tệp tin AES-256-GCM.
* **Interactive Bottom Sheet:** Giao diện Popup 2 phương án dịch AI (Ghi đè / Nhân bản).

---

## 3. MÔN 3: TRIỂN KHAI PHẦN MỀM (DEVOPS)
* **Docker Compose Multi-Services:** 7 Container độc lập (`web`, `api`, `ai-worker`, `postgres`, `redis`, `minio`, `nginx`).
* **Nginx Micro-Caching:** Proxy Cache lưu đệm ảnh tĩnh 30 ngày giảm 80% truy vấn trực tiếp.
* **CI/CD Pipeline (GitHub Actions):** Tự động Unit Test, Trivy Scan, Build Docker/APK và Deploy VPS qua SSH.
* **Observability:** Prometheus Metrics Exporter kết hợp Grafana Dashboard trực quan.

---

## 4. MÔN 4: AN TOÀN THÔNG TIN
* **Anti-Scraping / Anti-Leech:** Token Bucket Rate Limiting (60 req/min) + Dynamic HMAC-SHA256 Signed URLs (30 phút).
* **File Upload Sanitization:** Kiểm tra Magic Bytes nhị phân + Re-encoding làm sạch metadata EXIF ảnh.
* **Auth Security:** Mật khẩu Argon2id + JWT Refresh Token Rotation trong HttpOnly Cookie.
* **Ownership Authorization:** Ma trận phân quyền RBAC kết hợp quyền sở hữu tài nguyên (Resource Ownership).

---

## 5. MÔN 5: QUẢN LÝ DỰ ÁN CÔNG NGHỆ THÔNG TIN
* **Mô hình Agile/Scrum:** Kế hoạch 4 Sprint (2 tuần/Sprint) với Product Backlog và Sprint Backlog chi tiết.
* **Cấu trúc WBS 4 Cấp Độ & Ma Trận RACI.**
* **Ma Trận Quản Trị 16 Rủi Ro (R1 - R16)** kèm biện pháp phòng ngừa và kế hoạch ứng phó khẩn cấp.
* **Mô hình Dự toán Chi phí:** Phân tích chi phí cố định, chi phí biến đổi và kinh tế đơn vị (Unit Economics).

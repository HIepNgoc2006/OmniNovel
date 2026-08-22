# ⏱️ 14. Bảng Yêu Cầu Phi Chức Năng Đo Lường Được (Non-Functional Requirements)

Tài liệu này xác định các chỉ số hiệu năng (Performance), khả năng mở rộng (Scalability), độ sẵn sàng (Availability) và tính tin cậy đo lường được bằng các đơn vị kỹ thuật chuẩn, phân định rõ ràng giữa môi trường Demo đồ án và kiến trúc Production.

---

## 1. YÊU CẦU HIỆU NĂNG & ĐỘ TRỄ (PERFORMANCE METRICS)

| Mã NFR | Hạng Mục Đo Lường | Chỉ Số Mục Tiêu (Target Metric) | Phương Pháp Kiểm Thử & Công Cụ Đo |
| :--- | :--- | :--- | :--- |
| **NFR-PERF-01** | Độ trễ API Đọc Truyện (Catalog & Chapters)| **$p95 < 150ms$**, $p99 < 300ms$ dưới tải 500 RPS | K6 Load Testing chạy trên máy chủ API |
| **NFR-PERF-02** | Tốc độ Tìm Kiếm Nhanh (Debounced Search)  | **$p95 < 100ms$** cho từ khóa $\ge 2$ ký tự | Benchmark PostgreSQL Trigram Index Query |
| **NFR-PERF-03** | Ngân Sách Khung Hình Mobile (120Hz HRR)   | **Frame Budget $< 8.33ms$/frame** (tương đương 120 FPS)| Flutter DevTools Performance Overlay Profile |
| **NFR-PERF-04** | Bộ Nhớ RAM Trình Đọc Mobile (Memory Cache)| **Peak RAM $< 150MB$** khi cuộn 100 trang ảnh 2K | Android Profiler / Xcode Instruments trên thiết bị tham chiếu |
| **NFR-PERF-05** | Thời Gian Dịch AI 1 Chapter (30 trang)    | **Thời gian xử lý $< 120$ giây** trên GPU Worker | Benchmark luồng xử lý AI Worker với ảnh mẫu |

---

## 2. HỒ SƠ TRIỂN KHAI & ĐỘ SẴN SÀNG (DEPLOYMENT PROFILES & SLAs)

### 2.1. Hồ Sơ Demo Đồ Án (Academic Demo Profile):
* **Hạ Tầng Core Stack:** 1 VPS Linux cơ bản (4 vCPU, 8GB RAM, 160GB SSD) chạy các container: `nginx`, `web`, `api`, `postgres`, `redis`, `minio`.
* **Hạ Tầng AI Compute:** Dịch vụ `ai-worker` chạy trên **Máy tính phát triển cục bộ có GPU (hoặc endpoint GPU rời)** để xử lý các mô hình nặng (Manga-OCR, LaMa Inpaint), kết nối về Core API.
* **Mục Tiêu Độ Sẵn Sàng:** **99.5% Uptime** trong giai đoạn kiểm thử nghiệm thu đồ án.

### 2.2. Hồ Sơ Mở Rộng Sản Phẩm (Production Scale Profile):
* Cụm Multi-Node High Availability (HA) với Nginx cân bằng tải, Redis Sentinel, PostgreSQL Replication và cụm GPU Worker Node độc lập hướng tới **SLA 99.9% Uptime**.

---

## 3. TÍNH BẢO MẬT & TOÀN VẸN DỮ LIỆU (SECURITY & INTEGRITY)

* **NFR-SEC-01 (Mật khẩu):** Băm mật khẩu bằng Argon2id (Memory 64MB, Iterations 3, Parallelism 4); thời gian băm trung bình $\approx 250ms$/lần để ngăn chặn brute-force.
* **NFR-SEC-02 (Token Rotation):** Access Token có thời hạn sống tối đa **15 phút**; Refresh Token có thời hạn **7 ngày** ký `HS256` và bị thu hồi ngay lập tức nếu phát hiện reuse token.
* **NFR-SEC-03 (Anti-Leech):** Link ảnh Presigned URLs có chữ ký HMAC-SHA256 hết hạn sau **15 phút**.
* **NFR-SEC-04 (Atomic Ledger):** Toàn bộ giao dịch cộng/trừ EXP và OmniCoin phải tuân thủ nghiêm ngặt tính ACID; sai số số dư ví đảm bảo bằng 0.

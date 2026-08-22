# 🧪 17. Chiến Lược Kiểm Thử Toàn Diện & Bộ Dữ Liệu Benchmark AI (Testing & QA)

Tài liệu này xác định chiến lược kiểm thử đa tầng từ Unit Test, Integration Test, Playwright E2E, Flutter Driver đến Bộ dữ liệu đánh giá chất lượng AI.

---

## 1. MA TRẬN KIM TỰ THÁP KIỂM THỬ (TESTING PYRAMID)

* **Unit Tests (Jest / PyTest):** Đạt độ bao phủ (Coverage) $> 80\%$ cho Domain Entities, Use Cases và Thuật toán AI.
* **Integration Tests (Supertest + Testcontainers):** Kiểm thử tương tác giữa NestJS, PostgreSQL 16 và Redis.
* **Web E2E Tests (Playwright):** Kiểm thử tự động toàn bộ luồng từ Đăng nhập $\rightarrow$ Đọc Manga cuộn $\rightarrow$ Đổi server CDN.
* **Mobile Integration Tests (Flutter Driver):** Đo lường Frame Rate (120Hz) và dung lượng RAM khi cuộn 100 trang ảnh.
* **Load Testing (K6):** Mô phỏng 500 độc giả đọc truyện đồng thời và 20 tác vụ dịch AI chạy song song.

---

## 2. BỘ DỮ LIỆU ĐÁNH GIÁ CHẤT LƯỢNG AI (AI BENCHMARK DATASET)

Xây dựng bộ dữ liệu chuẩn (**Ground Truth Benchmark**):
* **50 trang Manga Nhật/Hàn tiêu chuẩn:** Đo lường độ chính xác OCR (Character Error Rate $< 5\%$) và tỷ lệ nhận diện bóng thoại (Recall $> 95\%$).
* **20 đoạn văn bản Light Novel phức tạp:** Đo lường mức độ nhất quán thuật ngữ Glossary ($100\%$) và độ tự nhiên của văn phong tiếng Việt.

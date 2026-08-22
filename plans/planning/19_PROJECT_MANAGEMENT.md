# 📊 19. Kế Hoạch Quản Lý Dự Án CNTT (Agile Scrum, WBS & Definition of Done)

Tài liệu này phân bổ chi tiết 4 Sprint Scrum, cấu trúc phân rã công việc (WBS 4 cấp) và tiêu chuẩn hoàn thành công việc (**Definition of Done - DoD**).

---

## 1. LỊCH TRÌNH 4 SPRINT SCRUM (2 TUẦN / SPRINT)

* **Sprint 1 (Tuần 1–2): Khởi Tạo Nền Tảng, Database Schema & Core API**
  * Thiết lập Monorepo, CSDL PostgreSQL 16 (20+ bảng DDL), kết nối MinIO Storage.
  * Xây dựng Core API CRUD Truyện tranh, Light Novel, Hệ thống Auth JWT & Phân quyền RBAC.
* **Sprint 2 (Tuần 3–4): AI Translation Worker & Web Client (TruyenQQ/DocLN)**
  * Xây dựng AI Worker (OCR bóng thoại, Inpainting, Typesetting, LLM translation).
  * Xây dựng giao diện Web đọc truyện tranh & truyện chữ chuẩn TruyenQQ và DocLN.
  * Hoàn thiện luồng Popup 2 phương án: *Ghi đè file cũ* hoặc *Nhân bản thành bản dịch riêng*.
* **Sprint 3 (Tuần 5–6): Phát Triển Ứng Dụng Di Động Flutter (120Hz & Offline)**
  * Xây dựng Mobile App với Trình đọc Webtoon cuộn dọc tối ưu RAM (Virtualized List chống OOM).
  * Trình đọc Light Novel với tùy biến Typography và chế độ Offline Reading.
* **Sprint 4 (Tuần 7–8): An Toàn Thông Tin, Docker DevOps & Nghiệm Thu 5 Môn**
  * Triển khai Anti-Leech Rate Limiting và kiểm tra Magic Bytes file upload.
  * Đóng gói Docker Compose 7 Containers, Nginx Caching Proxy và hoàn thiện CI/CD GitHub Actions.
  * Tổng hợp slide thuyết trình và hồ sơ báo cáo nghiệm thu liên môn cho 5 môn học.

---

## 2. TIÊU CHUẨN HOÀN THÀNH CÔNG VIỆC (DEFINITION OF DONE - DoD)

Một Task chỉ được đánh dấu là `[x] Hoàn thành` khi thỏa mãn đồng thời:
1. Mã nguồn được viết theo chuẩn Clean Architecture, không có code thừa (Clean Code).
2. Viết đầy đủ Unit Test và vượt qua toàn bộ Test Cases (Pass 100%).
3. Được Review Code và phê duyệt Pull Request trên GitHub.
4. Đạt toàn bộ các tiêu chí nghiệm thu (Acceptance Criteria Given-When-Then).
5. Không có cảnh báo bảo mật nghiêm trọng (SonarQube/Trivy passed).

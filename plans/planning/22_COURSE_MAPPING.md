# 🎓 22. Ma Trận Bằng Chứng Kỹ Thuật Dự Kiến 5 Môn Học (Planned Technical Evidence Matrix)

Tài liệu này xác định chi tiết các bằng chứng kỹ thuật, mã nguồn, mô hình thiết kế và tiêu chuẩn đánh giá dự kiến nhằm phục vụ báo cáo nghiệm thu cho 5 môn học chuyên ngành CNTT.

---

## 1. MÔN 1: KỸ NĂNG LẬP TRÌNH NÂNG CAO (ADVANCED PROGRAMMING)

* **Trọng tâm Nghiệm thu:** Clean Architecture, Design Patterns, Worker Queue, Caching đa tầng.
* **Bằng chứng Kỹ thuật Dự kiến (Planned Evidence):**
  * **Clean Architecture & IoC:** Cấu trúc 4 tầng trong `services/api` (Domain, Application, Infrastructure, Presentation) với NestJS Dependency Injection.
  * **Design Patterns:**
    * *Adapter Pattern:* `ITranslationProvider` cho phép hoán đổi giữa OpenAI, DeepL và Local LLM.
    * *State Pattern:* State Machine 14 trạng thái quản lý vòng đời `TranslationJob`.
    * *Observer / Event-Driven:* Phát và lắng nghe Domain Events (`ChapterCreatedEvent`, `UserLevelUpEvent`).
  * **Mô hình Caching Đa Tầng (Multi-Level Caching):**
    * *L1 Cache (In-process Memory):* Cache danh mục thể loại và cấu hình hệ thống bằng `node-cache` ($< 1ms$).
    * *L2 Cache (Distributed Redis 7):* Cache feed truyện HOT, bảng xếp hạng Top Views và Blacklist Token.
    * *Persistent Origin:* PostgreSQL 16 & MinIO Object Storage.

---

## 2. MÔN 2: PHÁT TRIỂN ỨNG DỤNG DI ĐỘNG (MOBILE DEVELOPMENT)

* **Trọng tâm Nghiệm thu:** Flutter High Refresh Rate (120Hz), Tối ưu RAM, Custom Paint Canvas, Offline Caching.
* **Bằng chứng Kỹ thuật Dự kiến (Planned Evidence):**
  * **Trình đọc Webtoon 120Hz:** Sử dụng `ListView.builder` và Virtualized List có cơ chế tự động giải phóng vùng nhớ ảnh ngoài viewport (Memory Eviction), duy trì Frame Time $< 8.33ms$ (120 FPS).
  * **Typography & Novel Reader:** Bộ điều khiển tùy biến cỡ chữ, khoảng cách dòng, màu nền Sepia/Dark OLED và định vị đoạn văn bằng `anchor_block_id`.
  * **Offline SQLite Storage (V1 Scope):** Lưu trữ mã hóa các chương truyện tranh trên bộ nhớ máy.

---

## 3. MÔN 3: TRIỂN KHAI PHẦN MỀM (SOFTWARE DEPLOYMENT & DEVOPS)

* **Trọng tâm Nghiệm thu:** Docker Compose Multi-Container, Nginx Reverse Proxy, CI/CD GitHub Actions, Disaster Recovery.
* **Bằng chứng Kỹ thuật Dự kiến (Planned Evidence):**
  * **Hạ tầng 7 Container:** `nginx`, `web`, `api`, `ai-worker`, `postgres`, `redis`, `minio`.
  * **Nginx Configuration:** Thiết lập SSL Termination, Gzip/Brotli compression, Static Caching và Rate Limiting.
  * **CI/CD Pipeline:** File `.github/workflows/ci-cd.yml` tự động chạy linter, kiểm thử unit test, scan bảo mật và build Docker image khi có commit mới.
  * **Kế hoạch DR:** Kịch bản tự động dump CSDL PostgreSQL mỗi ngày lúc 02:00 sáng.

---

## 4. MÔN 4: AN TOÀN THÔNG TIN (INFORMATION SECURITY)

* **Trọng tâm Nghiệm thu:** Mô hình STRIDE, Chống Leech bot, Quét an toàn file tải lên, Argon2id, RBAC.
* **Bằng chứng Kỹ thuật Dự kiến (Planned Evidence):**
  * **Bảo vệ Mật khẩu:** Triển khai **Argon2id** với memory cost 64MB, iterations 3.
  * **Anti-Leech Media Protection:** Link ảnh **Dynamic HMAC-SHA256 Signed URLs** có thời hạn sống 15 phút kèm Watermark mờ ID độc giả.
  * **Upload Sanitization:** Quét Magic Bytes, chặn tấn công Path Traversal / Zip Slip (`../`) và giới hạn tỷ lệ nén chống Zip Bomb ($< 100:1$).
  * **Ownership-Based Authorization:** Phân quyền 2 tầng bảo vệ tài nguyên qua `users.role` và `story_members.role`.

---

## 5. MÔN 5: QUẢN LÝ DỰ ÁN CNTT (IT PROJECT MANAGEMENT)

* **Trọng tâm Nghiệm thu:** Khung Scrum 4 Sprint, WBS 4 Cấp, Ma trận RACI, Quản trị 16 Rủi ro, Phân tích Chi phí Unit Economics.
* **Bằng chứng Kỹ thuật Dự kiến (Planned Evidence):**
  * **Tài liệu Kế hoạch:** Bộ 24 tài liệu đặc tả chuẩn hóa tại `plans/planning/` và 6 file theo dõi tiến độ tại `plans/phases/`.
  * **Phân rã Công việc:** WBS 4 Cấp và ma trận RACI phân công trách nhiệm rõ ràng.
  * **Ma trận Rủi ro & Dự toán:** Bảng 16 rủi ro (R1-R16) kèm biện pháp ứng phó và bài toán kinh tế hạ tầng chỉ $\approx \$20$ USD/tháng cho 1,000 DAU.

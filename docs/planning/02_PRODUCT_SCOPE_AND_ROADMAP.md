# 🎯 02. Phạm Vi Sản Phẩm (Scope) & Lộ Trình Phát Triển (MVP / V1 / V2)

Tài liệu này phân định ranh giới tính năng rõ ràng giữa các phiên bản phát hành nhằm kiểm soát chất lượng, tối ưu nguồn lực và ngăn chặn triệt để hiện tượng phình đại phạm vi (**Scope Creep**).

---

## 1. PHẠM VI PHIÊN BẢN KHỞI CHẠY TỐI THIỂU (MVP SCOPE - GIAI ĐOẠN ĐỒ ÁN)

Phiên bản MVP bắt buộc phải chạy thông suốt toàn bộ luồng nghiệp vụ từ đầu đến cuối (**End-to-End Flow**):

```
[1. Auth] ➔ [2. Discovery/Search] ➔ [3. Story Detail] ➔ [4. Manga/Novel Reader]
                                                                  │
                                                                  ▼
[7. Version Switch] ◄── [6. Overwrite/Duplicate] ◄── [5. Studio Upload & AI Translate]
```

### Các tính năng cốt lõi bắt buộc có trong MVP:
* **Xác thực & Tài khoản:** Đăng ký, Đăng nhập JWT, Phân quyền RBAC cơ bản (Admin, Uploader, Reader).
* **Khám phá & Bộ lọc:** Trang chủ (Slider HOT, Truyện mới cập nhật), Tìm kiếm theo tên, Lọc theo thể loại/quốc gia.
* **Chi tiết Bộ truyện:** Hiển thị thông tin truyện, cây mục lục phân cấp Tập (Volume) $\rightarrow$ Chương (Chapter).
* **Trình đọc Truyện tranh (Manga/Webtoon Reader):**
  * Hỗ trợ 2 chế độ: Cuộn dọc liên tục (Webtoon) và Lật từng trang (Manga).
  * Bộ chọn Server ảnh CDN (Server VIP / Server CDN 1 / Server CDN 2).
  * Tối ưu hiển thị màn hình 90Hz/120Hz mượt mà trên Mobile Flutter.
* **Trình đọc Truyện chữ (Light Novel Reader):**
  * Tùy biến Typography: Đổi cỡ chữ, font chữ, giãn dòng.
  * Đổi màu nền (Trắng, Vàng Sepia ấm áp, Đen OLED Dark Mode).
  * Hiển thị ảnh minh họa xen kẽ mượt mà.
* **Quản lý Tiến độ Đọc:** Tự động lưu vị trí trang/chương đang đọc dở trên đám mây.
* **Studio Upload & AI Translation Pipeline:**
  * Kéo thả tải lên file ZIP ảnh Manga hoặc file Text/EPUB.
  * Tự động OCR bóng thoại tranh, dịch thuật ngữ cảnh và xóa chữ cũ in chữ tiếng Việt.
  * **Popup 2 Phương án Xuất bản:** (1) Ghi đè file cũ (chuyển con trỏ `active_version_id`) và (2) Nhân bản thành bản dịch riêng mang nhãn `[Bản Dịch AI]`.
  * Bộ nút chuyển đổi ngôn ngữ (Bản Raw / Bản Dịch AI) trên giao diện đọc.

---

## 2. PHẠM VI PHIÊN BẢN MỞ RỘNG (V1 SCOPE - HẬU ĐỒ ÁN)
* Bình luận theo chương và Bình luận trực tiếp vào từng khung tranh (Inline Panel Comments).
* Đánh giá sao, gắn thẻ Spoiler làm mờ nội dung.
* Đọc truyện Offline hoàn chỉnh trên Mobile (Tải gói chương, lưu trữ mã hóa AES-256).
* Trình soạn thảo biên tập bản dịch AI (Translation Segment Editor) cho phép Uploader chỉnh sửa text trực tiếp trước khi xuất bản.
* Hệ thống quản trị báo lỗi chương và kiểm duyệt nội dung.

---

## 3. PHẠM VI TƯƠNG LAI (V2 / FUTURE ROADMAP)
* Gợi ý truyện thông minh bằng AI Recommendation Engine.
* Quản lý nhóm dịch (Translation Groups / Scanlation Teams) với quyền phân vai (Leader, Cleaner, Typesetter, Proofreader).
* Chuyển văn bản thành giọng đọc cảm xúc (AI Text-to-Speech Smart Audiobook).
* Bảng thống kê phân tích số liệu độc giả chi tiết cho tác giả (Creator Analytics).

---

## 4. NGOÀI PHẠM VI DỰ ÁN (EXPLICIT OUT-OF-SCOPE)

Để đảm bảo hoàn thành đồ án đúng hạn và đạt chất lượng kỹ thuật cao nhất, các tính năng sau **TUYỆT ĐỐI KHÔNG LÀM TRONG GIAI ĐOẠN NÀY**:
* ❌ **Cổng thanh toán tiền thật / Ví điện tử / Mua bán tiền tệ:** Không tích hợp nạp tiền qua ngân hàng/thẻ tín dụng.
* ❌ **Sàn giao dịch chợ vật phẩm / Marketplace:** Không triển khai mua bán bản quyền P2P.
* ❌ **Mạng xã hội tin nhắn trực tiếp / Live Chat:** Không làm tính năng nhắn tin riêng giữa các user.
* ❌ **Hạ tầng phân tán Multi-Region High Availability:** Triển khai tập trung trên cụm Container VPS chuẩn mực.

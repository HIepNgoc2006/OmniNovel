# ⚖️ 16. Quyền Riêng Tư, Bản Quyền Tác Giả & Quy Trình Xử Lý Khiếu Nại (Copyright & Takedown)

Tài liệu này xác định chính sách bảo vệ quyền riêng tư người dùng, các cấp độ hiển thị tác phẩm và quy trình kỹ thuật tiếp nhận, xử lý khiếu nại bản quyền (**Copyright & Content Takedown Workflow**).

---

## 1. BA CẤP ĐỘ HIỂN THỊ TÁC PHẨM (STORY VISIBILITY LEVELS)

| Cấp Độ Hiển Thị | Quyền Truy Cập (Access Control) | Hiển Thị Trên Trang Chủ & Tìm Kiếm |
| :--- | :--- | :---: |
| **`PUBLIC`** | Toàn bộ người dùng (kể cả khách vãng lai) đều có thể tìm thấy và đọc truyện. | ✅ Có hiển thị |
| **`UNLISTED`** | Chỉ những người có đường dẫn URL trực tiếp mới có thể xem (dành cho bản dịch thử nghiệm/nội bộ). | ❌ Không xuất hiện |
| **`PRIVATE`** | Chỉ Chủ sở hữu (`OWNER`) và các thành viên trong `story_members` mới có thể truy cập và chỉnh sửa. | ❌ Không xuất hiện |

---

## 2. QUY TRÌNH TIẾP NHẬN & XỬ LÝ KHIẾU NẠI BẢN QUYỀN (TAKEDOWN WORKFLOW)

```
[1. Tiếp nhận Báo cáo/Khiếu nại]
               │
               ▼
[2. Admin Kiểm duyệt & Tạm ẩn tác phẩm (Visibility ➔ PRIVATE)]
               │
               ▼
[3. Gửi Thông báo cho Uploader & Chờ Phản hồi (48 giờ)]
       │                                     │
       ├─[ Uploader Cung cấp Giấy phép ]     ├─[ Uploader Vi phạm / Không phản hồi ]
       │                                     │
       ▼                                     ▼
[4. Khôi phục Trạng thái PUBLIC]       [5. Gỡ bỏ Vĩnh viễn Tác phẩm & Cảnh cáo User]
```

1. **Bước 1: Tiếp nhận yêu cầu:** Tác giả gốc hoặc độc giả gửi báo cáo vi phạm kèm liên kết tác phẩm gốc và bằng chứng sở hữu qua `/admin/reports`.
2. **Bước 2: Tạm khóa bảo vệ:** Admin kích hoạt chế độ `visibility = 'PRIVATE'` ngay lập tức để ngăn chặn tiếp tục phân phối nội dung trong thời gian điều tra.
3. **Bước 3: Đối soát:** Hệ thống gửi thông báo trong ứng dụng cho Uploader bộ truyện kèm thời hạn phản hồi 48 giờ.
4. **Bước 4: Quyết định cuối cùng:** Nếu Uploader không chứng minh được quyền sử dụng hợp lệ $\rightarrow$ Admin thực hiện gỡ bỏ vĩnh viễn và gắn cờ cảnh cáo tài khoản.

---

## 3. CHÍNH SÁCH BẢO VỆ DỮ LIỆU CÁ NHÂN (DATA PRIVACY & RETENTION)

* **Xóa tài khoản (Account Deletion):** Người dùng có quyền yêu cầu xóa vĩnh viễn tài khoản. Toàn bộ thông tin email, password hash và thông tin cá nhân sẽ được xóa sạch khỏi `users`, các bản dịch/truyện đã xuất bản sẽ được chuyển sang quyền sở hữu ẩn danh (`owner_id = NULL`).
* **Lưu vết Logs (Log Retention):** Toàn bộ access logs và audit logs được lưu trữ bảo mật trong 30 ngày phục vụ điều tra sự cố trước khi được tự động dọn dẹp (Auto-purge).

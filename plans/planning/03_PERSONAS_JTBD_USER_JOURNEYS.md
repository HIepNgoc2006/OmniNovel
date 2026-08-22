# 👥 03. Chân Dung Người Dùng (Personas), Jobs To Be Done & Hành Trình Trải Nghiệm

Tài liệu này xác định 5 chân dung người dùng đại diện, khung lý thuyết **Jobs To Be Done (JTBD)** và bản đồ hành trình trải nghiệm người dùng (User Journeys).

---

## 1. NĂM CHÂN DUNG NGƯỜI DÙNG CHI TIẾT (5 USER PERSONAS)

| Thuộc tính | Persona 1: Manga Reader (Minh Tuấn, 19t) | Persona 2: LN Reader (Linh Chi, 22t) | Persona 3: Translator (Hoàng Long, 26t) | Persona 4: Creator/Author (Quốc Anh, 24t) | Persona 5: Admin/Mod (Thanh Hải, 29t) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Vai trò chính** | Độc giả truyện tranh | Độc giả tiểu thuyết | Nhóm trưởng dịch thuật | Tác giả sáng tác độc lập | Quản trị viên hệ thống |
| **Thiết bị chính** | Smartphone 120Hz Android | iPad Pro 120Hz & iPhone | PC 2 màn hình, Wacom | Laptop & Máy tính bảng | Laptop & Màn hình quản trị |
| **Mục tiêu cốt lõi** | Cuộn truyện cực mượt, đổi server nhanh khi lag, tải đọc offline. | Đọc đêm không mỏi mắt, chỉnh font/nền Sepia, xem ảnh minh họa. | Upload nhanh cả tập raw, nhờ AI dịch nháp để tiết kiệm 80% công sức. | Đăng tải tác phẩm gốc, quản lý các tập truyện, xem thống kê lượt đọc. | Kiểm soát lỗi chương, chặn bot cào trộm, đảm bảo an toàn hệ thống. |
| **Nỗi đau lớn nhất** | Web lậu nhiều quảng cáo rác, cuộn giật khựng, đơ ảnh khi mạng yếu. | Nền trắng chói mắt, chữ quá bé, không tùy chỉnh được khoảng cách dòng. | Xóa chữ và gõ text thủ công tốn hàng chục giờ cho một chapter. | Khó quản lý các ấn bản ngôn ngữ khác nhau của tác phẩm. | Không có công cụ kiểm duyệt báo lỗi tập trung, bot spam server. |
| **Mức độ am hiểu CNTT**| Trung bình | Trung bình | Khá - Giỏi | Trung bình | Chuyên gia (DevOps/Security) |

---

## 2. KHUNG LÝ THUYẾT JOBS TO BE DONE (JTBD)

```
CẤU TRÚC JTBD: [Bối cảnh khi...] ➔ [Tôi muốn...] ➔ [Để tôi có thể...]
```

* **JTBD-01 (Manga Offline Reading):**  
  * *Khi tôi:* Đang đi trên xe buýt hoặc tàu điện có kết nối mạng 4G chập chờn,  
  * *Tôi muốn:* Ứng dụng tự động tải trước và lưu trữ mã hóa toàn bộ 5 chapter tiếp theo vào bộ nhớ máy,  
  * *Để tôi có thể:* Thưởng thức trọn vẹn mạch truyện cuộn mượt mà không bao giờ bị đứng hình quay vòng tròn.

* **JTBD-02 (Novel Night Reading):**  
  * *Khi tôi:* Nằm trên giường đọc tiểu thuyết dài hàng giờ liền trong phòng tối trước khi ngủ,  
  * *Tôi muốn:* Bật tông màu nền Vàng Sepia ấm áp hoặc Đen OLED Dark Mode và chỉnh phông chữ có chân (Serif) với khoảng cách dòng thoáng,  
  * *Để tôi có thể:* Đắm chìm vào thế giới tác phẩm mà không bị cay mắt hay nhức đầu.

* **JTBD-03 (AI Manga Translation & Publishing):**  
  * *Khi tôi:* Mua được một tập raw truyện tranh tiếng Nhật mới phát hành gồm 40 trang ảnh,  
  * *Tôi muốn:* Tải toàn bộ file ZIP lên hệ thống để AI tự động phát hiện bóng thoại, xóa chữ cũ và điền bản dịch tiếng Việt nháp, sau đó cho tôi quyền chọn **Ghi đè** hoặc **Nhân bản tạo bản dịch riêng**,  
  * *Để tôi có thể:* Xuất bản nhanh chương truyện cho cộng đồng trong vòng 5 phút thay vì mất 2 ngày làm thủ công.

* **JTBD-04 (Error Reporting):**  
  * *Khi tôi:* Đang đọc truyện và phát hiện trang số 12 bị trắng xóa hoặc sai thứ tự,  
  * *Tôi muốn:* Bấm ngay nút "Báo lỗi chương" tại thanh công cụ đọc truyện,  
  * *Để tôi có thể:* Báo cho nhóm dịch và admin biết chính xác lỗi để họ khắc phục nhanh nhất.

---

## 3. BẢN ĐỒ HÀNH TRÌNH NGƯỜI DÙNG (USER JOURNEY MAP: UPLOADER & AI TRANSLATION)

```
GIAI ĐOẠN 1: KHỞI TẠO         GIAI ĐOẠN 2: XỬ LÝ AI          GIAI ĐOẠN 3: XEM TRƯỚC         GIAI ĐOẠN 4: XUẤT BẢN
┌──────────────────────┐      ┌──────────────────────┐      ┌──────────────────────┐      ┌──────────────────────┐
│ Uploader kéo thả     │ ───> │ Hệ thống đẩy vào     │ ───> │ Uploader nhận kết    │ ───> │ Uploader bấm chọn    │
│ file ZIP ảnh raw lên │      │ Queue: OCR ➔ Dịch ➔  │      │ quả, xem màn hình    │      │ Phương án 1 (Ghi đè) │
│ Studio và tích chọn  │      │ Inpaint ➔ Typeset    │      │ so sánh Diff Preview │      │ HOẶC Phương án 2     │
│ "Dịch tự động bằng AI│      │ (Xem % tiến trình)   │      │ trước và sau khi dịch│      │ (Nhân bản tạo bản AI)│
└──────────────────────┘      └──────────────────────┘      └──────────────────────┘      └──────────────────────┘
```

# 👥 03. Chân Dung Người Dùng (Personas), Jobs To Be Done & Hành Trình Trải Nghiệm

Tài liệu này xác định 5 chân dung người dùng đại diện, khung lý thuyết **Jobs To Be Done (JTBD)** và 6 bản đồ hành trình trải nghiệm người dùng (**User Journey Maps**) bao quát toàn bộ hệ sinh thái OmniNovel.

---

## 1. NĂM CHÂN DUNG NGƯỜI DÙNG CHI TIẾT (5 USER PERSONAS)

| Thuộc tính | Persona 1: Manga Reader (Minh Tuấn, 19t) | Persona 2: LN Reader (Linh Chi, 22t) | Persona 3: Translator (Hoàng Long, 26t) | Persona 4: Creator/Author (Quốc Anh, 24t) | Persona 5: Admin/Mod (Thanh Hải, 29t) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Vai trò chính** | Độc giả truyện tranh | Độc giả tiểu thuyết | Nhóm trưởng dịch thuật | Tác giả sáng tác độc lập | Quản trị viên hệ thống |
| **Thiết bị chính** | Smartphone 120Hz Android | iPad Pro 120Hz & iPhone | PC 2 màn hình, Wacom | Laptop & Máy tính bảng | Laptop & Màn hình quản trị |
| **Mục tiêu cốt lõi** | Cuộn truyện cực mượt, đổi server nhanh khi lag, tích lũy EXP tăng Level. | Đọc đêm không mỏi mắt, chỉnh font/nền Sepia, xem ảnh minh họa rõ nét. | Upload cả tập raw, nhờ AI dịch nháp để rút ngắn thời gian xử lý thủ công. | Đăng tải tác phẩm gốc, quản lý các ấn bản ngôn ngữ, theo dõi lượt xem. | Kiểm soát lỗi chương, chặn bot cào trộm, đảm bảo an toàn hệ thống. |
| **Nỗi đau lớn nhất** | Web lậu nhiều quảng cáo rác, cuộn giật khựng, đơ ảnh khi mạng yếu. | Nền trắng chói mắt, chữ quá bé, không tùy chỉnh được khoảng cách dòng. | Xóa chữ và gõ text thủ công tốn nhiều công sức cho một chapter. | Khó quản lý các ấn bản ngôn ngữ khác nhau của tác phẩm. | Không có công cụ kiểm duyệt báo lỗi tập trung, bot spam server. |
| **Mức độ am hiểu CNTT**| Trung bình | Trung bình | Khá - Giỏi | Trung bình | Chuyên gia (DevOps/Security) |

---

## 2. KHUNG LÝ THUYẾT JOBS TO BE DONE (JTBD)

```
CẤU TRÚC JTBD: [Bối cảnh khi...] ➔ [Tôi muốn...] ➔ [Để tôi có thể...]
```

* **JTBD-01 (Manga Smooth Reading):**  
  * *Khi tôi:* Đang đọc bộ truyện tranh hành động nhiều khung tranh lớn trên smartphone 120Hz,  
  * *Tôi muốn:* Trình đọc cuộn dọc liên tục mượt mà, tải ảnh trước ngầm và tự do đổi Server CDN khi mạng lag,  
  * *Để tôi có thể:* Thưởng thức trọn vẹn mạch truyện mà không bao giờ bị đứng hình hay giật lag.

* **JTBD-02 (Novel Night Reading):**  
  * *Khi tôi:* Nằm trên giường đọc tiểu thuyết dài hàng giờ liền trong phòng tối trước khi ngủ,  
  * *Tôi muốn:* Bật tông màu nền Vàng Sepia ấm áp hoặc Đen OLED Dark Mode và chỉnh phông chữ có chân (Serif) với khoảng cách dòng thoáng,  
  * *Để tôi có thể:* Đắm chìm vào thế giới tác phẩm mà không bị cay mắt hay nhức đầu.

* **JTBD-03 (AI Manga Translation & Publishing):**  
  * *Khi tôi:* Có một tập raw truyện tranh tiếng Nhật mới phát hành gồm 30-50 trang ảnh,  
  * *Tôi muốn:* Tải toàn bộ file ZIP lên hệ thống để AI tự động phát hiện bóng thoại, xóa chữ cũ và điền bản dịch tiếng Việt nháp, sau đó cho tôi quyền chọn **Ghi đè** hoặc **Nhân bản tạo bản dịch riêng**,  
  * *Để tôi có thể:* Rút ngắn đáng kể công sức xử lý thủ công ban đầu mà vẫn giữ toàn quyền kiểm soát bản xuất bản.

* **JTBD-04 (Gamification Check-in & Progression):**  
  * *Khi tôi:* Truy cập ứng dụng mỗi ngày để đọc các chương truyện mới,  
  * *Tôi muốn:* Thực hiện điểm danh nhận OmniCoin và tích lũy EXP từ các chương đọc hợp lệ để nâng cấp Level và đổi danh hiệu Rank độc đáo,  
  * *Để tôi có thể:* Thể hiện thành tích và gắn bó lâu dài cùng cộng đồng độc giả.

* **JTBD-05 (Error Reporting):**  
  * *Khi tôi:* Đang đọc truyện và phát hiện trang số 12 bị trắng xóa hoặc lỗi font,  
  * *Tôi muốn:* Bấm ngay nút "Báo lỗi chương" tại thanh công cụ đọc truyện,  
  * *Để tôi có thể:* Báo cho nhóm dịch và admin biết chính xác vị trí lỗi để khắc phục nhanh nhất.

---

## 3. SÁU BẢN ĐỒ HÀNH TRÌNH NGƯỜI DÙNG (USER JOURNEY MAPS)

### Journey 1: Manga Reader Journey (Độc giả Truyện Tranh)
```
[Khám Phá] ──> [Trang Chi Tiết] ──> [Đọc Webtoon 120Hz] ──> [Đổi Server CDN / Bản Dịch] ──> [Lưu Tiến Độ]
Duyệt Slider HOT   Xem tóm tắt, mục   Cuộn dọc mượt mà,     Chuyển Server VIP khi mạng   Hệ thống tự lưu vị
hoặc lọc thể loại  lục tập/chương     tự pre-fetch ảnh tiếp lag, đổi qua lại Raw/AI      trí đọc dở
```

### Journey 2: Light Novel Reader Journey (Độc giả Truyện Chữ)
```
[Tìm Kiếm] ──> [Vào Chương Tiểu Thuyết] ──> [Tùy Biến Typography] ──> [Xem Ảnh Minh Họa] ──> [Bookmark / Trở Lại]
Gõ từ khóa có     Mở chương truyện chữ     Đổi font chữ, cỡ 20px,     Mở Gallery xem hình     Đồng bộ vị trí đọc
gợi ý tức thì     với thanh Drawer         nền Vàng Sepia             phóng to sắc nét        theo block đoạn văn
```

### Journey 3: Translator / Studio Journey (Nhóm Dịch Thuật & AI)
```
[Tạo Phiên Dịch] ──> [Upload ZIP Raw] ──> [AI Processing Queue] ──> [Màn Hình Diff Preview] ──> [Chọn Phương Án Xuất Bản]
Chọn truyện &        Kéo thả file ZIP,    Xem % tiến trình qua        So sánh ảnh trước/sau     Chọn Ghi đè con trỏ active
ngôn ngữ đích        quét magic bytes     WebSocket (OCR/Dịch/Inpaint)khi AI hoàn tất 100%      hoặc Nhân bản bản dịch riêng
```

### Journey 4: Creator / Author Journey (Tác Giả & Xuất Bản)
```
[Tạo Bộ Truyện] ──> [Thiết Lập Ấn Bản] ──> [Quản Lý Volume/Chapter] ──> [Phân Quyền Nhóm] ──> [Xuất Bản Public]
Điền metadata, bìa,  Tạo StoryEdition      Tạo cây phân cấp tập &      Thêm thành viên vào       Chuyển trạng thái sang
thể loại, tóm tắt    (Tiếng Việt / Gốc)    chương truyện               story_members (Editor)    Public cho cộng đồng
```

### Journey 5: Admin / Moderator Journey (Quản Trị & Kiểm Duyệt)
```
[Tiếp Nhận Báo Lỗi] ──> [Kiểm Tra Chi Tiết] ──> [Thao Tác Xử Lý] ──> [Phản Hồi / Đóng Báo Cáo] ──> [Ghi Audit Log]
Độc giả gửi report      Xem snapshot lỗi,     Ẩn chương lỗi, sửa lại URL   Gửi thông báo hoàn tất      Hệ thống lưu vết hành
ảnh hỏng / bản quyền    vị trí trang ảnh      ảnh hoặc cảnh báo uploader   cho người báo lỗi           động quản trị
```

### Journey 6: Gamification Progression Journey (Tiến Trình & Điểm Thưởng)
```
[Vào OmniNovel] ──> [Điểm Danh Hàng Ngày] ──> [Đọc Chương Hợp Lệ] ──> [Tăng EXP & Lên Cấp] ──> [Chọn Theme & Nhận Thưởng]
Đăng nhập tài khoản  Nhận OmniCoin & streak   Nhận +5 EXP / chapter       Cột mốc Level 10 ➔           Đổi Rank Theme "Tu Tiên",
hợp lệ               liên tục (Atomic Ledger) (chống farm reload)         thăng cấp danh hiệu mới      claim phần thưởng Level
```

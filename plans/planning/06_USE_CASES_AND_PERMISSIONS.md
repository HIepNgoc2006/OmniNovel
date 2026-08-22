# 👥 06. Danh Mục 35 Use Cases & Ma Trận Phân Quyền Sở Hữu (Ownership-Based Authorization)

Tài liệu này xác định đầy đủ danh mục **35 Use Cases** của hệ thống OmniNovel, đặc tả chuyên sâu **10 Use Cases cốt lõi** và ma trận phân quyền sở hữu dựa trên CSDL (**Ownership-Based RBAC với `story_members`**).

---

## 1. DANH MỤC ĐẦY ĐỦ 35 USE CASES CỦA OMNINOVEL

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                  DANH MỤC 35 USE CASES HỆ THỐNG                                  │
├────────────────────┬────────────────────┬────────────────────┬──────────────────────────────────┤
│ PHÂN HỆ AUTH (4)   │ PHÂN HỆ KHÁM PHÁ (5│ PHÂN HỆ TRÌNH ĐỌC(6│ PHÂN HỆ TỦ SÁCH (4)              │
│ • UC-AUTH-01: ĐK   │ • UC-DISC-01: Feed │ • UC-READ-01: M.120│ • UC-LIB-01: Sync Tiến Độ       │
│ • UC-AUTH-02: ĐN   │ • UC-DISC-02: Search│ • UC-READ-02: M.Page│ • UC-LIB-02: Bookmark Truyện   │
│ • UC-AUTH-03: ĐX   │ • UC-DISC-03: Filter│ • UC-READ-03: CDN  │ • UC-LIB-03: Tải Offline (V1)   │
│ • UC-AUTH-04: Pass │ • UC-DISC-04: BXH  │ • UC-READ-04: LN.Typ│ • UC-LIB-04: Phân Loại Tủ Sách │
│                    │ • UC-DISC-05: Detail│ • UC-READ-05: LN.Gal│                                  │
│                    │                    │ • UC-READ-06: Switch│                                  │
├────────────────────┼────────────────────┼────────────────────┼──────────────────────────────────┤
│ PHÂN HỆ STUDIO/AI(5│ PHÂN HỆ GAMIFY (5) │ PHÂN HỆ QUẢN TRỊ(3)│ PHÂN HỆ CỘNG ĐỒNG (3) (V1)       │
│ • UC-STUD-01: Story│ • UC-GAM-01: Checkin│ • UC-ADM-01: Report│ • UC-COM-01: Bình Luận Chương    │
│ • UC-STUD-02: Upload│ • UC-GAM-02: EXP   │ • UC-ADM-02: Users │ • UC-COM-02: Inline Panel Comment│
│ • UC-STUD-03: AI Job│ • UC-GAM-03: Theme │ • UC-ADM-03: Visib.│ • UC-COM-03: Đánh Giá Sao        │
│ • UC-STUD-04: Apply│ • UC-GAM-04: Reward│                    │                                  │
│ • UC-STUD-05: Gloss│ • UC-GAM-05: Ledger│                    │                                  │
└────────────────────┴────────────────────┴────────────────────┴──────────────────────────────────┘
```

---

## 2. MA TRẬN PHÂN QUYỀN SỞ HỮU DỰA TRÊN DỮ LIỆU (OWNERSHIP RBAC MATRIX)

Quyền hạn được xác định qua 2 tầng: **Global Role** (`users.role`) và **Story Member Role** (`story_members.role`):

| Hành Động Nghiệp Vụ (Action) | Guest | Global READER | Story UPLOADER | Story TRANSLATOR | Story EDITOR | Story OWNER | Global ADMIN |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Đọc truyện công khai (Public Read)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Đánh dấu theo dõi & Lưu tiến độ đọc**| ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Điểm danh & Tích lũy EXP/OmniCoin**  | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Tạo bộ truyện mới (Create Story)**   | ❌ | ❌ (Cần apply) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Tải lên tập raw (Upload ZIP/Text)**  | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Kích hoạt Task Dịch AI**             | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Xuất bản / Ghi đè Active Version**   | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Chỉnh sửa Metadata & Quản lý Member**| ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Khóa tài khoản & Điều khiển Ẩn/Hiện**| ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## 3. ĐẶC TẢ CHI TIẾT 10 USE CASES CỐT LÕI (CORE DETAILED USE CASES)

### 📄 UC-01 (UC-AUTH-02): Đăng Nhập Tài Khoản & Cấp Phát Token Kép
* **Primary Actor:** Reader / Translator / Admin.
* **Preconditions:** Tài khoản đã đăng ký hợp lệ và đang ở trạng thái `is_active = TRUE`, `is_deleted = FALSE`.
* **Main Flow:**
  1. Người dùng nhập Email/Username và Mật khẩu $\rightarrow$ Bấm "Đăng nhập".
  2. Server kiểm tra mật khẩu bằng thuật toán **Argon2id**.
  3. Server sinh Access Token (15 phút) và Refresh Token (7 ngày) ký `HS256`.
  4. Server lưu hash của Refresh Token vào Redis kèm `userId` và trả về Access Token trong body, Refresh Token trong HttpOnly Cookie.
* **Postconditions:** Người dùng đăng nhập thành công và client lưu phiên làm việc.

---

### 📄 UC-02 (UC-DISC-02): Tìm Kiếm Truyện Nhanh Có Gợi Ý Tức Thì
* **Primary Actor:** Guest / Reader.
* **Main Flow:**
  1. Độc giả gõ từ khóa vào thanh tìm kiếm (ví dụ: "Solo Leveling").
  2. Client tự động debounce 300ms và gửi request `GET /api/v1/stories/search?q=Solo`.
  3. Server truy vấn Full-Text Search trong PostgreSQL (Trigram Index) và trả về danh sách tối đa 10 gợi ý.
  4. Giao diện hiển thị dropdown danh sách truyện kèm ảnh bìa, tác giả và thể loại.
  5. Độc giả bấm vào một kết quả để chuyển hướng đến trang chi tiết.

---

### 📄 UC-03 (UC-READ-01/03): Đọc Truyện Tranh Webtoon 120Hz & Đổi Server CDN
* **Primary Actor:** Guest / Reader.
* **Preconditions:** Chapter đã có ít nhất một `ChapterVersion` đang active.
* **Main Flow:**
  1. Độc giả mở một chapter truyện tranh trên điện thoại.
  2. App Flutter gọi `GET /api/v1/chapters/:id` nhận danh sách HMAC Signed URLs các trang ảnh WebP.
  3. Trình đọc nạp ảnh vào Virtualized List, tối ưu GPU Impeller để cuộn mượt 120Hz.
  4. Nếu Server chính bị chậm, độc giả chọn "Server CDN 1" trên thanh điều khiển $\rightarrow$ URL ảnh tự động chuyển sang route dự phòng giữ nguyên vị trí trang đang đọc.

---

### 📄 UC-04 (UC-READ-04/05): Đọc Truyện Chữ Light Novel & Tùy Biến Typography
* **Primary Actor:** Guest / Reader.
* **Main Flow:**
  1. Độc giả mở chương tiểu thuyết.
  2. Trình đọc render nội dung văn bản kèm ảnh minh họa inline sắc nét.
  3. Độc giả mở menu cài đặt $\rightarrow$ Chọn nền "Vàng Sepia", tăng cỡ chữ lên 20px và chọn font Serif.
  4. Giao diện áp dụng ngay lập tức mà không làm nhảy vị trí đọc hiện tại.

---

### 📄 UC-05 (UC-LIB-01): Lưu & Đồng Bộ Tiến Độ Đọc Đa Thiết Bị
* **Primary Actor:** Reader đã đăng nhập.
* **Main Flow:**
  1. Độc giả cuộn đọc đến trang 25 của Manga hoặc `block-id-42` của Novel.
  2. Client gửi heartbeat debounce `POST /api/v1/library/progress` với `{ storyId, chapterId, pageIndex, anchorBlockId }`.
  3. Server cập nhật bản ghi `reading_progress` với `updated_at = NOW()`.
  4. Khi độc giả mở ứng dụng trên thiết bị thứ hai, hệ thống hiển thị nút "Đọc tiếp" và mở đúng vị trí đã lưu.

---

### 📄 UC-06 (UC-STUD-01): Tạo Bộ Truyện Mới & Thiết Lập Ấn Bản (StoryEdition)
* **Primary Actor:** Global Translator / Story Owner.
* **Main Flow:**
  1. Thành viên vào `/studio/stories/new`, nhập Tên truyện, Thể loại, Tóm tắt và Upload ảnh bìa.
  2. Server lưu bản ghi vào `stories`, gán `created_by = user.id` và tự động tạo `story_members` với `role = 'OWNER'`.
  3. Thành viên tạo thêm ấn bản `story_editions` (ví dụ: "Bản Dịch Tiếng Việt", language: 'vi').

---

### 📄 UC-07 (UC-STUD-02/03): Tải Lên Raw & Khởi Chạy Tác Vụ Dịch AI
* **Primary Actor:** Story Translator / Editor / Owner.
* **Secondary Actor:** NestJS BullMQ, MinIO, Python AI Engine.
* **Main Flow:**
  1. Thành viên kéo thả file ZIP 30 trang ảnh Manga vào Studio và tích chọn "Dịch tự động bằng AI".
  2. Server kiểm tra an toàn tệp tin, giải nén và tải ảnh lên MinIO bucket `manga-media`.
  3. Server tạo `TranslationJob` trạng thái `QUEUED` và đẩy vào BullMQ.
  4. Worker gọi Python AI Engine thực hiện: Detection $\rightarrow$ OCR $\rightarrow$ Translation $\rightarrow$ Inpainting $\rightarrow$ Typesetting.
  5. Tiến trình % được phát thời gian thực qua WebSocket đến màn hình Studio.

---

### 📄 UC-08 (UC-STUD-04): Xem Trước So Sánh (Diff) & Áp Dụng Xuất Bản
* **Primary Actor:** **Story Editor / Story Owner / Global Admin** *(Translator không có quyền này)*.
* **Preconditions:** `TranslationJob` đã hoàn tất 100% (trạng thái `READY_FOR_REVIEW`).
* **Main Flow:**
  1. Giao diện Studio hiển thị thanh trượt Diff so sánh ảnh raw gốc và ảnh sau khi dịch AI.
  2. Popup hiển thị 2 phương án:
     * *(Phương án 1 - Ghi đè):* Editor/Owner chọn Ghi đè $\rightarrow$ Server cập nhật con trỏ `chapter.active_version_id = translated_version_id`. Bản raw cũ vẫn tồn tại bất biến trong CSDL.
     * *(Phương án 2 - Nhân bản):* Editor/Owner chọn Nhân bản $\rightarrow$ Server giữ nguyên `active_version_id` cũ, tạo `ChapterVersion` mới và hiển thị trong menu chọn bản dịch.
  3. Chương truyện lập tức sẵn sàng phục vụ độc giả.

---

### 📄 UC-09 (UC-GAM-01): Điểm Danh Hàng Ngày & Tích Lũy Chuỗi Streak
* **Primary Actor:** Reader đã đăng nhập.
* **Main Flow:**
  1. Độc giả nhấn nút "Điểm danh ngay" trên trang OmniCoin.
  2. Server kiểm tra trong `daily_checkins` xem hôm nay người dùng đã điểm danh chưa.
  3. Nếu chưa: Chạy transaction CSDL nguyên tử:
     * Thêm bản ghi `daily_checkins`.
     * Tăng `current_streak` thêm 1 (hoặc reset về 1 nếu ngắt chuỗi).
     * Cộng 5 OmniCoin và 10 Total EXP vào `user_progression`.
     * Ghi 2 dòng lịch sử vào sổ cái bất biến `reward_transactions` (`CHECKIN:<user>:<date>:EXP` và `CHECKIN:<user>:<date>:OMNICOIN`).
  4. Server trả về `200 OK` kèm số OmniCoin nhận được và chuỗi streak hiện tại.

---

### 📄 UC-10 (UC-ADM-01): Tiếp Nhận Báo Lỗi Chương & Xử Lý Quản Trị
* **Primary Actor:** Độc giả (Người báo) và Admin (Người xử lý).
* **Main Flow:**
  1. Độc giả bấm "Báo lỗi chương" tại trang đọc (chọn lỗi "Ảnh bị lỗi tải" ở Trang 12).
  2. Server lưu bản ghi vào `chapter_error_reports` trạng thái `PENDING`.
  3. Admin vào `/admin/reports`, xem snapshot thông tin lỗi và bấm "Kiểm tra chương".
  4. Sau khi sửa file ảnh trên MinIO hoặc re-run tác vụ, Admin bấm "Đã xử lý".
  5. Hệ thống cập nhật trạng thái báo cáo sang `RESOLVED` và đóng khiếu nại.

# ⚙️ 05. Bảng Đặc Tả Yêu Cầu Chức Năng & Tiêu Chí Nghiệm Thu (Functional Requirements)

Tài liệu này đặc tả chi tiết toàn bộ các Yêu Cầu Chức Năng (**Functional Requirements - FR**) kèm tiêu chí nghiệm thu kiểm thử chuẩn **Acceptance Criteria (Given-When-Then)** và các trạng thái ngoại lệ (**Error, Loading, Empty, Offline, Rate Limited States**).

---

## 1. PHÂN HỆ ĐỌC TRUYỆN TRANH (MANGA & WEBTOON FRs)

### FR-MANGA-01: Trình Đọc Webtoon Cuộn Dọc Tối Ưu RAM
* **Mô tả:** Hệ thống nạp và hiển thị danh sách trang ảnh theo chiều dọc liên tục, đảm bảo cuộn mượt mà và giải phóng RAM tự động.
* **Tiêu chí nghiệm thu (Acceptance Criteria):**
  * `Given` người dùng mở một chapter Manga có 50 trang ảnh trên thiết bị di động màn hình 120Hz,
  * `When` người dùng thực hiện vuốt cuộn nhanh qua 20 trang ảnh,
  * `Then` hệ thống hiển thị ảnh mượt mà không khựng hình (Frame time $< 8.33ms$), bộ nhớ RAM tiêu thụ $< 150MB$, các trang ảnh cách xa hơn 3 màn hình được giải phóng khỏi RAM.
* **Xử lý trạng thái (States):**
  * *Loading State:* Hiển thị khung xương xám (Skeleton Placeholder) với tỷ lệ đúng kích thước trang ảnh.
  * *Error State:* Nếu trang ảnh thứ $N$ bị lỗi tải, hiển thị icon ảnh lỗi kèm nút **"Thử lại trang này"**.
  * *Empty State:* Nếu chapter không có trang ảnh nào, hiển thị thông báo "Chương này chưa có nội dung ảnh".

---

### FR-MANGA-02: Bộ Chọn Server Ảnh CDN (CDN Selector)
* **Mô tả:** Cho phép người dùng chuyển đổi nguồn phân phối hình ảnh khi gặp sự cố mạng.
* **Tiêu chí nghiệm thu (Acceptance Criteria):**
  * `Given` độc giả đang ở màn hình đọc truyện tại trang số 15 với Server hiện tại là "Server VIP",
  * `When` độc giả chọn "Server CDN 1" trên thanh điều khiển,
  * `Then` hệ thống chuyển đổi URL nguồn ảnh sang domain `cdn1.omninovel.com` mà vẫn giữ nguyên vị trí trang số 15 đang đọc dở.
* **Xử lý trạng thái (States):**
  * *Fallback State:* Nếu Server VIP bị timeout quá 3 giây, hệ thống tự động fallback sang CDN 1 và hiển thị thông báo toast nhẹ: *"Đã tự động chuyển sang máy chủ dự phòng"*.

---

## 2. PHÂN HỆ ĐỌC TRUYỆN CHỮ (LIGHT NOVEL FRs)

### FR-NOVEL-01: Bộ Điều Khiển Typography & Đổi Theme Nền
* **Mô tả:** Cho phép độc giả tùy chỉnh font chữ, cỡ chữ, line-height và màu nền đọc truyện chữ.
* **Tiêu chí nghiệm thu (Acceptance Criteria):**
  * `Given` độc giả đang đọc một chương Light Novel ở chế độ nền Trắng mặc định,
  * `When` độc giả chọn theme "Vàng Sepia", tăng cỡ chữ lên 20px và chọn font "Literata",
  * `Then` giao diện lập tức áp dụng màu nền `#F4ECD8`, cỡ chữ 20px, font Literata và tự động lưu cấu hình này vào LocalStorage cho các chương tiếp theo.

---

## 3. PHÂN HỆ STUDIO ĐĂNG TẢI & DỊCH AI (AI TRANSLATION FRs)

### FR-AI-01: Luồng Xử Lý Dịch Tự Động & Popup 2 Lựa Chọn (Overwrite vs Duplicate)
* **Mô tả:** Xử lý file raw tải lên, gọi AI Worker xử lý ngầm và hiển thị popup cho Uploader quyết định phương án xuất bản.
* **Tiêu chí nghiệm thu (Acceptance Criteria):**
  * `Given` Uploader đã tải lên file ZIP gồm 30 trang ảnh Manga và bấm "Dịch tự động bằng AI",
  * `When` AI Worker hoàn tất xử lý 100% các bước (OCR, Dịch, Inpaint, Typeset),
  * `Then` giao diện hiển thị màn hình Diff Preview và bật Popup hiển thị 2 lựa chọn:
    * (1) *Ghi đè file cũ:* Cập nhật `chapter.active_version_id = translated_version_id` và di chuyển raw vào backup.
    * (2) *Nhân bản tạo bản riêng:* Tạo một Chapter mới mang nhãn `[Bản Dịch AI]` liên kết với bản gốc.
* **Xử lý trạng thái (States):**
  * *Validation Error State:* Nếu file ZIP chứa file không phải ảnh (ví dụ: file `.exe`, file text độc hại) $\rightarrow$ Báo lỗi *"Tệp tin chứa định dạng không được hỗ trợ"*.
  * *Queue Processing State:* Hiển thị thanh tiến trình % thực tế (Stage: OCR 15/30 pages $\rightarrow$ Overall: 45%).
  * *AI Failure State:* Nếu API AI bị lỗi quota/timeout $\rightarrow$ Hiển thị nút "Thử lại tác vụ" hoặc "Hủy bỏ giữ bản raw".

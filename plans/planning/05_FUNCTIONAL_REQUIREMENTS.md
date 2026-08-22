# ⚙️ 05. Bảng Đặc Tả Yêu Cầu Chức Năng & Tiêu Chí Nghiệm Thu (Functional Requirements)

Tài liệu này đặc tả toàn bộ các Yêu Cầu Chức Năng (**Functional Requirements - FR**) tương ứng với các User Requirements (P0/P1), kèm tiêu chí nghiệm thu kiểm thử chuẩn **Acceptance Criteria (Given-When-Then)** và các trạng thái ngoại lệ (**Loading, Error, Empty, Fallback, Rate Limited States**).

---

## 1. PHÂN HỆ XÁC THỰC & TÀI KHOẢN (AUTH FRs)

### FR-AUTH-01: Đăng Ký Tài Khoản Mới
* **Mô tả:** Tiếp nhận thông tin đăng ký (Email, Username, Password) và khởi tạo tài khoản mới.
* **Tiêu chí nghiệm thu (Acceptance Criteria):**
  * `Given` người dùng chưa có tài khoản trong hệ thống,
  * `When` người dùng gửi `POST /api/v1/auth/register` với Email hợp lệ, Username chưa tồn tại và mật khẩu $\ge 8$ ký tự,
  * `Then` hệ thống băm mật khẩu bằng Argon2id, lưu bản ghi vào `users`, khởi tạo `user_progression` (Level 1, 0 EXP, 0 OmniCoin) và trả về `201 Created`.
* **Xử lý ngoại lệ:** Nếu Email hoặc Username đã tồn tại $\rightarrow$ Trả về `409 Conflict` (`AUTH_EMAIL_EXISTS` / `AUTH_USERNAME_EXISTS`).

### FR-AUTH-02: Đăng Nhập & Cấp Phát Token Kép (JWT Rotation)
* **Mô tả:** Xác thực danh tính và trả về Access Token (15 phút) cùng Refresh Token (7 ngày).
* **Tiêu chí nghiệm thu (Acceptance Criteria):**
  * `Given` người dùng đã đăng ký tài khoản hợp lệ,
  * `When` người dùng gửi `POST /api/v1/auth/login` đúng email/mật khẩu,
  * `Then` hệ thống trả về `200 OK` chứa Access Token trong response body và Refresh Token lưu trong HttpOnly Secure Cookie (Web) hoặc Secure Storage (Mobile).

### FR-AUTH-03: Đăng Xuất & Thu Hồi Phiên (Session Revocation)
* **Mô tả:** Vô hiệu hóa Refresh Token hiện tại và xóa phiên đăng nhập trên Redis.
* **Tiêu chí nghiệm thu:**
  * `Given` người dùng đang có phiên đăng nhập hợp lệ,
  * `When` người dùng gửi `POST /api/v1/auth/logout`,
  * `Then` hệ thống xóa Refresh Token tương ứng khỏi Redis và xóa Cookie ở client.

---

## 2. PHÂN HỆ KHÁM PHÁ & TÌM KIẾM (DISCOVERY FRs)

### FR-DISC-01: Bảng Tin Trang Chủ & Slider Truyện Nổi Bật
* **Mô tả:** Trả về danh sách truyện HOT, truyện mới cập nhật và truyện phân theo thể loại.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả truy cập trang chủ,
  * `When` client gọi `GET /api/v1/stories/featured` và `GET /api/v1/stories/recent`,
  * `Then` hệ thống trả về danh sách kèm cache Redis L2 trong 60 giây, thời gian phản hồi p95 $< 100ms$.

### FR-DISC-02: Tìm Kiếm Nhanh Kèm Gợi Ý Tức Thì (Debounced Instant Search)
* **Mô tả:** Tìm kiếm truyện theo tiêu đề với cơ chế debounce 300ms.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả nhập chuỗi từ khóa $\ge 2$ ký tự vào ô tìm kiếm,
  * `When` client gọi `GET /api/v1/stories/search?q=...`,
  * `Then` hệ thống sử dụng PostgreSQL Trigram/Full-Text Search và trả về tối đa 10 gợi ý khớp nhất kèm ảnh bìa và tác giả.

### FR-DISC-03: Bộ Lọc Truyện Đa Tiêu Chí (Explore Catalog)
* **Mô tả:** Lọc truyện kết hợp theo Thể loại, Định dạng (Comic/Novel), Tình trạng và Quốc gia.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả chọn lọc Genre = "Action" và MediaFormat = "COMIC",
  * `When` client gửi `GET /api/v1/stories?genre=action&format=COMIC&page=1&limit=20`,
  * `Then` hệ thống trả về danh sách truyện phân trang chuẩn kèm tổng số trang `totalPages`.

### FR-DISC-04: Bảng Xếp Hạng Độc Giả (Leaderboards)
* **Mô tả:** Thống kê và hiển thị Top truyện theo lượt xem Ngày, Tuần, Tháng.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả mở tab Rankings,
  * `When` client gọi `GET /api/v1/stories/rankings?timeframe=weekly`,
  * `Then` hệ thống truy xuất từ Redis Sorted Sets và trả về bảng xếp hạng được cập nhật mỗi giờ.

### FR-DISC-05: Trang Chi Tiết & Cây Phân Cấp Mục Lục (Hierarchy Navigation)
* **Mô tả:** Hiển thị thông tin truyện và cây phân cấp: `Story` $\rightarrow$ `StoryEdition` $\rightarrow$ `Volume` $\rightarrow$ `Chapter`.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả mở trang chi tiết một bộ truyện theo slug,
  * `When` client gọi `GET /api/v1/stories/:slug`,
  * `Then` hệ thống trả về thông tin tác giả, danh mục thể loại, các ấn bản và danh sách các tập/chương kèm chỉ số `active_version_id`.

---

## 3. PHÂN HỆ ĐỌC TRUYỆN TRANH (MANGA & WEBTOON FRs)

### FR-MANGA-01: Trình Đọc Webtoon Cuộn Dọc Tối Ưu RAM 120Hz
* **Mô tả:** Nạp danh sách trang ảnh theo chiều dọc liên tục, đảm bảo cuộn mượt mà và giải phóng RAM tự động.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả mở một chapter Manga có 50 trang ảnh trên thiết bị di động màn hình 120Hz,
  * `When` độc giả vuốt cuộn nhanh qua 20 trang ảnh,
  * `Then` hệ thống hiển thị ảnh mượt mà không khựng hình (Frame time $< 8.33ms$), bộ nhớ RAM tiêu thụ $< 150MB$, các trang ảnh cách xa hơn 3 màn hình được giải phóng khỏi RAM.

### FR-MANGA-02: Trình Đọc Manga Lật Từng Trang (Paged Mode)
* **Mô tả:** Hiển thị từng trang đơn hoặc đôi, hỗ trợ thao tác lật trang phải $\rightarrow$ trái chuẩn Manga Nhật Bản và phóng to pinch-to-zoom.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả bật chế độ đọc lật trang,
  * `When` độc giả vuốt từ phải sang trái hoặc bấm cạnh màn hình,
  * `Then` hệ thống chuyển trang tức thì với animation mượt mà và tải trước ngầm 2 trang tiếp theo.

### FR-MANGA-03: Bộ Chọn Server Ảnh CDN (CDN Selector & Fallback)
* **Mô tả:** Cho phép chuyển đổi nguồn phân phối hình ảnh khi gặp sự cố mạng.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả đang đọc tại trang số 15 với Server hiện tại là "Server VIP",
  * `When` độc giả chọn "Server CDN 1" trên thanh điều khiển,
  * `Then` hệ thống chuyển đổi URL nguồn ảnh sang domain CDN dự phòng mà vẫn giữ nguyên vị trí trang số 15 đang đọc dở.
  * *Fallback State:* Nếu Server VIP bị timeout quá 3 giây, hệ thống tự động fallback sang CDN 1 kèm toast thông báo nhẹ.

### FR-MANGA-04: Bộ Chuyển Đổi Phiên Bản Ngôn Ngữ (Version Switcher)
* **Mô tả:** Cho phép độc giả chuyển đổi giữa Bản Raw Gốc, Bản Dịch AI và Bản Dịch Human.
* **Tiêu chí nghiệm thu:**
  * `Given` chương truyện có cả bản Raw và bản dịch tiếng Việt,
  * `When` độc giả chọn "Bản Raw Gốc" trên thanh công cụ đọc truyện,
  * `Then` hệ thống tải các trang ảnh thuộc về `ChapterVersion` tương ứng mà không làm thay đổi vị trí trang hiện tại.

---

## 4. PHÂN HỆ ĐỌC TRUYỆN CHỮ (LIGHT NOVEL FRs)

### FR-NOVEL-01: Bộ Điều Khiển Typography & Đổi Theme Nền
* **Mô tả:** Tùy biến font chữ, cỡ chữ, line-height và màu nền đọc truyện chữ.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả đang đọc chương Light Novel,
  * `When` độc giả chọn theme "Vàng Sepia", tăng cỡ chữ lên 20px và chọn font "Literata",
  * `Then` giao diện lập tức áp dụng màu nền `#F4ECD8`, cỡ chữ 20px và tự động lưu cấu hình này vào LocalStorage cho các chương tiếp theo.

### FR-NOVEL-02: Bộ Sưu Tập Ảnh Minh Họa (Illustration Gallery Modal)
* **Mô tả:** Hiển thị ảnh minh họa xen kẽ trong văn bản hoặc xem tập trung trong modal.
* **Tiêu chí nghiệm thu:**
  * `Given` chương tiểu thuyết có chứa 3 ảnh minh họa,
  * `When` độc giả bấm vào ảnh minh họa hoặc mở tab "Ảnh Minh Họa",
  * `Then` hệ thống hiển thị modal ảnh độ phân giải cao kèm tính năng zoom và vuốt chuyển ảnh.

### FR-NOVEL-03: Thanh Mục Lục Trượt (Drawer Index Navigation)
* **Mô tả:** Mở thanh mục lục trượt từ mép màn hình để nhảy chương tức thì.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả đang đọc truyện chữ,
  * `When` độc giả vuốt từ mép trái hoặc bấm icon Mục Lục,
  * `Then` thanh Drawer hiển thị danh sách toàn bộ các tập/chương, làm nổi bật chương hiện tại và cho phép nhảy chương tức thì.

### FR-NOVEL-04: Neo Vị Trí Đọc Theo Block Đoạn Văn (Novel Position Anchoring)
* **Mô tả:** Lưu vị trí đọc dở dựa trên ID block đoạn văn thay vì phần trăm pixel cuộn thuần túy.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả đang đọc đến đoạn văn bản `block-id-42`,
  * `When` độc giả thay đổi cỡ chữ từ 16px lên 24px hoặc đổi thiết bị,
  * `Then` hệ thống tự động cuộn chính xác đến vị trí `block-id-42` mà không bị lệch vị trí đọc.

---

## 5. PHÂN HỆ TỦ SÁCH & TIẾN ĐỘ ĐỌC (LIBRARY FRs)

### FR-LIB-01: Đồng Bộ Tiến Độ Đọc Đa Thiết Bị (Reading Progress Sync)
* **Mô tả:** Tự động gửi heartbeat lưu tiến độ đọc lên server và đồng bộ đa thiết bị.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả đã đăng nhập đọc truyện trên Web đến Trang 25,
  * `When` độc giả mở ứng dụng Mobile trên điện thoại,
  * `Then` ứng dụng Mobile hiển thị nút "Đọc tiếp" và mở ngay Trang 25 của chương đó.

### FR-LIB-02: Theo Dõi & Đánh Dấu Truyện (Follow / Bookmark)
* **Mô tả:** Thêm/bớt truyện vào tủ sách cá nhân.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả đang ở trang chi tiết bộ truyện,
  * `When` độc giả bấm "Theo dõi",
  * `Then` hệ thống tạo bản ghi `bookmarks`, tăng `followers_count` thêm 1 và hiển thị truyện trong mục `/library`.

---

## 6. PHÂN HỆ STUDIO ĐĂNG TẢI & DỊCH AI (STUDIO & AI FRs)

### FR-AI-01: Tải Lên Tập Tin & Quét An Toàn File (ZIP Sanitization)
* **Mô tả:** Tiếp nhận file ZIP ảnh Manga hoặc Text/EPUB, kiểm tra Magic Bytes và ngăn chặn Zip Slip/Zip Bomb.
* **Tiêu chí nghiệm thu:**
  * `Given` uploader tải lên file ZIP gồm 30 trang ảnh,
  * `When` client gửi `POST /api/v1/uploads/sessions`,
  * `Then` hệ thống kiểm tra file hợp lệ, giải nén an toàn trong thư mục tạm, lưu file vào MinIO và trả về session upload thành công.
  * *Security State:* Nếu phát hiện file `.exe`, file path traversal (`../`) hoặc tỷ lệ nén bất thường ($>100:1$) $\rightarrow$ Từ chối và trả về `400 Bad Request`.

### FR-AI-02: Khởi Tạo Tác Vụ Dịch AI & Stream Tiến Trình Thời Gian Thực
* **Mô tả:** Đẩy task vào hàng đợi BullMQ và phát event tiến trình qua WebSocket.
* **Tiêu chí nghiệm thu:**
  * `Given` uploader chọn "Dịch tự động bằng AI",
  * `When` client gửi `POST /api/v1/ai/jobs`,
  * `Then` hệ thống tạo `TranslationJob` trạng thái `QUEUED`, NestJS đẩy vào BullMQ và phát event `%` tiến trình qua WebSocket đến màn hình Studio.

### FR-AI-03: Xem Trước Diff & Áp Dụng Phiên Bản Xuất Bản (Overwrite vs Duplicate)
* **Mô tả:** Hiển thị màn hình so sánh trước/sau khi dịch và popup 2 phương án xuất bản chuẩn Semantics.
* **Tiêu chí nghiệm thu:**
  * `Given` AI Worker hoàn tất xử lý 100% các trang truyện,
  * `When` uploader xem màn hình Diff Preview và chọn phương án xuất bản:
    * *(1) Ghi đè (Overwrite):* Gửi `POST /api/v1/ai/jobs/:id/apply` với `mode: OVERWRITE_ACTIVE_VERSION` $\rightarrow$ Hệ thống cập nhật `chapter.active_version_id = translated_version_id`, giữ nguyên bản raw gốc bất biến.
    * *(2) Nhân bản (Duplicate):* Gửi `POST /api/v1/ai/jobs/:id/apply` với `mode: CREATE_ALTERNATE_VERSION` $\rightarrow$ Hệ thống tạo `ChapterVersion` mới mang nhãn `[Bản Dịch AI]`, giữ nguyên `active_version_id` hiện tại và hiển thị trong menu chọn bản dịch.

### FR-AI-04: Quản Lý Từ Điển Thuật Ngữ (Glossary Management)
* **Mô tả:** Thêm, sửa, xóa các cặp từ khóa cố định (Tên nhân vật, chiêu thức) để ép AI dịch chuẩn xác.
* **Tiêu chí nghiệm thu:**
  * `Given` thành viên nhóm dịch thêm cặp từ `"Rasengan" $\rightarrow$ "Loa Toàn Hoàn"`,
  * `When` AI Worker thực hiện dịch trang truyện có chứa từ "Rasengan",
  * `Then` hệ thống tự động thay thế bằng "Loa Toàn Hoàn" bất kể kết quả sinh tự do của LLM.

---

## 7. PHÂN HỆ QUẢN TRỊ HỆ THỐNG & BÁO LỖI (ADMIN FRs)

### FR-ADM-01: Tiếp Nhận & Xử Lý Báo Lỗi Chương (Report Resolution)
* **Mô tả:** Cho phép độc giả gửi báo lỗi và Admin kiểm tra, đóng báo cáo.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả gửi báo lỗi "Trang 5 bị nhòe",
  * `When` Admin xem danh sách báo lỗi tại `/admin/reports` và bấm "Đã khắc phục",
  * `Then` hệ thống cập nhật trạng thái `chapter_error_reports.status = 'RESOLVED'` và ghi nhận `resolved_by`.

### FR-ADM-02: Quản Lý Người Dùng & Phân Quyền Toàn Cục
* **Mô tả:** Admin cấp quyền Translator, Moderator hoặc khóa tài khoản vi phạm.
* **Tiêu chí nghiệm thu:**
  * `Given` Admin thực hiện cập nhật role cho một user,
  * `When` Admin gửi `PATCH /api/v1/admin/users/:id/role` với `role: TRANSLATOR`,
  * `Then` hệ thống cập nhật quyền trong CSDL, xóa cache phân quyền của user trong Redis và áp dụng quyền mới ngay lập tức.

### FR-ADM-03: Kiểm Duyệt Nội Dung & Takedown Bản Quyền
* **Mô tả:** Ẩn hoặc xóa các nội dung truyện/chương vi phạm tiêu chuẩn hoặc bản quyền.
* **Tiêu chí nghiệm thu:**
  * `Given` Admin nhận khiếu nại bản quyền hợp lệ,
  * `When` Admin chuyển trạng thái bộ truyện sang `visibility: PRIVATE`,
  * `Then` bộ truyện lập tức biến mất khỏi danh sách công khai và API chặn truy cập từ độc giả thông thường.

---

## 8. PHÂN HỆ TIẾN TRÌNH & GAMIFICATION (GAMIFICATION FRs)

### FR-GAM-01: Điểm Danh Hàng Ngày & Tích Lũy Chuỗi Streak (Atomic Transaction)
* **Mô tả:** Độc giả bấm điểm danh mỗi ngày để nhận OmniCoin, EXP và tăng chuỗi streak liên tục.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả đã đăng nhập và chưa điểm danh trong ngày hôm nay (`Asia/Ho_Chi_Minh`),
  * `When` độc giả gửi `POST /api/v1/gamification/checkin`,
  * `Then` hệ thống chạy transaction nguyên tử (Atomic): Ghi bản ghi `daily_checkins`, cộng OmniCoin/EXP vào ví, tạo transaction trong `reward_transactions`, tăng `current_streak` thêm 1 và trả về `200 OK`.
  * *Duplicate Check:* Nếu độc giả bấm lại lần 2 trong ngày $\rightarrow$ Trả về `400 Bad Request` (`CHECKIN_ALREADY_CLAIMED`) và không thay đổi số dư.

### FR-GAM-02: Tích Lũy EXP & Thăng Cấp Tài Khoản (Anti-Farming Gate)
* **Mô tả:** Cộng EXP khi đọc hoàn thành một chapter hợp lệ (đọc tối thiểu 45 giây và cuộn qua 80% nội dung).
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả đọc xong một chapter mới chưa từng nhận thưởng trước đó,
  * `When` client gửi event hoàn thành chapter,
  * `Then` hệ thống kiểm tra quy tắc: Chỉ nhận 1 lần / user / chapter và không vượt quá giới hạn 100 EXP/ngày từ hoạt động đọc $\rightarrow$ Cộng +5 EXP và kiểm tra nếu vượt ngưỡng EXP sẽ tự động tăng Level và bắn event `UserLevelUpEvent`.

### FR-GAM-03: Lựa Chọn Bộ Chủ Đề Danh Hiệu (Rank Themes Selection)
* **Mô tả:** Cho phép độc giả chọn bộ theme danh hiệu hiển thị (Tu Tiên, Game Thủ, Ma Vương, Pháp Sư, Tinh Không) theo Level hiện tại.
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả đạt Level 12 và đang ở theme mặc định,
  * `When` độc giả chọn theme "Tu Tiên" qua API `PATCH /api/v1/gamification/rank-theme`,
  * `Then` hệ thống cập nhật `rank_theme = 'TU_TIEN'` và profile hiển thị danh hiệu tương ứng (ví dụ: *"Kim Đan Sơ Kỳ"*).

### FR-GAM-04: Nhận Thưởng Cột Mốc Level (Level Rewards Claim)
* **Mô tả:** Mở khóa và nhận phần thưởng OmniCoin/Badge tại các mốc Level (Level 5, 10, 20, 50).
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả vừa thăng cấp lên Level 10 và chưa claim thưởng mốc Level 10,
  * `When` độc giả bấm "Nhận Thưởng Level 10",
  * `Then` hệ thống ghi nhận `level_rewards_claimed`, cộng 100 OmniCoin vào ví và ghi transaction sổ cái.

### FR-GAM-05: Sổ Cái Biến Động Số Dư Bất Biến (Immutable Transaction Ledger)
* **Mô tả:** Ghi nhận và truy vấn lịch sử biến động số dư EXP và OmniCoin theo cơ chế sổ cái đơn bất biến (Single-entry Immutable Ledger).
* **Tiêu chí nghiệm thu:**
  * `Given` độc giả muốn xem lịch sử nhận điểm thưởng,
  * `When` client gửi `GET /api/v1/gamification/transactions?page=1&limit=20`,
  * `Then` hệ thống trả về danh sách lịch sử gồm `reward_type`, `amount`, `balance_after`, `source_type` (CHECKIN, READ_CHAPTER, LEVEL_REWARD) và `created_at`.

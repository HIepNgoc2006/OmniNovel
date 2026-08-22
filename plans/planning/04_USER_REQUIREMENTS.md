# 📋 04. Bảng Yêu Cầu Người Dùng Theo Phân Hệ Nghiệp Vụ (User Requirements)

Tài liệu này xác định toàn bộ các Yêu cầu Người Dùng (**User Requirements - UR**) được phân bổ theo 9 phân hệ nghiệp vụ, phân loại mức độ ưu tiên theo chuẩn **MoSCoW (Must, Should, Could, Won't)** và mức độ ưu tiên kỹ thuật (**P0, P1, P2, P3**).

---

## 📌 QUY ƯỚC VAI TRÒ & PHÂN QUYỀN (ROLES & MEMBERSHIP DEFINITION)

Để đảm bảo tính nhất quán trong toàn bộ hệ thống, OmniNovel phân biệt rõ 2 khái niệm:
1. **Global User Role (Vai trò Toàn cục trong Hệ thống):**
   * `READER`: Người dùng thông thường (Đọc truyện, Tủ sách cá nhân, Gamification).
   * `TRANSLATOR`: Thành viên được cấp quyền sử dụng Studio và AI Translation Hub.
   * `ADMIN`: Quản trị viên tối cao (Quản lý người dùng, xử lý báo lỗi, kiểm duyệt nội dung).
2. **Story Membership Role (Vai trò Thành viên theo từng Bộ truyện cụ thể - `story_members`):**
   * `OWNER`: Người tạo bộ truyện, có toàn quyền cao nhất trên bộ truyện đó.
   * `EDITOR`: Có quyền chỉnh sửa metadata, tạo tập (Volume), duyệt và xuất bản chương.
   * `TRANSLATOR`: Có quyền tạo task dịch AI và tải lên các bản dịch mới trong bộ truyện.
   * `UPLOADER`: Có quyền tải lên file raw và chương mới.

---

## 1. PHÂN HỆ XÁC THỰC & TÀI KHOẢN (AUTH DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Vai Trò Áp Dụng | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :---: | :--- | :---: |
| **UR-AUTH-01** | Độc giả có thể đăng ký tài khoản mới bằng Email/Username và mật khẩu an toàn. | Guest | **Must Have** | **P0** |
| **UR-AUTH-02** | Độc giả có thể đăng nhập an toàn nhận phiên làm việc duy trì đăng nhập (Remember Me). | Guest | **Must Have** | **P0** |
| **UR-AUTH-03** | Người dùng có thể đăng xuất và thu hồi phiên làm việc trên thiết bị hiện tại. | Reader | **Must Have** | **P0** |
| **UR-AUTH-04** | Người dùng có thể cập nhật thông tin cá nhân (Ảnh đại diện Avatar, Đổi mật khẩu). | Reader | **Should Have**| **P1** |
| **UR-AUTH-05** | Người dùng có thể yêu cầu đặt lại mật khẩu qua email xác thực khi quên mật khẩu. | Guest | **Should Have**| **P1** |

---

## 2. PHÂN HỆ KHÁM PHÁ & TÌM KIẾM (DISCOVERY DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Vai Trò Áp Dụng | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :---: | :--- | :---: |
| **UR-DISC-01** | Độc giả có thể duyệt xem các bộ truyện nổi bật (Slider HOT) và danh sách truyện mới cập nhật. | Guest / Reader | **Must Have** | **P0** |
| **UR-DISC-02** | Độc giả có thể tìm kiếm nhanh tên truyện với gợi ý tức thì kèm ảnh bìa khi gõ từ khóa. | Guest / Reader | **Must Have** | **P0** |
| **UR-DISC-03** | Độc giả có thể lọc truyện đa tiêu chí kết hợp: Thể loại, Trạng thái, Quốc gia xuất xứ. | Guest / Reader | **Must Have** | **P0** |
| **UR-DISC-04** | Độc giả có thể xem Bảng xếp hạng truyện theo Top Ngày, Top Tuần, Top Tháng, Top All-Time. | Guest / Reader | **Must Have** | **P0** |
| **UR-DISC-05** | Độc giả có thể xem chi tiết thông tin bộ truyện, tóm tắt và cây mục lục Ấn bản $\rightarrow$ Tập $\rightarrow$ Chương. | Guest / Reader | **Must Have** | **P0** |

---

## 3. PHÂN HỆ TRẢI NGHIỆM ĐỌC TRUYỆN TRANH (MANGA READER DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Vai Trò Áp Dụng | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :---: | :--- | :---: |
| **UR-MANGA-01**| Độc giả có thể đọc truyện tranh chế độ Cuộn Dọc liên tục (Webtoon) siêu mượt trên màn hình 120Hz. | Guest / Reader | **Must Have** | **P0** |
| **UR-MANGA-02**| Độc giả có thể đọc truyện tranh chế độ Lật Từng Trang (Manga) hỗ trợ lật phải $\rightarrow$ trái và phóng to. | Guest / Reader | **Must Have** | **P0** |
| **UR-MANGA-03**| Độc giả có thể đổi Server ảnh CDN (Server VIP, CDN 1, CDN 2) ngay tại giao diện đọc khi mạng lag. | Guest / Reader | **Must Have** | **P0** |
| **UR-MANGA-04**| Độc giả có thể tùy chỉnh giãn cách trang ảnh (0px, 5px, 10px) và bật chế độ tự động cuộn trang. | Reader | **Should Have**| **P1** |
| **UR-MANGA-05**| Độc giả có thể chuyển đổi qua lại giữa Bản Raw Gốc và Bản Dịch AI/Human tại thanh điều khiển. | Guest / Reader | **Must Have** | **P0** |
| **UR-MANGA-06**| Độc giả có thể gửi Báo lỗi chương (ảnh hỏng, sai trang, load chậm) về cho đội ngũ quản trị. | Reader | **Should Have**| **P1** |

---

## 4. PHÂN HỆ TRẢI NGHIỆM ĐỌC TRUYỆN CHỮ (NOVEL READER DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Vai Trò Áp Dụng | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :---: | :--- | :---: |
| **UR-NOVEL-01**| Độc giả có thể đọc nội dung tiểu thuyết Light Novel với định dạng văn bản chuẩn mực. | Guest / Reader | **Must Have** | **P0** |
| **UR-NOVEL-02**| Độc giả có thể tùy biến Typography: Thay đổi cỡ chữ (14–36px), font chữ, chiều cao dòng và canh lề. | Reader | **Must Have** | **P0** |
| **UR-NOVEL-03**| Độc giả có thể chuyển đổi màu nền đọc: Trắng sáng, Vàng Sepia ấm áp, Xám dịu và Đen OLED. | Reader | **Must Have** | **P0** |
| **UR-NOVEL-04**| Độc giả có thể xem toàn bộ ảnh minh họa của tập truyện trong tab Gallery và phóng to độ nét cao. | Guest / Reader | **Must Have** | **P0** |
| **UR-NOVEL-05**| Độc giả có thể mở thanh mục lục trượt (Drawer Index) từ mép màn hình để nhảy chương tức thì. | Guest / Reader | **Must Have** | **P0** |

---

## 5. PHÂN HỆ TỦ SÁCH & TIẾN ĐỘ ĐỌC (LIBRARY & OFFLINE DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Vai Trò Áp Dụng | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :---: | :--- | :---: |
| **UR-LIB-01** | Hệ thống tự động ghi nhớ và đồng bộ vị trí đọc dở (theo trang Manga hoặc anchor block Novel). | Reader | **Must Have** | **P0** |
| **UR-LIB-02** | Độc giả có thể thêm bộ truyện vào danh sách Theo dõi (Follow / Bookmark) để nhận thông báo. | Reader | **Must Have** | **P0** |
| **UR-LIB-03** | Độc giả có thể tải toàn bộ chương truyện tranh hoặc truyện chữ về máy để đọc khi mất mạng. | Reader | **Should Have**| **P1** |
| **UR-LIB-04** | Độc giả có thể phân loại tủ sách cá nhân theo trạng thái: Đang đọc, Đã đọc xong, Dự định đọc. | Reader | **Could Have** | **P2** |

---

## 6. PHÂN HỆ STUDIO ĐĂNG TẢI & DỊCH AI (STUDIO & AI DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Vai Trò Áp Dụng | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :---: | :--- | :---: |
| **UR-AI-01** | Thành viên có quyền có thể tạo bộ truyện, ấn bản (StoryEdition) và phân quyền StoryMember. | Translator/Owner| **Must Have** | **P0** |
| **UR-AI-02** | Thành viên có thể tải lên tập truyện mới qua file ZIP ảnh Manga hoặc file Text/EPUB. | Uploader/Member | **Must Have** | **P0** |
| **UR-AI-03** | Thành viên có thể kích hoạt dịch tự động bằng AI và theo dõi tiến trình xử lý thời gian thực. | Translator/Member| **Must Have** | **P0** |
| **UR-AI-04** | Thành viên có thể xem màn hình so sánh (Diff Preview) giữa bản raw gốc và bản dịch tiếng Việt. | Translator/Member| **Must Have** | **P0** |
| **UR-AI-05** | Thành viên có thể chọn **Phương án 1 (Ghi đè - Overwrite)** để trỏ `active_version_id` sang bản dịch mới. | Translator/Owner | **Must Have** | **P0** |
| **UR-AI-06** | Thành viên có thể chọn **Phương án 2 (Nhân bản - Duplicate)** để tạo ChapterVersion mới độc lập. | Translator/Owner | **Must Have** | **P0** |
| **UR-AI-07** | Thành viên có thể quản lý Từ điển thuật ngữ (Glossary) để ép AI dịch nhất quán tên riêng, chiêu thức. | Translator/Member| **Should Have**| **P1** |
| **UR-AI-08** | Thành viên có thể chỉnh sửa trực tiếp text trong từng bóng thoại (Translation Editor) trước khi xuất bản. | Translator/Member| **Should Have**| **P1** |

---

## 7. PHÂN HỆ TƯƠNG TÁC CỘNG ĐỒNG (COMMUNITY DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Vai Trò Áp Dụng | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :---: | :--- | :---: |
| **UR-COM-01** | Độc giả có thể viết bình luận, phản hồi bình luận theo từng chương truyện. | Reader | **Should Have**| **P1** |
| **UR-COM-02** | Độc giả có thể gắn thẻ `[spoiler]` để làm mờ nội dung bình luận tiết lộ trước cốt truyện. | Reader | **Should Have**| **P1** |
| **UR-COM-03** | Độc giả có thể đánh giá điểm sao (1 đến 5 sao) cho bộ truyện. | Reader | **Should Have**| **P1** |
| **UR-COM-04** | Độc giả có thể thả bình luận trực tiếp vào từng khung tranh cụ thể (Inline Panel Comments). | Reader | **Could Have** | **P2** |

---

## 8. PHÂN HỆ QUẢN TRỊ HỆ THỐNG (ADMIN DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Vai Trò Áp Dụng | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :---: | :--- | :---: |
| **UR-ADM-01** | Admin có thể xem danh sách và xử lý các báo cáo lỗi chương truyện từ độc giả. | Admin | **Must Have** | **P0** |
| **UR-ADM-02** | Admin có thể quản lý danh sách người dùng, cấp quyền Global Translator và khóa tài khoản vi phạm. | Admin | **Must Have** | **P0** |
| **UR-ADM-03** | Admin có thể kiểm duyệt, ẩn hoặc xóa các nội dung truyện/bình luận vi phạm tiêu chuẩn cộng đồng. | Admin | **Must Have** | **P0** |
| **UR-ADM-04** | Admin có thể xem dashboard thống kê lượt đọc, lưu lượng MinIO và lượng Token AI tiêu thụ. | Admin | **Should Have**| **P1** |

---

## 9. PHÂN HỆ TIẾN TRÌNH & GAMIFICATION (GAMIFICATION DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Vai Trò Áp Dụng | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :---: | :--- | :---: |
| **UR-GAM-01** | Độc giả có thể tích lũy EXP qua các hoạt động đọc hợp lệ để tăng Level (chống farm reload). | Reader | **Must Have** | **P0** |
| **UR-GAM-02** | Độc giả có thể điểm danh hàng ngày theo lịch tháng để nhận EXP, OmniCoin và duy trì chuỗi streak. | Reader | **Must Have** | **P0** |
| **UR-GAM-03** | Độc giả có thể chọn bộ chủ đề Cấp bậc (Rank Theme: Tu Tiên, Ma Vương, Magic...) hiển thị trên Profile. | Reader | **Must Have** | **P0** |
| **UR-GAM-04** | Độc giả có thể nhận phần thưởng mở khóa tại các cột mốc Level nhất định (Level Rewards). | Reader | **Must Have** | **P0** |
| **UR-GAM-05** | Độc giả có thể xem lịch sử biến động số dư OmniCoin & EXP chi tiết qua sổ cái bất biến (Ledger History).| Reader | **Must Have** | **P0** |
| **UR-GAM-06** | Độc giả có thể thực hiện và nhận thưởng từ Nhiệm vụ ngày/tuần (Daily/Weekly Missions). | Reader | **Should Have**| **P1** |
| **UR-GAM-07** | Độc giả có thể mở khóa và trưng bày Huy hiệu Thành tựu (Achievements & Badges) trên Profile. | Reader | **Should Have**| **P1** |
| **UR-GAM-08** | Độc giả có thể sử dụng OmniCoin để đổi các vật phẩm trang trí (Cosmetics, Frames, Themes). | Reader | **Could Have** | **P2** |

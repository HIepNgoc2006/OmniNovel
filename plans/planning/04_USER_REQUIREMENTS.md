# 📋 04. Bảng Yêu Cầu Người Dùng Theo Phân Hệ Nghiệp Vụ (User Requirements)

Tài liệu này xác định toàn bộ các Yêu cầu Người Dùng (**User Requirements - UR**) được phân bổ theo 8 phân hệ nghiệp vụ, phân loại mức độ ưu tiên theo chuẩn **MoSCoW (Must, Should, Could, Won't)** và mức độ ưu tiên kỹ thuật (**P0, P1, P2, P3**).

---

## 1. PHÂN HỆ XÁC THỰC & TÀI KHOẢN (AUTH DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :--- | :---: |
| **UR-AUTH-01** | Độc giả có thể đăng ký tài khoản mới bằng Email/Username và mật khẩu an toàn. | **Must Have** | **P0** |
| **UR-AUTH-02** | Độc giả có thể đăng nhập an toàn nhận phiên làm việc duy trì đăng nhập (Remember Me). | **Must Have** | **P0** |
| **UR-AUTH-03** | Người dùng có thể đăng xuất và thu hồi phiên làm việc trên thiết bị hiện tại. | **Must Have** | **P0** |
| **UR-AUTH-04** | Người dùng có thể cập nhật thông tin cá nhân (Ảnh đại diện Avatar, Đổi mật khẩu). | **Should Have**| **P1** |
| **UR-AUTH-05** | Người dùng có thể yêu cầu đặt lại mật khẩu qua email xác thực khi quên mật khẩu. | **Should Have**| **P1** |

---

## 2. PHÂN HỆ KHÁM PHÁ & TÌM KIẾM (DISCOVERY DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :--- | :---: |
| **UR-DISC-01** | Độc giả có thể duyệt xem các bộ truyện nổi bật (Slider HOT) và danh sách truyện mới cập nhật. | **Must Have** | **P0** |
| **UR-DISC-02** | Độc giả có thể tìm kiếm nhanh tên truyện với gợi ý tức thì kèm ảnh bìa khi gõ từ khóa. | **Must Have** | **P0** |
| **UR-DISC-03** | Độc giả có thể lọc truyện đa tiêu chí kết hợp: Thể loại, Trạng thái, Quốc gia xuất xứ. | **Must Have** | **P0** |
| **UR-DISC-04** | Độc giả có thể xem Bảng xếp hạng truyện theo Top Ngày, Top Tuần, Top Tháng, Top All-Time. | **Must Have** | **P0** |
| **UR-DISC-05** | Độc giả có thể xem chi tiết thông tin bộ truyện, tóm tắt nội dung và danh sách các tập/chương. | **Must Have** | **P0** |

---

## 3. PHÂN HỆ TRẢI NGHIỆM ĐỌC TRUYỆN TRANH (MANGA READER DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :--- | :---: |
| **UR-MANGA-01**| Độc giả có thể đọc truyện tranh chế độ Cuộn Dọc liên tục (Webtoon) siêu mượt trên màn hình 120Hz. | **Must Have** | **P0** |
| **UR-MANGA-02**| Độc giả có thể đọc truyện tranh chế độ Lật Từng Trang (Manga) hỗ trợ lật phải $\rightarrow$ trái và phóng to. | **Must Have** | **P0** |
| **UR-MANGA-03**| Độc giả có thể đổi Server ảnh CDN (Server VIP, CDN 1, CDN 2) ngay tại giao diện đọc khi mạng lag. | **Must Have** | **P0** |
| **UR-MANGA-04**| Độc giả có thể tùy chỉnh giãn cách trang ảnh (0px, 5px, 10px) và bật chế độ tự động cuộn trang. | **Should Have**| **P1** |
| **UR-MANGA-05**| Độc giả có thể chuyển đổi qua lại giữa Bản Raw Gốc và Bản Dịch AI Tiếng Việt tại thanh điều khiển. | **Must Have** | **P0** |
| **UR-MANGA-06**| Độc giả có thể gửi Báo lỗi chương (ảnh hỏng, sai trang, load chậm) về cho đội ngũ quản trị. | **Should Have**| **P1** |

---

## 4. PHÂN HỆ TRẢI NGHIỆM ĐỌC TRUYỆN CHỮ (NOVEL READER DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :--- | :---: |
| **UR-NOVEL-01**| Độc giả có thể đọc nội dung tiểu thuyết Light Novel với định dạng văn bản chuẩn mực. | **Must Have** | **P0** |
| **UR-NOVEL-02**| Độc giả có thể tùy biến Typography: Thay đổi cỡ chữ (14–36px), font chữ, chiều cao dòng và canh lề. | **Must Have** | **P0** |
| **UR-NOVEL-03**| Độc giả có thể chuyển đổi màu nền đọc: Trắng sáng, Vàng Sepia ấm áp, Xám dịu và Đen OLED. | **Must Have** | **P0** |
| **UR-NOVEL-04**| Độc giả có thể xem toàn bộ ảnh minh họa của tập truyện trong tab Gallery và phóng to độ nét cao. | **Must Have** | **P0** |
| **UR-NOVEL-05**| Độc giả có thể mở thanh mục lục trượt (Drawer Index) từ mép màn hình để nhảy chương tức thì. | **Must Have** | **P0** |

---

## 5. PHÂN HỆ TỦ SÁCH & ĐỌC OFFLINE (LIBRARY & OFFLINE DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :--- | :---: |
| **UR-LIB-01** | Hệ thống tự động ghi nhớ và đồng bộ chính xác vị trí chương/trang đang đọc dở trên các thiết bị. | **Must Have** | **P0** |
| **UR-LIB-02** | Độc giả có thể thêm bộ truyện vào danh sách Theo dõi (Follow / Bookmark) để nhận thông báo. | **Must Have** | **P0** |
| **UR-LIB-03** | Độc giả có thể tải toàn bộ chương truyện tranh hoặc truyện chữ về máy để đọc khi mất mạng. | **Should Have**| **P1** |
| **UR-LIB-04** | Độc giả có thể phân loại tủ sách cá nhân theo trạng thái: Đang đọc, Đã đọc xong, Dự định đọc. | **Could Have** | **P2** |

---

## 6. PHÂN HỆ STUDIO ĐĂNG TẢI & DỊCH AI (STUDIO & AI DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :--- | :---: |
| **UR-AI-01** | Uploader có thể tạo bộ truyện mới và thiết lập chế độ hiển thị (Private, Unlisted, Public). | **Must Have** | **P0** |
| **UR-AI-02** | Uploader có thể tải lên tập truyện mới qua file ZIP ảnh Manga hoặc file Text/EPUB. | **Must Have** | **P0** |
| **UR-AI-03** | Uploader có thể kích hoạt dịch tự động bằng AI và theo dõi tiến trình xử lý thời gian thực. | **Must Have** | **P0** |
| **UR-AI-04** | Uploader có thể xem màn hình so sánh (Diff Preview) giữa bản raw gốc và bản dịch tiếng Việt. | **Must Have** | **P0** |
| **UR-AI-05** | Uploader có thể chọn **Phương án 1 (Ghi đè file cũ)** để cập nhật trực tiếp bản dịch vào chương. | **Must Have** | **P0** |
| **UR-AI-06** | Uploader có thể chọn **Phương án 2 (Nhân bản)** để tạo một bản dịch độc lập song song với bản raw. | **Must Have** | **P0** |
| **UR-AI-07** | Uploader có thể quản lý Từ điển thuật ngữ (Glossary) để ép AI dịch nhất quán tên riêng, chiêu thức. | **Should Have**| **P1** |
| **UR-AI-08** | Uploader có thể chỉnh sửa trực tiếp text trong từng bóng thoại (Translation Editor) trước khi xuất bản. | **Should Have**| **P1** |

---

## 7. PHÂN HỆ TƯƠNG TÁC CỘNG ĐỒNG (COMMUNITY DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :--- | :---: |
| **UR-COM-01** | Độc giả có thể viết bình luận, phản hồi bình luận theo từng chương truyện. | **Should Have**| **P1** |
| **UR-COM-02** | Độc giả có thể gắn thẻ `[spoiler]` để làm mờ nội dung bình luận tiết lộ trước cốt truyện. | **Should Have**| **P1** |
| **UR-COM-03** | Độc giả có thể đánh giá điểm sao (1 đến 5 sao) cho bộ truyện. | **Should Have**| **P1** |
| **UR-COM-04** | Độc giả có thể thả bình luận trực tiếp vào từng khung tranh cụ thể (Inline Panel Comments). | **Could Have** | **P2** |

---

## 8. PHÂN HỆ QUẢN TRỊ HỆ THỐNG (ADMIN DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :--- | :---: |
| **UR-ADM-01** | Admin có thể xem danh sách và xử lý các báo cáo lỗi chương truyện từ độc giả. | **Must Have** | **P0** |
| **UR-ADM-02** | Admin có thể quản lý danh sách người dùng, cấp quyền Uploader/Translator và khóa tài khoản vi phạm. | **Must Have** | **P0** |
| **UR-ADM-03** | Admin có thể kiểm duyệt, ẩn hoặc xóa các nội dung truyện/bình luận vi phạm tiêu chuẩn cộng đồng. | **Must Have** | **P0** |
| **UR-ADM-04** | Admin có thể xem dashboard thống kê lượt đọc, lưu lượng MinIO và lượng Token AI tiêu thụ. | **Should Have**| **P1** |

---

## 9. PHÂN HỆ TIẾN TRÌNH & ĐIỂM THƯỞNG (GAMIFICATION DOMAIN)

| Mã UR | Yêu Cầu Người Dùng (User Requirement) | Ưu Tiên MoSCoW | Priority |
| :--- | :--- | :--- | :---: |
| **UR-GAM-01** | Độc giả có thể tích lũy EXP qua các hoạt động hợp lệ để tăng Level tài khoản. | **Must Have** | **P0** |
| **UR-GAM-02** | Độc giả có thể điểm danh hàng ngày theo lịch tháng để nhận EXP và OmniCoin. | **Must Have** | **P0** |
| **UR-GAM-03** | Độc giả có thể thực hiện và nhận thưởng từ Nhiệm vụ ngày/tuần. | **Should Have**| **P1** |
| **UR-GAM-04** | Độc giả có thể chọn bộ chủ đề Cấp bậc (Rank Theme: Tu Tiên, Ma Vương, Magic...) hiển thị trên Profile. | **Must Have** | **P0** |
| **UR-GAM-05** | Độc giả có thể nhận phần thưởng mở khóa tại các cột mốc Level nhất định (Level Rewards). | **Must Have** | **P0** |
| **UR-GAM-06** | Độc giả có thể mở khóa và trưng bày Huy hiệu Thành tựu (Achievements & Badges) trên Profile. | **Should Have**| **P1** |
| **UR-GAM-07** | Độc giả có thể xem lịch sử biến động số dư OmniCoin & EXP chi tiết (Ledger History). | **Must Have** | **P0** |
| **UR-GAM-08** | Độc giả có thể sử dụng OmniCoin để đổi các vật phẩm trang trí (Cosmetics, Frames, Themes). | **Could Have** | **P2** |

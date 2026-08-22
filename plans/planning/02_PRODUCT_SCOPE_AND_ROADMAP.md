# 🎯 02. Phạm Vi Sản Phẩm (Scope) & Lộ Trình Phát Triển (MVP / V1 / V2)

Tài liệu này phân định ranh giới tính năng rõ ràng giữa các phiên bản phát hành nhằm kiểm soát chất lượng, tối ưu nguồn lực và ngăn chặn triệt để hiện tượng phình đại phạm vi (**Scope Creep**).

---

## 1. PHẠM VI PHIÊN BẢN KHỞI CHẠY TỐI THIỂU (MVP SCOPE - GIAI ĐOẠN 8 TUẦN ĐỒ ÁN)

Phiên bản MVP bắt buộc phải chạy thông suốt toàn bộ luồng nghiệp vụ từ đầu đến cuối (**End-to-End Flow**):

```
[1. Auth & Profile] ➔ [2. Discovery/Search] ➔ [3. Story Detail] ➔ [4. Manga/Novel Reader]
                                                                        │
                                                                        ▼
[7. Version Switch] ◄── [6. Overwrite/Duplicate] ◄── [5. Studio Upload & AI Prototype]
        │
        ▼
[8. Gamification Core: EXP, OmniCoin, Daily Check-in & Rank Themes]
```

### Các tính năng cốt lõi bắt buộc có trong MVP (P0):
* **Xác thực & Tài khoản (Auth & Identity):** Đăng ký, Đăng nhập JWT với Refresh Token Rotation, Phân quyền RBAC cơ bản (Reader, Translator, Admin) và Story Membership (`story_members`).
* **Khám phá & Bộ lọc (Discovery & Search):** Trang chủ (Slider HOT, Truyện mới cập nhật), Tìm kiếm theo tên (Debounce), Lọc theo thể loại/quốc gia, BXH Top Views.
* **Chi tiết Bộ truyện (Story Detail):** Thông tin truyện, tác giả, cây mục lục phân cấp: Tác phẩm (`Story`) $\rightarrow$ Ấn bản (`StoryEdition`) $\rightarrow$ Tập (`Volume`) $\rightarrow$ Chương (`Chapter`).
* **Trình đọc Truyện tranh (Manga/Webtoon Reader):**
  * Hỗ trợ 2 chế độ: Cuộn dọc liên tục (Webtoon 120Hz) và Lật từng trang (Manga).
  * Bộ chọn Server ảnh CDN (Server VIP / Server CDN 1 / Server CDN 2).
  * Chuyển đổi linh hoạt giữa Bản Raw và Bản Dịch AI/Human trên thanh điều khiển.
* **Trình đọc Truyện chữ (Light Novel Reader):**
  * Tùy biến Typography: Đổi cỡ chữ, font chữ, giãn dòng, màu nền (Trắng, Vàng Sepia, Đen OLED).
  * Hiển thị ảnh minh họa xen kẽ và lưu vị trí đọc theo block đoạn văn bản.
* **Quản lý Tiến độ Đọc (Reading Progress):** Tự động lưu và đồng bộ vị trí đọc trên đám mây theo từng tài khoản.
* **Studio Upload & AI Translation Pipeline (Working Prototype):**
  * Kéo thả tải lên file ZIP ảnh Manga hoặc file Text/EPUB với cơ chế quét bảo mật magic bytes.
  * Pipeline xử lý AI nguyên mẫu (Prototype): Phát hiện bóng thoại $\rightarrow$ OCR $\rightarrow$ Dịch ngữ cảnh (OpenAI/DeepL) $\rightarrow$ Tẩy chữ inpainting $\rightarrow$ Typeset text tiếng Việt.
  * **Popup 2 Phương án Xuất bản chuẩn Semantics:**
    * *(1) Ghi đè (Overwrite):* Tạo `ChapterVersion` mới và cập nhật con trỏ `chapter.active_version_id = new_version_id` (Bản raw cũ vẫn được giữ nguyên bất biến).
    * *(2) Nhân bản (Duplicate):* Tạo `ChapterVersion` mới mang nhãn `[Bản Dịch AI]` và giữ nguyên `active_version_id` hiện tại, cho phép độc giả chuyển đổi qua lại trong version switcher.
* **Hệ thống Gamification Cốt Lõi (Minimal Gamification - P0):**
  * **EXP & Level:** Tích lũy EXP khi hoàn thành chapter (có giới hạn chống cày farm reload 1 lần/chapter/user) và tính Level 1-100.
  * **OmniCoin Wallet:** Ví điểm thưởng nhận qua Điểm danh hằng ngày.
  * **Daily Check-in:** Điểm danh nhận thưởng chuỗi streak hàng ngày (Atomic Transaction).
  * **Rank Themes:** Bộ chọn chủ đề danh hiệu hiển thị (Tu Tiên, Game Thủ, Ma Vương, Pháp Sư, Tinh Không) theo mốc Level.
  * **Level Rewards:** Nhận thưởng OmniCoin/Badge tại các mốc Level cố định.
  * **Immutable Transaction Ledger:** Sổ cái ghi nhận lịch sử biến động số dư EXP và OmniCoin.

---

## 2. PHẠM VI PHIÊN BẢN MỞ RỘNG (V1 SCOPE - HẬU ĐỒ ÁN)
* **Đọc truyện Offline (Offline Reader P1):** Tải gói chương truyện tranh và tiểu thuyết, lưu trữ mã hóa cục bộ SQLite trên thiết bị di động.
* **Bình luận & Tương tác (Community P1):** Bình luận theo chương, bình luận trực tiếp vào từng khung tranh (Inline Panel Comments), gắn thẻ Spoiler làm mờ.
* **Đánh giá & Review:** Đánh giá sao 1-5 kèm nhận xét bộ truyện.
* **Trình Soạn Thảo Bản Dịch AI (Translation Segment Editor P1):** Cho phép Uploader/Translator chỉnh sửa trực tiếp text trong từng bóng thoại trước khi xuất bản.
* **Nhiệm vụ & Thành tựu Gamification (Missions & Achievements P1):** Hệ thống nhiệm vụ ngày/tuần và bộ sưu tập huy hiệu thành tựu nâng cao.
* **Quản trị Báo lỗi & Khiếu nại Bản quyền (Moderation & Takedown P1):** Tiếp nhận và xử lý báo cáo lỗi trang/chương và khiếu nại bản quyền.

---

## 3. PHẠM VI TƯƠNG LAI (V2 / FUTURE ROADMAP)
* **Gợi ý truyện thông minh (AI Recommendation Engine):** Dựa trên lịch sử đọc và vector tương đồng nội dung.
* **Quản lý Nhóm dịch (Scanlation Teams):** Phân chia vai trò chi tiết (Leader, Cleaner, Typesetter, Proofreader) và chia sẻ doanh thu/tiền thưởng nội bộ.
* **Giọng đọc AI cảm xúc (AI Text-to-Speech Smart Audiobook):** Tự động chuyển đổi tiểu thuyết thành kịch truyền thanh đa giọng đọc.
* **Chợ Vật Phẩm Trang Trí (Cosmetics Store):** Dùng OmniCoin đổi khung avatar, hiệu ứng bình luận động và theme độc quyền.

---

## 4. NGOÀI PHẠM VI DỰ ÁN (EXPLICIT OUT-OF-SCOPE)

Để đảm bảo hoàn thành đồ án đúng hạn và đạt chất lượng kỹ thuật cao nhất, các tính năng sau **TUYỆT ĐỐI KHÔNG LÀM TRONG GIAI ĐOẠN NÀY**:
* ❌ **Cổng thanh toán tiền thật / Ví điện tử / Nạp thẻ cào:** Không tích hợp nạp tiền qua ngân hàng hay cổng thanh toán thẻ tín dụng.
* ❌ **Sàn giao dịch P2P / Chợ mua bán bản quyền:** Không triển khai mua bán tài sản giữa người dùng.
* ❌ **Thuật toán Huấn luyện Mô hình AI từ đầu (Training from Scratch):** Chỉ sử dụng mô hình mã nguồn mở có sẵn (Manga-OCR, LaMa Inpaint) và Fine-tuning/Prompting LLM APIs.

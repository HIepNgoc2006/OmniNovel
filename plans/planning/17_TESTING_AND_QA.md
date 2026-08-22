# 🧪 17. Chiến Lược Kiểm Thử Toàn Diện, Test Case Catalog & Bộ Benchmark AI (Testing & QA)

Tài liệu này xác định tháp kiểm thử phần mềm (**Testing Pyramid**), danh mục mã ca kiểm thử chuẩn (**Test Case Catalog `TC-*`**) và tiêu chí đánh giá chất lượng mô hình AI.

---

## 1. THÁP KIỂM THỬ PHẦN MỀM (TESTING PYRAMID)

```
       / \
      / E2E \       --> Playwright (Web) & Flutter Driver (Mobile) [10% Coverage]
     /-------\
    / Integr. \     --> Supertest + Testcontainers PostgreSQL & Redis [30% Coverage]
   /-----------\
  /  Unit Tests \   --> Jest (NestJS) & Dart Test (Flutter) & Pytest (AI) [60% Coverage]
 /---------------\
```

---

## 2. DANH MỤC CA KIỂM THỬ CHUẨN (TEST CASE CATALOG `TC-*`)

| Mã Test Case | Hạng Mục Kiểm Thử | Dữ Liệu Đầu Vào (Input) | Kết Quả Kỳ Vọng (Expected Output) | Loại Test |
| :--- | :--- | :--- | :--- | :---: |
| **TC-AUTH-01** | Đăng ký tài khoản hợp lệ | Email mới, password 8+ ký tự | Trả về `201 Created`, user được lưu với password băm Argon2id | Integration |
| **TC-AUTH-02** | Đăng nhập sai mật khẩu | Đúng email, sai password | Trả về `401 Unauthorized` (`AUTH_INVALID_CREDENTIALS`) | Integration |
| **TC-AUTH-03** | Đăng xuất & Thu hồi Token | Gửi token hợp lệ tới logout | Trả về `200 OK`, xóa Refresh Token trên Redis, thu hồi phiên | Integration |
| **TC-DISC-01** | Lấy danh sách Featured Feed | `GET /api/v1/stories/featured`| Trả về `200 OK` chứa slider HOT và banner mới nhất từ Redis cache | Integration |
| **TC-DISC-02** | Tìm kiếm truyện có dấu tiếng Việt | `q = "đại quản gia"` | Trả về danh sách truyện khớp với điểm tương đồng trigram cao nhất | Unit |
| **TC-DISC-03** | Lọc truyện đa tiêu chí | `genre=action&format=COMIC` | Trả về danh sách truyện đúng bộ lọc kèm phân trang chuẩn | Integration |
| **TC-DISC-04** | Lấy Bảng xếp hạng Top Views | `timeframe=weekly` | Trả về danh sách truyện top view tuần từ Redis Sorted Sets | Integration |
| **TC-DISC-05** | Lấy Cây mục lục chi tiết truyện| `GET /api/v1/stories/:slug` | Trả về chi tiết Story, Editions, Volumes và Chapters kèm active version | Integration |
| **TC-MANGA-01**| Cuộn Webtoon 50 trang không rò rỉ RAM | 50 ảnh 2K WebP cuộn nhanh | Khung hình Target 120Hz (Acceptance $\ge 90$ FPS, Jank $< 1\%$), RAM $< 150MB$ | Mobile E2E |
| **TC-NOVEL-01**| Đổi font và lưu vị trí đọc theo block | Chỉnh cỡ 22px, nhảy `block-42` | Vị trí đọc được lưu chính xác, mở lại thiết bị khác trỏ đúng block | Mobile E2E |
| **TC-STUD-01** | Tạo Story mới gán quyền Owner | Payload tạo truyện mới | Tạo bản ghi `stories` kèm `story_members(role='OWNER')` | Integration |
| **TC-AI-01**   | Quét chống Zip Slip tệp tin tải lên | File ZIP chứa entry `../../etc/passwd` | Bị chặn ngay lập tức, trả về `400 Bad Request` | Unit |
| **TC-AI-02**   | Dịch Manga có từ khóa Glossary | Ảnh chứa chữ "Rasengan" | Text tiếng Việt hiển thị chính xác "Loa Toàn Hoàn" | AI Integration |
| **TC-GAM-01**  | Điểm danh nguyên tử lần đầu trong ngày | `POST /api/v1/gamification/checkin` | +5 Coin, +10 Total EXP, Streak +1, tạo 2 bản ghi sổ cái ledger | Integration |
| **TC-GAM-02**  | Chặn điểm danh lặp lại lần 2 | Gửi tiếp request checkin | Trả về `400 Bad Request` (`CHECKIN_ALREADY_CLAIMED`), balance giữ nguyên | Integration |
| **TC-GAM-03**  | Thưởng EXP khi đọc hoàn thành chapter | Gửi event đọc $\ge 45$s và $\ge 80\%$ | +5 Total EXP, tính lại level, kiểm soát trần tối đa 100 EXP/ngày | Integration |
| **TC-GAM-04**  | Thay đổi Rank Theme hiển thị | `PATCH /api/v1/gamification/rank-theme` | Cập nhật `rank_theme_id`, profile hiển thị danh hiệu tương ứng | Integration |
| **TC-GAM-05**  | Nhận thưởng mốc Level mới | `POST /api/v1/gamification/rewards/claim`| Ghi nhận `user_claimed_level_rewards`, cộng coin vào ví qua ledger | Integration |
| **TC-GAM-06**  | Truy vấn lịch sử giao dịch sổ cái | `GET /api/v1/gamification/transactions` | Trả về danh sách lịch sử biến động số dư EXP và OmniCoin phân trang | Integration |
| **TC-ADM-01**  | Xử lý đóng báo cáo lỗi chương | Admin token gọi resolve report | Cập nhật `status = 'RESOLVED'`, gán `resolved_by = admin.id` | Integration |
| **TC-ADM-02**  | Phân quyền Global Role người dùng | Admin token gọi đổi role | Cập nhật `users.role = 'TRANSLATOR'`, xóa cache Redis tức thì | Integration |
| **TC-ADM-03**  | Điều khiển trạng thái hiển thị truyện| Admin token gọi đổi visibility | Cập nhật `stories.visibility = 'UNLISTED'`, ẩn khỏi feed công khai | Integration |

---

## 3. KHUNG TIÊU CHÍ ĐÁNH GIÁ CHẤT LƯỢNG DỊCH AI (HUMAN EVALUATION RUBRIC)

Đánh giá chất lượng bản dịch AI theo thang điểm 1 đến 5 trên bộ dữ liệu kiểm chuẩn (Benchmark Ground Truth Dataset gồm 10 chapter mẫu):

| Tiêu Chí | Thang Điểm 1 (Kém) | Thang Điểm 3 (Chấp Nhận Được) | Thang Điểm 5 (Xuất Sắc) |
| :--- | :--- | :--- | :--- |
| **1. Độ chính xác ngữ nghĩa (Accuracy)** | Sai lệch hoàn toàn ý nghĩa gốc | Đúng ý chính, còn sót vài chi tiết nhỏ | Dịch sát nghĩa gốc 100%, không bịa đặt |
| **2. Độ mượt mà văn phong (Naturalness)** | Giọng văn máy móc thô cứng (Google Dịch cũ) | Văn phong dễ hiểu, đôi chỗ lặp từ | Câu thoại tự nhiên, đúng ngữ cảnh truyện |
| **3. Tuân thủ Thuật ngữ (Terminology)** | Dịch lung tung tên nhân vật/chiêu thức | Đúng 80% thuật ngữ quan trọng | Tuân thủ 100% từ điển Glossary |
| **4. Thẩm mỹ Tẩy xóa & Dàn chữ (Visual)** | Nền tranh bị lem nhem, chữ tràn khung | Tẩy sạch chữ, font chữ vừa vặn | Tranh phục hồi hoàn hảo, font chữ mỹ thuật đẹp mắt |

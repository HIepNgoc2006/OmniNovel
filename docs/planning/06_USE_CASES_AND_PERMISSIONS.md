# 👥 06. Danh Mục 28 Use Cases & Ma Trận Phân Quyền Sở Hữu (Ownership-Based Authorization)

Tài liệu này xác định chi tiết 28 Use Cases và ma trận phân quyền dựa trên quyền sở hữu (**Ownership-Based RBAC**).

---

## 1. MA TRẬN PHÂN QUYỀN TRUY CẬP & SỞ HỮU (OWNERSHIP PERMISSION MATRIX)

```
Phân quyền theo cấp:
User Role (Global) ➔ Resource Ownership / Membership (Story Level)
```

| Hành Động Nghiệp Vụ (Action) | Guest | Reader | Creator (Owner) | Translator (Member) | Admin |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Đọc truyện công khai (Read Public)** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Theo dõi truyện & Lưu lịch sử** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Tải truyện đọc Offline (Mobile)** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Tạo bộ truyện mới (Private/Public)** | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Upload chương mới vào truyện của mình** | ❌ | ❌ | ✅ | ✅ (nếu là member) | ✅ |
| **Kích hoạt Dịch AI trên truyện của mình**| ❌ | ❌ | ✅ | ✅ (nếu là member) | ✅ |
| **Sửa/Xóa chương của người khác** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Kiểm duyệt báo lỗi & Khóa tài khoản** | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## 2. ĐẶC TẢ CHI TIẾT 6 USE CASES CỐT LÕI

### 📄 UC-01: UC-AUTH-02 – Đăng Nhập & Cấp Phát Token
* **Primary Actor:** Reader / Creator / Admin.
* **Trigger:** Người dùng nhập Username/Email + Password và bấm "Đăng nhập".
* **Preconditions:** Tài khoản đã được đăng ký và không bị khóa.
* **Main Flow:**
  1. Client gửi request `POST /api/v1/auth/login`.
  2. Server kiểm tra mật khẩu bằng thuật toán **Argon2id**.
  3. Server sinh Access Token (15 phút) và Refresh Token (7 ngày).
  4. Server lưu Refresh Token vào Redis và trả Access Token về Client kèm Refresh Token trong HttpOnly Cookie.
* **Postconditions:** Người dùng đăng nhập thành công.

---

### 📄 UC-02: UC-STUD-AI-FLOW – Tải Lên & Dịch AI 2 Phương Án
* **Primary Actor:** Translator / Creator.
* **Secondary Actor:** AI Worker Service, MinIO Storage, BullMQ Queue.
* **Trigger:** Uploader bấm "Tải lên & Dịch tự động bằng AI".
* **Main Flow:**
  1. Uploader kéo thả file ZIP ảnh Manga lên Studio.
  2. Server kiểm tra Magic Bytes và lưu raw files vào MinIO.
  3. Server tạo `TranslationJob` và đẩy vào BullMQ Queue.
  4. AI Worker thực hiện: OCR $\rightarrow$ Dịch LLM $\rightarrow$ Inpaint $\rightarrow$ Typeset.
  5. Khi hoàn tất 100%, hệ thống hiển thị màn hình Diff Preview và Popup 2 Lựa chọn.
  6. Uploader chọn (1) Ghi đè hoặc (2) Nhân bản và bấm "Xác nhận xuất bản".
* **Postconditions:** ChapterVersion mới được tạo và gán trạng thái phù hợp.

---

### 📄 UC-03: UC-GAM-CHECKIN – Điểm Danh Hàng Ngày & Nhận Thưởng Chuỗi
* **Primary Actor:** Reader / Translator / Creator.
* **Preconditions:** Người dùng đã đăng nhập vào tài khoản hợp lệ.
* **Trigger:** Người dùng nhấn nút "Điểm danh hôm nay" tại trang OmniCoin.
* **Main Flow:**
  1. Client gửi request `POST /api/v1/gamification/checkin`.
  2. Server xác định ngày hiện tại theo timezone `Asia/Ho_Chi_Minh`.
  3. Server kiểm tra trong bảng `daily_checkins` xem đã tồn tại bản ghi của user trong ngày chưa.
  4. Server tính toán số ngày streak liên tiếp và phần thưởng tương ứng.
  5. Trong 1 Database Transaction duy nhất (Atomic):
     * Insert bản ghi `daily_checkins`.
     * Cập nhật `user_progression` (tăng EXP, tăng streak, ghi nhận `last_checkin_date`).
     * Insert bản ghi `wallet_transactions` với `idempotency_key = CHECKIN:USER_ID:YYYY-MM-DD`.
     * Cập nhật `wallets.balance`.
  6. Server kiểm tra nếu EXP vượt ngưỡng thì kích hoạt sự kiện `UserLevelUpEvent`.
  7. Server trả về kết quả thành công và phát WebSocket Toast chúc mừng.
* **Postconditions:** Số dư ví và chuỗi streak được cập nhật nhất quán và lưu vào sổ cái.

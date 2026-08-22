# 🏆 23. Phân Hệ Cấp Độ, Điểm Thưởng & Danh Hiệu (Gamification & User Progression System)

Tài liệu này đặc tả toàn diện phân hệ **Gamification & Tiến Trình Người Dùng (User Progression)** của hệ sinh thái OmniNovel, bao gồm cơ chế phân tách 3 lớp (EXP / OmniCoin / Rank), vòng đời nhiệm vụ, điểm danh chuỗi, thành tựu, kiến trúc Event-Driven và các quy tắc phòng chống gian lận (Anti-Farming).

---

## 1. NGUYÊN TẮC CỐT LÕI: PHÂN TÁCH 3 LỚP ĐỘC LẬP

Hệ thống OmniNovel phân định tuyệt đối ranh giới giữa 3 khái niệm:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                OMNINOVEL GAMIFICATION PILLARS                                   │
├───────────────────────────────┬───────────────────────────────┬─────────────────────────────────┤
│            1. EXP             │         2. OMNICOIN           │        3. RANK / TITLE          │
├───────────────────────────────┼───────────────────────────────┼─────────────────────────────────┤
│ • Dùng để tích lũy Level.     │ • Đơn vị tiền tệ thưởng.      │ • Danh hiệu / Cấp bậc hiển thị. │
│ • Level 1 ➔ Level 100.        │ • Dùng mua Cosmetics, Frames, │ • Tùy biến theo Rank Theme:     │
│ • Không thể tiêu xài / trừ.   │   Profile Themes, Badges.     │   (Tu Tiên, Ma Vương, Magic...) │
│ • Tăng theo Difficulty Curve. │ • Quản lý qua Ledger bất biến.│ • Không thay đổi Level thật.    │
└───────────────────────────────┴───────────────────────────────┴─────────────────────────────────┘
```

> **Quy tắc bất biến:** `EXP ≠ OmniCoin ≠ Rank`. Level và OmniCoin **tuyệt đối không quyết định quyền bảo mật** của tài khoản (Quyền bảo mật chỉ dựa trên RBAC và Resource Ownership).

---

## 2. HỆ THỐNG CẤP ĐỘ & ĐƯỜNG CONG KINH NGHIỆM (LEVEL & EXP CURVE)

### 2.1. Nguồn Tích Lũy EXP Hợp Lệ (Valid EXP Sources)
* Đọc hoàn thành 1 chapter (Thỏa mãn đọc $> 80\%$ nội dung và $> 60$ giây): `+5 EXP` *(Giới hạn: 1 lần duy nhất / user / chapter)*.
* Đọc liên tục 20 phút (Session Milestone): `+5 EXP` *(Tối đa 3 lần / ngày)*.
* Điểm danh hàng ngày (Daily Check-in): `+10 EXP`.
* Hoàn thành Nhiệm vụ ngày: `+15 EXP`.
* Viết bài đánh giá (Review) truyện hợp lệ: `+10 EXP`.
* Xuất bản Chapter mới thành công (Creator): `+20 EXP`.
* Hiệu đính bản dịch AI (Translator Proofread): `+25 EXP`.

### 2.2. Bảng Cấu Hình Ngưỡng Cấp Độ (Level Thresholds)
Hệ thống sử dụng bảng tra cứu `level_thresholds` cấu hình sẵn thay vì công thức tuyến tính:

| Level | Tổng EXP Yêu Cầu | EXP Cần Để Lên Cấp Tiếp | Phần Thưởng Mở Khóa (Level Reward) |
| :---: | :---: | :---: | :--- |
| **1** | 0 | 100 | Danh hiệu *Tân Độc Giả* |
| **2** | 100 | 150 | `+5 OmniCoin` |
| **5** | 600 | 300 | `+10 OmniCoin` + Profile Badge Slot 1 |
| **10**| 2,500 | 600 | `+20 OmniCoin` + Khung Avatar *Độc Giả Tri Thức* |
| **20**| 10,000| 1,500 | `+50 OmniCoin` + Theme Trình Đọc *Sepia Cổ Điển* |
| **30**| 25,000| 3,000 | Mở khóa Rank Theme Đặc Biệt *Tinh Không (Cosmic)* |

---

## 3. DANH HIỆU & BỘ CHỦ ĐỀ CẤP BẬC (RANK & RANK THEMES)

Người dùng có thể tự do lựa chọn **Rank Theme** trên trang cá nhân. Cấp bậc hiển thị sẽ tự động ánh xạ theo Level hiện tại mà không làm biến động cấp độ thật:

```
[User Level: 30]
 ├── Theme Mặc Định ➔ [Bậc Sư Độc Giả (Master Reader)]
 ├── Theme Tu Tiên   ➔ [Nguyên Anh Kỳ]
 ├── Theme Fantasy   ➔ [Đại Hiệp Sĩ (Grand Knight)]
 ├── Theme Ma Vương  ➔ [Ma Tướng]
 └── Theme Pháp Sư   ➔ [Đại Pháp Sư (Archmage)]
```

### Danh Mục 5 Bộ Chủ Đề Cấp Bậc Chuẩn:
1. **Mặc Định (Reader Path):** Tân Thủ $\rightarrow$ Độc Giả $\rightarrow$ Mọt Sách $\rightarrow$ Bậc Thầy Đọc $\rightarrow$ Đại Học Giả $\rightarrow$ Huyền Thoại.
2. **Tu Tiên (Cultivation):** Luyện Khí $\rightarrow$ Trúc Cơ $\rightarrow$ Kim Đan $\rightarrow$ Nguyên Anh $\rightarrow$ Hóa Thần $\rightarrow$ Luyện Hư $\rightarrow$ Hợp Thể $\rightarrow$ Đại Thừa $\rightarrow$ Độ Kiếp.
3. **Fantasy (Heroic Path):** Tập Sự $\rightarrow$ Thợ Săn $\rightarrow$ Hiệp Sĩ $\rightarrow$ Thánh Kỵ Sĩ $\rightarrow$ Dũng Giả $\rightarrow$ Đại Anh Hùng.
4. **Ma Vương (Demon Realm):** Tiểu Ma $\rightarrow$ Ma Binh $\rightarrow$ Ma Tướng $\rightarrow$ Ma Vương $\rightarrow$ Đại Ma Vương $\rightarrow$ Ma Thần Tối Cao.
5. **Pháp Sư (Magic Arcana):** Pháp Đồ $\rightarrow$ Pháp Sư $\rightarrow$ Cao Giai $\rightarrow$ Đại Pháp Sư $\rightarrow$ Ma Đạo Sư $\rightarrow$ Pháp Thần.

---

## 4. ĐIỂM DANH HÀNG NGÀY & CHUỖI STREAK (DAILY CHECK-IN)

* **Lịch Điểm Danh Tháng:** Hiển thị lưới ngày trong tháng (28–31 ô). Mỗi ngày có icon phần thưởng rõ ràng (`🪙 OmniCoin`, `⭐ EXP`, `🎁 Hộp Quà Chuỗi`).
* **Chu kỳ Reset:** Đúng **00:00:00 (Múi giờ Asia/Ho_Chi_Minh)** mỗi ngày.
* **Chuỗi Streak Thưởng Lũy Tiến:**
  * *1 Ngày:* `+1 OmniCoin` + `+5 EXP`
  * *3 Ngày liên tiếp:* `+3 OmniCoin` + `+10 EXP`
  * *7 Ngày liên tiếp:* `+10 OmniCoin` + Badge *Kiên Trì Tu Luyện*
  * *14 Ngày liên tiếp:* `+20 OmniCoin` + Khung Avatar *Ngọn Lửa Bất Diệt*
  * *30 Ngày trọn tháng:* `+50 OmniCoin` + Danh hiệu Độc Quyền Tháng
* **Chính sách Thân thiện (No-Pressure Streak):** Đứt chuỗi chỉ reset streak ngắn hạn, không xóa tổng số ngày đã điểm danh trong tháng (Monthly Attendance Count).

---

## 5. HỆ THỐNG NHIỆM VỤ ĐA DẠNG (MISSIONS ENGINE)

```
┌──────────────────────────────┬──────────────────────────────┬──────────────────────────────┐
│     1. ĐỘC GIẢ (READER)      │   2. DỊCH GIẢ (TRANSLATOR)   │    3. TÁC GIẢ (CREATOR)      │
├──────────────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ • Đọc 1 chapter: +5 EXP      │ • Hoàn thành 1 AI Job: +20 EXP│ • Đăng 1 chương mới: +30 EXP │
│ • Đọc 3 chapter: +10 EXP     │ • Hiệu đính 20 khung thoại:  │ • Cập nhật thông tin truyện: │
│ • Đọc 20 phút: +1 OmniCoin   │   +15 EXP + 1 OmniCoin       │   +10 EXP                    │
│ • Theo dõi 1 truyện: +5 EXP  │ • Sửa 10 từ glossary: +10 EXP│ • Đạt 100 lượt đọc: +50 EXP  │
└──────────────────────────────┴──────────────────────────────┴──────────────────────────────┘
```

---

## 6. SỔ CÁI GIAO DỊCH OMNICOIN (TRANSACTION LEDGER MODEL)

Tuyệt đối không sử dụng cơ chế cập nhật số dư đơn thuần `wallet.balance += 10`. Mọi biến động số dư phải tuân thủ chuẩn **Kế toán kép (Ledger Accounting)**:

\`\`\`sql
-- Cấu trúc Giao Dịch Sổ Cái Bất Biến
CREATE TABLE wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    amount INT NOT NULL, -- Số dương (+) khi nhận, số âm (-) khi tiêu
    transaction_type VARCHAR(30) NOT NULL CHECK (transaction_type IN ('REWARD', 'SPEND', 'REFUND', 'ADMIN_ADJUSTMENT')),
    source_type VARCHAR(50) NOT NULL CHECK (source_type IN (
        'DAILY_CHECKIN', 'MISSION_DAILY', 'MISSION_WEEKLY', 
        'LEVEL_REWARD', 'ACHIEVEMENT', 'COSMETIC_PURCHASE', 'ADMIN_MANUAL'
    )),
    source_id VARCHAR(100),
    idempotency_key VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
\`\`\`

---

## 7. KIẾN TRÚC EVENT-DRIVEN GAMIFICATION (OBSERVER PATTERN)

Hệ thống Reader / Uploader **hoàn toàn không gọi trực tiếp Gamification Service**. Tương tác được điều phối thông qua **Domain Events**:

```
[Client đọc xong Chapter] ➔ [ReaderModule phát event 'ChapterCompleted']
                                              │
                                              ▼ (Async Pub/Sub)
                         [Gamification EventHandler lắng nghe]
                                              │
                                              ▼
                         [Reward Rule Engine kiểm tra Anti-Farming]
                                              │
                                              ▼
                         [Tạo Ledger Transaction + Cập nhật EXP & OmniCoin]
                                              │
                                              ▼
                         [Kiểm tra Thăng Cấp (Level Up) & Bắn WebSocket Toast]
```

---

## 8. CHỐNG GIAN LẬN & CÀO ĐIỂM (ANTI-FARMING RULES)

1. **Chapter Completion Validation:**
   * Chỉ thưởng EXP nếu độc giả cuộn qua ít nhất $80\%$ chiều dài trang ảnh và thời gian lưu lại trên chapter tối thiểu 60 giây.
   * Ràng buộc duy nhất: Mỗi cặp `(user_id, chapter_id)` chỉ nhận EXP hoàn thành đúng 1 lần duy nhất trong đời.
2. **Comment Anti-Spam:** Không thưởng OmniCoin trực tiếp trên từng comment. Chỉ có nhiệm vụ ngày *"Đăng 1 bình luận có ý nghĩa (> 20 ký tự)"* (Tối đa 1 lần/ngày).
3. **Idempotency Check:** Mọi request nhận thưởng (Claim Reward / Check-in) đều đi kèm `idempotency_key = EVENT:USER_ID:RESOURCE_ID:DATE`. Nếu người dùng click liên tục hoặc mạng lag gửi lại request, hệ thống từ chối an toàn với mã `DUPLICATE_REWARD_CLAIMED`.
4. **Không Đánh Bạc / Lootbox (No Gambling):** Toàn bộ vật phẩm Cosmetic đều niêm yết giá OmniCoin rõ ràng, loại bỏ hoàn toàn cơ chế quay hũ / mở rương ngẫu nhiên.

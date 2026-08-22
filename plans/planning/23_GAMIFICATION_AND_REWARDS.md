# 🎮 23. Đặc Tả Hệ Thống Gamification, Tiến Trình Người Dùng & Sổ Cái Điểm Thưởng (Gamification Domain)

Tài liệu này đặc tả chi tiết toàn bộ phân hệ **Gamification** của OmniNovel, bao gồm cơ chế tính Total EXP/Level, Ví OmniCoin, Chuỗi điểm danh hằng ngày (Daily Check-in), Bộ chủ đề Cấp bậc (Rank Themes) và Sổ cái giao dịch bất biến (**Single-Entry Immutable Transaction Ledger**).

---

## 1. NGUYÊN TẮC CỐT LÕI: TÁCH BIỆT 3 THÀNH PHẦN

> **Total EXP $\ne$ OmniCoin $\ne$ Rank / Title.**

| Thành phần | Định Nghĩa | Công Dụng Nghiệp Vụ | Quy Tắc Tích Lũy / Tiêu Dùng |
| :--- | :--- | :--- | :--- |
| **Total EXP** | **Nguồn Sự Thật Duy Nhất** về Điểm kinh nghiệm | Tích lũy vĩnh viễn, Level được tính toán dẫn xuất từ `total_exp` | Tích lũy vĩnh viễn, không bao giờ bị trừ hay đem đi mua bán/đổi đồ. |
| **OmniCoin** | Tiền tệ điểm thưởng ảo | Đổi quà, nhận vật phẩm trang trí, cosmetic | Nhận qua điểm danh/nhiệm vụ; có thể tiêu dùng giảm số dư ví. |
| **Rank / Title** | Danh hiệu hiển thị Profile | Thể hiện cá tính độc giả theo chủ đề | Mở khóa theo mốc Level; độc giả tự do đổi theme hiển thị. |

---

## 2. HỆ THỐNG CẤP ĐỘ (LEVEL & TOTAL EXP PROGRESSION)

### 2.1. Bảng Phân Bổ EXP Hoạt Động (Activity Rewards):
* **Đọc hoàn thành một chapter hợp lệ:** $+5$ Total EXP *(Điều kiện: Thời gian đọc $\ge 45$ giây và cuộn qua $\ge 80\%$ nội dung)*.
* **Điểm danh hàng ngày:** $+10$ Total EXP.
* **Hoàn thành nhiệm vụ ngày (V1):** $+15$ Total EXP.
* **Review truyện hợp lệ (V1):** $+10$ Total EXP.

### 2.2. Quy Tắc Chống Cày Farm (Anti-Farming Gate):
* **Quy tắc 1 (Một lần duy nhất):** Mỗi chapter chỉ thưởng EXP một lần duy nhất cho mỗi độc giả (`1 reward / user / chapter`). Thao tác reload hoặc đọc lại chapter cũ sẽ **không được cộng thêm EXP**.
* **Quy tắc 2 (Giới hạn trần theo ngày):** Giới hạn tối đa **100 EXP/ngày** từ hoạt động đọc truyện thông thường để ngăn chặn bot tự động cuộn trang.

### 2.3. Công Thức Tính Level Dẫn Xuất (Derived Level):
* **Tính toán đồng bộ (Denormalized Cache):** `total_exp` là Nguồn Sự Thật Duy Nhất. Trường `user_progression.level` là trường cache phi chuẩn hóa được tính toán và cập nhật đồng bộ trong cùng database transaction mỗi khi có giao dịch cộng Total EXP, ngăn ngừa triệt để sai lệch (drift).
* Cột mốc tích lũy để đạt Level $L$:
$$\text{TotalEXP}_{\text{required}}(L) = \sum_{i=1}^{L-1} \lfloor 100 \times i^{1.5} \rfloor$$
* API trả về định dạng rõ ràng:
```json
{
  "level": 12,
  "totalExp": 8450,
  "currentLevelExp": 450,
  "nextLevelExp": 900,
  "omnicoinBalance": 428,
  "streak": 7,
  "rankTitle": "Kim Đan Kỳ"
}
```

---

## 3. ĐIỂM DANH HÀNG NGÀY & CHUỖI STREAK (DAILY CHECK-IN)

* **Chu Kỳ Điểm Danh:** Tính theo lịch tháng (từ ngày 1 đến ngày cuối tháng) theo múi giờ `Asia/Ho_Chi_Minh`.
* **Phần Thưởng Cơ Bản:** $+5$ OmniCoin và $+10$ Total EXP mỗi ngày.
* **Thưởng Chuỗi Streak Liên Tục:**
  * **Streak 7 ngày:** Thưởng thêm $+20$ OmniCoin và $+50$ Total EXP.
  * **Streak 14 ngày:** Thưởng thêm $+50$ OmniCoin và $+100$ Total EXP.
  * **Streak 30 ngày:** Thưởng thêm $+150$ OmniCoin, $+300$ Total EXP và Huy Hiệu *"Độc Giả Chuyên Cần"*.

---

## 4. BỘ CHỦ ĐỀ CẤP BẬC TÙY BIẾN (DATA-DRIVEN RANK THEMES)

Độc giả có thể lựa chọn bộ Theme danh hiệu hiển thị trên trang cá nhân theo sở thích mà không làm thay đổi Level hay EXP thực tế:

| Mốc Level | Theme 1: Tu Tiên (Cultivation) | Theme 2: Game Thủ (Gamer) | Theme 3: Ma Vương (Demon King) | Theme 4: Pháp Sư (Magic) | Theme 5: Tinh Không (Sci-Fi) |
| :---: | :--- | :--- | :--- | :--- | :--- |
| **Lv 1 - 9** | Luyện Khí Kỳ | Tân Thủ (Novice) | Tiểu Quỷ (Imp) | Học Viên Phép Thuật | Thực Tập Phi Hành |
| **Lv 10 - 19**| Trúc Cơ Kỳ | Chiến Binh (Warrior) | Quỷ Binh (Fiend) | Pháp Sư Sơ Cấp | Thám Hiểm Không Gian |
| **Lv 20 - 39**| Kim Đan Kỳ | Sát Thủ Bóng Đêm | Kỵ Sĩ Hắc Ám | Đại Pháp Sư | Chỉ Huy Hạm Đội |
| **Lv 40 - 59**| Nguyên Anh Kỳ | Tông Sư (Master) | Lãnh Chúa Ma Vực | Pháp Hoàng | Thống Soái Thiên Hà |
| **Lv 60 - 79**| Hóa Thần Kỳ | Huyền Thoại (Legend) | Ma Vương Bất Tử | Thánh Ma Đạo Sư | Chúa Tể Tinh Cầu |
| **Lv 80 - 99**| Độ Kiếp Kỳ | Tối Thượng (Ultimate) | Hư Không Ma Hoàng | Ma Thần Thượng Cổ | Đấng Sáng Tạo Vũ Trụ |
| **Lv 100** | Đại Thừa Viên Mãn | Thần Thoại Vô Địch | Thần Ma Tối Cao | Tối Cao Pháp Thần | Đấng Toàn Tri Toàn Năng |

---

## 5. SỔ CÁI BIẾN ĐỘNG SỐ DƯ BẤT BIẾN (SINGLE-ENTRY IMMUTABLE LEDGER)

Mọi thao tác thay đổi số dư EXP hoặc OmniCoin bắt buộc phải ghi lại một bản ghi giao dịch bất biến trong `reward_transactions` với `idempotency_key` duy nhất:

```sql
-- Ví dụ: Giao dịch EXP khi điểm danh
INSERT INTO reward_transactions (
    user_id, reward_type, amount, balance_after, source_type, source_id, idempotency_key
) VALUES (
    'user-uuid-123', 'EXP', 10, 8450, 'CHECKIN', 'checkin-2026-08-22', 'CHECKIN:user-uuid-123:2026-08-22:EXP'
);

-- Ví dụ: Giao dịch OmniCoin khi điểm danh
INSERT INTO reward_transactions (
    user_id, reward_type, amount, balance_after, source_type, source_id, idempotency_key
) VALUES (
    'user-uuid-123', 'OMNICOIN', 5, 433, 'CHECKIN', 'checkin-2026-08-22', 'CHECKIN:user-uuid-123:2026-08-22:OMNICOIN'
);
```

* **Tính Bất Biến (Immutable):** Bản ghi sổ cái không bao giờ bị `UPDATE` hay `DELETE`.
* **Đối Soát Số Dư:** Số dư `user_progression.omnicoin_balance` luôn bằng tổng giá trị `SUM(amount)` của toàn bộ các transaction thuộc user đó trong sổ cái.

---

## 6. CHÍNH SÁCH CỘNG DỒN PHẦN THƯỞNG (REWARD STACKING POLICY)

* **Stacking Hợp Lệ:** Phần thưởng cơ bản từ hoạt động đọc ($+5$ EXP) được **cộng dồn đồng thời** với phần thưởng Nhiệm vụ Ngày (ví dụ: hoàn thành nhiệm vụ "Đọc 1 chapter" được nhận thêm $+5$ EXP).
* **Kiểm Soát Trần:** Mọi khoản thưởng cộng dồn từ hoạt động đọc đều chịu sự kiểm soát của trần tối đa **100 EXP/ngày**.

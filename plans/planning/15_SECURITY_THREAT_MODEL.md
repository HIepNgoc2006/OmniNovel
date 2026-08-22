# 🛡️ 15. Mô Hình Đe Dọa An Ninh STRIDE & Cơ Chế Phòng Thủ (Security Threat Model)

Tài liệu này phân tích toàn diện các mối đe dọa an ninh mạng theo mô hình chuẩn quốc tế **STRIDE (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege)** và các biện pháp kỹ thuật phòng thủ tương ứng.

---

## 1. PHÂN TÍCH ĐE DỌA THEO MÔ HÌNH STRIDE

| Hạng Mục STRIDE | Mối Đe Dọa Cụ Thể Trong Dự Án | Biện Pháp Kỹ Thuật Phòng Thủ |
| :--- | :--- | :--- |
| **S - Spoofing**<br>*(Giả mạo danh tính)* | Kẻ tấn công giả mạo token người dùng hoặc chiếm đoạt session để sửa truyện. | • Cấp phát JWT ký bảo mật bằng thuật toán **`HS256`** với secret key an toàn trong `.env`.<br>• Refresh Token Rotation lưu hash trong Redis.<br>• Web lưu cookie `HttpOnly; Secure; SameSite=Strict`; Mobile lưu trong Android Keystore / iOS Keychain.<br>• Phòng vệ **CSRF** bằng SameSite cookie và Custom Header (`X-Requested-With`). |
| **T - Tampering**<br>*(Can thiệp sửa đổi)* | Kẻ xấu sửa đổi URL ảnh để xem truyện trả phí hoặc gửi file nén độc hại (Zip Slip/Zip Bomb, Malicious EPUB, Stored XSS trong Novel HTML). | • **Chống Zip Slip:** Kiểm tra path traversal (`..`) trước khi giải nén.<br>• **Chống Zip Bomb:** Giới hạn tỷ lệ nén $< 100:1$ và dung lượng tối đa 100MB.<br>• **Kiểm tra Magic Bytes:** Xác thực đúng header ảnh (`FF D8 FF` JPG, `89 50 4E 47` PNG, `52 49 46 46` WebP).<br>• **Chống Stored XSS:** Lọc sạch nội dung Novel HTML và tệp EPUB qua thư viện **DOMPurify/Sanitizer** trước khi lưu vào MinIO. |
| **R - Repudiation**<br>*(Chối bỏ trách nhiệm)* | Uploader hoặc Admin xóa dữ liệu/thay đổi bản dịch rồi chối bỏ hành động. | • Bảng **`audit_logs`** ghi lại IP, User ID, Timestamp, Action và Metadata chi tiết của mọi thao tác nhạy cảm.<br>• Mô hình `ChapterVersion` bất biến lưu vết lịch sử mọi phiên bản. |
| **I - Information Disclosure**<br>*(Lộ lọt thông tin)* | Bot cào tải hàng loạt toàn bộ ảnh Manga từ MinIO để đem lên trang truyện lậu. | • **Dynamic HMAC-SHA256 Signed URLs** có thời hạn sống 15 phút giúp giảm thiểu tình trạng hotlinking.<br>• Nhúng mã truy vết ẩn danh (Pseudonymous Trace Code) trên canvas đọc truyện. |
| **D - Denial of Service**<br>*(Tấn công từ chối dịch vụ)* | Hacker spam hàng nghìn request dịch AI hoặc brute-force endpoint login. | • Cấu hình **Nginx Rate Limiting** (tối đa 20 req/s cho public APIs).<br>• Redis Throttler cho AI translation (tối đa 2 task đồng thời / user).<br>• Khóa IP tạm thời sau 5 lần đăng nhập thất bại liên tiếp. |
| **E - Elevation of Privilege**<br>*(Leo thang đặc quyền)* | User thông thường gửi request đổi role thành Admin hoặc sửa truyện của người khác. | • Phân quyền 2 lớp: Global Role Guard + Story Ownership Guard (`story_members`).<br>• Mọi thao tác sửa/xóa/apply version đều kiểm tra quyền `EDITOR`, `OWNER` hoặc `ADMIN`. |

---

## 2. QUY TRÌNH XỬ LÝ AN TOÀN TỆP TIN TẢI LÊN (FILE UPLOAD SANITIZATION PIPELINE)

```
[1. Upload File] ➔ [2. Magic Bytes Scan] ➔ [3. Zip Slip/Bomb Check] ➔ [4. Strip Metadata / DOMPurify] ➔ [5. MinIO Storage]
```

1. **Magic Bytes Scan:** Đọc 16 bytes đầu tiên của tệp tin để xác định định dạng nhị phân thực tế, loại bỏ triệt để các tệp tin giả mạo đuôi mở rộng (ví dụ: `malware.exe` đổi tên thành `chap1.zip`).
2. **Zip Slip / Path Traversal Defense:** Sử dụng hàm chuẩn hóa đường dẫn, từ chối mọi entry chứa `../` hoặc đường dẫn tuyệt đối ra ngoài thư mục tạm.
3. **Image Sanitization & Metadata Stripping:** Tái mã hóa (Re-encoding) ảnh qua thư viện Sharp/Pillow sang định dạng WebP chuẩn, loại bỏ toàn bộ dữ liệu EXIF/GPS cá nhân tiềm ẩn nguy cơ bảo mật.
4. **Novel HTML Sanitization:** Quét và lọc sạch mọi thẻ `<script>`, `<iframe>`, `onload` độc hại trước khi ghi nhận thành `MediaAsset`.

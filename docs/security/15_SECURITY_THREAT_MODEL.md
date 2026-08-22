# 🛡️ 15. Mô Hình Đe Dọa Bảo Mật STRIDE & Chiến Lược Phòng Thủ Đa Tầng

Tài liệu này phân tích toàn bộ các mối đe dọa an ninh mạng theo mô hình **STRIDE** (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege) và các chốt chặn kỹ thuật tương ứng.

---

## 1. MA TRẬN MÔ HÌNH ĐE DỌA STRIDE

| Hạng Mục STRIDE | Mối Đe Dọa Cụ Thể Trong OmniNovel | Chốt Chặn Kỹ Thuật (Mitigation Control) |
| :--- | :--- | :--- |
| **Spoofing (Giả mạo danh tính)** | Kẻ tấn công giả mạo Uploader để tải lên nội dung độc hại. | Xác thực JWT kép (Access 15p + Refresh 7d) có Rotation, bắt buộc Argon2id. |
| **Tampering (Sửa đổi dữ liệu)** | Thay đổi URL ảnh hoặc sửa đổi kết quả dịch AI của người khác. | Kiểm tra Ownership-based Authorization và kiểm tra tính toàn vẹn chữ ký HMAC. |
| **Repudiation (Chối bỏ hành động)** | Uploader/Admin chối bỏ việc xóa truyện hoặc duyệt nội dung vi phạm. | Bảng `audit_logs` ghi nhận bất biến: `user_id`, `action`, `ip_address`, `timestamp`. |
| **Information Disclosure (Lộ dữ liệu)** | Bị bot quét cào trộm toàn bộ kho ảnh Manga gốc hoặc lộ truyện Private. | Dynamic HMAC-SHA256 Signed URLs (hết hạn 30p) + Phân quyền Private/Unlisted/Public. |
| **Denial of Service (Từ chối dịch vụ)** | Tấn công DDoS hoặc spam kích hoạt AI Worker làm sập hệ thống. | Rate Limiting phân tầng theo ngữ cảnh (60 req/min đọc truyện, 5 req/min tạo AI Job). |
| **Elevation of Privilege (Leo thang đặc quyền)** | Reader gửi request sửa đổi quyền hạn thành Admin (IDOR / Mass Assignment). | DTO Validation Pipe (`whitelist: true, forbidNonWhitelisted: true`) + NestJS RBAC Guard. |

---

## 2. BẢO MẬT TẢI LÊN FILE & PHÒNG CHỐNG ZIP SLIP / ZIP BOMB

1. **Phòng chống Zip Slip:** Kiểm tra chặt chẽ đường dẫn file khi giải nén, từ chối mọi tệp tin chứa ký tự `../` hoặc đường dẫn tuyệt đối.
2. **Phòng chống Zip Bomb:** Giới hạn tỷ lệ nén (Decompression Ratio $< 100$), giới hạn tổng số lượng file trong 1 ZIP $< 200$ files và tổng dung lượng giải nén $< 300MB$.
3. **Kiểm tra Magic Bytes:** Đọc trực tiếp byte đầu file trên RAM (`FF D8 FF` cho JPEG, `89 50 4E 47` cho PNG, `50 4B 03 04` cho ZIP).
4. **Re-encoding Sanitization:** Tái nén toàn bộ ảnh qua Sharp/OpenCV loại bỏ 100% metadata EXIF chứa mã độc ẩn.

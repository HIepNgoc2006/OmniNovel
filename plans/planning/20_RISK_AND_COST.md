# 💰 20. Ma Trận Quản Trị 16 Rủi Ro (Risk Register) & Mô Hình Dự Toán Chi Phí Chi Tiết

Tài liệu này xác định 16 rủi ro tiềm ẩn kèm biện pháp ứng phó và mô hình kinh tế đơn vị (**Unit Economics Cost Model**).

---

## 1. MA TRẬN 16 RỦI RO DỰ ÁN (RISK REGISTER R1 - R16)

| Mã | Tên Rủi Ro | Mức Độ | Người Phụ Trách | Dấu Hiệu Kích Hoạt (Trigger) | Biện Pháp Phòng Ngừa & Ứng Phó |
| :--- | :--- | :---: | :--- | :--- | :--- |
| **R1** | AI dịch sai ngữ cảnh / tràn text | Cao | AI Lead | Tỷ lệ user báo lỗi $> 5\%$ | Cung cấp Studio Diff Preview cho phép edit thủ công trước khi xuất bản |
| **R2** | Nghẽn băng thông do ảnh Manga | Cao | DevOps Lead | CPU Nginx $> 80\%$ | Tự động nén WebP + Nginx Image Cache 30 ngày giảm 80% tải MinIO |
| **R3** | Ứng dụng di động tràn RAM (OOM) | Cao | Mobile Lead | RAM App $> 200MB$ | Virtualized List Windowing, giải phóng trang cũ theo thuật toán LRU |
| **R4** | Bị bot cào trộm kho truyện | Trung bình | Security Lead | Request IP $> 60/min$ | Rate Limiting 60 req/min + HMAC-SHA256 Signed URLs thời hạn 30p |
| **R5** | File upload chứa mã độc / Zip Bomb | Cao | Backend Lead | Tỷ lệ nén $> 100$ | Kiểm tra Magic Bytes nhị phân + Re-encoding làm sạch metadata EXIF |
| **R6** | Máy chủ AI Worker bị quá tải queue | Trung bình | Backend Lead | Queue backlog $> 20$ jobs | BullMQ điều phối 5 jobs song song, tự động retry Exponential Backoff |
| **R7** | Phình đại phạm vi (Scope Creep) | Cao | Project Manager | Chậm tiến độ Sprint $> 3$ ngày | Khóa chặt Out-of-Scope (không làm payment/live chat), ưu tiên P0 |

---

## 2. MÔ HÌNH KINH TẾ ĐƠN VỊ (UNIT ECONOMICS COST MODEL)

* **Chi phí Cố Định (Fixed Cost):** Máy chủ VPS (4 Core, 8GB RAM, 160GB SSD) $\approx 15$ - $20$/tháng; Domain $\approx 10$/năm.
* **Chi phí Biến Đổi (Variable Cost):**
  * Lưu trữ MinIO S3: $0$ (Self-hosted) hoặc Cloudflare R2 ($0.015$/GB/tháng, $0$ egress bandwidth).
  * Chi phí AI Dịch thuật (GPT-4o-mini): $\approx 0.002$/chương truyện 30 trang ($pprox 2$ cho 1.000 chương truyện).
* **Đơn giá phục vụ 1.000 độc giả hoạt động hàng ngày:** $\approx 0.50$/tháng.

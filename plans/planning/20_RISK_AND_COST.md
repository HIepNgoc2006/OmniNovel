# ⚠️ 20. Ma Trận Quản Trị 16 Rủi Ro (R1 - R16) & Mô Hình Chi Phí Vận Hành (Risk & Cost Model)

Tài liệu này xác định ma trận 16 rủi ro trọng yếu phân loại theo các nhóm (Kỹ thuật, An toàn thông tin, AI, Pháp lý bản quyền, Quản trị dự án) và mô hình dự toán chi phí vận hành (**Unit Economics**).

---

## 1. MA TRẬN 16 RỦI RO TRỌNG YẾU (RISK MATRIX R1 - R16)

| Mã Rủi Ro | Mô Tả Rủi Ro Cụ Thể | Mức Độ | Biện Pháp Giảm Thiểu & Kế Hoạch Ứng Phó (Mitigation Plan) |
| :--- | :--- | :---: | :--- |
| **R1** | Tràn bộ nhớ RAM trên điện thoại khi cuộn Webtoon dài 100 trang ảnh 2K. | **Cao** | Áp dụng Virtualized List giải phóng trang ảnh ngoài viewport; nén WebP $< 200KB$/trang. |
| **R2** | Bot lậu cào trộm toàn bộ kho ảnh Manga qua link trực tiếp. | **Cao** | Sử dụng Dynamic HMAC Signed URLs thời hạn 15 phút + Nginx Rate Limiting theo IP. |
| **R3** | Lỗi tấn công Zip Slip / Zip Bomb khi người dùng upload file nén độc hại. | **Cao** | Quét magic bytes, chuẩn hóa đường dẫn loại bỏ `../`, giới hạn tỷ lệ nén tối đa $100:1$. |
| **R4** | Độc giả spam script reload để cày farm EXP lên Level nhanh. | **Trung bình**| Áp dụng Anti-farming gate: Chỉ tính EXP 1 lần / chapter / user; giới hạn tối đa 100 EXP/ngày. |
| **R5** | Sai lệch số dư OmniCoin khi nhiều request điểm danh gửi đồng thời. | **Cao** | CSDL Transaction ACID + Single-Entry Immutable Ledger + Idempotency Key (`CHECKIN:<user>:<date>:EXP`). |
| **R6** | Chi phí gọi API AI (OpenAI GPT-4o-mini) tăng đột biến do người dùng dịch liên tục. | **Trung bình**| Giới hạn 2 tác vụ dịch đồng thời/user + Caching bản dịch phân đoạn + Adapter hỗ trợ Local LLM. |
| **R7** | Trôi lệch kế hoạch đồ án (Schedule Overrun) vượt quá thời hạn 8 tuần. | **Cao** | Đưa Offline Mode và Inline Comments sang V1 Scope; cố định phạm vi MVP tối thiểu (P0). |
| **R8** | Khiếu nại bản quyền tác phẩm (Copyright Dispute / Takedown Request). | **Cao** | Áp dụng Takedown Workflow: Tạm ẩn `visibility = 'PRIVATE'` trong 48h xác minh giấy phép. |
| **R9** | Sự cố gián đoạn dịch vụ AI Provider (OpenAI / DeepL API Outage). | **Trung bình**| Kiến trúc Adapter tự động fallback sang mô hình phụ trợ hoặc Local LLM nội bộ. |
| **R10**| Mất mát dữ liệu do sự cố phần cứng máy chủ (Data Loss Disaster). | **Cao** | Thiết lập Cronjob tự động backup CSDL PostgreSQL và MinIO sang vùng lưu trữ dự phòng mỗi ngày. |
| **R11**| Rò rỉ thông tin nhạy cảm qua file cấu hình hoặc biến môi trường. | **Cao** | Đặt toàn bộ secrets trong `.env`, commit file `.gitignore` nghiêm ngặt và quét Secret qua CI/CD. |
| **R12**| Lỗi xung đột tiến độ đọc khi người dùng đọc đồng thời trên 2 thiết bị. | **Thấp** | Cập nhật theo cơ chế Last-Write-Wins dựa trên `updated_at` timestamp chuẩn UTC. |
| **R13**| Bản dịch AI bị lỗi chính tả hoặc dịch sai thuật ngữ quan trọng. | **Trung bình**| Tích hợp bắt buộc bảng Từ Điển Thuật Ngữ (`Glossary`) và hiển thị Diff Preview cho người duyệt. |
| **R14**| Đứt kết nối mạng trong lúc đang xử lý tác vụ dịch AI dài. | **Thấp** | Áp dụng mô hình WebSocket Reconnect-Aware kèm REST API query trạng thái từ Redis. |
| **R15**| Xung đột phiên bản khi nhiều người cùng chỉnh sửa một chapter. | **Trung bình**| Mô hình `ChapterVersion` bất biến ngăn chặn ghi đè vật lý; lưu trữ phiên bản độc lập. |
| **R16**| Hiệu năng tìm kiếm bị chậm khi số lượng truyện lên đến hàng chục nghìn bộ. | **Trung bình**| Sử dụng PostgreSQL GIN Trigram Index kết hợp bộ nhớ đệm Redis L2 Caching cho từ khóa HOT. |

---

## 2. MÔ HÌNH CHI PHÍ VẬN HÀNH & ĐƠN GIÁ (UNIT ECONOMICS & COST MODEL)

### 2.1. Các giả định định lượng (Assumptions):
1. **Dung lượng ảnh Manga:** Trung bình 30 trang/chapter $\times$ 180 KB/trang (WebP) $\approx$ **5.4 MB / chapter**.
2. **Chi phí Dịch AI (OpenAI GPT-4o-mini API):**
   * Trung bình 30 khung thoại/chapter $\approx$ 1,500 Input Tokens + 1,200 Output Tokens.
   * Đơn giá: \$0.15 / 1M input tokens + \$0.60 / 1M output tokens.
   * Chi phí AI Token cho 1 chapter $\approx$ **\$0.00095 USD / chapter** (chưa đến 25 VNĐ/chapter).
3. **Băng thông phân phối (CDN Bandwidth):** Giả định mỗi độc giả đọc 10 chapters/ngày $\approx$ 54 MB/ngày $\rightarrow$ 1,000 DAU tiêu thụ $\approx$ 54 GB/ngày.

### 2.2. Phân Tách Chi Phí Hạ Tầng & AI Compute:
| Hạng Mục Hạ Tầng | Cấu Hình Kỹ Thuật | Chi Phí Ước Tính / Tháng |
| :--- | :--- | :---: |
| **Hạ tầng Core VPS** | 4 vCPU, 8GB RAM, 160GB SSD (Chạy Web, API, Postgres, Redis, MinIO, Nginx) | **\$15 - \$20 USD** (~400.000 VNĐ) |
| **Lưu trữ & Băng thông MinIO** | Lưu trữ 100GB dữ liệu truyện + Egress Traffic qua Cloudflare | **\$0 USD** (Tận dụng Free Tier / Local) |
| **Chi phí AI Token API (GPT-4o-mini)**| Xử lý dịch 1,000 chapters mới/tháng qua GPT-4o-mini API | **\$1.00 - \$2.00 USD** (~50.000 VNĐ) |
| **Chi phí AI GPU Worker Compute** | Chạy CV/ML Models (Manga-OCR, LaMa Inpaint) trên máy Local Dev có GPU | **\$0 USD** (Tận dụng phần cứng sẵn có) |
| **TỔNG CHI PHÍ VẬN HÀNH DEMO** | **Hoàn toàn khả thi và tiết kiệm tối đa cho môi trường học tập** | **$\approx$ \$20 USD / tháng** |

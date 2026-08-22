# 📋 Phase 3: AI Translation Worker & Upload Queue

- **Mục tiêu:** Xây dựng Worker xử lý ảnh Manga, dịch thuật ngữ Light Novel và hoàn thiện logic 2 phương án.
- **Trạng thái:** [ ] Chưa bắt đầu

---

### Danh Sách Đầu Việc (Checklist):
- [ ] Xây dựng AI Worker Python FastAPI
- [ ] Module Manga: Phát hiện bóng thoại (Contours/YOLO) + OCR tiếng Nhật/Hàn/Trung
- [ ] Module Manga: Inpainting xóa chữ cũ + Typesetting tự động căn chỉnh chữ tiếng Việt
- [ ] Module Light Novel: Trích xuất Glossary + Dịch văn phong tiểu thuyết
- [ ] Tích hợp BullMQ & Redis Queue điều phối hàng đợi tác vụ dịch ngầm
- [ ] Hoàn thiện logic 2 phương án sau dịch: **Ghi đè (Overwrite)** và **Nhân bản (Duplicate)**

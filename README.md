# 📚 OmniNovel – Nền tảng Đọc Truyện Đa Phương Thức & AI Translation Studio

Dự án phục vụ đồ án liên môn 5 môn học:
- **Kỹ năng lập trình nâng cao**
- **Phát triển ứng dụng di động**
- **Triển khai phần mềm (DevOps)**
- **An toàn thông tin**
- **Quản lý dự án công nghệ thông tin**

## 🌟 Tính năng chính
1. **Đọc truyện tranh & Manga:** Theo phong cách **TruyenQQ** (Chọn Server ảnh CDN, chế độ Cuộn/Lật, Báo lỗi chương).
2. **Đọc truyện chữ & Light Novel:** Theo phong cách **DocLN / Valvrare** (Tùy chỉnh font, màu nền Sepia/Dark, cây mục lục đa cấp).
3. **AI Translation Studio:** Tự động OCR bóng thoại truyện tranh, dịch thuật ngữ truyện chữ, hỗ trợ 2 chế độ sau khi dịch: **Ghi đè file gốc** hoặc **Nhân bản (Duplicate) thành bản dịch riêng**.
4. **Bảo mật & Tối ưu:** Chống Bot cào trộm (Anti-Leech), Caching Redis 3 tầng, mã hóa dữ liệu.
5. **Hạ tầng DevOps:** Đóng gói Docker Compose, Nginx Caching, CI/CD tự động build APK và deploy VPS.

## 🚀 Cấu trúc dự án
```
Doctruyen_project/
├── .agents/             # Cấu hình Agent & quy chuẩn dự án
├── plans/               # Quản lý Roadmap & Phase tracking
├── apps/
│   ├── web/             # Web đọc truyện & Studio (Next.js)
│   └── mobile/          # Mobile App (Flutter / React Native)
├── services/
│   ├── api/             # Core Backend API
│   └── ai-worker/       # Dịch vụ xử lý ảnh & AI Translation
├── packages/
│   └── shared/          # Types & Shared Utils
├── deploy/              # Dockerfile, Docker Compose, Nginx
└── .env.example         # Mẫu biến môi trường
```

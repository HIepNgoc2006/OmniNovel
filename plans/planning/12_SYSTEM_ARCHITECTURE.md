# 📐 12. Kiến Trúc Hệ Thống Tổng Thể, Monorepo & Ranh Giới Module

Tài liệu này xác định ranh giới phân tầng Clean Architecture, cấu trúc Monorepo và ranh giới các module trong NestJS Core API.

---

## 1. SƠ ĐỒ KIẾN TRÚC TỔNG THỂ HỆ THỐNG (SYSTEM ARCHITECTURE DIAGRAM)

```
┌──────────────────────────┐      ┌──────────────────────────┐
│   Web Client (Next.js)   │      │   Mobile App (Flutter)   │
│  • Reader UI (Manga/LN)  │      │  • 120Hz Webtoon Engine  │
│  • Studio & AI Dashboard │      │  • Offline SQLite Cache  │
└────────────┬─────────────┘      └────────────┬─────────────┘
             │                                 │
             └────────────────┬────────────────┘
                              │ HTTPS / WSS
                              ▼
┌────────────────────────────────────────────────────────────┐
│                    Nginx Reverse Proxy                     │
│  • Rate Limiting & SSL Termination                         │
│  • Caching Static Chunks & Media Routing                   │
└─────────────────────────────┬──────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│                NestJS Core Backend API                     │
│  ┌───────────────┬───────────────┬──────────────────────┐  │
│  │  AuthModule   │ CatalogModule │  GamificationModule  │  │
│  ├───────────────┼───────────────┼──────────────────────┤  │
│  │ ReaderModule  │ LibraryModule │  TranslationModule   │  │
│  ├───────────────┼───────────────┼──────────────────────┤  │
│  │ UploadModule  │  AdminModule  │     SearchModule     │  │
│  └───────────────┴───────────────┴──────────────────────┘  │
└──────┬──────────────┬──────────────┬──────────────┬────────┘
       │              │              │              │
       ▼              ▼              ▼              ▼
┌─────────────┐┌─────────────┐┌─────────────┐┌─────────────┐
│ PostgreSQL16││   Redis 7   ││MinIO Storage││BullMQ Queue │
│ (Relational ││(L2 Cache &  ││ (S3 Media   ││(AI Pipeline │
│  Database)  ││   Sessions) ││   Assets)   ││   Worker)   │
└─────────────┘└─────────────┘└─────────────┘└──────┬──────┘
                                                    │ HTTP/gRPC
                                                    ▼
                                            ┌─────────────┐
                                            │  Python AI  │
                                            │   Engine    │
                                            │(CV/ML Tasks)│
                                            └─────────────┘
```

---

## 2. DANH MỤC CÁC MODULE TRONG NESTJS (MODULE BOUNDARIES)

1. **`AuthModule`:** Quản lý đăng ký, đăng nhập, JWT Token Rotation (Access/Refresh Token), mã hóa mật khẩu Argon2id.
2. **`UserModule`:** Quản lý thông tin hồ sơ người dùng, cập nhật avatar, phân quyền RBAC toàn cục.
3. **`CatalogModule`:** Quản lý nghiệp vụ tác phẩm (`Story`, `StoryEdition`, `Volume`, `Chapter`, `Genre`, `Creator`).
4. **`ReaderModule`:** Quản lý việc cấp phát HMAC Signed URLs cho trang ảnh Manga, lấy nội dung text Novel kèm metadata typography.
5. **`LibraryModule`:** Quản lý tủ sách cá nhân, đánh dấu theo dõi (`bookmarks`), đồng bộ tiến độ đọc (`reading_progress`).
6. **`UploadModule`:** Quản lý Resumable Upload Session, giải nén ZIP an toàn và tải tệp lên MinIO.
7. **`TranslationModule`:** Quản lý `TranslationProject`, `TranslationJob`, `TranslationGlossary`, đẩy task vào BullMQ và phát tiến trình qua WebSocket Gateway.
8. **`GamificationModule`:** Quản lý `UserProgression`, tính toán Level/EXP với cơ chế chống farm (Anti-farming gate), Điểm danh hằng ngày (`daily_checkins`), Rank Themes và Sổ cái giao dịch bất biến (`reward_transactions`).
9. **`AdminModule`:** Quản lý tiếp nhận và xử lý báo lỗi chương (`chapter_error_reports`), kiểm duyệt nội dung và xem thống kê hệ thống.
10. **`SearchModule`:** Xử lý tìm kiếm toàn văn Full-Text Search và gợi ý từ khóa với độ trễ thấp qua PostgreSQL pg_trgm.

---

## 3. NGUYÊN TẮC THIẾT KẾ CLEAN ARCHITECTURE

```
┌────────────────────────────────────────────────────────────┐
│ 1. Domain Layer (Entities, Value Objects, Domain Events)   │
│    • Độc lập 100% với Database, Framework và Thư viện ngoài│
├────────────────────────────────────────────────────────────┤
│ 2. Application Layer (Use Cases, DTOs, Interface Contracts)│
│    • Điều phối luồng nghiệp vụ, định nghĩa Repository Ports│
├────────────────────────────────────────────────────────────┤
│ 3. Infrastructure Layer (TypeORM/Prisma, Redis, MinIO)     │
│    • Cài đặt chi tiết các Repository Adapters và kết nối DB│
├────────────────────────────────────────────────────────────┤
│ 4. Presentation Layer (NestJS Controllers, WebSocket Gates)│
│    • Nhận HTTP Request, Validate dữ liệu DTO và trả về JSON│
└────────────────────────────────────────────────────────────┘
```

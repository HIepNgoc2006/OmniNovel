# 📐 12. Kiến Trúc Hệ Thống Tổng Thể, Monorepo & Ranh Giới Module

Tài liệu này xác định ranh giới phân tầng Clean Architecture, cấu trúc Monorepo và ranh giới các module trong NestJS.

---

## 1. RANH GIỚI MODULE TRONG CORE BACKEND (NESTJS MODULE BOUNDARIES)

* `AuthModule`: Quản lý đăng ký, đăng nhập, JWT Rotation, Argon2id.
* `UserModule`: Quản lý thông tin tài khoản, avatar, phân quyền RBAC.
* `CatalogModule`: Quản lý Story, StoryEdition, Volume, Chapter, Genre, Creator.
* `ReaderModule`: Quản lý việc cấp phát Signed URLs ảnh, lấy nội dung text Novel.
* `LibraryModule`: Quản lý tủ sách cá nhân, tiến độ đọc, bookmark.
* `UploadModule`: Quản lý Resumable Upload Session, giải nén ZIP an toàn.
* `TranslationModule`: Quản lý TranslationProject, TranslationJob, BullMQ Producer.
* `AdminModule`: Quản lý báo lỗi chương, kiểm duyệt nội dung, audit log.

---

## 2. QUY TẮC PHỤ THUỘC CLEAN ARCHITECTURE (DEPENDENCY RULE)

```
[Domain Entities & Rules] (Không import bất kỳ framework/database nào)
            ▲
            │
[Application Use Cases & DTOs]
            ▲
            │
[Infrastructure: TypeORM, MinIO, Redis, BullMQ, NestJS Controllers]
```

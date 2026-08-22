# 🏛️ 08. Mô Hình Miền Nghiệp Vụ (Domain Model & Ubiquitous Language)

Tài liệu này xác định các ranh giới miền (Bounded Contexts / Subdomains), các thực thể miền nghiệp vụ (Entities), Value Objects, Aggregates và các sự kiện miền (Domain Events) trong kiến trúc **Domain-Driven Design (DDD)** của OmniNovel.

---

## 1. CÁC PHÂN VÙNG NGHIỆP VỤ (BOUNDED CONTEXTS & SUBDOMAINS)

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   OMNINOVEL BOUNDED CONTEXTS                                    │
├──────────────────┬──────────────────┬──────────────────┬──────────────────┬─────────────────────┤
│ 1. IDENTITY      │ 2. CATALOG       │ 3. READER        │ 4. LIBRARY       │ 5. AI TRANSLATION   │
│ • User           │ • Story          │ • ReadingSession │ • LibraryEntry   │ • TranslationProject│
│ • Role (Global)  │ • StoryEdition   │ • ProgressAnchor │ • Bookmark       │ • TranslationJob    │
│ • StoryMember    │ • Volume/Chapter │ • ViewCounter    │ • OfflineBundle  │ • Segment & Glossary│
│ • Anonymization  │                  │                  │                  │                     │
├──────────────────┼──────────────────┼──────────────────┼──────────────────┼─────────────────────┤
│ 6. PUBLISHING    │ 7. GAMIFICATION  │ 8. MODERATION    │ 9. COMMUNITY(V1) │ 10. NOTIFICATION(V1)│
│ • ChapterVersion │ • UserProgression│ • ErrorReport    │ • StoryReview    │ • SystemAlert       │
│ • MediaAsset     │ • RewardLedger   │ • StoryVisibility│ • ChapterComment │ • PushNotification  │
│ • ActivePointer  │ • DailyCheckin   │ • AuditLog       │ • PanelComment   │ • InAppNotice       │
└──────────────────┴──────────────────┴──────────────────┴──────────────────┴─────────────────────┘
```

---

## 2. CÁC THỰC THỂ CỐT LÕI & CẤU TRÚC AGGREGATES (CORE AGGREGATES)

### 2.1. Aggregate Root: `User` & `StoryMember` (Identity Domain)
* **`User` (Entity):** Quản lý thông tin xác thực (`id`, `username`, `email`, `password_hash`, `role`, `is_active`, `is_deleted`, `deleted_at`).
  * **Vòng đời Ẩn danh hóa (Account Anonymization):** Khi xóa tài khoản, hệ thống chuyển trạng thái `is_deleted = TRUE`, ẩn danh hóa email/username nhưng **giữ nguyên UUID nội bộ** để bảo vệ toàn vẹn lịch sử Sổ cái Ledger và quyền tác giả.
* **`StoryMember` (Canonical Entity):** **Nguồn sự thật duy nhất về quyền sở hữu và phân quyền bộ truyện** (`id`, `story_id`, `user_id`, `role: OWNER | EDITOR | TRANSLATOR | UPLOADER`).

### 2.2. Aggregate Root: `Story` & `StoryEdition` (Catalog Domain)
```
Story (created_by)
├── StoryMember (Canonical Ownership & Permissions: OWNER, EDITOR, TRANSLATOR, UPLOADER)
├── StoryCreator (Author, Artist, Illustrator)
└── StoryEdition (Dòng Xuất Bản: Bản Dịch Chính Thức, Bản Dịch Cộng Đồng...)
    └── Volume (Tập 1, Tập 2...)
        └── Chapter (Chương 1, Chương 2...)
            └── ChapterVersion (Immutable Versions: Raw ja, AI vi, Edited vi)
                └── MediaAsset (Trang ảnh WebP, Novel HTML, Illustration)
```

* **`Story` (Entity):** Đại diện cho tác phẩm gốc (`id`, `title`, `slug`, `media_format: COMIC | NOVEL`, `publication_format`, `origin_country`, `summary`, `cover_url`, `created_by`, `visibility`).
* **`StoryEdition` (Entity):** Đại diện cho một dòng xuất bản / nhóm phát hành (`id`, `story_id`, `edition_name`, `language: default language`, `is_default`).

### 2.3. Aggregate Root: `Chapter` & `ChapterVersion` (Publishing Domain)
* **`Chapter` (Entity):** Container logic chứa các bản phát hành (`id`, `story_edition_id`, `volume_id`, `chapter_number`, `title`, `active_version_id`).
* **`ChapterVersion` (Immutable Entity):** Bản phát hành cụ thể (`id`, `chapter_id`, `version_number`, `version_type: RAW_ORIGINAL | AI_TRANSLATED | HUMAN_EDITED`, `language`, `is_published`).
  * **Quy tắc bất biến (Invariance Rule):** Bản ghi `ChapterVersion` khi đã tạo thì không được sửa đổi nội dung tệp tin media; nếu có thay đổi bắt buộc phải sinh `version_number` mới.
* **`MediaAsset` (Entity):** Tệp tin thành phần (`id`, `version_id`, `sort_order`, `asset_type: MANGA_PAGE | NOVEL_HTML | ILLUSTRATION`, `storage_key`, `file_size_bytes`).

### 2.4. Aggregate Root: `UserProgression` & `RewardTransaction` (Gamification Domain)
* **`UserProgression`:** Hồ sơ tiến trình độc giả (`user_id`, `level: derived`, `total_exp: SSoT`, `omnicoin_balance`, `current_streak`, `rank_theme_id`).
* **`RewardTransaction` (Single-entry Immutable Ledger):** Sổ cái ghi nhận mọi giao dịch điểm (`id`, `user_id`, `reward_type: EXP | OMNICOIN`, `amount`, `balance_after`, `source_type: CHECKIN | READ_CHAPTER | LEVEL_REWARD`, `idempotency_key: UNIQUE NOT NULL`).

### 2.5. Aggregate Root: `AuditLog` (Moderation & Security Domain)
* **`AuditLog` (Entity):** Nhật ký kiểm toán bảo mật và hành động nhạy cảm (`id`, `actor_user_id`, `action`, `resource_type`, `resource_id`, `ip_address`, `metadata_json`, `created_at`).

---

## 3. CÁC SỰ KIỆN MIỀN NGHIỆP VỤ (DOMAIN EVENTS)

* `ChapterCreatedEvent`: Phát sinh khi một chương mới được khởi tạo trong một StoryEdition.
* `RawMediaUploadedEvent`: Phát sinh khi uploader hoàn tất upload file ZIP/Text vào MinIO.
* `TranslationJobQueuedEvent`: Phát sinh khi tác vụ dịch AI được đưa vào hàng đợi BullMQ.
* `TranslationProgressUpdatedEvent`: Phát sinh khi một trang/đoạn được xử lý xong để stream % qua WebSocket.
* `TranslationJobCompletedEvent`: Phát sinh khi AI hoàn tất 100%, sẵn sàng cho màn hình Diff Preview.
* `ChapterVersionActivatedEvent`: Phát sinh khi Editor/Owner chọn Ghi đè (trỏ `active_version_id` sang version mới) hoặc Nhân bản.
* `ChapterReadingCompletedEvent`: Phát sinh khi độc giả đọc hoàn thành 1 chapter hợp lệ, kích hoạt logic tính Total EXP (Anti-farming check).
* `DailyCheckinCompletedEvent`: Phát sinh khi độc giả điểm danh thành công trong ngày.
* `UserLevelUpEvent`: Phát sinh khi Total EXP vượt ngưỡng lên cấp, mở khóa phần thưởng Level mới.
* `UserAccountAnonymizedEvent`: Phát sinh khi người dùng yêu cầu xóa tài khoản, kích hoạt luồng ẩn danh hóa và chuyển quyền sở hữu truyện.

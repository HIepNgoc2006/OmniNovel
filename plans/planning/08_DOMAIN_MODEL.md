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
├──────────────────┼──────────────────┼──────────────────┼──────────────────┼─────────────────────┤
│ 6. PUBLISHING    │ 7. GAMIFICATION  │ 8. MODERATION    │ 9. COMMUNITY(V1) │ 10. NOTIFICATION    │
│ • ChapterVersion │ • UserProgression│ • ErrorReport    │ • StoryReview    │ • SystemAlert       │
│ • MediaAsset     │ • RewardLedger   │ • ContentTakedown│ • ChapterComment │ • PushNotification  │
│ • ActivePointer  │ • DailyCheckin   │ • AuditLog       │ • PanelComment   │ • InAppNotice       │
└──────────────────┴──────────────────┴──────────────────┴──────────────────┴─────────────────────┘
```

---

## 2. CÁC THỰC THỂ CỐT LÕI & CẤU TRÚC AGGREGATES (CORE AGGREGATES)

### 2.1. Aggregate Root: `Story` & `StoryEdition` (Catalog Domain)
```
Story
├── StoryMember (OWNER, EDITOR, TRANSLATOR, UPLOADER)
├── StoryCreator (Author, Artist, Illustrator)
└── StoryEdition (Ngôn ngữ / Ấn bản: Original Japanese, Vietnamese Official, Fan Translation)
    └── Volume (Tập 1, Tập 2...)
        └── Chapter (Chương 1, Chương 2...)
            └── ChapterVersion (Immutable Versions)
                └── MediaAsset (Trang ảnh WebP, Novel HTML, Illustration)
```

* **`Story` (Entity):** Đại diện cho tác phẩm gốc (`id`, `title`, `slug`, `media_format: COMIC | NOVEL`, `publication_format`, `origin_country`, `summary`, `cover_url`).
* **`StoryEdition` (Entity):** Đại diện cho một ấn bản theo ngôn ngữ hoặc nhóm dịch (`id`, `story_id`, `edition_name`, `language`, `is_default`).
* **`StoryMember` (Entity):** Xác định quyền hạn cộng tác viên theo từng bộ truyện (`id`, `story_id`, `user_id`, `role: OWNER | EDITOR | TRANSLATOR | UPLOADER`).
* **`StoryCreator` (Join Entity):** Liên kết tác phẩm với tác giả/họa sĩ (`story_id`, `creator_id`, `role: AUTHOR | ARTIST | ILLUSTRATOR`).

### 2.2. Aggregate Root: `Chapter` & `ChapterVersion` (Publishing Domain)
* **`Chapter` (Entity):** Container logic chứa các bản phát hành (`id`, `story_edition_id`, `volume_id`, `chapter_number`, `title`, `active_version_id`).
* **`ChapterVersion` (Immutable Entity):** Bản phát hành cụ thể (`id`, `chapter_id`, `version_number`, `version_type: RAW_ORIGINAL | AI_TRANSLATED | HUMAN_EDITED`, `language`, `is_published`).
  * **Quy tắc bất biến (Invariance Rule):** Bản ghi `ChapterVersion` khi đã tạo thì không được sửa đổi nội dung tệp tin media; nếu có thay đổi bắt buộc phải sinh `version_number` mới.
* **`MediaAsset` (Entity):** Tệp tin thành phần (`id`, `version_id`, `sort_order`, `asset_type: MANGA_PAGE | NOVEL_HTML | ILLUSTRATION`, `storage_key`, `file_size_bytes`).

### 2.3. Aggregate Root: `TranslationProject` & `TranslationJob` (AI Domain)
* **`TranslationProject`:** Dự án dịch thuật (`id`, `story_edition_id`, `source_lang`, `target_lang`).
* **`TranslationJob`:** Một phiên dịch cụ thể cho 1 ChapterVersion (`id`, `project_id`, `source_version_id`, `target_version_id`, `status: 14 states`, `progress_percentage`).
* **`TranslationSegment`:** Từng khung thoại / đoạn văn (`id`, `job_id`, `sort_order`, `bbox`, `raw_text`, `translated_text`, `confidence`).
* **`GlossaryTerm`:** Cặp từ vựng cố định (`id`, `project_id`, `source_term`, `target_term`, `category`).

### 2.4. Aggregate Root: `UserProgression` & `RewardTransaction` (Gamification Domain)
* **`UserProgression`:** Hồ sơ tiến trình độc giả (`user_id`, `level`, `current_exp`, `omnicoin_balance`, `current_streak`, `rank_theme_id`).
* **`RewardTransaction` (Single-entry Immutable Ledger):** Sổ cái ghi nhận mọi giao dịch điểm (`id`, `user_id`, `reward_type: EXP | OMNICOIN`, `amount`, `balance_after`, `source_type: CHECKIN | READ_CHAPTER | LEVEL_REWARD`, `idempotency_key`).

---

## 3. CÁC SỰ KIỆN MIỀN NGHIỆP VỤ (DOMAIN EVENTS)

* `ChapterCreatedEvent`: Phát sinh khi một chương mới được khởi tạo trong một StoryEdition.
* `RawMediaUploadedEvent`: Phát sinh khi uploader hoàn tất upload file ZIP/Text vào MinIO.
* `TranslationJobQueuedEvent`: Phát sinh khi tác vụ dịch AI được đưa vào hàng đợi BullMQ.
* `TranslationProgressUpdatedEvent`: Phát sinh khi một trang/đoạn được xử lý xong để stream % qua WebSocket.
* `TranslationJobCompletedEvent`: Phát sinh khi AI hoàn tất 100%, sẵn sàng cho màn hình Diff Preview.
* `ChapterVersionActivatedEvent`: Phát sinh khi người dùng chọn Ghi đè (trỏ `active_version_id` sang version mới) hoặc Nhân bản.
* `ChapterReadingCompletedEvent`: Phát sinh khi độc giả đọc hoàn thành 1 chapter hợp lệ, kích hoạt logic tính EXP (Anti-farming check).
* `DailyCheckinCompletedEvent`: Phát sinh khi độc giả điểm danh thành công trong ngày.
* `UserLevelUpEvent`: Phát sinh khi EXP vượt ngưỡng lên cấp, mở khóa phần thưởng Level mới.

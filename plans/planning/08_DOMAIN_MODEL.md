# 🏛️ 08. Mô Hình Miền Nghiệp Vụ (Domain Model & Ubiquitous Language)

Tài liệu này xác định ranh giới ngữ cảnh (Bounded Contexts), các thực thể miền nghiệp vụ (Entities), Value Objects, Aggregates và các sự kiện miền (Domain Events) trong kiến trúc **Domain-Driven Design (DDD)** của OmniNovel.

---

## 1. CÁC RANH GIỚI NGỮ CẢNH (BOUNDED CONTEXTS)

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   OMNINOVEL BOUNDED CONTEXTS                                    │
├──────────────────┬──────────────────┬──────────────────┬──────────────────┬─────────────────────┤
│ 1. CATALOG CONTEXT│ 2. READER CONTEXT│ 3. LIBRARY CONTEXT│ 4. AI CONTEXT   │ 5. PUBLISHING       │
│ • Story / Work   │ • Reading Session│ • Library Entry  │ • TranslationProj│ • ChapterVersion    │
│ • Edition        │ • Progress Anchor│ • Bookmark       │ • TranslationJob │ • Media Asset       │
│ • Volume         │ • View Counter   │ • Offline Bundle │ • Segment/Glossar│ • Active Version Pointer
└──────────────────┴──────────────────┴──────────────────┴──────────────────┴─────────────────────┘
```

---

## 2. CÁC THỰC THỂ CỐT LÕI (CORE ENTITIES & AGGREGATES)

### 2.1. Aggregate Root: \`Story\` & \`StoryEdition\`
* \`Story\`: Định danh tác phẩm (\`id\`, \`slug\`, \`title\`, \`media_format: COMIC | NOVEL\`, \`publication_format: MANGA | MANHWA | WEBTOON | LIGHT_NOVEL\`, \`origin_country\`, \`original_language\`).
* \`StoryEdition\`: Ấn bản cụ thể (\`id\`, \`story_id\`, \`edition_name: Original | Vietnamese Official | AI Translated\`, \`language: ja | ko | vi | en\`).

### 2.2. Aggregate Root: \`Chapter\` & \`ChapterVersion\` (Bất Biến - Immutable Versioning)
* \`Chapter\`: Đơn vị chương logic (\`id\`, \`story_id\`, \`volume_id\`, \`chapter_number\`, \`active_version_id\`).
* \`ChapterVersion\`: **Bản phát hành bất biến cụ thể của chương** (\`id\`, \`chapter_id\`, \`version_number\`, \`version_type: RAW_ORIGINAL | AI_TRANSLATED | HUMAN_EDITED\`, \`language\`, \`created_by\`, \`created_at\`).
* \`MediaAsset\`: Tệp tin cụ thể (\`id\`, \`version_id\`, \`page_number\`, \`storage_key\`, \`mime_type\`, \`width\`, \`height\`, \`file_size\`).

### 2.3. Aggregate Root: \`TranslationProject\` & \`TranslationJob\`
* \`TranslationProject\`: Quản trị dự án dịch (\`id\`, \`story_id\`, \`source_lang\`, \`target_lang\`, \`glossary_id\`).
* \`TranslationJob\`: Một phiên dịch cụ thể (\`id\`, \`project_id\`, \`source_version_id\`, \`target_version_id\`, \`status: 14 states\`, \`progress_percentage\`).
* \`TranslationSegment\`: Khung thoại / đoạn text (\`id\`, \`job_id\`, \`page_number\`, \`bbox: x,y,w,h\`, \`raw_text\`, \`translated_text\`, \`confidence\`, \`is_human_verified\`).

---

## 3. CÁC SỰ KIỆN MIỀN (DOMAIN EVENTS)

* \`ChapterCreatedEvent\`: Phát sinh khi một chương mới được khởi tạo.
* \`RawFilesUploadedEvent\`: Phát sinh khi uploader hoàn tất upload file ZIP ảnh hoặc file text vào MinIO.
* \`TranslationJobQueuedEvent\`: Phát sinh khi tác vụ dịch AI được đưa vào hàng đợi BullMQ.
* \`TranslationSegmentCompletedEvent\`: Phát sinh mỗi khi một trang/đoạn được OCR và dịch xong (dùng để stream % tiến trình).
* \`TranslationJobReadyForReviewEvent\`: Phát sinh khi AI dịch xong 100%, kích hoạt màn hình Diff Preview và Popup 2 Lựa chọn.
* \`ChapterVersionActivatedEvent\`: Phát sinh khi uploader chọn **Ghi đè** (trỏ con trỏ \`active_version_id\` sang version mới) hoặc **Nhân bản**.

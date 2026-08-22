# 🗄️ 09. Thiết Kế Cơ Sở Dữ Liệu PostgreSQL & MinIO Storage (Enterprise Schema)

Tài liệu này cung cấp toàn bộ lược đồ CSDL quan hệ PostgreSQL 16 hoàn chỉnh với 20+ bảng có đầy đủ ràng buộc (Constraints), chỉ mục (Indexes), Khóa ngoại (Foreign Keys) và cấu trúc phân bổ MinIO Storage.

---

## 1. LƯỢC ĐỒ CSDL POSTGRESQL HOÀN CHỈNH (DDL SCRIPTS)

```sql
-- 1. Người dùng & Thiết bị
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'READER' CHECK (role IN ('ADMIN', 'TRANSLATOR', 'READER')),
    avatar_url VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Tác giả & Họa sĩ
CREATE TABLE creators (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    bio TEXT,
    avatar_url VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Bộ truyện (Work / Story)
CREATE TABLE stories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    media_format VARCHAR(20) NOT NULL CHECK (media_format IN ('COMIC', 'NOVEL')),
    publication_format VARCHAR(20) NOT NULL CHECK (publication_format IN ('MANGA', 'MANHWA', 'MANHUA', 'WEBTOON', 'LIGHT_NOVEL', 'WEB_NOVEL')),
    origin_country VARCHAR(10) DEFAULT 'JP',
    original_language VARCHAR(10) DEFAULT 'ja',
    cover_url VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'ONGOING' CHECK (status IN ('ONGOING', 'COMPLETED', 'HIATUS', 'CANCELLED')),
    visibility VARCHAR(20) DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC', 'UNLISTED', 'PRIVATE')),
    summary TEXT,
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    views_count BIGINT DEFAULT 0,
    followers_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Thể loại truyện
CREATE TABLE genres (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    slug VARCHAR(50) UNIQUE NOT NULL
);

CREATE TABLE story_genres (
    story_id UUID REFERENCES stories(id) ON DELETE CASCADE,
    genre_id INT REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (story_id, genre_id)
);

-- 5. Tập truyện (Volumes)
CREATE TABLE volumes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    volume_number INT NOT NULL CHECK (volume_number >= 0),
    title VARCHAR(255) NOT NULL,
    cover_url VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(story_id, volume_number)
);

-- 6. Chương truyện Logic (Chapter Container)
CREATE TABLE chapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    volume_id UUID REFERENCES volumes(id) ON DELETE SET NULL,
    chapter_number NUMERIC(6,2) NOT NULL CHECK (chapter_number >= 0),
    title VARCHAR(255),
    active_version_id UUID, -- Sẽ trỏ vào chapter_versions(id)
    views_count BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(story_id, chapter_number)
);

-- 7. Phiên bản Chương (Chapter Versions - Immutable Model)
CREATE TABLE chapter_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    version_number INT NOT NULL DEFAULT 1,
    version_type VARCHAR(30) NOT NULL CHECK (version_type IN ('RAW_ORIGINAL', 'AI_TRANSLATED', 'HUMAN_EDITED', 'COMMUNITY_FAN')),
    language VARCHAR(10) NOT NULL DEFAULT 'vi',
    source_version_id UUID REFERENCES chapter_versions(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    is_published BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Thêm khóa ngoại cho active_version_id của chapters
ALTER TABLE chapters ADD CONSTRAINT fk_active_version FOREIGN KEY (active_version_id) REFERENCES chapter_versions(id) ON DELETE SET NULL;

-- 8. Tài nguyên Media (Trang ảnh Manga & Text Novel)
CREATE TABLE media_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id UUID NOT NULL REFERENCES chapter_versions(id) ON DELETE CASCADE,
    page_number INT NOT NULL CHECK (page_number >= 1),
    asset_type VARCHAR(20) NOT NULL CHECK (asset_type IN ('MANGA_PAGE', 'NOVEL_HTML', 'ILLUSTRATION')),
    storage_key VARCHAR(255) NOT NULL, -- Đường dẫn trên MinIO
    width INT CHECK (width > 0),
    height INT CHECK (height > 0),
    file_size_bytes BIGINT CHECK (file_size_bytes > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(version_id, page_number)
);

-- 9. Tiến độ Đọc (Reading Progress - Cross-device Conflict Aware)
CREATE TABLE reading_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    version_id UUID REFERENCES chapter_versions(id) ON DELETE SET NULL,
    page_index INT DEFAULT 1,
    scroll_offset_ratio NUMERIC(5,4) DEFAULT 0.0000,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, story_id)
);

-- 10. Tủ Sách Cá Nhân (Library Entries)
CREATE TABLE library_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'READING' CHECK (status IN ('READING', 'PLAN_TO_READ', 'COMPLETED', 'ON_HOLD', 'DROPPED')),
    follow_notifications BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, story_id)
);

-- 11. Dự Án & Tác Vụ Dịch AI
CREATE TABLE translation_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    source_language VARCHAR(10) NOT NULL,
    target_language VARCHAR(10) NOT NULL DEFAULT 'vi',
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE translation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES translation_projects(id) ON DELETE CASCADE,
    source_version_id UUID NOT NULL REFERENCES chapter_versions(id) ON DELETE CASCADE,
    target_version_id UUID REFERENCES chapter_versions(id) ON DELETE SET NULL,
    status VARCHAR(30) DEFAULT 'CREATED' CHECK (status IN (
        'CREATED', 'VALIDATING', 'QUEUED', 'PREPROCESSING', 'OCR', 
        'TRANSLATING', 'INPAINTING', 'TYPESETTING', 'QUALITY_CHECK', 
        'READY_FOR_REVIEW', 'APPLIED', 'FAILED', 'CANCELED', 'EXPIRED'
    )),
    progress_percentage INT DEFAULT 0 CHECK (progress_percentage BETWEEN 0 AND 100),
    current_stage VARCHAR(50) DEFAULT 'INIT',
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE translation_segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
    page_number INT NOT NULL,
    segment_index INT NOT NULL,
    bbox_x INT,
    bbox_y INT,
    bbox_w INT,
    bbox_h INT,
    raw_text TEXT NOT NULL,
    translated_text TEXT,
    confidence_score NUMERIC(4,3) DEFAULT 0.000,
    is_human_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 12. Từ Điển Thuật Ngữ (Glossaries)
CREATE TABLE glossaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES translation_projects(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE glossary_terms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    glossary_id UUID NOT NULL REFERENCES glossaries(id) ON DELETE CASCADE,
    source_term VARCHAR(255) NOT NULL,
    target_term VARCHAR(255) NOT NULL,
    term_category VARCHAR(50) DEFAULT 'CHARACTER_NAME',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 13. Báo Cáo Lỗi & Kiểm Duyệt
CREATE TABLE chapter_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    error_type VARCHAR(50) NOT NULL CHECK (error_type IN ('BROKEN_IMAGE', 'WRONG_ORDER', 'DUPLICATE', 'TRANSLATION_ERROR')),
    description TEXT,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_PROGRESS', 'RESOLVED', 'REJECTED')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- CÁC CHỈ MỤC TỐI ƯU HÓA TRUY VẤN (INDEXES)
CREATE INDEX idx_stories_slug ON stories(slug);
CREATE INDEX idx_stories_views ON stories(views_count DESC);
CREATE INDEX idx_stories_updated ON stories(updated_at DESC);
CREATE INDEX idx_chapters_story_number ON chapters(story_id, chapter_number ASC);
CREATE INDEX idx_media_assets_version_page ON media_assets(version_id, page_number ASC);
CREATE INDEX idx_reading_progress_user ON reading_progress(user_id);
CREATE INDEX idx_library_entries_user ON library_entries(user_id);
CREATE INDEX idx_translation_jobs_status ON translation_jobs(status);
```

---

## 2. CẤU TRÚC LƯU TRỮ TRÊN MINIO OBJECT STORAGE

```
manga-media/
├── raw/{story_id}/{version_id}/page_01.webp
├── inpaint_cleaned/{story_id}/{version_id}/page_01.webp
├── translated/{story_id}/{version_id}/page_01.webp
└── backups/{story_id}/{version_id}/page_01.webp

novel-media/
├── raw/{story_id}/{version_id}/chapter.txt
├── translated/{story_id}/{version_id}/chapter.html
└── illustrations/{story_id}/{volume_id}/illu_01.webp
```

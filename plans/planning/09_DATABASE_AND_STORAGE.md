# 🗄️ 09. Thiết Kế Cơ Sở Dữ Liệu PostgreSQL & MinIO Storage (Enterprise Schema)

Tài liệu này cung cấp toàn bộ lược đồ CSDL quan hệ PostgreSQL 16 hoàn chỉnh với **24 nhóm thực thể (gồm 27 bảng quan hệ)** có đầy đủ ràng buộc (Constraints), chỉ mục (Indexes), Khóa ngoại (Foreign Keys), cơ chế ẩn danh hóa tài khoản và cấu trúc phân bổ MinIO Storage.

---

## 1. LƯỢC ĐỒ CSDL POSTGRESQL HOÀN CHỈNH (CANONICAL DDL)

```sql
-- Kích hoạt extension UUID và Trigram
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- 1. Người dùng & Phân quyền Toàn cục (Hỗ trợ Account Anonymization)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE, -- Cho phép NULL khi tài khoản đã ẩn danh hóa (Deleted)
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'READER' CHECK (role IN ('ADMIN', 'TRANSLATOR', 'READER')),
    avatar_url VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP WITH TIME ZONE,
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

-- 3. Bộ truyện Gốc (Work / Story)
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
    created_by UUID REFERENCES users(id) ON DELETE SET NULL, -- Chỉ ghi nhận metadata người tạo ban đầu
    views_count BIGINT DEFAULT 0,
    followers_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Bảng liên kết Tác giả - Bộ truyện (Story Creators)
CREATE TABLE story_creators (
    story_id UUID REFERENCES stories(id) ON DELETE CASCADE,
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
    role VARCHAR(30) NOT NULL DEFAULT 'AUTHOR' CHECK (role IN ('AUTHOR', 'ARTIST', 'ILLUSTRATOR', 'ORIGINAL_STORY')),
    PRIMARY KEY (story_id, creator_id, role)
);

-- 5. Bảng Phân quyền Thành viên Bộ truyện (Story Members - CANONICAL OWNERSHIP & RBAC)
CREATE TABLE story_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('OWNER', 'EDITOR', 'TRANSLATOR', 'UPLOADER')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(story_id, user_id)
);

-- 6. Thể loại truyện (2 Bảng: genres & story_genres)
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

-- 7. Ấn bản Bộ truyện (Story Editions - Dòng Xuất Bản)
CREATE TABLE story_editions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    edition_name VARCHAR(100) NOT NULL, -- e.g. 'Bản Dịch Chính Thức', 'Bản Dịch Cộng Đồng'
    language VARCHAR(10) NOT NULL DEFAULT 'vi',
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(story_id, edition_name)
);

-- 8. Tập truyện (Volumes)
CREATE TABLE volumes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_edition_id UUID NOT NULL REFERENCES story_editions(id) ON DELETE CASCADE,
    volume_number INT NOT NULL CHECK (volume_number >= 0),
    title VARCHAR(255) NOT NULL,
    cover_url VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(story_edition_id, volume_number)
);

-- 9. Chương truyện Logic (Chapter Container)
CREATE TABLE chapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_edition_id UUID NOT NULL REFERENCES story_editions(id) ON DELETE CASCADE,
    volume_id UUID REFERENCES volumes(id) ON DELETE SET NULL,
    chapter_number NUMERIC(6,2) NOT NULL CHECK (chapter_number >= 0),
    title VARCHAR(255),
    active_version_id UUID, -- Foreign Key trỏ vào chapter_versions(id)
    views_count BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(story_edition_id, chapter_number)
);

-- 10. Phiên bản Chương (Chapter Versions - Immutable Model)
CREATE TABLE chapter_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    version_number INT NOT NULL DEFAULT 1,
    version_type VARCHAR(30) NOT NULL CHECK (version_type IN ('RAW_ORIGINAL', 'AI_TRANSLATED', 'HUMAN_EDITED', 'COMMUNITY_FAN')),
    language VARCHAR(10) NOT NULL DEFAULT 'vi',
    source_version_id UUID REFERENCES chapter_versions(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    is_published BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(chapter_id, version_number)
);

-- Thêm Foreign Key ràng buộc cho active_version_id của chapters
ALTER TABLE chapters ADD CONSTRAINT fk_active_version FOREIGN KEY (active_version_id) REFERENCES chapter_versions(id) ON DELETE SET NULL;

-- 11. Tài nguyên Media (Trang ảnh Manga & Text Novel)
CREATE TABLE media_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id UUID NOT NULL REFERENCES chapter_versions(id) ON DELETE CASCADE,
    sort_order INT NOT NULL CHECK (sort_order >= 1),
    asset_type VARCHAR(20) NOT NULL CHECK (asset_type IN ('MANGA_PAGE', 'NOVEL_HTML', 'ILLUSTRATION')),
    storage_key VARCHAR(255) NOT NULL, -- Đường dẫn tệp trên MinIO
    width INT CHECK (width > 0),
    height INT CHECK (height > 0),
    file_size_bytes BIGINT CHECK (file_size_bytes > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(version_id, asset_type, sort_order)
);

-- 12. Tiến độ Đọc (Reading Progress - Tối ưu cho cả Manga & Novel)
CREATE TABLE reading_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    page_index INT DEFAULT 1,
    anchor_block_id VARCHAR(100), -- Dùng định vị chính xác đoạn văn trong Light Novel
    text_offset INT DEFAULT 0,
    progress_ratio NUMERIC(5,4) DEFAULT 0 CHECK (progress_ratio >= 0 AND progress_ratio <= 1.0),
    scroll_offset_ratio NUMERIC(5,4) DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, story_id)
);

-- 13. Tủ Sách Cá Nhân & Bookmark
CREATE TABLE bookmarks (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    story_id UUID REFERENCES stories(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, story_id)
);

-- 14. Báo Cáo Lỗi Chương (Error Reports)
CREATE TABLE chapter_error_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    page_number INT,
    error_type VARCHAR(30) NOT NULL CHECK (error_type IN ('IMAGE_CORRUPT', 'WRONG_ORDER', 'TRANSLATION_ERROR', 'TYPO', 'COPYRIGHT_INFRINGEMENT', 'OTHER')),
    description TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'INVESTIGATING', 'RESOLVED', 'REJECTED')),
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 15. Quản Trị Dự Án Dịch Thuật AI (Translation Projects)
CREATE TABLE translation_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_edition_id UUID NOT NULL REFERENCES story_editions(id) ON DELETE CASCADE,
    source_language VARCHAR(10) NOT NULL DEFAULT 'ja',
    target_language VARCHAR(10) NOT NULL DEFAULT 'vi',
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 16. Từ Điển Thuật Ngữ Cố Định (Glossaries)
CREATE TABLE translation_glossaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES translation_projects(id) ON DELETE CASCADE,
    source_term VARCHAR(100) NOT NULL,
    target_term VARCHAR(100) NOT NULL,
    category VARCHAR(50) DEFAULT 'CHARACTER_NAME',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(project_id, source_term)
);

-- 17. Tác Vụ Dịch AI (Translation Jobs - 14 Trạng Thái & Operational Fields)
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
    progress_percentage INT DEFAULT 0 CHECK (progress_percentage >= 0 AND progress_percentage <= 100),
    attempt_count INT DEFAULT 0,
    max_attempts INT DEFAULT 3,
    provider VARCHAR(50) DEFAULT 'OPENAI',
    model_name VARCHAR(50) DEFAULT 'gpt-4o-mini',
    prompt_version VARCHAR(20) DEFAULT 'v1.0',
    error_trace TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    heartbeat_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '7 days'),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 18. Khung Thoại & Đoạn Dịch (Translation Segments)
CREATE TABLE translation_segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
    page_number INT, -- Nullable cho Light Novel / Text
    anchor_block_id VARCHAR(100), -- Định danh đoạn văn bản trong Novel
    sort_order INT NOT NULL,
    bbox_x INT,
    bbox_y INT,
    bbox_w INT,
    bbox_h INT,
    raw_text TEXT NOT NULL,
    translated_text TEXT,
    confidence NUMERIC(4,3) DEFAULT 0.950,
    is_human_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 19. Hệ Thống Chủ Đề Cấp Bậc (2 Bảng: rank_themes & rank_levels)
CREATE TABLE rank_themes (
    id VARCHAR(30) PRIMARY KEY, -- e.g. 'DEFAULT', 'TU_TIEN', 'GAME', 'DEMON_KING', 'MAGICIAN'
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE rank_levels (
    id SERIAL PRIMARY KEY,
    theme_id VARCHAR(30) NOT NULL REFERENCES rank_themes(id) ON DELETE CASCADE,
    min_level INT NOT NULL CHECK (min_level >= 1),
    max_level INT NOT NULL CHECK (max_level >= min_level),
    rank_title VARCHAR(100) NOT NULL,
    badge_icon VARCHAR(255),
    UNIQUE(theme_id, min_level)
);

-- 20. Hồ Sơ Tiến Trình Người Dùng (User Progression - Total EXP SSoT & Denormalized Level)
CREATE TABLE user_progression (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    level INT DEFAULT 1 CHECK (level >= 1 AND level <= 100), -- Denormalized Cache tính đồng bộ từ total_exp
    total_exp BIGINT DEFAULT 0 CHECK (total_exp >= 0), -- Nguồn sự thật duy nhất về EXP
    omnicoin_balance BIGINT DEFAULT 0 CHECK (omnicoin_balance >= 0),
    current_streak INT DEFAULT 0 CHECK (current_streak >= 0),
    max_streak INT DEFAULT 0 CHECK (max_streak >= 0),
    last_checkin_date DATE,
    rank_theme_id VARCHAR(30) DEFAULT 'DEFAULT' REFERENCES rank_themes(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 21. Lịch Điểm Danh Hàng Ngày (Daily Check-ins)
CREATE TABLE daily_checkins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    checkin_date DATE NOT NULL,
    streak_count INT NOT NULL,
    reward_coins INT NOT NULL DEFAULT 5,
    reward_exp INT NOT NULL DEFAULT 10,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, checkin_date)
);

-- 22. Sổ Cái Biến Động Số Dư Bất Biến (Single-Entry Immutable Reward Transaction Ledger)
CREATE TABLE reward_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, -- Tuyệt đối không xóa bản ghi sổ cái
    reward_type VARCHAR(20) NOT NULL CHECK (reward_type IN ('EXP', 'OMNICOIN')),
    amount INT NOT NULL, -- Dương là cộng, âm là trừ
    balance_after BIGINT NOT NULL,
    source_type VARCHAR(50) NOT NULL CHECK (source_type IN ('CHECKIN', 'READ_CHAPTER', 'LEVEL_REWARD', 'MISSION_DAILY', 'ADMIN_ADJUSTMENT')),
    source_id VARCHAR(100),
    idempotency_key VARCHAR(150) UNIQUE NOT NULL, -- Format: CHECKIN:<user>:<date>:EXP hoặc UUID
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 23. Phần Thưởng Mốc Level (2 Bảng: level_rewards & user_claimed_level_rewards)
CREATE TABLE level_rewards (
    id SERIAL PRIMARY KEY,
    milestone_level INT UNIQUE NOT NULL CHECK (milestone_level >= 1),
    reward_coins INT DEFAULT 0,
    reward_badge_id VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE user_claimed_level_rewards (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    reward_id INT REFERENCES level_rewards(id) ON DELETE CASCADE,
    claimed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY(user_id, reward_id)
);

-- 24. Nhật Ký Kiểm Toán Bảo Mật & Hoạt Động (Audit Logs)
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL, -- e.g. 'STORY_VISIBILITY_CHANGED', 'VERSION_APPLIED', 'USER_ROLE_UPDATED', 'ACCOUNT_ANONYMIZED'
    resource_type VARCHAR(50) NOT NULL, -- e.g. 'STORY', 'CHAPTER_VERSION', 'USER'
    resource_id VARCHAR(100) NOT NULL,
    ip_address VARCHAR(45),
    metadata_json JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- CHỈ MỤC TỐI ƯU HIỆU NĂNG (INDEXES)
CREATE INDEX idx_stories_slug ON stories(slug);
CREATE INDEX idx_stories_title_trgm ON stories USING gin (title gin_trgm_ops);
CREATE INDEX idx_chapters_story_edition ON chapters(story_edition_id, chapter_number);
CREATE INDEX idx_media_assets_version ON media_assets(version_id, sort_order);
CREATE INDEX idx_translation_jobs_status ON translation_jobs(status);
CREATE INDEX idx_reward_transactions_user ON reward_transactions(user_id, created_at DESC);
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_user_id);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
```

---

## 2. QUY TRÌNH ẨN DANH HÓA TÀI KHOẢN (ACCOUNT ANONYMIZATION LIFECYCLE)

Nhằm tuân thủ quyền riêng tư (Privacy) nhưng vẫn **bảo vệ tính toàn vẹn tuyệt đối của Sổ cái bất biến (Immutable Ledger)** và quyền tác giả của các bản dịch:
1. Khi người dùng bấm "Xóa tài khoản":
   * Cập nhật `users`: `email = NULL`, `username = 'deleted_user_' || substring(id::text, 1, 8)`, `password_hash = 'INVALID'`, `avatar_url = NULL`, `is_active = FALSE`, `is_deleted = TRUE`, `deleted_at = NOW()`.
   * Khóa ngoại (UUID) vẫn tồn tại nguyên vẹn $\rightarrow$ `reward_transactions`, `chapter_versions.created_by`, `audit_logs` **không bị phá vỡ ràng buộc Foreign Key**.
2. Ràng buộc đối với Story Owner:
   * Nếu người dùng là `OWNER` duy nhất của một bộ truyện đang `PUBLIC`, trước khi xóa tài khoản phải:
     * (a) Chuyển giao quyền Owner cho thành viên khác trong `story_members`, HOẶC
     * (b) Chuyển trạng thái bộ truyện sang `PRIVATE`.

---

## 3. CẤU TRÚC PHÂN BỔ ĐỐI TƯỢNG TRÊN MINIO STORAGE

```
manga-media/
└── stories/
    └── {story_slug}/
        └── editions/
            └── {edition_id}/
                └── chapters/
                    └── {chapter_number}/
                        ├── v1_raw/
                        │   ├── 001.webp
                        │   └── 002.webp
                        └── v2_ai_translated/
                            ├── 001.webp
                            └── 002.webp

novel-media/
└── stories/
    └── {story_slug}/
        └── editions/
            └── {edition_id}/
                └── chapters/
                    └── {chapter_number}/
                        ├── v1_raw/
                        │   ├── content.html
                        │   └── illustrations/
                        │       └── ill_001.webp
                        └── v2_ai_translated/
                            └── content.html
```

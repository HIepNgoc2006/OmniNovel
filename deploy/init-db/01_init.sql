-- =========================================================
-- OMNINOVEL DATABASE INITIALIZATION SCRIPT (PostgreSQL 16)
-- Canonical DDL matching 09_DATABASE_AND_STORAGE.md (27 Tables)
-- =========================================================

-- Kích hoạt extension UUID và Trigram
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- 1. Người dùng & Phân quyền Toàn cục (Hỗ trợ Account Anonymization)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE,
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
CREATE TABLE IF NOT EXISTS creators (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    bio TEXT,
    avatar_url VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Bộ truyện Gốc (Work / Story)
CREATE TABLE IF NOT EXISTS stories (
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
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    views_count BIGINT DEFAULT 0,
    followers_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Bảng liên kết Tác giả - Bộ truyện (Story Creators)
CREATE TABLE IF NOT EXISTS story_creators (
    story_id UUID REFERENCES stories(id) ON DELETE CASCADE,
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
    role VARCHAR(30) NOT NULL DEFAULT 'AUTHOR' CHECK (role IN ('AUTHOR', 'ARTIST', 'ILLUSTRATOR', 'ORIGINAL_STORY')),
    PRIMARY KEY (story_id, creator_id, role)
);

-- 5. Bảng Phân quyền Thành viên Bộ truyện (Story Members - CANONICAL OWNERSHIP & RBAC)
CREATE TABLE IF NOT EXISTS story_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('OWNER', 'EDITOR', 'TRANSLATOR', 'UPLOADER')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(story_id, user_id)
);

-- 6. Thể loại truyện (genres & story_genres)
CREATE TABLE IF NOT EXISTS genres (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    slug VARCHAR(50) UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS story_genres (
    story_id UUID REFERENCES stories(id) ON DELETE CASCADE,
    genre_id INT REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (story_id, genre_id)
);

-- 7. Ấn bản Bộ truyện (Story Editions - Dòng Xuất Bản)
CREATE TABLE IF NOT EXISTS story_editions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    edition_name VARCHAR(100) NOT NULL,
    language VARCHAR(10) NOT NULL DEFAULT 'vi',
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(story_id, edition_name)
);

-- 8. Tập truyện (Volumes)
CREATE TABLE IF NOT EXISTS volumes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_edition_id UUID NOT NULL REFERENCES story_editions(id) ON DELETE CASCADE,
    volume_number INT NOT NULL CHECK (volume_number >= 0),
    title VARCHAR(255) NOT NULL,
    cover_url VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(story_edition_id, volume_number)
);

-- 9. Chương truyện Logic (Chapter Container)
CREATE TABLE IF NOT EXISTS chapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_edition_id UUID NOT NULL REFERENCES story_editions(id) ON DELETE CASCADE,
    volume_id UUID REFERENCES volumes(id) ON DELETE SET NULL,
    chapter_number NUMERIC(6,2) NOT NULL CHECK (chapter_number >= 0),
    title VARCHAR(255),
    active_version_id UUID,
    views_count BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(story_edition_id, chapter_number)
);

-- 10. Phiên bản Chương (Chapter Versions - Immutable Model & Composite Invariant)
CREATE TABLE IF NOT EXISTS chapter_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    version_number INT NOT NULL DEFAULT 1,
    version_type VARCHAR(30) NOT NULL CHECK (version_type IN ('RAW_ORIGINAL', 'AI_TRANSLATED', 'HUMAN_EDITED', 'COMMUNITY_FAN')),
    language VARCHAR(10) NOT NULL DEFAULT 'vi',
    source_version_id UUID REFERENCES chapter_versions(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    is_published BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(chapter_id, version_number),
    CONSTRAINT uq_chapter_version_pair UNIQUE (chapter_id, id)
);

-- RÀNG BUỘC TOÀN VẸN: active_version_id của chapters bắt buộc phải thuộc CHÍNH CHAPTER ĐÓ
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_active_version_same_chapter') THEN
        ALTER TABLE chapters ADD CONSTRAINT fk_active_version_same_chapter 
        FOREIGN KEY (id, active_version_id) 
        REFERENCES chapter_versions(chapter_id, id) 
        ON DELETE SET NULL (active_version_id);
    END IF;
END $$;

-- 11. Tài nguyên Media (Trang ảnh Manga & Text Novel)
CREATE TABLE IF NOT EXISTS media_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id UUID NOT NULL REFERENCES chapter_versions(id) ON DELETE CASCADE,
    sort_order INT NOT NULL CHECK (sort_order >= 1),
    asset_type VARCHAR(20) NOT NULL CHECK (asset_type IN ('MANGA_PAGE', 'NOVEL_HTML', 'ILLUSTRATION')),
    storage_key VARCHAR(255) NOT NULL,
    width INT CHECK (width > 0),
    height INT CHECK (height > 0),
    file_size_bytes BIGINT CHECK (file_size_bytes > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(version_id, asset_type, sort_order)
);

-- 12. Tiến độ Đọc (Reading Progress - Tối ưu cho cả Manga & Novel)
CREATE TABLE IF NOT EXISTS reading_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    page_index INT DEFAULT 1,
    anchor_block_id VARCHAR(100),
    text_offset INT DEFAULT 0,
    progress_ratio NUMERIC(5,4) DEFAULT 0 CHECK (progress_ratio >= 0 AND progress_ratio <= 1.0),
    scroll_offset_ratio NUMERIC(5,4) DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, story_id)
);

-- 13. Tủ Sách Cá Nhân & Bookmark
CREATE TABLE IF NOT EXISTS bookmarks (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    story_id UUID REFERENCES stories(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, story_id)
);

-- 14. Báo Cáo Lỗi Chương (Error Reports)
CREATE TABLE IF NOT EXISTS chapter_error_reports (
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
CREATE TABLE IF NOT EXISTS translation_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_edition_id UUID NOT NULL REFERENCES story_editions(id) ON DELETE CASCADE,
    source_language VARCHAR(10) NOT NULL DEFAULT 'ja',
    target_language VARCHAR(10) NOT NULL DEFAULT 'vi',
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 16. Từ Điển Thuật Ngữ Cố Định (Glossaries)
CREATE TABLE IF NOT EXISTS translation_glossaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES translation_projects(id) ON DELETE CASCADE,
    source_term VARCHAR(100) NOT NULL,
    target_term VARCHAR(100) NOT NULL,
    category VARCHAR(50) DEFAULT 'CHARACTER_NAME',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(project_id, source_term)
);

-- 17. Tác Vụ Dịch AI (Translation Jobs)
CREATE TABLE IF NOT EXISTS translation_jobs (
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
CREATE TABLE IF NOT EXISTS translation_segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
    page_number INT,
    anchor_block_id VARCHAR(100),
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

-- 19. Hệ Thống Chủ Đề Cấp Bậc (rank_themes & rank_levels)
CREATE TABLE IF NOT EXISTS rank_themes (
    id VARCHAR(30) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS rank_levels (
    id SERIAL PRIMARY KEY,
    theme_id VARCHAR(30) NOT NULL REFERENCES rank_themes(id) ON DELETE CASCADE,
    min_level INT NOT NULL CHECK (min_level >= 1),
    max_level INT NOT NULL CHECK (max_level >= min_level),
    rank_title VARCHAR(100) NOT NULL,
    badge_icon VARCHAR(255),
    UNIQUE(theme_id, min_level)
);

-- 20. Hồ Sơ Tiến Trình Người Dùng (user_progression)
CREATE TABLE IF NOT EXISTS user_progression (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    level INT DEFAULT 1 CHECK (level >= 1 AND level <= 100),
    total_exp BIGINT DEFAULT 0 CHECK (total_exp >= 0),
    omnicoin_balance BIGINT DEFAULT 0 CHECK (omnicoin_balance >= 0),
    current_streak INT DEFAULT 0 CHECK (current_streak >= 0),
    max_streak INT DEFAULT 0 CHECK (max_streak >= 0),
    last_checkin_date DATE,
    rank_theme_id VARCHAR(30) DEFAULT 'DEFAULT' REFERENCES rank_themes(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 21. Lịch Điểm Danh Hàng Ngày (daily_checkins)
CREATE TABLE IF NOT EXISTS daily_checkins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    checkin_date DATE NOT NULL,
    streak_count INT NOT NULL,
    reward_coins INT NOT NULL DEFAULT 5,
    reward_exp INT NOT NULL DEFAULT 10,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, checkin_date)
);

-- 22. Sổ Cái Biến Động Số Dư Bất Biến (reward_transactions)
CREATE TABLE IF NOT EXISTS reward_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reward_type VARCHAR(20) NOT NULL CHECK (reward_type IN ('EXP', 'OMNICOIN')),
    amount INT NOT NULL,
    balance_after BIGINT NOT NULL,
    source_type VARCHAR(50) NOT NULL CHECK (source_type IN ('CHECKIN', 'READ_CHAPTER', 'LEVEL_REWARD', 'MISSION_DAILY', 'ADMIN_ADJUSTMENT')),
    source_id VARCHAR(100),
    idempotency_key VARCHAR(150) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 23. Phần Thưởng Mốc Level (level_rewards & user_claimed_level_rewards)
CREATE TABLE IF NOT EXISTS level_rewards (
    id SERIAL PRIMARY KEY,
    milestone_level INT UNIQUE NOT NULL CHECK (milestone_level >= 1),
    reward_coins INT DEFAULT 0,
    reward_badge_id VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_claimed_level_rewards (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    reward_id INT REFERENCES level_rewards(id) ON DELETE CASCADE,
    claimed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY(user_id, reward_id)
);

-- 24. Nhật Ký Kiểm Toán Bảo Mật (audit_logs)
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    resource_id VARCHAR(100) NOT NULL,
    ip_address VARCHAR(45),
    metadata_json JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_stories_slug ON stories(slug);
CREATE INDEX IF NOT EXISTS idx_stories_title_trgm ON stories USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_chapters_story_edition ON chapters(story_edition_id, chapter_number);
CREATE INDEX IF NOT EXISTS idx_media_assets_version ON media_assets(version_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_translation_jobs_status ON translation_jobs(status);
CREATE INDEX IF NOT EXISTS idx_reward_transactions_user ON reward_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);

-- SEED TOÀN BỘ 5 RANK THEMES & LEVEL TITLES (Khớp 100% 23_GAMIFICATION_AND_REWARDS.md)
INSERT INTO rank_themes (id, name, description) VALUES
('DEFAULT', 'Mặc Định', 'Hệ thống cấp bậc tiêu chuẩn độc giả'),
('TU_TIEN', 'Tu Tiên', 'Hệ thống cảnh giới tu tiên cổ điển'),
('GAME', 'Game Thủ', 'Hệ thống danh hiệu RPG chiến binh'),
('DEMON_KING', 'Ma Vương', 'Hệ thống cấp bậc thế lực bóng tối'),
('MAGICIAN', 'Pháp Sư', 'Hệ thống học viện pháp thuật huyền bí'),
('SCI_FI', 'Tinh Không', 'Hệ thống quân hàm thám hiểm thiên hà')
ON CONFLICT (id) DO NOTHING;

INSERT INTO rank_levels (theme_id, min_level, max_level, rank_title) VALUES
-- Default
('DEFAULT', 1, 9, 'Độc Giả Sơ Cấp'),
('DEFAULT', 10, 19, 'Độc Giả Trung Cấp'),
('DEFAULT', 20, 39, 'Độc Giả Cao Cấp'),
('DEFAULT', 40, 59, 'Độc Giả Tinh Anh'),
('DEFAULT', 60, 79, 'Độc Giả Uyên Bác'),
('DEFAULT', 80, 99, 'Đại Tông Sư Độc Giả'),
('DEFAULT', 100, 100, 'Huyền Thoại Độc Giả'),
-- Tu Tiên
('TU_TIEN', 1, 9, 'Luyện Khí Kỳ'),
('TU_TIEN', 10, 19, 'Trúc Cơ Kỳ'),
('TU_TIEN', 20, 39, 'Kim Đan Kỳ'),
('TU_TIEN', 40, 59, 'Nguyên Anh Kỳ'),
('TU_TIEN', 60, 79, 'Hóa Thần Kỳ'),
('TU_TIEN', 80, 99, 'Độ Kiếp Kỳ'),
('TU_TIEN', 100, 100, 'Đại Thừa Viên Mãn'),
-- Game Thủ
('GAME', 1, 9, 'Tân Thủ (Novice)'),
('GAME', 10, 19, 'Chiến Binh (Warrior)'),
('GAME', 20, 39, 'Sát Thủ Bóng Đêm'),
('GAME', 40, 59, 'Tông Sư (Master)'),
('GAME', 60, 79, 'Huyền Thoại (Legend)'),
('GAME', 80, 99, 'Tối Thượng (Ultimate)'),
('GAME', 100, 100, 'Thần Thoại Vô Địch'),
-- Ma Vương
('DEMON_KING', 1, 9, 'Tiểu Quỷ (Imp)'),
('DEMON_KING', 10, 19, 'Quỷ Binh (Fiend)'),
('DEMON_KING', 20, 39, 'Kỵ Sĩ Hắc Ám'),
('DEMON_KING', 40, 59, 'Lãnh Chúa Ma Vực'),
('DEMON_KING', 60, 79, 'Ma Vương Bất Tử'),
('DEMON_KING', 80, 99, 'Hư Không Ma Hoàng'),
('DEMON_KING', 100, 100, 'Thần Ma Tối Cao'),
-- Pháp Sư
('MAGICIAN', 1, 9, 'Học Viên Phép Thuật'),
('MAGICIAN', 10, 19, 'Pháp Sư Sơ Cấp'),
('MAGICIAN', 20, 39, 'Đại Pháp Sư'),
('MAGICIAN', 40, 59, 'Pháp Hoàng'),
('MAGICIAN', 60, 79, 'Thánh Ma Đạo Sư'),
('MAGICIAN', 80, 99, 'Ma Thần Thượng Cổ'),
('MAGICIAN', 100, 100, 'Tối Cao Pháp Thần'),
-- Tinh Không / Sci-Fi
('SCI_FI', 1, 9, 'Thực Tập Phi Hành'),
('SCI_FI', 10, 19, 'Thám Hiểm Không Gian'),
('SCI_FI', 20, 39, 'Chỉ Huy Hạm Đội'),
('SCI_FI', 40, 59, 'Thống Soái Thiên Hà'),
('SCI_FI', 60, 79, 'Chúa Tể Tinh Cầu'),
('SCI_FI', 80, 99, 'Đấng Sáng Tạo Vũ Trụ'),
('SCI_FI', 100, 100, 'Đấng Toàn Tri Toàn Năng')
ON CONFLICT (theme_id, min_level) DO NOTHING;

-- SEED MỐC PHẦN THƯỞNG CẤP ĐỘ (LEVEL MILESTONE REWARDS)
INSERT INTO level_rewards (milestone_level, reward_coins, reward_badge_id) VALUES
(2, 20, 'BADGE_LVL_2'),
(5, 50, 'BADGE_LVL_5'),
(10, 100, 'BADGE_LVL_10'),
(20, 200, 'BADGE_LVL_20'),
(30, 300, 'BADGE_LVL_30'),
(50, 500, 'BADGE_LVL_50'),
(100, 1000, 'BADGE_LVL_100')
ON CONFLICT (milestone_level) DO NOTHING;

-- 22. TIẾN ĐỘ ĐỌC TRUYỆN (READING PROGRESS & RESUME POINTER)
CREATE TABLE IF NOT EXISTS reading_progress (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    chapter_version_id UUID REFERENCES chapter_versions(id) ON DELETE SET NULL,
    reading_mode VARCHAR(20) DEFAULT 'WEBTOON',
    progress_percentage NUMERIC(5,2) DEFAULT 0,
    scroll_position NUMERIC(10,2) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, story_id)
);

-- 23. TRẠNG THÁI ĐÃ ĐỌC THEO CHƯƠNG (CHAPTER READ STATES)
CREATE TABLE IF NOT EXISTS chapter_read_states (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    last_version_id UUID REFERENCES chapter_versions(id) ON DELETE SET NULL,
    max_progress_percentage NUMERIC(5,2) DEFAULT 0,
    completed_at TIMESTAMPTZ,
    last_read_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, chapter_id)
);

CREATE INDEX IF NOT EXISTS idx_reading_progress_user_updated ON reading_progress (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chapter_read_states_user_last_read ON chapter_read_states (user_id, last_read_at DESC);



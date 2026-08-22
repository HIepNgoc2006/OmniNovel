# 🔗 21. Ma Trận Truy Vết Yêu Cầu Kỹ Thuật (Requirements Traceability Matrix - RTM)

Tài liệu này cung cấp ma trận truy vết khép kín 100% hai chiều (**Bidirectional Traceability Matrix**) từ Yêu Cầu Người Dùng (**UR**) $\rightarrow$ Yêu Cầu Chức Năng (**FR**) $\rightarrow$ Ca Sử Dụng (**UC**) $\rightarrow$ Màn Hình (**Screen**) $\rightarrow$ API Endpoint $\rightarrow$ Bảng CSDL (**DB**) $\rightarrow$ Ca Kiểm Thử (**TC**).

---

## MA TRẬN TRUY VẾT KỸ THUẬT CHI TIẾT (CANONICAL RTM)

| Mã UR | Mã FR | Mã UC | Màn Hình Web/App | API Endpoint Liên Quan | Bảng CSDL (DB) | Mã Test Case |
| :--- | :--- | :--- | :---: | :--- | :--- | :---: |
| **UR-AUTH-01** | FR-AUTH-01 | UC-AUTH-01 | WEB-006 / MOB-008 | `POST /api/v1/auth/register` | `users`, `user_progression` | TC-AUTH-01 |
| **UR-AUTH-02** | FR-AUTH-02 | UC-AUTH-02 | WEB-006 / MOB-008 | `POST /api/v1/auth/login` | `users` | TC-AUTH-02 |
| **UR-AUTH-03** | FR-AUTH-03 | UC-AUTH-03 | WEB-006 / MOB-008 | `POST /api/v1/auth/logout` | Redis Session Keys | TC-AUTH-02 |
| **UR-DISC-01** | FR-DISC-01 | UC-DISC-01 | WEB-001 / MOB-001 | `GET /api/v1/stories/featured` | `stories`, `volumes` | TC-DISC-01 |
| **UR-DISC-02** | FR-DISC-02 | UC-DISC-02 | WEB-001 / MOB-002 | `GET /api/v1/stories/search` | `stories` (Trigram Index) | TC-DISC-01 |
| **UR-DISC-03** | FR-DISC-03 | UC-DISC-03 | WEB-002 / MOB-001 | `GET /api/v1/stories` | `stories`, `genres` | TC-DISC-01 |
| **UR-DISC-05** | FR-DISC-05 | UC-DISC-05 | WEB-003 / MOB-003 | `GET /api/v1/stories/:slug` | `stories`, `story_editions` | TC-DISC-01 |
| **UR-MANGA-01**| FR-MANGA-01 | UC-READ-01 | WEB-004 / MOB-004 | `GET /api/v1/chapters/:id` | `media_assets` | TC-MANGA-01 |
| **UR-MANGA-02**| FR-MANGA-02 | UC-READ-02 | WEB-004 / MOB-005 | `GET /api/v1/chapters/:id` | `media_assets` | TC-MANGA-01 |
| **UR-MANGA-03**| FR-MANGA-03 | UC-READ-03 | WEB-004 / MOB-004 | `GET /api/v1/chapters/:id` | `media_assets` | TC-MANGA-01 |
| **UR-MANGA-05**| FR-MANGA-04 | UC-READ-06 | WEB-004 / MOB-004 | `GET /api/v1/chapters/:id` | `chapter_versions` | TC-MANGA-01 |
| **UR-NOVEL-01**| FR-NOVEL-01 | UC-READ-04 | WEB-005 / MOB-006 | `GET /api/v1/chapters/:id` | `media_assets` | TC-NOVEL-01 |
| **UR-NOVEL-02**| FR-NOVEL-01 | UC-READ-04 | WEB-005 / MOB-006 | LocalStorage / Settings | LocalStorage | TC-NOVEL-01 |
| **UR-NOVEL-04**| FR-NOVEL-02 | UC-READ-05 | WEB-005 / MOB-007 | `GET /api/v1/chapters/:id` | `media_assets` | TC-NOVEL-01 |
| **UR-LIB-01** | FR-LIB-01 | UC-LIB-01 | WEB-007 / MOB-009 | `POST /api/v1/library/progress`| `reading_progress` | TC-NOVEL-01 |
| **UR-LIB-02** | FR-LIB-02 | UC-LIB-02 | WEB-007 / MOB-009 | `POST /api/v1/library/bookmarks`| `bookmarks` | TC-DISC-01 |
| **UR-AI-01** | FR-AI-01 | UC-STUD-01 | WEB-011 / Studio | `POST /api/v1/studio/stories` | `stories`, `story_members` | TC-AI-01 |
| **UR-AI-02** | FR-AI-01 | UC-STUD-02 | WEB-012 / Studio | `POST /api/v1/uploads/sessions`| `chapter_versions`, MinIO | TC-AI-01 |
| **UR-AI-03** | FR-AI-02 | UC-STUD-03 | WEB-013 / Studio | `POST /api/v1/ai/jobs` | `translation_jobs`, BullMQ| TC-AI-02 |
| **UR-AI-04** | FR-AI-03 | UC-STUD-04 | WEB-014 / Studio | `GET /api/v1/ai/jobs/:id` | `translation_segments` | TC-AI-02 |
| **UR-AI-05** | FR-AI-03 | UC-STUD-04 | WEB-014 / Studio | `POST /api/v1/ai/jobs/:id/apply`| `chapters.active_version` | TC-AI-02 |
| **UR-AI-06** | FR-AI-03 | UC-STUD-04 | WEB-014 / Studio | `POST /api/v1/ai/jobs/:id/apply`| `chapter_versions` | TC-AI-02 |
| **UR-AI-07** | FR-AI-04 | UC-STUD-05 | WEB-011 / Studio | `POST /api/v1/ai/glossary` | `translation_glossaries` | TC-AI-02 |
| **UR-ADM-01** | FR-ADM-01 | UC-ADM-01 | WEB-015 / Admin | `PATCH /admin/reports/:id` | `chapter_error_reports` | TC-ADM-01 |
| **UR-ADM-02** | FR-ADM-02 | UC-ADM-02 | WEB-015 / Admin | `PATCH /admin/users/:id/role` | `users` | TC-ADM-01 |
| **UR-ADM-03** | FR-ADM-03 | UC-ADM-03 | WEB-015 / Admin | `PATCH /stories/:id/visibility`| `stories.visibility` | TC-ADM-01 |
| **UR-GAM-01** | FR-GAM-02 | UC-GAM-02 | WEB-008 / MOB-010 | Event-Driven Reader Hook | `user_progression`, `reward`| TC-GAM-01 |
| **UR-GAM-02** | FR-GAM-01 | UC-GAM-01 | WEB-009 / MOB-010 | `POST /gamification/checkin` | `daily_checkins`, `reward` | TC-GAM-01 |
| **UR-GAM-03** | FR-GAM-03 | UC-GAM-03 | WEB-008 / MOB-010 | `PATCH /gamification/rank-theme`| `user_progression` | TC-GAM-01 |
| **UR-GAM-04** | FR-GAM-04 | UC-GAM-04 | WEB-008 / MOB-010 | `POST /gamification/rewards/claim`| `user_claimed_level_rewards`| TC-GAM-01 |
| **UR-GAM-05** | FR-GAM-05 | UC-GAM-05 | WEB-010 / MOB-010 | `GET /gamification/transactions`| `reward_transactions` | TC-GAM-01 |

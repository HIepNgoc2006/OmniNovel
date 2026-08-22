# 🔗 21. Ma Trận Truy Vết Yêu Cầu Toàn Diện (Requirements Traceability Matrix - RTM)

Tài liệu này thiết lập ma trận ánh xạ 1-1 xuyên suốt từ Yêu cầu người dùng (UR) $\rightarrow$ Yêu cầu chức năng (FR) $\rightarrow$ Use Case (UC) $\rightarrow$ Màn hình (Screen) $\rightarrow$ API Endpoint $\rightarrow$ CSDL Table $\rightarrow$ Test Case ID.

---

## MA TRẬN TRUY VẾT RTM

| UR Code | FR Code | Use Case | Screen ID | API Endpoint | DB Table | Test Case ID |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **UR-AUTH-01** | FR-AUTH-01 | UC-AUTH-01 | WEB-008 | `POST /api/v1/auth/register` | `users` | `TC-AUTH-01` |
| **UR-AUTH-02** | FR-AUTH-02 | UC-AUTH-02 | WEB-008 | `POST /api/v1/auth/login` | `users` | `TC-AUTH-02` |
| **UR-DISC-01** | FR-DISC-01 | UC-DISC-01 | WEB-001 / MOB-001 | `GET /api/v1/stories/featured` | `stories` | `TC-DISC-01` |
| **UR-DISC-03** | FR-DISC-03 | UC-DISC-03 | WEB-002 | `GET /api/v1/stories` | `stories`, `genres` | `TC-DISC-03` |
| **UR-MANGA-01**| FR-MANGA-01| UC-MANGA-01| WEB-004 / MOB-002 | `GET /api/v1/chapters/:id` | `chapters`, `media_assets`| `TC-MANGA-01`|
| **UR-MANGA-03**| FR-MANGA-02| UC-MANGA-03| WEB-004 | `GET /api/v1/chapters/:id` | `media_assets` | `TC-MANGA-03`|
| **UR-NOVEL-01**| FR-NOVEL-01| UC-NOVEL-01| WEB-005 / MOB-003 | `GET /api/v1/chapters/:id` | `chapters`, `media_assets`| `TC-NOVEL-01`|
| **UR-AI-02** | FR-AI-01 | UC-STUD-02 | WEB-006 | `POST /api/v1/uploads/sessions`| `media_assets` | `TC-AI-01` |
| **UR-AI-05** | FR-AI-03 | UC-STUD-05 | WEB-007 | `POST /api/v1/ai/jobs/:id/apply`| `chapters`, `chapter_versions`| `TC-AI-05` |

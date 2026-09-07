# 📚 Trung Tâm Kế Hoạch & Quy Hoạch Kỹ Thuật OmniNovel (plans/)

Toàn bộ 24 tài liệu đặc tả kỹ thuật và theo dõi tiến độ thi công của dự án **OmniNovel** được quản lý tập trung và trực quan tại thư mục `plans/` này.

---

## 📂 1. DANH MỤC 24 TÀI LIỆU ĐẶC TẢ KẾ HOẠCH (plans/planning/)

| STT | Tài Liệu | Nội Dung Trọng Tâm |
| :---: | :--- | :--- |
| **00** | [00_README_AND_DOCUMENT_INDEX.md](planning/00_README_AND_DOCUMENT_INDEX.md) | **Single Source of Truth:** Từ điển thuật ngữ chuẩn & Quyết định kiến trúc ADRs. |
| **01** | [01_PRODUCT_VISION.md](planning/01_PRODUCT_VISION.md) | **Product Vision:** Problem, Value Proposition & 5 Trụ cột cốt lõi. |
| **02** | [02_PRODUCT_SCOPE_AND_ROADMAP.md](planning/02_PRODUCT_SCOPE_AND_ROADMAP.md) | **Product Scope:** Phân chia MVP, V1, V2 & Ranh giới Out-of-Scope. |
| **03** | [03_PERSONAS_JTBD_USER_JOURNEYS.md](planning/03_PERSONAS_JTBD_USER_JOURNEYS.md) | **Users:** 5 Personas chi tiết, Jobs To Be Done & User Journeys. |
| **04** | [04_USER_REQUIREMENTS.md](planning/04_USER_REQUIREMENTS.md) | **Requirements:** Bảng Yêu cầu Người Dùng theo MoSCoW & P0-P3. |
| **05** | [05_FUNCTIONAL_REQUIREMENTS.md](planning/05_FUNCTIONAL_REQUIREMENTS.md) | **Specs:** Functional Requirements kèm Acceptance Criteria (Given-When-Then). |
| **06** | [06_USE_CASES_AND_PERMISSIONS.md](planning/06_USE_CASES_AND_PERMISSIONS.md) | **Use Cases:** 35 Use Cases & Ma trận Phân quyền Sở hữu (Ownership RBAC). |
| **07** | [07_INFORMATION_ARCHITECTURE.md](planning/07_INFORMATION_ARCHITECTURE.md) | **IA:** Sitemap Web/Mobile, Screen Inventory & Luồng điều hướng. |
| **08** | [08_DOMAIN_MODEL.md](planning/08_DOMAIN_MODEL.md) | **Domain:** Mô hình miền DDD, Aggregates & Domain Events. |
| **09** | [09_DATABASE_AND_STORAGE.md](planning/09_DATABASE_AND_STORAGE.md) | **Database:** Lược đồ CSDL PostgreSQL 20+ bảng DDL & MinIO S3. |
| **10** | [10_API_AND_EVENT_CONTRACTS.md](planning/10_API_AND_EVENT_CONTRACTS.md) | **API:** Đặc tả RESTful API Endpoints /api/v1, WebSocket & Chuẩn Error JSON. |
| **11** | [11_AI_TRANSLATION_ARCHITECTURE.md](planning/11_AI_TRANSLATION_ARCHITECTURE.md) | **AI Engine:** Pipeline Manga/Novel OCR, Inpaint & State Machine 14 trạng thái. |
| **12** | [12_SYSTEM_ARCHITECTURE.md](planning/12_SYSTEM_ARCHITECTURE.md) | **Architecture:** Kiến trúc tổng thể Monorepo & Ranh giới Module NestJS. |
| **13** | [13_ARCHITECTURE_DECISIONS.md](planning/13_ARCHITECTURE_DECISIONS.md) | **ADRs:** Tuyển tập 11 quyết định kiến trúc chuẩn MADR (bổ sung ADR-011 TypeORM Migrations). |
| **14** | [14_NON_FUNCTIONAL_REQUIREMENTS.md](planning/14_NON_FUNCTIONAL_REQUIREMENTS.md) | **NFRs:** Yêu cầu Phi chức năng định lượng (120Hz, RAM < 150MB, SLAs). |
| **15** | [15_SECURITY_THREAT_MODEL.md](planning/15_SECURITY_THREAT_MODEL.md) | **Security:** Mô hình đe dọa STRIDE, Anti-Leech & File Sanitization. |
| **16** | [16_PRIVACY_CONTENT_AND_RIGHTS.md](planning/16_PRIVACY_CONTENT_AND_RIGHTS.md) | **Privacy & Rights:** Quyền sở hữu nội dung, Takedown Workflow & Quyền riêng tư. |
| **17** | [17_TESTING_AND_QA.md](planning/17_TESTING_AND_QA.md) | **QA:** Chiến lược kiểm thử đa tầng & Bộ dữ liệu Benchmark AI Ground Truth. |
| **18** | [18_DEVOPS_OBSERVABILITY_DR.md](planning/18_DEVOPS_OBSERVABILITY_DR.md) | **DevOps:** Cấu hình 7 Container, Nginx, CI/CD, Prometheus & Kế hoạch DR. |
| **19** | [19_PROJECT_MANAGEMENT.md](planning/19_PROJECT_MANAGEMENT.md) | **PM:** Lịch trình Scrum 4 Sprint, WBS 4 Cấp & Definition of Done. |
| **20** | [20_RISK_AND_COST.md](planning/20_RISK_AND_COST.md) | **Risk & Cost:** Ma trận 16 rủi ro (R1-R16) & Mô hình Unit Economics. |
| **21** | [21_REQUIREMENTS_TRACEABILITY.md](planning/21_REQUIREMENTS_TRACEABILITY.md) | **Traceability:** Ma trận truy vết UR ➔ FR ➔ UC ➔ API ➔ DB ➔ Test. |
| **22** | [22_COURSE_MAPPING.md](planning/22_COURSE_MAPPING.md) | **Academic:** Bằng chứng kỹ thuật nghiệm thu 5 môn học chuyên ngành. |
| **23** | [23_GAMIFICATION_AND_REWARDS.md](planning/23_GAMIFICATION_AND_REWARDS.md) | **Gamification:** Cấp độ, Điểm thưởng OmniCoin, Chuỗi điểm danh & Danh hiệu. |

---

## 📋 2. KHU VỰC THEO DÕI TIẾN ĐỘ THI CÔNG (plans/phases/)

* [Phase 1: Setup & Architecture Baseline](phases/phase_01_setup.md) `[x] Đã hoàn thành (100%)`
* [Phase 2: Core Backend API & Security](phases/phase_02_backend_core.md) `[x] Đã hoàn thành (100% - 56/56 E2E Tests Passing)`
  * [Kế hoạch Kỹ thuật Chi tiết Phase 2](phases/phase_02_implementation_plan.md)
* [Phase 3: AI Translation Worker & Upload Queue](phases/phase_03_ai_worker.md) `[x] Đã hoàn thành (100% - Vertical Slice 1, 2, 3 FROZEN - 184/184 AI Worker Tests & 106/106 NestJS Tests - 290/290 Total Tests Passed)`
* [Phase 4: Web Client (TruyenQQ & DocLN)](phases/phase_04_web_client.md) `[/] Đang thực hiện (Phase 4A, 4B, 4C & 4D.1–4D.4 + #162 Manga Clean Bases + #166 WebSocket Security + #159 Manga Previews 100% HOÀN TẤT & FROZEN trên main@c607976; chuẩn bị Track A dependencies #157 Re-render / remainder #155 & 4D.5 Studio Frontend UI)`
* [Phase 5: Mobile App (Flutter 120Hz & Offline)](phases/phase_05_mobile_app.md) `[ ] Chưa bắt đầu`
* [Phase 6: DevOps, CI/CD & Academic Defense](phases/phase_06_devops_final.md) `[ ] Chưa bắt đầu`

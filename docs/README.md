# 📚 OmniNovel Documentation Portal (docs/)

Chào mừng bạn đến với Cổng tài liệu đặc tả kỹ thuật và kiến trúc hệ thống chính thức của **OmniNovel** (`github.com/OmniNovel/omninovel`).

---

## 📂 DANH MỤC TÀI LIỆU KỸ THUẬT THEO CHUYÊN MỤC

### 🎯 1. Kế Hoạch & Yêu Cầu Sản Phẩm (Planning & Requirements)
* [01. Product Vision](planning/01_PRODUCT_VISION.md) – Tầm nhìn, Problem, Value Proposition & 5 Trụ cột cốt lõi.
* [02. Product Scope & Roadmap](planning/02_PRODUCT_SCOPE_AND_ROADMAP.md) – Phân chia MVP, V1, V2 & Out-of-Scope.
* [03. Personas, JTBD & Journeys](planning/03_PERSONAS_JTBD_USER_JOURNEYS.md) – 5 Personas, Jobs To Be Done & User Journey.
* [04. User Requirements (UR)](planning/04_USER_REQUIREMENTS.md) – Bảng Yêu cầu Người Dùng theo MoSCoW & P0-P3.
* [05. Functional Requirements (FR)](planning/05_FUNCTIONAL_REQUIREMENTS.md) – Yêu cầu Chức năng kèm Acceptance Criteria (Given-When-Then).
* [06. Use Cases & Permissions](planning/06_USE_CASES_AND_PERMISSIONS.md) – 28 Use Cases & Ma trận Phân quyền Sở hữu (Ownership RBAC).
* [07. Information Architecture](planning/07_INFORMATION_ARCHITECTURE.md) – Sitemap Web/Mobile & Screen Inventory.
* [21. Requirements Traceability Matrix](planning/21_REQUIREMENTS_TRACEABILITY.md) – Ma trận truy vết UR ➔ FR ➔ UC ➔ API ➔ DB ➔ Test.
* [22. Course Mapping & Evidence](planning/22_COURSE_MAPPING.md) – Bằng chứng kỹ thuật nghiệm thu 5 môn học.

### 🏛️ 2. Kiến Trúc Hệ Thống (Architecture)
* [08. Domain Model](architecture/08_DOMAIN_MODEL.md) – Mô hình miền DDD, Aggregates & Domain Events.
* [12. System Architecture](architecture/12_SYSTEM_ARCHITECTURE.md) – Kiến trúc tổng thể Monorepo & Ranh giới Module NestJS.
* [14. Non-Functional Requirements](architecture/14_NON_FUNCTIONAL_REQUIREMENTS.md) – Yêu cầu Phi chức năng định lượng (120Hz, RAM < 150MB, SLAs).

### 📝 3. Quyết Định Kiến Trúc (ADRs)
* [00. Glossary & Core Decisions](adr/00_GLOSSARY_AND_DECISIONS.md) – Từ điển thuật ngữ chuẩn & Bảng chốt công nghệ.
* [13. Architecture Decision Records](adr/13_ARCHITECTURE_DECISIONS.md) – Tuyển tập 10 quyết định kiến trúc chuẩn MADR (ADR-001 đến ADR-010).

### 🔌 4. Giao Tiếp API & Sự Kiện (API & Events)
* [10. API & Event Contracts](api/10_API_AND_EVENT_CONTRACTS.md) – Đặc tả RESTful API Endpoints /api/v1, WebSocket & Chuẩn Error JSON.

### 🗄️ 5. Cơ Sở Dữ Liệu & Lưu Trữ (Database & Storage)
* [09. Database & Storage Schema](database/09_DATABASE_AND_STORAGE.md) – Lược đồ CSDL PostgreSQL 20+ bảng DDL & MinIO Storage.

### 🤖 6. Động Cơ Dịch Truyện AI (AI Translation Engine)
* [11. AI Translation Architecture](ai/11_AI_TRANSLATION_ARCHITECTURE.md) – Pipeline Manga/Novel OCR, Inpainting, Typesetting & State Machine 14 trạng thái.

### 🛡️ 7. An Toàn Thông Tin & Pháp Lý (Security & Rights)
* [15. Security Threat Model](security/15_SECURITY_THREAT_MODEL.md) – Mô hình đe dọa STRIDE, Anti-Leech & File Sanitization.
* [16. Privacy, Content & Rights](security/16_PRIVACY_CONTENT_AND_RIGHTS.md) – Quyền sở hữu nội dung, DMCA & Takedown Workflow.

### 🧪 8. Kiểm Thử & Đảm Bảo Chất Lượng (QA & Testing)
* [17. Testing & QA Strategy](qa/17_TESTING_AND_QA.md) – Chiến lược kiểm thử đa tầng & Bộ dữ liệu Benchmark AI Ground Truth.

### 🚀 9. Triển Khai & Vận Hành (DevOps & Observability)
* [18. DevOps, Observability & DR](devops/18_DEVOPS_OBSERVABILITY_DR.md) – Cấu hình 7 Container, Nginx, CI/CD, Prometheus & Kế hoạch DR.

### 📊 10. Quản Lý Dự Án (Project Management)
* [19. Project Management & Scrum](project-management/19_PROJECT_MANAGEMENT.md) – Lịch trình Scrum 4 Sprint, WBS 4 Cấp & Definition of Done.
* [20. Risk Register & Unit Economics](project-management/20_RISK_AND_COST.md) – Ma trận 16 rủi ro (R1-R16) & Mô hình Unit Economics.

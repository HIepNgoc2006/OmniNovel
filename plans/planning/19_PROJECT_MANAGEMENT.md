# 📅 19. Kế Hoạch Quản Trị Dự Án, Phân Rã Công Việc WBS & Khung Scrum (Project Management)

Tài liệu này xác định lịch trình phát triển 4 Sprint Scrum, bảng phân rã công việc **WBS 4 Cấp (Work Breakdown Structure)**, ma trận phân công trách nhiệm **RACI** và tiêu chuẩn hoàn thành (**Definition of Done - DoD**).

---

## 1. LỊCH TRÌNH SCRUM 4 SPRINTS & ÁNH XẠ 6 PHASES (SPRINT-PHASE MAPPING)

| Sprint | Thời Gian | Mục Tiêu Trọng Tâm | Ánh Xạ Phase Triển Khai |
| :---: | :---: | :--- | :--- |
| **Sprint 1** | Tuần 1 - 2 | • Thiết lập Monorepo, Docker Compose, CSDL 20+ bảng.<br>• Hoàn thiện AuthModule, UserModule và CatalogModule CRUD. | **Phase 1 (Setup)** + **Phase 2 (Core Backend)** |
| **Sprint 2** | Tuần 3 - 4 | • Xây dựng AI Translation Worker Pipeline (OCR, LLM, Inpaint).<br>• Tích hợp BullMQ Queue, WebSocket và Popup 2 Lựa chọn (Diff). | **Phase 3 (AI Worker)** + **Phase 2 (Translation)** |
| **Sprint 3** | Tuần 5 - 6 | • Phát triển Web Client (Next.js) & Mobile App (Flutter 120Hz).<br>• Trình đọc Manga Webtoon, Novel Typography, Tủ sách cá nhân.<br>• Phân hệ Gamification MVP (Total EXP, OmniCoin, Daily Check-in). | **Phase 4 (Web)** + **Phase 5 (Mobile)** |
| **Sprint 4** | Tuần 7 - 8 | • Tích hợp E2E Testing, K6 Load Testing, Security Audit.<br>• Cấu hình CI/CD GitHub Actions, Nginx Proxy, Demo Nghiệm thu 5 môn. | **Phase 6 (DevOps & Defense)** |

---

## 2. CẤU TRÚC PHÂN RÃ CÔNG VIỆC WBS 4 CẤP (WORK BREAKDOWN STRUCTURE)

```
1. OmniNovel Platform
├── 1.1. Hạ Tầng & CSDL (Infrastructure & Database)
│   ├── 1.1.1. Cấu hình Docker Compose 7 Container (Nginx, API, Web, AI, Postgres, Redis, MinIO)
│   ├── 1.1.2. Khởi tạo CSDL PostgreSQL 16 (DDL 20+ bảng quan hệ và Constraints)
│   └── 1.1.3. Cấu hình MinIO Buckets và Presigned URL Policy
├── 1.2. Backend Core API (NestJS)
│   ├── 1.2.1. Phân hệ Xác thực: JWT Rotation (HS256), Argon2id, Role Guards
│   ├── 1.2.2. Phân hệ Bộ truyện & Trình đọc: Hierarchy CRUD, Signed URLs, Novel Blocks
│   ├── 1.2.3. Phân hệ Dịch thuật: TranslationProject, BullMQ Producer, Version Semantics
│   └── 1.2.4. Phân hệ Gamification: Atomic Check-in, Anti-farming EXP, Sổ cái Ledger
├── 1.3. AI Translation Worker (Python FastAPI)
│   ├── 1.3.1. Thị giác máy tính: Text Detection CRAFT + Reading Order Sorting
│   ├── 1.3.2. Nhận dạng chữ & Dịch: Manga-OCR + LLM Contextual Translation + Glossary
│   └── 1.3.3. Xử lý ảnh: LaMa Inpainting + Pillow Typesetting Rendering
├── 1.4. Client Applications (Web & Mobile)
│   ├── 1.4.1. Web Next.js: Feed, Trình đọc Manga/LN, Studio AI Upload & Diff Preview
│   └── 1.4.2. Mobile Flutter: Webtoon Virtualized List 120Hz, Check-in, [Offline: V1 Scope]
└── 1.5. Đảm Bảo Chất Lượng & Triển Khai (QA & DevOps)
    ├── 1.5.1. Bộ kiểm thử Unit, Integration Supertest và E2E Playwright
    ├── 1.5.2. Pipeline CI/CD GitHub Actions tự động build/test/deploy
    └── 1.5.3. Tài liệu nghiệm thu đồ án & Báo cáo ma trận 5 môn học
```

---

## 3. MA TRẬN PHÂN CÔNG TRÁCH NHIỆM RACI (RACI MATRIX)

*(R: Responsible - Thực hiện, A: Accountable - Chịu trách nhiệm, C: Consulted - Tham vấn, I: Informed - Nhận thông tin)*

| Gói Công Việc | Team Leader | Backend Eng | AI/CV Eng | Mobile Eng | DevOps/QA Eng |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Kiến trúc & CSDL Monorepo** | **A** | **R** | C | C | C |
| **Phát triển Core API NestJS** | A | **R** | C | I | I |
| **Xây dựng AI Translation Pipeline**| A | C | **R** | I | I |
| **Phát triển Mobile Flutter 120Hz**| A | I | I | **R** | I |
| **Phát triển Web Next.js Studio**  | A | C | C | I | **R** |
| **Thiết lập CI/CD & Security Audit**| A | I | I | I | **R** |

---

## 4. TIÊU CHUẨN HOÀN THÀNH (DEFINITION OF DONE - DoD)

Một User Story hoặc Tính năng chỉ được coi là hoàn thành (`DONE`) khi thỏa mãn 100% các tiêu chí:
1. Mã nguồn được viết theo chuẩn Clean Architecture, tuân thủ linter (ESLint, Dart Analyze).
2. Viết đầy đủ Unit Tests với độ bao phủ $\ge 70\%$, chạy pass toàn bộ test suite.
3. API có tài liệu Swagger đầy đủ và xử lý mã lỗi theo đúng chuẩn JSON quy định.
4. Được review và merge vào nhánh `main` qua Pull Request có kiểm tra CI/CD tự động.
5. Kiểm thử thực tế trên thiết bị mục tiêu (Web Chrome + Smartphone Android 120Hz) đạt hiệu năng.

# 🗺️ OmniNovel Master Roadmap & Phase Tracking

Tài liệu này theo dõi tiến độ toàn diện của dự án **OmniNovel** qua các giai đoạn từ xây dựng nền móng đến hoàn thiện sản phẩm thương mại.

---

## 📊 Bảng Tổng Quan Trạng Thái Tiến Độ

| Giai Đoạn | Tên Giai Đoạn | Trọng Tâm | Trạng Thái |
| :---: | :--- | :--- | :---: |
| **Phase 1** | [Setup & Architecture Baseline](phases/phase_01_setup.md) | Khởi tạo Monorepo, Docker, Shared Package | `[x] Hoàn thành (100%)` |
| **Phase 2** | [Core Backend API & Security](phases/phase_02_backend_core.md) | NestJS API, PostgreSQL DDL, RBAC, Redis Cache | `[x] Hoàn thành (100%)` |
| **Phase 3** | [AI Translation Worker & Queue](phases/phase_03_ai_worker.md) | FastAPI, OCR, Manga Inpainting, Translation Worker | `[x] Hoàn thành (100%)` |
| **Phase 4** | [Web Client](phases/phase_04_web_client.md) | Next.js, Manga/Novel Reader, Studio UI | `[x] Hoàn thành (100%)` |
| **Phase 5** | [Mobile App Engine](phases/phase_05_mobile_app.md) | Flutter, Offline Caching, Storage Quota LRU | `[x] Hoàn thành (100%)` |
| **Phase 6** | [DevOps, CI/CD & Academic Defense](phases/phase_06_devops_final.md) | Hardening, Observability, 5 Môn Đồ án Nghiệm thu | `[x] Hoàn thành (100%)` |
| **Phase 7** | [**OmniNovel Product Completion**](phases/phase_07_product_completion.md) | **Chuyển dịch sang sản phẩm thực tế: Guest-first, Sync Web↔App, Parity, Community** | `[/] Đang Khởi Động (Phase 7A)` |

---

## 🎯 Chi Tiết Trọng Tâm Phase 7: Product Completion

- **Phase 7A: Guest-first Identity & Account Lifecycle** `[/] Đang làm`
  - `[ ]` 7A.1. Shared Contracts & DTOs cho Guest State & Migration (`@omninovel/shared`)
  - `[ ]` 7A.2. Backend Migration Endpoint `POST /api/v1/account/import-guest-state` & Account APIs
  - `[ ]` 7A.3. Web Client Local-first Library Repository & Auto Migration on Login
  - `[ ]` 7A.4. Mobile App Guest Mode & SQLite Local Persistence
- **Phase 7B: Unified Sync Engine** `[ ] Chưa làm`
  - `[ ]` 7B.1. Canonical Sync Protocol (Novel block offset, Manga scroll position, Preferences)
  - `[ ]` 7B.2. Backend Sync Hub (`/sync/state`, `/sync/reconcile`)
  - `[ ]` 7B.3. Client Background Reconcilers (Web ServiceWorker / Mobile Background Worker)
- **Phase 7C: Feature Parity giữa Web và Mobile** `[ ] Chưa làm`
  - `[ ]` 7C.1. Capability Matrix Audit & Đồng bộ tính năng
  - `[ ]` 7C.2. Web Offline Cache (Service Worker Cache API / IndexedDB)
- **Phase 7D: Community & Discussion** `[ ] Chưa làm`
  - `[ ]` 7D.1. Database Schema & Migration cho Comments, Replies, Reactions, Spoiler Tags
  - `[ ]` 7D.2. Backend Discussion Module (CRUD, Pagination cursor-based, Rate Limiting)
  - `[ ]` 7D.3. Frontend & Mobile Integration (Thay thế mock data bằng real API)
- **Phase 7E: Notifications & Following** `[ ] Chưa làm`
  - `[ ]` 7E.1. Story Following Engine
  - `[ ]` 7E.2. In-App Notification Center (Web & Mobile)
- **Phase 7F: Product UX Polish & 8 UI States Audit** `[ ] Chưa làm`
  - `[ ]` 7F.1. Audit 8 Trạng Thái Hệ Thống (Loading, Error, Empty, Offline, Unauthorized, Forbidden, Expired Session, Partial Data)
  - `[ ]` 7F.2. Phím tắt, Haptics, AMOLED, Gestures
- **Phase 7G: Production Release Engineering** `[ ] Chưa làm`
  - `[ ]` 7G.1. Mobile Production Release (Signing, AAB, ProGuard)
  - `[ ]` 7G.2. Web Production Readiness (SEO, OpenGraph, PWA Manifest)
  - `[ ]` 7G.3. Disaster Recovery & Automated Backup/Restore Drills

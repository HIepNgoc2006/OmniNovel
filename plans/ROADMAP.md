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
| **Phase 5** | [Mobile App Engine](phases/phase_05_mobile_app.md) | Flutter, Offline Caching, Storage Quota LRU | `[Archived]` *Legacy academic scope archived; hardware-matrix acceptance superseded by Phase 7 product acceptance criteria.* |
| **Phase 6** | [DevOps, CI/CD & Academic Defense](phases/phase_06_devops_final.md) | Hardening, Observability, 5 Môn Đồ án Nghiệm thu | `[x] Hoàn thành (100%)` |
| **Phase 7** | [**OmniNovel Product Completion**](phases/phase_07_product_completion.md) | **Chuyển dịch sang sản phẩm thương mại: Identity, Claim, Sync, Parity, Community** | `[/] Đang Triển Khai (Phase 7.0 Gate PASS)` |

---

## 🎯 Chi Tiết Trọng Tâm Phase 7: Product Completion

- **Phase 7.0: Product Architecture & Data Ownership Design Gate** `[x] Hoàn thành (100%)`
  - `[x]` 7.0.1. [Identity & Ownership Model](product/identity_and_ownership_model.md) (UUIDv4 `installationId`, namespace `guest:<id>` vs `account:<id>`, isolation P0).
  - `[x]` 7.0.2. [Guest-to-Account Claim Protocol](product/guest_to_account_claim_protocol.md) (Two-step prepare & commit, zero client timestamp authority, anti-exploit gamification).
  - `[x]` 7.0.3. [Unified Sync Protocol](product/unified_sync_protocol.md) (Server revisions, client mutations queue, tombstones, anti-resurrection).
  - `[x]` 7.0.4. [Web ↔ Mobile Capability Parity Matrix](product/web_mobile_capability_matrix.md) (Next.js 16.3.3 / React 19.2 & Flutter, 8 system states).
- **Phase 7A: Guest Local Runtime (Local-First Engine)** `[/] Đang Khởi Động`
  - `[ ]` 7A.1. Web IndexedDB Primary Store (`omninovel_local_v2`) cho Bookmarks, Reading Progress, History.
  - `[ ]` 7A.2. Mobile SQLite `owner_scope` Adapter cho Guest Isolation.
  - `[ ]` 7A.3. Chế độ đọc hoàn chỉnh offline/local không phụ thuộc JWT.
- **Phase 7B: Account Claim & Lifecycle Protocol** `[ ] Chưa làm`
  - `[ ]` 7B.1. Two-Step Claim Backend API (`POST /account/guest-claims/prepare` & `POST /account/guest-claims/:claimId/commit`).
  - `[ ]` 7B.2. Account Lifecycle APIs (`forgot-password`, `reset-password`, `change-password`, `GET/DELETE sessions`, `DELETE account`, `GET export-data`).
  - `[ ]` 7B.3. Client Auto-Claim Hook & Offline Metadata Rebind.
- **Phase 7C: Unified Multi-Device Sync Engine** `[ ] Chưa làm`
  - `[ ]` 7C.1. Core API Sync Hub (`GET /sync/changes?after=rev`, `POST /sync/mutations/batch`).
  - `[ ]` 7C.2. Table `sync_change_log` & Tombstone Anti-Resurrection Logic.
  - `[ ]` 7C.3. Web Service Worker & Mobile Sync Background Worker.
- **Phase 7D: Web ↔ Mobile Capability Parity** `[ ] Chưa làm`
  - `[ ]` 7D.1. Web Offline Reading Cache (Service Worker Cache API / IndexedDB).
  - `[ ]` 7D.2. Mobile Studio Viewer & Quick Translation Approval.
- **Phase 7E: Community & Discussion (Production Persistence)** `[ ] Chưa làm`
  - `[ ]` 7E.1. PostgreSQL Schema: Comments, Nested Replies, Reactions, Spoiler Tags, Reports.
  - `[ ]` 7E.2. Backend Discussion Module (CRUD, Cursor-based Pagination, Rate Limiting).
  - `[ ]` 7E.3. Thay thế hoàn toàn Mock UI trên Web và tích hợp Mobile Discussion Sheet.
- **Phase 7F: Notifications & Following** `[ ] Chưa làm`
  - `[ ]` 7F.1. Story Following Engine (Tách riêng Bookmark cá nhân và Follow nhận thông báo).
  - `[ ]` 7F.2. Event `chapter.published` Dispatcher & In-App Notification Center.
- **Phase 7G: Product UX Polish & 8 System States Audit** `[ ] Chưa làm`
  - `[ ]` 7G.1. Audit 8 Trạng Thái Hệ Thống trên mọi màn hình Web & Mobile.
  - `[ ]` 7G.2. Haptics, AMOLED, Phím tắt, Reader Ergonomics.
- **Phase 7H: Production Release Engineering** `[ ] Chưa làm`
  - `[ ]` 7H.1. Mobile Production Release (Signing, AAB, ProGuard).
  - `[ ]` 7H.2. Web Production Readiness (SEO, OpenGraph, PWA Manifest).
  - `[ ]` 7H.3. Disaster Recovery & Automated Backup/Restore Drills.

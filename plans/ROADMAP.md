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
- **Phase 7A: Guest Local Runtime (Local-First Engine)** `[x] Hoàn thành (100% — All 7 Tasks PASS & Frozen ✅)`
  - `[x]` 7A.1. Local Identity & ActiveScope Coordinator (Web & Mobile SSoT — 25/25 tests PASS ✅).
  - `[x]` 7A.2. Canonical Local Library Schema & Migration (IndexedDB v1, SQLite v3 — All Invariants PASS ✅).
  - `[x]` 7A.3. Web Repository Layer & IndexedDB Implementation (`omninovel_local_v2` — 17/17 tests PASS, Full Invariants Locked ✅).
  - `[x]` 7A.4. Web Reader / Bookmark / History Integration (Repository Abstraction — FROZEN at `8b6f1fb` ✅).
  - `[x]` 7A.5. Mobile Local Library Schema & Repository (SQLite v3 `owner_scope` — LocalLibraryDao & Guest Repositories Completed ✅).
  - `[x]` 7A.6. Mobile Guest Navigation & Reader Integration ("Continue as Guest" — Step 1 & Step 2 FROZEN CLEAN at `903d718` ✅).
  - `[x]` 7A.7. Identity Isolation / Persistence / Crash / Acceptance Verification (Cross-Platform Matrix PASS ✅).
- **Phase 7B: Account Claim & Lifecycle Protocol** `[x] Hoàn thành (100% — All Tasks PASS & FROZEN CLEAN ✅)`
  - `[x]` 7B.1. Three-Endpoint Claim Backend API (`POST /prepare`, `POST /commit`, `GET /status`, Durable PostgreSQL Ledger `guest_claims`, `bookmarks`, `chapter_read_states`, `reading_progress`, 1-based `pageIndex >= 1`, canonical `readingMode`, Idempotency First, Best-effort Redis Lock, Ensure Epoch Row + Domain Row Locking chống TOCTOU, Mode-Aware Conflict, Tombstone Anti-Resurrection, Zero Gamification `user_progression`) — *FROZEN CLEAN (Run #420 Green 7/7)* ✅.
  - `[x]` 7B.2. Account Lifecycle APIs (Register auto-login, Access Token `sid` claim & `req.user.sessionId`, `forgot-password` non-enumeration + real email delivery provider, `reset-password`, `change-password` revoke others, immediate session/token revocation via Redis, stable session management `auth_session` via `familyId`, Two-Phase deletion: Day 0 soft-delete bảo tồn attributions ↔ `POST /auth/reactivate-account` 3 nhánh chặt chẽ (reject active account 400) ↔ Day 30 final purge hard-delete `users` row + Anonymize Ledgers `guest_claims`/`reward_transactions` + FK SET NULL / CASCADE + Node crypto hash ledger, `GET export-data` đầy đủ dataset gồm translations) — *Task 7B.2 & 7B.2a Remediation FROZEN CLEAN* ✅.
  - `[x]` 7B.3.1. Shared Contracts Architecture (Canonical TS contracts cho API/Web, Mirror Dart models cho Mobile, Conformance tests PASS, bao gồm `expectedStateFingerprint` trong `CommitGuestClaimPayload`) — *FROZEN CLEAN* ✅.
  - `[x]` 7B.3a. Web Client Remediation (P0-1 Contract `expectedStateFingerprint` payload & DTO guard, P0-2 Zero-Mutation Window `deferScopeResolution` on Login/Register, P0-3 Conflict-Aware `rebindScope` honoring `KEEP_CLOUD`/`USE_GUEST`, P0/P1 Fail-Closed Tri-State Crash Recovery `PENDING_UNAVAILABLE`, P1 Canonical `register()` AuthProvider Bridge — Run #432 Green 7/7) — *REMEDIATED* 🛡️.
  - `[x]` 7B.3b. Fail-Closed Scope Resolution Hardening (P0 Prepare failure keeps TRANSITIONING lock, P0 hasGuestData rejects on storage/cursor error, P0 refetchUser preserves TRANSITIONING state and blocks mutations — 50/50 Vitest pass, 657/657 tests pass, Next.js build pass — Hosted CI Run #435 ID 37662890229 Green 7/7) — *FROZEN CLEAN (Commit `9f74ea1`)* ✅.
  - `[x]` 7B.3. Web Client Integration (Guest Claim Coordinator, Transitioning Scope Lock, GuestClaimDialog, Marker Quarantine giữ nguyên physical partition, Rebind IndexedDB merge & purge source, Crash Recovery via pendingClaimId, Auto re-prepare on 409 conflict — 50/50 vitest PASS, Next.js build PASS, Playwright 31/31 PASS) — *FROZEN CLEAN (Run #435 Green 7/7, Commit `9f74ea1`)* ✅.
  - `[x]` 7B.3. Mobile Client Integration (Transitioning Scope Flow, GuestClaimListener, SQLite Transactional Merge & Journal v4, Marker Quarantine, Crash Recovery Matrix, 19/19 AC Tests PASS, 500/500 Full Mobile Regression PASS, Flutter Analyze 0 Issues) — *FROZEN CLEAN & OFFICIALLY ACCEPTED (Hosted CI Run #39008770517 Green 7/7, Tested Commit `0cbbfc9`, Lock Commit `656d060`)* ✅.
  - `[x]` 7B.4. Comprehensive Test Suite, Crash Acceptance Matrix & Zero-Gamification Verification ([phase_07b_4_test_crash_matrix_plan.md](phase_07b_4_test_crash_matrix_plan.md) — 16/16 E2E tests, 478 unit tests, 284 E2E/integration tests, 657 web tests, 500 mobile tests, 323 AI worker tests, Trivy 3 CVEs remediated, chuẩn hóa cách ly test DB container/port 55433, fail-closed migration target guard, strict exact-set topology gate 17/17 PASS, Hosted CI 7/7 Run #40632991971 Green, Commit `516cec6`, doc `d1bdfae`) — *FROZEN CLEAN & OFFICIALLY ACCEPTED* ✅.
- **Phase 7C: Unified Multi-Device Sync Engine** `[/] Đang làm`
  - `[/]` 7C.0. Architecture & Protocol Review Gate ([phase_07c_architecture_gate.md](phase_07c_architecture_gate.md) — 5 Invariants, JCS RFC 8785 Canonical Serializer, Optimistic Snapshot Restart 409, History Epoch Guard, Fresh Mutation IDs, 20 Scenarios SYNC-01..SYNC-20).
  - `[ ]` 7C.1. Database Schema & Core Entities (`user_sync_state`, `sync_change_log`, `sync_tombstones`, `sync_mutation_receipts`, Decimal String 64-bit BIGINTs).
  - `[ ]` 7C.2. Core API Sync Hub & Delta Protocol (`GET /sync/changes`, `GET /sync/snapshot`, `POST /sync/mutations/batch`, Legacy `SyncLogEmitter`, Anti-Resurrection Guard).
  - `[ ]` 7C.3. Web Client Sync Reconciler (IndexedDB v3, Cross-Tab BroadcastChannel Leader, Safe 410 Full Resync Triage).
  - `[ ]` 7C.4. Mobile Client Sync Reconciler (SQLite v4, Background SyncWorker with Backoff, Safe 410 Full Resync Triage).
  - `[ ]` 7C.5. Comprehensive Cross-Platform Sync Verification Matrix (20 Acceptance Scenarios SYNC-01..SYNC-20).
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

---

## 📌 Non-Blocking Technical Debt & P2 Backlog
- [x] **P1 Trivy Exception Lifecycle, Image Scope, Expiry & Package-Level Binding Gate (CLOSED PASS):** Đã hoàn thiện và tích hợp toàn diện vào CI với đầy đủ bằng chứng thực tế: (1) Cách ly file ignore độc lập cho từng image (`deploy/security/trivy/*.trivyignore`); (2) Package-level binding gate phân tích PURL chuẩn hóa, kiểm tra định danh image strictly qua `ArtifactName` và đối chiếu package authority; (3) Bộ 12/12 negative, integration & governance test scenarios tự động (unapproved, expired, cross-image, stale resolved, conflicting images, missing expiry, conflicting packages, package match pass, wrong package blocked, corrupt/missing report fail-closed, image identity mismatch, missing PkgName); (4) Tích hợp `setup-trivy@v0.3.1`, xuất 5 raw JSON scan reports với `--scanners vuln --ignorefile="" --exit-code 0` (ngăn chặn triệt để suppression mặc định lúc trích xuất); (5) Đối chiếu 100% suppressed findings thực tế trên cả 5 images (ai-worker: 81/81, api: 28/28, grafana: 69/69, prometheus: 8/8, nginx: 0 clean) và thực thi kiểm toán fail-closed `--enforce-reports` trực tiếp trên GitHub-hosted CI (Hosted CI Run #39466268491 Green 7/7, Commit `6e27cd9`). Lịch rà soát định kỳ giữ nguyên: 01/11/2026 & 01/12/2026. Gate chính thức được nghiệm thu **CLOSED PASS**.
- [ ] **React Test `act(...)` Warning:** Ghi nhận cảnh báo `act(...)` không đồng bộ trong một số React hook tests trên Web Vitest (không ảnh hưởng tính đúng đắn logic hay kết quả assertion).
- [ ] **GitHub Actions Node.js 20 Deprecation:** Chuẩn bị nâng cấp actions runner lên Node.js 22 runtime theo lộ trình của GitHub Actions.


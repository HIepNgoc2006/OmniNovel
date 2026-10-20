# 🧪 Phase 7B.4: Comprehensive Test Suite, Crash Acceptance Matrix & Zero-Gamification Verification

> **Trạng thái:** `[/] Đang Khởi Tạo Thực Thi`  
> **Mục tiêu:** Kiểm chứng toàn diện 11 kịch bản sự cố, bảo vệ tính toàn vẹn kinh tế ảo (Zero Gamification), ma trận phục hồi sau sự cố (Crash Matrix), và khóa cứng cổng kiểm soát không thoái lui (Zero Regression Gate) trên toàn bộ hệ thống Web, Mobile và Core API.

---

## 🏛️ 1. Danh Mục Các Hạng Mục Kiểm Thử Cần Thực Hiện

### 1.1. Core API E2E & Integration Lifecycle (`services/api`)
Tạo mới file kiểm thử toàn diện: `services/api/test/guest-claim-lifecycle.e2e-spec.ts`:
- [ ] **Kịch bản 1 (Input Boundaries & DTO Validation):**
  - Chặn `pageIndex < 1` (1-based index invariant).
  - Chặn `readingMode` không thuộc `WEBTOON | PAGED | NOVEL`.
  - Chặn payload danh sách vượt quá 500 mục.
  - Chặn chapter chưa xuất bản (`UNPUBLISHED`).
- [ ] **Kịch bản 2 (Mode-Aware Conflict Detection):**
  - Thẩm định so sánh xung đột theo từng chế độ đọc chuyên biệt (PAGED dùng `pageIndex`, WEBTOON dùng `scrollPosition` + `progressPercentage`, NOVEL dùng `anchorBlockId` + `textOffset`).
- [ ] **Kịch bản 3 (Tombstone Anti-Resurrection Invariant):**
  - Đảm bảo truyện có tombstone bị chặn triệt để, không cho phép hồi sinh read states hoặc progress vào PostgreSQL.
- [ ] **Kịch bản 4 (Commit Idempotency First):**
  - Gọi commit lần 1 thành công -> Gọi commit lần 2 trả ngay 200 OK từ ledger `guest_claims`, không duplicate insert, không thay đổi số liệu, bất kể quá hạn TTL 15 phút.
- [ ] **Kịch bản 5 (Redis Loss Fallback & High Availability):**
  - Giả lập Redis bị sập / mất kết nối -> Commit vẫn hoàn tất an toàn 100% nhờ hàng phòng ngự khóa hàng PostgreSQL row lock (`SELECT FOR UPDATE`).
- [ ] **Kịch bản 6 (TOCTOU Protection & Stale Fingerprint Detection):**
  - Giả lập dữ liệu Cloud thay đổi giữa thời điểm `prepare` và `commit` -> Commit phát hiện fingerprint sai lệch và trả về `409 Conflict (CLAIM_STALE_REPREPARE)`.
- [ ] **Kịch bản 7 (Security Ownership Enforcement):**
  - User B dùng token của mình gọi commit `claimId` do User A prepare -> Chặn đứng bằng `403 Forbidden`.
- [ ] **Kịch bản 8 (Expired Session Handshake):**
  - Gọi commit claim ở trạng thái `PREPARED` sau khi đã quá hạn 15 phút -> Chuyển trạng thái sang `EXPIRED` và trả về `410 Gone`.
- [ ] **Kịch bản 9 (Crash Recovery via Status Polling):**
  - Endpoint `GET /status` trả đầy đủ trạng thái và kết quả finalization để client khôi phục sau sự cố crash mạng/app. User khác gọi status bị chặn `403 Forbidden`.
- [ ] **Kịch bản 10 (Zero-Gamification Verification - P0 Bắt Buộc):**
  - Snapshot bảng thực tế `user_progression` trước và sau commit (`total_exp`, `omnicoin_balance`, `current_streak`, `max_streak`) -> Khẳng định $\Delta = 0$ trên 100% các chỉ số này.
- [ ] **Kịch bản 11 (Two-Phase Deletion & Account Lifecycle Coherence):**
  - Day 0 Soft delete bảo tồn nguyên vẹn quyền tác giả và ledger (`guest_claims`, `reward_transactions`).
  - Reactivate Account phân xử đúng 3 nhánh.
  - Day 30 Purge dùng Node.js SHA-256 ẩn danh hóa ledgers và kích hoạt cascade dọn sạch private data.

---

### 1.2. Web Client Crash Recovery & Transitioning Lock (`apps/web`)
- [ ] Xác nhận 50/50 tests Vitest trong `guest-claim-coordinator.spec.ts` và `guest-claim-dialog.spec.tsx` bao phủ trọn vẹn:
  - Khóa `TRANSITIONING` ngăn chặn triệt để account mutation khi đang xử lý claim.
  - Marker Quarantine: bấm Skip thì đánh dấu marker, bảo toàn partition vật lý `guest:<id>`.
  - Rebind & Purge: commit thành công thì sáp nhập vào IndexedDB account và dọn dẹp partition khách.
  - Crash recovery via `pendingClaimId` tri-state (`NONE`, `RESOLVED`, `PENDING_UNAVAILABLE`).

---

### 1.3. Mobile Client Crash Matrix & Transactional Merge (`apps/mobile`)
- [ ] Xác nhận toàn bộ 19/19 Acceptance Criteria tests và 500/500 Mobile Flutter tests:
  - Quét đúng SQLite partition `guest:<id>`.
  - Transactional local merge không xung đột Primary Key `[ownerScope, storyId]`.
  - Marker quarantine khi Skip.
  - Khôi phục an toàn sau crash qua `pending_claim_id`.

---

### 1.4. Cổng Kiểm Soát Không Thoái Lui Toàn Hệ Thống (Regression Gate)
- [ ] NestJS Core API: Unit tests & E2E tests pass 100%.
- [ ] Web Client: Lint, Typecheck, Vitest (657/657 tests) & Playwright E2E pass 100%.
- [ ] Mobile Client: Flutter analyze 0 errors & 500/500 Flutter tests pass 100%.
- [ ] AI Worker: Pytest suite pass 100%.
- [ ] Security Audit: TruffleHog + P1 Trivy Governance 12/12 scenarios pass 100%.
- [ ] Hosted CI: 7/7 jobs SUCCESS.

---

## 📅 2. Bảng Theo Dõi Tiến Độ Thực Thi

| Bước | Nội Dung | Trạng Thái |
| :---: | :--- | :---: |
| **Bước 1** | Xây dựng bộ test E2E `guest-claim-lifecycle.e2e-spec.ts` cho Core API bao phủ 11 kịch bản | `[/] Đang làm` |
| **Bước 2** | Chạy kiểm thử cục bộ NestJS Test Suite & sửa lỗi phát sinh (nếu có) | `[ ] Chưa làm` |
| **Bước 3** | Rà soát và hoàn thiện ma trận Crash Matrix trên Web & Mobile Client | `[ ] Chưa làm` |
| **Bước 4** | Chạy kiểm thử toàn bộ hệ thống (Web 657 tests, Mobile 500 tests, Core API) | `[ ] Chưa làm` |
| **Bước 5** | Commit & Push lên GitHub, kích hoạt Hosted CI Run xác thực 7/7 jobs | `[ ] Chưa làm` |
| **Bước 6** | Tổng hợp kết quả nghiệm thu và đóng hoàn toàn Phase 7B | `[ ] Chưa làm` |

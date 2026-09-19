# Design Document: Translation Job Apply / Publish UI (#152)

- **Date:** 2026-09-19
- **Status:** Draft / Pending User Review
- **Issue:** #152 ([Phase 4D][Web] Implement Apply/Publish preview with overwrite vs alternate-version strategies)
- **Parent Tracking:** #143 (Phase 4D AI Translation Studio & Apply Management)
- **Target Audience:** Web Client, Core API, Shared Types

---

## 1. Context & Objectives

Manga Review Studio (#149) is complete and merged through RED 0–6. Reviewers can navigate pages, edit translation segments with OCC, verify segments, and re-materialize fresh artifacts.

The missing link to complete the end-to-end user loop:
$$\text{AI Translation} \longrightarrow \text{Review} \longrightarrow \text{Edit} \longrightarrow \text{Verify} \longrightarrow \text{Re-materialize} \longrightarrow \mathbf{Apply / Publish} \longrightarrow \text{Reader}$$

Issue #152 implements the **Apply / Publish UI**, allowing authorized users (Admin, Story Owner, Story Editor) to publish the reviewed and materialized translation as an authoritative `ChapterVersion`, selecting between two strategies:
1. `OVERWRITE_ACTIVE_VERSION`: Replaces the current reader version for the chapter.
2. `CREATE_ALTERNATE_VERSION`: Creates a secondary version without disrupting the active reader version.

While scoped Manga-first, the contracts, pure policies, and modal components are built modularly so they can be reused without modification by Novel Review Studio (#150).

---

## 2. Architectural Contract Locks (SSoT)

### Lock 1: Canonical Apply Contracts in `@omninovel/shared`
Move `ApplyTranslationMode` from backend DTO to `@omninovel/shared`, and define strict request/response shapes:
```typescript
export enum ApplyTranslationMode {
  OVERWRITE_ACTIVE_VERSION = 'OVERWRITE_ACTIVE_VERSION',
  CREATE_ALTERNATE_VERSION = 'CREATE_ALTERNATE_VERSION',
}

export interface ApplyTranslationJobRequest {
  mode: ApplyTranslationMode;
}

export interface ApplyTranslationJobResponse {
  chapterId: string;
  activeVersionId: string | null;
  targetVersionId: string;
  versionNumber: number;
  versionType: ChapterVersionType;
  isAlreadyApplied: boolean;
}
```

In `TranslationJobReviewDetailResponse`:
```typescript
export interface TranslationJobReviewDetailResponse {
  // ...
  permissions: {
    canApply: boolean;
    applyBlockReason?: 'INSUFFICIENT_ROLE';
  };
}
```
- `permissions` is **required**.
- No localized strings in API contracts; the UI maps `'INSUFFICIENT_ROLE'` to user-facing copy.
- Backend fix: Idempotent replay (`isAlreadyApplied: true`) **must** always return `targetVersionId: job.targetVersionId` (currently missing).

### Lock 2: Idempotency Identity `(key, mode)` & Conflict Guard
- Web client must freeze `{ idempotencyKey: string, submittedMode: ApplyTranslationMode }` when submission starts.
- Retries on network error or ambiguous timeout **must** reuse the same `idempotencyKey` AND the same `submittedMode`.
- If user wants to switch modes, they must create a new logical submission action with a newly generated UUIDv4.
- Backend database schema: Migration 0014 adds `apply_mode VARCHAR(50) NULL` to `translation_jobs`.
  - When `job.applyIdempotencyKey === idempotencyKey`:
    - If `job.applyMode === dto.mode`: Return idempotent replay response (`isAlreadyApplied: true`).
    - If `job.applyMode !== dto.mode`: Throw HTTP 409 `ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency-Key reuse with conflicting mode' })`.

### Lock 3: Authoritative Reconciliation — No Optimistic State Mutation
- Web Client must **never** optimistically set `job.status = 'APPLIED'` upon receiving the 200 OK response from `POST /api/v1/ai/jobs/:id/apply`.
- Workflow:
  1. `POST /api/v1/ai/jobs/:id/apply` succeeds with `ApplyTranslationJobResponse`.
  2. UI retains response in state and transitions modal state to `RECONCILING`.
  3. UI triggers authoritative refetch: `refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' })`.
  4. Server returns fresh `TranslationJobReviewDetailResponse` with `status: 'APPLIED'` and incremented `workspaceRevision`.
  5. UI transitions workspace mode to `APPLIED` (read-only) and modal state to `SUCCEEDED`.
- **Fault-tolerant handling**: If step 1 succeeds but step 3 fails (e.g., transient network disconnection during refetch), UI transitions to `COMMITTED_RECONCILIATION_REQUIRED`:
  - Modal notifies user: *"Xuất bản đã được máy chủ ghi nhận, nhưng chưa thể làm mới không gian làm việc. Vui lòng làm mới trang."*
  - It does **not** falsely report "Xuất bản thất bại" since the version was indeed created on the server.

### Lock 4: Reader Deep-link Invariant
- Success state links must always include `?versionId=`:
  ```typescript
  `/stories/${story.slug}/read/${response.chapterId}?versionId=${response.targetVersionId}`
  ```
- **Rationale**: For `CREATE_ALTERNATE_VERSION`, `chapter.activeVersionId` is not modified. Navigating to the raw chapter URL would display the prior active version, misleading users into thinking apply failed. Deep-linking with explicit `versionId` guarantees accurate presentation for both modes.

### Lock 5: Global Draft Publish Fence & Freshness Gate
Publishing is strictly fail-closed. The Apply CTA is enabled **only** when all invariants pass:
```typescript
export interface CanApplyJobParams {
  jobStatus: TranslationJobStatus;
  canApplyPermission: boolean;
  freshnessStatus: string;
  hasUncommittedDrafts: boolean;
  applyInFlight: boolean;
  materializationInFlight: boolean;
}

export function canApplyJob(params: CanApplyJobParams): boolean {
  return (
    params.jobStatus === TranslationJobStatus.READY_FOR_REVIEW &&
    params.canApplyPermission === true &&
    params.freshnessStatus === 'FRESH' &&
    !params.hasUncommittedDrafts &&
    !params.applyInFlight &&
    !params.materializationInFlight
  );
}
```
- `hasUncommittedDrafts`: Computed across **all** segments across the entire job (`Object.keys(drafts).length > 0`), not just the currently displayed page.
- `freshnessStatus === 'FRESH'`: Guarantees `materializedRevision === reviewRevision`.

### Lock 6: Explicit Mode Selection & Verification Warning
- Initial modal state has **no** default mode selected (`selectedMode: null`).
- "Xác Nhận Xuất Bản" button is disabled until user explicitly clicks one of the two mode cards.
- Mode 1: `OVERWRITE_ACTIVE_VERSION`
  - Title: *"Ghi đè bản đọc chính thức (Active Version)"*
  - Badge: Amber warning *"Thay thế bản đọc mặc định hiện tại của độc giả ngay lập tức."*
- Mode 2: `CREATE_ALTERNATE_VERSION`
  - Title: *"Tạo bản dịch phụ (Alternate Version)"*
  - Badge: Cyan info *"Tạo phiên bản mới song song, giữ nguyên bản đọc mặc định."*
- If `verifiedCount < segmentCount`:
  - Prominent warning banner: *"Có X ô thoại chưa được duyệt thủ công. Bạn có chắc chắn muốn xuất bản với kết quả dịch AI tự động?"*
  - Non-blocking (warning only, not hard gate).

---

## 3. Component Architecture & Data Flow

```
+-------------------------------------------------------------------------+
| apps/web/src/app/(site)/(studio)/studio/ai/jobs/[jobId]/page.tsx       |
|                                                                         |
|  [Header Action Bar]                                                    |
|  +--------------------+  +--------------------+  +-------------------+  |
|  | Hủy Job            |  | Kết Xuất (RED 5)   |  | Xuất Bản (#152)   |  |
|  +--------------------+  +--------------------+  +---------+---------+  |
+------------------------------------------------------------|------------+
                                                             | (opens)
                                                             v
+-------------------------------------------------------------------------+
| ApplyTranslationModal (apps/web/src/components/studio)                  |
|                                                                         |
|  State Machine:                                                         |
|  IDLE -> SUBMITTING -> RECONCILING -> SUCCEEDED                         |
|                    \-> ERROR                                            |
|                    \-> COMMITTED_RECONCILIATION_REQUIRED                |
|                                                                         |
|  [Verification Summary Card]                                            |
|   Verified X / Y segments (Z%)                                          |
|   Warning if Z < 100%                                                   |
|                                                                         |
|  [Strategy Cards]                                                       |
|   [O] OVERWRITE_ACTIVE_VERSION (Strong warning)                         |
|   [O] CREATE_ALTERNATE_VERSION (Non-destructive)                        |
|                                                                         |
|  [Action Buttons]                                                       |
|   [Hủy / Đóng]               [Xác Nhận Xuất Bản (Disabled if !mode)]   |
+-------------------------------------------------------------------------+
                                 |
                                 | calls studio.applyJob(mode, idempotencyKey)
                                 v
+-------------------------------------------------------------------------+
| useMangaReviewStudio (apps/web/src/lib/studio/use-manga-review-studio)  |
|                                                                         |
|  - Freezes (idempotencyKey, submittedMode)                              |
|  - Calls POST /api/v1/ai/jobs/:id/apply                                 |
|  - Upon 200 OK: calls refetchDetail({ requirement: 'AUTHORITATIVE' })   |
|  - Reconciles workspaceRevision & switches to read-only APPLIED         |
+-------------------------------------------------------------------------+
```

---

## 4. Backend Implementation Plan

1. **Migration 0014**:
   - `services/api/src/database/migrations/1700000000014-AddTranslationJobApplyMode.ts`
   - Adds column `apply_mode VARCHAR(50) NULL` to table `translation_jobs`.
2. **Entity & DTO Parity**:
   - `TranslationJob.applyMode: string | null` in `translation-job.entity.ts`.
   - Update `ApplyTranslationJobDto` to import `ApplyTranslationMode` from `@omninovel/shared`.
3. **Controller & Service Updates**:
   - `getJob()` in `translation.service.ts`: Check user role efficiently without double-querying `story_members`. Populate `permissions: { canApply: boolean, applyBlockReason?: 'INSUFFICIENT_ROLE' }`.
   - `applyJob()` in `translation.service.ts`:
     - If `job.applyIdempotencyKey === idempotencyKey`:
       - Check `job.applyMode === dto.mode`. If mismatch, throw 409 `IDEMPOTENCY_CONFLICT`.
       - Return replay response including `targetVersionId: job.targetVersionId`.
     - In transaction: save `apply_mode = dto.mode`.

---

## 5. Frontend Implementation Plan

1. **Shared Types**:
   - Update `packages/shared/src/index.ts` with `ApplyTranslationMode`, `ApplyTranslationJobRequest`, `ApplyTranslationJobResponse`, and required `permissions` field in `TranslationJobReviewDetailResponse`.
2. **Pure Policy (`apps/web/src/lib/studio/studio-apply-policy.ts`)**:
   - `canApplyJob(params)`
   - `resolveApplyBlockReason(params)`
   - `resolvePostApplyReaderUrl(storySlug, response)`
3. **Modal Component (`apps/web/src/components/studio/apply-translation-modal.tsx`)**:
   - Accessible dialog built on `Modal`.
   - Explicit selection cards with Tailwind CSS rich aesthetics.
   - Verification summary and warning indicators.
   - Success screen with direct Reader link and Dashboard link.
4. **Hook Integration (`apps/web/src/lib/studio/use-manga-review-studio.ts`)**:
   - `applyState: ApplyState`
   - `applyError: string | null`
   - `applyResponse: ApplyTranslationJobResponse | null`
   - `applyJob: (mode: ApplyTranslationMode) => Promise<ApplyTranslationJobResponse>`
   - `canApply: boolean`
5. **Page Integration (`apps/web/src/app/(site)/(studio)/studio/ai/jobs/[jobId]/page.tsx`)**:
   - Add "Xuất Bản" button (`btn-open-apply-modal`) to header.
   - Render `ApplyTranslationModal`.

---

## 6. Verification & Test Strategy

### Vitest Unit & Integration Tests:
- `apps/web/src/test/studio-apply-policy.spec.ts`:
  - `canApplyJob`: tests all 6 gates (status, permission, freshness, uncommitted drafts, in-flight mutations).
  - Reader URL resolver: tests both overwrite and alternate modes.
- `apps/web/src/test/apply-translation-modal.spec.tsx`:
  - Renders verification summary (< 100% warning).
  - Mode selection required before submit button activates.
  - Submitting state disables controls and displays spinner.
  - Success state renders correct Reader URL with `?versionId=`.
  - Error state renders server error and retains mode for retry.
  - `COMMITTED_RECONCILIATION_REQUIRED` state displays appropriate recovery guidance.
- `apps/web/src/test/manga-studio-route.spec.tsx`:
  - Verifies "Xuất Bản" button visibility and disabled states.
  - Verifies modal opening and closing.

### Playwright E2E Tests:
- `apps/web/e2e/manga-studio-apply.spec.ts`:
  - Flow 1: Alternate version happy path (`CREATE_ALTERNATE_VERSION`) -> modal opens -> user selects alternate -> submits -> verifies Reader deep link with `?versionId=`.
  - Flow 2: Overwrite version happy path (`OVERWRITE_ACTIVE_VERSION`) -> warning shown -> confirmed -> job transitions to `APPLIED`.

### Backend Integration Tests:
- `services/api/src/modules/translation/test/apply-job-idempotency.spec.ts`:
  - Replay with same key + same mode -> 200 OK (`isAlreadyApplied: true`).
  - Replay with same key + different mode -> 409 `IDEMPOTENCY_CONFLICT`.
  - Permission gate: Translator-only -> 403 `FORBIDDEN`.

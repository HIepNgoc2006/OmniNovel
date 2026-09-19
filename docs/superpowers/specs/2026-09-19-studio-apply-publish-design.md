# Design Document: Translation Job Apply / Publish UI (#152)

- **Date:** 2026-09-19
- **Status:** Approved / Ready for Implementation Plan
- **Issue:** #152 ([Phase 4D][Web] Implement Apply/Publish preview with overwrite vs alternate-version strategies)
- **Parent Tracking:** #143 (Phase 4D AI Translation Studio & Apply Management)
- **Target Audience:** Web Client, Core API, Shared Types

---

## 1. Context & Objectives

Manga Review Studio (#149) is complete and merged through RED 0–6. Reviewers can navigate pages, edit translation segments with OCC, verify segments, and re-materialize fresh artifacts.

The missing link to complete the end-to-end user loop:
$$\text{AI Translation} \longrightarrow \text{Review} \longrightarrow \text{Edit} \longrightarrow \text{Verify} \longrightarrow \text{Re-materialize} \longrightarrow \mathbf{Apply / Publish} \longrightarrow \text{Reader}$$

Issue #152 implements the **Apply / Publish UI**, allowing authorized users (Admin, Story Owner, Story Editor) to publish the reviewed and materialized translation as an authoritative `ChapterVersion`, selecting between two strategies:
1. `OVERWRITE_ACTIVE_VERSION`: Tạo phiên bản mới và đặt làm bản đọc chính thức cho độc giả (cập nhật con trỏ `chapter.activeVersionId`).
2. `CREATE_ALTERNATE_VERSION`: Tạo phiên bản mới song song nhưng giữ nguyên bản đọc mặc định hiện tại.

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
- **Fail-closed Idempotent Replay**: Backend replay must fail-closed if `chapter` or `existingTargetVersion` is missing; it must never return undefined or malformed 200 responses.

### Lock 2: Idempotency Identity `(key, mode)` & Conflict Guard
- Web client freezes `{ idempotencyKey: string, submittedMode: ApplyTranslationMode }` when submission starts.
- Retries on network error or ambiguous timeout **must** reuse the same `idempotencyKey` AND the same `submittedMode`.
- **Mode change rule after ambiguous failure**:
  - After timeout / network ambiguity, `{ idempotencyKey, submittedMode }` remains strictly frozen.
  - User cannot change mode while an ambiguous action remains unverified.
  - Changing mode and generating a new key is **only** permitted after an authoritative GET (`refetchDetail`) proves that the job is still in `READY_FOR_REVIEW` (meaning the prior submission did not commit on the server).
  - If unverified, the UI only allows "Thử lại (Retry same action)" or "Làm mới / Đối chiếu trạng thái".
- **Backend database schema**: Migration 0014 (`1700000000014-AddTranslationJobApplyMode.ts`) adds `apply_mode VARCHAR(50) NULL` to `translation_jobs` with CHECK constraint:
  ```sql
  CONSTRAINT chk_translation_jobs_apply_mode CHECK (apply_mode IS NULL OR apply_mode IN ('OVERWRITE_ACTIVE_VERSION', 'CREATE_ALTERNATE_VERSION'))
  ```
- **Backend idempotency handling**:
  - When `job.status === TranslationJobStatus.APPLIED && job.applyIdempotencyKey === idempotencyKey`:
    - **Legacy compatibility rule**: If `job.applyMode === null` (jobs applied prior to Migration 0014), replay existing result directly (`isAlreadyApplied: true`) without executing a second apply. Do not throw 409.
    - If `job.applyMode !== null && job.applyMode === dto.mode`: Return idempotent replay response (`isAlreadyApplied: true`).
    - If `job.applyMode !== null && job.applyMode !== dto.mode`: Throw HTTP 409 `ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'Yêu cầu xuất bản trùng Idempotency-Key nhưng khác chế độ áp dụng (mode).' })`.

### Lock 3: Authoritative Reconciliation — Single SSoT Lifecycle & Coherence Check
- Web Client must **never** optimistically set `job.status = 'APPLIED'` upon receiving the 200 OK response from `POST /api/v1/ai/jobs/:id/apply`.
- **Single SSoT Lifecycle Owner**: `useMangaReviewStudio` hook is the authoritative owner of `applyLifecycle`:
  ```typescript
  export type ApplyLifecycleState =
    | 'IDLE'
    | 'SUBMITTING'
    | 'SUBMISSION_OUTCOME_UNKNOWN'
    | 'RECONCILING'
    | 'SUCCEEDED'
    | 'COMMITTED_RECONCILIATION_REQUIRED'
    | 'FAILED';
  ```
- **Discriminated Result Contract**:
  ```typescript
  export type ApplyJobResult =
    | {
        outcome: 'SUCCEEDED';
        response: ApplyTranslationJobResponse;
      }
    | {
        outcome: 'COMMITTED_RECONCILIATION_REQUIRED';
        response: ApplyTranslationJobResponse;
        error: ParsedApiError;
      }
    | {
        outcome: 'SUBMISSION_OUTCOME_UNKNOWN';
        error: ParsedApiError;
      }
    | {
        outcome: 'FAILED';
        error: ParsedApiError;
      };
  ```
- **Semantics of Failure & Ambiguity**:
  - Authoritative rejection (HTTP 400, 403, 409, 422, 500 with payload) $\to$ `FAILED`.
  - Network disconnection / timeout prior to receiving response $\to$ `SUBMISSION_OUTCOME_UNKNOWN`. Frozen identity `{key, mode}` preserved; allows retry or reconcile.
  - POST 200 OK received $\to$ `RECONCILING`.
  - POST 200 OK received but subsequent `refetchDetail` fails or coherence check fails $\to$ `COMMITTED_RECONCILIATION_REQUIRED`.
  - Coherence verified $\to$ `SUCCEEDED`, workspace switches to `APPLIED` (read-only).
- **Coherence Check**: Server authoritative detail must satisfy:
  ```typescript
  refreshedDetail.job.status === TranslationJobStatus.APPLIED &&
  refreshedDetail.context.targetVersion?.id === response.targetVersionId &&
  refreshedDetail.job.workspaceRevision >= previousWorkspaceRevision
  ```

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
  - Title: *"Tạo phiên bản mới và đặt làm bản đọc chính"*
  - Badge: Amber warning *"Thay thế bản đọc mặc định hiện tại của độc giả ngay lập tức."*
- Mode 2: `CREATE_ALTERNATE_VERSION`
  - Title: *"Tạo bản dịch phụ (Alternate Version)"*
  - Badge: Cyan info *"Tạo phiên bản mới song song, giữ nguyên bản đọc mặc định."*
- If `verifiedCount < segmentCount`:
  - Prominent warning banner: *"Còn {unverifiedCount} phân đoạn chưa được đánh dấu đã duyệt thủ công. Bạn vẫn muốn xuất bản?"*
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
|  Presentation State: isOpen, selectedMode                               |
|  Consumes studio.applyLifecycle SSoT from hook                          |
|                                                                         |
|  [Verification Summary Card]                                            |
|   Verified X / Y segments (Z%)                                          |
|   Warning: "Còn K phân đoạn chưa duyệt thủ công..."                     |
|                                                                         |
|  [Strategy Cards]                                                       |
|   [O] OVERWRITE_ACTIVE_VERSION (Tạo bản mới & đặt làm bản chính)        |
|   [O] CREATE_ALTERNATE_VERSION (Tạo bản dịch phụ song song)             |
|                                                                         |
|  [Action Buttons]                                                       |
|   [Hủy / Đóng]               [Xác Nhận Xuất Bản (Disabled if !mode)]   |
+-------------------------------------------------------------------------+
                                 |
                                 | calls studio.applyJob(mode)
                                 v
+-------------------------------------------------------------------------+
| useMangaReviewStudio (apps/web/src/lib/studio/use-manga-review-studio)  |
|                                                                         |
|  Lifecycle Owner: IDLE -> SUBMITTING -> RECONCILING -> SUCCEEDED        |
|                        \-> SUBMISSION_OUTCOME_UNKNOWN                   |
|                        \-> COMMITTED_RECONCILIATION_REQUIRED            |
|                        \-> FAILED                                       |
|  - Freezes (idempotencyKey, submittedMode)                              |
|  - Calls POST /api/v1/ai/jobs/:id/apply                                 |
|  - Upon 200 OK: calls refetchDetail({ requirement:                      |
|                       'AUTHORITATIVE_REQUIRED' })                       |
|  - Verifies Coherence: status===APPLIED && targetVersion.id matches     |
|  - Returns discriminated ApplyJobResult                                 |
+-------------------------------------------------------------------------+
```

---

## 4. Backend Implementation Plan

1. **Migration 0014**:
   - File: `services/api/src/database/migrations/1700000000014-AddTranslationJobApplyMode.ts`
   - SQL:
     ```sql
     ALTER TABLE translation_jobs
     ADD COLUMN apply_mode VARCHAR(50) NULL;

     ALTER TABLE translation_jobs
     ADD CONSTRAINT chk_translation_jobs_apply_mode
     CHECK (apply_mode IS NULL OR apply_mode IN ('OVERWRITE_ACTIVE_VERSION', 'CREATE_ALTERNATE_VERSION'));
     ```
2. **Entity & DTO Parity**:
   - `TranslationJob.applyMode: ApplyTranslationMode | null` in `translation-job.entity.ts`.
   - Update `ApplyTranslationJobDto` to import `ApplyTranslationMode` from `@omninovel/shared`.
3. **Controller & Service Updates**:
   - Refactor permission checking in `translation.service.ts`:
     - Helper: `resolveStoryAccess(storyId: string, user: any, manager?: EntityManager): Promise<StoryAccessResolution>`.
     - Returns `{ canReview: boolean; canApply: boolean; effectiveRole: 'ADMIN' | StoryMemberRole }`.
     - Passes transaction `manager` when called within `dataSource.transaction('REPEATABLE READ', ...)` to preserve snapshot isolation.
     - Single query to `story_members` (or bypass for ADMIN), used for both workspace authorization and projecting:
       ```typescript
       permissions: {
         canApply: access.canApply,
         applyBlockReason: access.canApply ? undefined : 'INSUFFICIENT_ROLE',
       }
       ```
   - `applyJob()` in `translation.service.ts`:
     - Maintain independent server-side guard `['OWNER', 'EDITOR']` / Admin.
     - Check `job.applyIdempotencyKey === idempotencyKey`:
       - If `job.applyMode === null`: Replay existing result (`isAlreadyApplied: true`), fail-closed on missing chapter/targetVersion, always include `targetVersionId: job.targetVersionId`.
       - If `job.applyMode !== null && job.applyMode === dto.mode`: Replay existing result (`isAlreadyApplied: true`), include `targetVersionId: job.targetVersionId`.
       - If `job.applyMode !== null && job.applyMode !== dto.mode`: Throw 409 `IDEMPOTENCY_CONFLICT`.
     - In transaction: save `apply_mode = dto.mode` in **BOTH** SQL update paths (with and without `resultManifest`).

---

## 5. Frontend Implementation Plan

1. **Shared Types (`packages/shared/src/index.ts`)**:
   - `ApplyTranslationMode`
   - `ApplyTranslationJobRequest`
   - `ApplyTranslationJobResponse`
   - `TranslationJobReviewDetailResponse.permissions` (required)
2. **Fixture Migration**:
   - Update existing test fixtures in `apps/web` (`manga-studio-foundation.spec.tsx`, `manga-studio-page-navigator.spec.tsx`, `manga-studio-route.spec.tsx`, `manga-studio-materialization.spec.tsx`, `manga-studio-realtime-cleanup.spec.tsx`, and E2E mock routes) to include `permissions: { canApply: true }`.
3. **Pure Policy (`apps/web/src/lib/studio/studio-apply-policy.ts`)**:
   - `canApplyJob(params: CanApplyJobParams): boolean`
   - `resolveApplyBlockReason(params): string | null`
   - `resolvePostApplyReaderUrl(storySlug: string, response: ApplyTranslationJobResponse): string`
   - `classifyApplyError(error: unknown): ParsedApiError`
4. **Modal Component (`apps/web/src/components/studio/apply-translation-modal.tsx`)**:
   - Accessible dialog built on `Modal`.
   - Explicit selection cards with Tailwind CSS rich aesthetics.
   - Verification summary and warning indicators: *"Còn {unverifiedCount} phân đoạn chưa được đánh dấu đã duyệt thủ công..."*
   - Success screen with direct Reader link (`?versionId=...`) and Dashboard link.
5. **Hook Integration (`apps/web/src/lib/studio/use-manga-review-studio.ts`)**:
   - Single SSoT lifecycle state: `applyLifecycle: ApplyLifecycleState`
   - `applyError: ParsedApiError | null`
   - `applyResponse: ApplyTranslationJobResponse | null`
   - `applyJob: (mode: ApplyTranslationMode) => Promise<ApplyJobResult>`
   - `canApply: boolean`
   - `frozenSubmission: { idempotencyKey: string; submittedMode: ApplyTranslationMode } | null`
6. **Page Integration (`apps/web/src/app/(site)/(studio)/studio/ai/jobs/[jobId]/page.tsx`)**:
   - Add "Xuất Bản" button (`btn-open-apply-modal`) to header.
   - Render `ApplyTranslationModal`.

---

## 6. Verification & Test Strategy

### Vitest Unit & Integration Tests:
- `apps/web/src/test/studio-apply-policy.spec.ts`:
  - `canApplyJob`: tests all 6 gates (status, permission, freshness, uncommitted drafts, in-flight mutations).
  - Reader URL resolver: tests both overwrite and alternate modes with `?versionId=`.
  - Error classifier: parses 400, 403, 409, 500 into `ParsedApiError`.
- `apps/web/src/test/apply-translation-modal.spec.tsx`:
  - Verification summary displays "< 100% manual review" warning correctly.
  - Mode selection required before submit button activates.
  - Submitting state disables controls and displays spinner.
  - Success state renders correct Reader URL with `?versionId=`.
  - Case 1: Post commit succeeded on server, but authoritative refetch fails $\to$ transitions to `COMMITTED_RECONCILIATION_REQUIRED` without claiming failure.
  - Case 2: Timeout / network error, retry with same key + same mode $\to$ allowed and preserves frozen identity.
  - Case 3: Timeout / network error, user attempts to change mode $\to$ client fence blocks mode change until authoritative reconciliation proves job is still `READY_FOR_REVIEW`.
- `apps/web/src/test/manga-studio-route.spec.tsx`:
  - Verifies "Xuất Bản" button visibility and disabled states.
  - Verifies modal opening and closing.

### Backend Integration & E2E Tests:
- `services/api/test/apply-job-idempotency.e2e-spec.ts` (Placed in `test/` running in E2E phase after DB migrations):
  - Case 4: Legacy job with `apply_idempotency_key` and `apply_mode = NULL` replayed $\to$ returns existing version without error or second version.
  - Replay with same key + same mode $\to$ 200 OK (`isAlreadyApplied: true`, contains `targetVersionId`, fail-closed non-null assertions).
  - Replay with same key + different mode $\to$ 409 `IDEMPOTENCY_CONFLICT`.
  - Case 5: `getJob()` returns `canApply: true` for ADMIN/OWNER/EDITOR, `canApply: false` with `applyBlockReason: 'INSUFFICIENT_ROLE'` for TRANSLATOR, and 403 for non-members.
  - Permission gate on `POST /apply`: Translator-only $\to$ 403 `FORBIDDEN`.

### Playwright E2E Tests (`apps/web/e2e/manga-studio-apply.spec.ts`):
- Flow 1: Alternate version happy path (`CREATE_ALTERNATE_VERSION`) $\to$ modal opens $\to$ user selects alternate $\to$ submits $\to$ verifies Reader deep link with `?versionId=`.
- Flow 2: Overwrite version happy path (`OVERWRITE_ACTIVE_VERSION`) $\to$ warning shown $\to$ confirmed $\to$ job transitions to `APPLIED`.

# Translation Job Apply / Publish UI (#152) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the end-to-end Apply / Publish UI for Translation Jobs (#152), allowing authorized reviewers to publish reviewed Manga translations as authoritative chapter versions with two explicit strategies (`OVERWRITE_ACTIVE_VERSION` and `CREATE_ALTERNATE_VERSION`), backed by server-driven permission gating, global draft fences, strict idempotency locking, and authoritative post-apply reconciliation.

**Architecture:** Contract-first in `@omninovel/shared`, followed by backend migration and idempotency/permission projection in `services/api` (tested via E2E after migrations), pure policies and SSoT hook lifecycle orchestration in `apps/web` with `SUBMISSION_OUTCOME_UNKNOWN` ambiguity handling, and a decoupled `ApplyTranslationModal` reusable for both Manga and Novel studios.

**Tech Stack:** TypeScript, Next.js 16 (App Router), React 19, NestJS 10, TypeORM, PostgreSQL, Tailwind CSS, Vitest, Playwright.

## Global Constraints
- Target Issue: #152 ([Phase 4D][Web] Implement Apply/Publish preview with overwrite vs alternate-version strategies)
- Do not mutate client state optimistically; `useMangaReviewStudio` relies on `refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' })` to confirm `status === 'APPLIED'`.
- All reader deep-links must format as: `/stories/${story.slug}/read/${chapterId}?versionId=${targetVersionId}`.
- Global draft presence fence: `hasUncommittedDrafts = Object.keys(drafts).length > 0`.
- Idempotency identity freezes `{ idempotencyKey: string, submittedMode: ApplyTranslationMode }`. Mode change requires verified `READY_FOR_REVIEW` state.
- Single SSoT lifecycle owner in hook: `applyLifecycle` (`IDLE`, `SUBMITTING`, `SUBMISSION_OUTCOME_UNKNOWN`, `RECONCILING`, `SUCCEEDED`, `COMMITTED_RECONCILIATION_REQUIRED`, `FAILED`).
- Network drop / timeout prior to receiving HTTP response MUST NOT be treated as `FAILED`; it maps to `SUBMISSION_OUTCOME_UNKNOWN`.
- Backend DB tests must live in `services/api/test/apply-job-idempotency.e2e-spec.ts` (run after migrations in CI pipeline).
- All commands must use canonical `npm --prefix <path>` syntax.

---

### Task 1: Canonical Shared Contracts & Web Fixture Migration

**Files:**
- Modify: `packages/shared/src/index.ts:350-420`
- Modify: Existing web test fixtures across `apps/web/src/test/` to include `permissions: { canApply: true }`:
  - `apps/web/src/test/manga-studio-foundation.spec.tsx`
  - `apps/web/src/test/manga-studio-page-navigator.spec.tsx`
  - `apps/web/src/test/manga-studio-route.spec.tsx`
  - `apps/web/src/test/manga-studio-materialization.spec.tsx`
  - `apps/web/src/test/manga-studio-realtime-cleanup.spec.tsx`
  - `apps/web/src/test/manga-studio-verification.spec.tsx`
  - `apps/web/e2e/manga-studio-*.ts` mocks

**Interfaces:**
- Consumes: `TranslationJobStatus`, `ChapterVersionType`, `ReviewSummaryDto` from `@omninovel/shared`.
- Produces:
  - `ApplyTranslationMode`: `'OVERWRITE_ACTIVE_VERSION' | 'CREATE_ALTERNATE_VERSION'`
  - `ApplyTranslationJobRequest`: `{ mode: ApplyTranslationMode }`
  - `ApplyTranslationJobResponse`: `{ chapterId: string, activeVersionId: string | null, targetVersionId: string, versionNumber: number, versionType: ChapterVersionType, isAlreadyApplied: boolean }`
  - `TranslationJobReviewDetailResponse.permissions`: `{ canApply: boolean, applyBlockReason?: 'INSUFFICIENT_ROLE' }` (required field).

- [x] **Step 1: Write/Update shared types in `packages/shared/src/index.ts`**

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

// In TranslationJobReviewDetailResponse:
export interface TranslationJobReviewDetailResponse {
  job: { ... };
  context: { ... };
  reviewSummary: ReviewSummaryDto;
  permissions: {
    canApply: boolean;
    applyBlockReason?: 'INSUFFICIENT_ROLE';
  };
  glossarySnapshot?: ...;
  error?: ...;
}
```

- [x] **Step 2: Build `@omninovel/shared`**

Run: `npm --prefix packages/shared run build`
Expected: PASS with 0 errors.

- [x] **Step 3: Update existing test fixtures in `apps/web`**

Add `permissions: { canApply: true }` to default mock job detail responses in `manga-studio-foundation.spec.tsx`, `manga-studio-page-navigator.spec.tsx`, `manga-studio-route.spec.tsx`, `manga-studio-materialization.spec.tsx`, `manga-studio-realtime-cleanup.spec.tsx`, and `manga-studio-verification.spec.tsx`.

- [x] **Step 4: Verify typecheck passes across monorepo**

Run: `npm --prefix apps/web run typecheck`
Expected: PASS with 0 TypeScript errors.

- [x] **Step 5: Commit Task 1**

```bash
git add packages/shared/src/index.ts apps/web/src/test/
git commit -m "feat(shared): add canonical apply types and review detail permissions with fixture migration (#152)"
```

---

### Task 2: Backend Migration 0014, Entity, Idempotency & Permission Projection

**Files:**
- Create: `services/api/src/database/migrations/1700000000014-AddTranslationJobApplyMode.ts`
- Modify: `services/api/src/modules/translation/entities/translation-job.entity.ts:65-75`
- Modify: `services/api/src/modules/translation/dto/apply-translation-job.dto.ts:1-23`
- Modify: `services/api/src/modules/translation/translation.service.ts:600-750, 1615-1875`
- Create: `services/api/test/apply-job-idempotency.e2e-spec.ts`

**Interfaces:**
- Consumes: `ApplyTranslationMode`, `ApplyTranslationJobResponse`, `TranslationJobReviewDetailResponse` from `@omninovel/shared`.
- Produces:
  - `Migration 1700000000014`: adds `apply_mode VARCHAR(50) NULL` with CHECK constraint.
  - `resolveStoryAccess(storyId, user, manager)`: returns `{ canReview: boolean, canApply: boolean, effectiveRole: string }` within transaction snapshot.
  - `GET /api/v1/ai/jobs/:id`: returns `permissions: { canApply: boolean, applyBlockReason?: 'INSUFFICIENT_ROLE' }`.
  - `POST /api/v1/ai/jobs/:id/apply`: enforces same-key same-mode replay (or legacy `apply_mode IS NULL`), 409 on mode mismatch, always returns non-null `targetVersionId`, updates `apply_mode` in both SQL paths.

- [x] **Step 1: Write failing backend E2E integration test**

In `services/api/test/apply-job-idempotency.e2e-spec.ts`:
- Test 1: Replay with same key + same mode returns 200 OK (`isAlreadyApplied: true`, strictly non-null `targetVersionId`, `chapterId`, `versionNumber`).
- Test 2: Replay with same key + different mode throws 409 `IDEMPOTENCY_CONFLICT`.
- Test 3: Legacy job with `apply_idempotency_key` and `apply_mode = null` returns `isAlreadyApplied: true` without 409.
- Test 4: `getJob()` returns `canApply: true` for ADMIN/OWNER/EDITOR, and `canApply: false, applyBlockReason: 'INSUFFICIENT_ROLE'` for TRANSLATOR.
- Test 5: `applyJob()` throws 403 `FORBIDDEN` for TRANSLATOR.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --prefix services/api run test:e2e -- apply-job-idempotency.e2e-spec.ts`
Expected: FAIL (missing `apply_mode` column / methods).

- [x] **Step 3: Implement Migration 0014, Entity update, and Service refactoring**

1. Create migration `services/api/src/database/migrations/1700000000014-AddTranslationJobApplyMode.ts`:
```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTranslationJobApplyMode1700000000014 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE translation_jobs
      ADD COLUMN apply_mode VARCHAR(50) NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE translation_jobs
      ADD CONSTRAINT chk_translation_jobs_apply_mode
      CHECK (apply_mode IS NULL OR apply_mode IN ('OVERWRITE_ACTIVE_VERSION', 'CREATE_ALTERNATE_VERSION'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE translation_jobs
      DROP CONSTRAINT IF EXISTS chk_translation_jobs_apply_mode;
    `);
    await queryRunner.query(`
      ALTER TABLE translation_jobs
      DROP COLUMN IF EXISTS apply_mode;
    `);
  }
}
```

2. Update `translation-job.entity.ts`:
```typescript
import { ApplyTranslationMode } from '@omninovel/shared';

@Column({ name: 'apply_mode', type: 'varchar', length: 50, nullable: true })
applyMode: ApplyTranslationMode | null;
```

3. Update `ApplyTranslationJobDto`:
Import `ApplyTranslationMode` from `@omninovel/shared`.

4. In `translation.service.ts`:
Implement `resolveStoryAccess`:
```typescript
export interface StoryAccessResolution {
  canReview: boolean;
  canApply: boolean;
  effectiveRole: 'ADMIN' | StoryMemberRole;
}

private async resolveStoryAccess(
  storyId: string,
  user: any,
  manager?: EntityManager,
): Promise<StoryAccessResolution> {
  if (user.role === 'ADMIN') {
    return { canReview: true, canApply: true, effectiveRole: 'ADMIN' };
  }
  const repo = manager ? manager.getRepository(StoryMember) : this.storyMemberRepo;
  const membership = await repo.findOne({
    where: { storyId, userId: user.id },
  });
  if (!membership || !['OWNER', 'EDITOR', 'TRANSLATOR'].includes(membership.role)) {
    throw new ForbiddenException('Bạn không có quyền truy cập tác phẩm này.');
  }
  const canApply = ['OWNER', 'EDITOR'].includes(membership.role);
  return {
    canReview: true,
    canApply,
    effectiveRole: membership.role as StoryMemberRole,
  };
}
```

5. In `getJob()`, call `const access = await this.resolveStoryAccess(story.id, user, manager);` and project `permissions: { canApply: access.canApply, applyBlockReason: access.canApply ? undefined : 'INSUFFICIENT_ROLE' }`.

6. In `applyJob()`:
- Check `job.applyIdempotencyKey === idempotencyKey`:
  - If `job.applyMode !== null && job.applyMode !== dto.mode`: throw 409 `IDEMPOTENCY_CONFLICT`.
  - Replay response fail-closed:
    ```typescript
    const existingTargetVersion = await manager.findOne(ChapterVersion, {
      where: { id: job.targetVersionId },
    });
    const chapter = await manager.findOne(Chapter, {
      where: { id: job.sourceVersion.chapterId },
    });
    if (!chapter || !existingTargetVersion || !job.targetVersionId) {
      throw new InternalServerErrorException(
        'Dữ liệu Chapter hoặc TargetVersion không tồn tại cho TranslationJob đã áp dụng.',
      );
    }
    return {
      chapterId: chapter.id,
      activeVersionId: chapter.activeVersionId,
      targetVersionId: job.targetVersionId,
      versionNumber: existingTargetVersion.versionNumber,
      versionType: existingTargetVersion.versionType,
      isAlreadyApplied: true,
    };
    ```
- In BOTH SQL update paths (with `resultManifest` around L1834 and without `resultManifest` around L1864):
  `SET target_version_id = $2, status = 'APPLIED', apply_idempotency_key = $3, apply_mode = $4, completed_at = NOW(), workspace_revision = workspace_revision + 1`

- [x] **Step 4: Run migration and E2E test to verify it passes**

Run:
```powershell
npm --prefix services/api run migration:run
npm --prefix services/api run test:e2e -- apply-job-idempotency.e2e-spec.ts
```
Expected: PASS (all tests green).

- [x] **Step 5: Commit Task 2**

```bash
git add services/api/src/database/migrations/1700000000014-AddTranslationJobApplyMode.ts \
        services/api/src/modules/translation/entities/translation-job.entity.ts \
        services/api/src/modules/translation/dto/apply-translation-job.dto.ts \
        services/api/src/modules/translation/translation.service.ts \
        services/api/test/apply-job-idempotency.e2e-spec.ts
git commit -m "feat(api): add migration 0014 apply_mode, idempotency conflict guard and permission projection (#152)"
```

---

### Task 3: Pure Policy & Client Error Classifier in Web

**Files:**
- Create: `apps/web/src/lib/studio/studio-apply-policy.ts`
- Test: `apps/web/src/test/studio-apply-policy.spec.ts`

**Interfaces:**
- Consumes: `ApplyTranslationMode`, `ApplyTranslationJobResponse`, `TranslationJobStatus` from `@omninovel/shared`.
- Produces:
  - `CanApplyJobParams`: `{ jobStatus, canApplyPermission, freshnessStatus, hasUncommittedDrafts, applyInFlight, materializationInFlight }`
  - `canApplyJob(params)`: boolean
  - `resolveApplyBlockReason(params)`: string | null
  - `resolvePostApplyReaderUrl(storySlug, response)`: string
  - `classifyApplyError(error: unknown)`: `ParsedApiError`
  - `ApplyLifecycleState`: `'IDLE' | 'SUBMITTING' | 'SUBMISSION_OUTCOME_UNKNOWN' | 'RECONCILING' | 'SUCCEEDED' | 'COMMITTED_RECONCILIATION_REQUIRED' | 'FAILED'`
  - `ApplyJobResult`: discriminated union (`SUCCEEDED`, `COMMITTED_RECONCILIATION_REQUIRED`, `SUBMISSION_OUTCOME_UNKNOWN`, `FAILED`)

- [x] **Step 1: Write failing policy tests in `apps/web/src/test/studio-apply-policy.spec.ts`**

Test scenarios:
- `canApplyJob` returns false if `jobStatus !== READY_FOR_REVIEW`.
- `canApplyJob` returns false if `canApplyPermission === false`.
- `canApplyJob` returns false if `freshnessStatus !== 'FRESH'`.
- `canApplyJob` returns false if `hasUncommittedDrafts === true` (global draft fence).
- `canApplyJob` returns false if `applyInFlight === true` or `materializationInFlight === true`.
- `canApplyJob` returns true only when all 6 conditions are satisfied.
- `resolvePostApplyReaderUrl` formats `/stories/${slug}/read/${chapterId}?versionId=${targetVersionId}` for both `OVERWRITE_ACTIVE_VERSION` and `CREATE_ALTERNATE_VERSION`.
- `classifyApplyError` extracts 400, 403, 409 (`IDEMPOTENCY_CONFLICT`), 409 (`ARTIFACT_STALE`), 422 into structured `ParsedApiError` with non-ambiguous status.
- HTTP 5xx classification hardening: HTTP 5xx errors from POST apply are classified as ambiguous (`isAmbiguous: true`, mapping to `SUBMISSION_OUTCOME_UNKNOWN`), retaining frozen `{ idempotencyKey, mode }` for retry since transaction might have committed prior to 5xx response.
- Network timeout classifier detects timeout/network error and flags ambiguity (`isAmbiguous: true`).

- [x] **Step 2: Run test to verify it fails**

Run: `npm --prefix apps/web test -- src/test/studio-apply-policy.spec.ts`
Expected: FAIL (module not found).

- [x] **Step 3: Implement `apps/web/src/lib/studio/studio-apply-policy.ts`**

Implement all pure policy functions without external DOM or React dependencies.

- [x] **Step 4: Run test to verify it passes**

Run: `npm --prefix apps/web test -- src/test/studio-apply-policy.spec.ts`
Expected: PASS.

- [x] **Step 5: Commit Task 3**

```bash
git add apps/web/src/lib/studio/studio-apply-policy.ts apps/web/src/test/studio-apply-policy.spec.ts
git commit -m "feat(web): implement studio apply pure policy, lifecycle types, and error classifier (#152)"
```

---

### Task 4: Hook Orchestration in `useMangaReviewStudio` (Lifecycle SSoT & Coherence)

**Files:**
- Modify: `apps/web/src/lib/studio/use-manga-review-studio.ts`
- Modify: `apps/web/src/lib/api/translation.ts`
- Test: `apps/web/src/test/manga-studio-apply-hook.spec.tsx`

**Interfaces:**
- Consumes: `studio-apply-policy.ts`, `ApplyTranslationJobRequest`, `ApplyTranslationJobResponse`.
- Produces:
  - `applyTranslationJob(jobId, request, idempotencyKey)` in `apps/web/src/lib/api/translation.ts`.
  - In `useMangaReviewStudio`:
    - `applyLifecycle`: `ApplyLifecycleState`
    - `applyError`: `ParsedApiError | null`
    - `applyResponse`: `ApplyTranslationJobResponse | null`
    - `canApply`: boolean
    - `applyJob(mode: ApplyTranslationMode)`: `Promise<ApplyJobResult>`
    - `retryApplyAction()`: `Promise<ApplyJobResult>`
    - `reconcileAfterCommitted()`: `Promise<boolean>`
    - `resetApplyAction()`: boolean (resets frozen state ONLY if authoritative GET proves `READY_FOR_REVIEW`)

- [x] **Step 1: Write failing hook tests in `apps/web/src/test/manga-studio-apply-hook.spec.tsx`**

Test scenarios:
- Happy path: POST 200 -> RECONCILING -> refetchDetail confirms APPLIED + targetVersionId matches + `workspaceRevision > previousWorkspaceRevision` -> outcome `SUCCEEDED`.
- Network drop / timeout during POST -> outcome `SUBMISSION_OUTCOME_UNKNOWN` (NOT FAILED), retains frozen submission for retry.
- HTTP 5xx during POST -> outcome `SUBMISSION_OUTCOME_UNKNOWN` (ambiguous, retains frozen key & mode), NOT FAILED.
- Post succeeds on server but refetchDetail fails -> outcome `COMMITTED_RECONCILIATION_REQUIRED`, does not claim failure.
- Coherence failure (targetVersionId mismatch): refetchDetail returns APPLIED but targetVersionId does not match -> outcome `COMMITTED_RECONCILIATION_REQUIRED`.
- Coherence failure (revision monotonic bump): refetchDetail returns APPLIED but `workspaceRevision <= previousWorkspaceRevision` -> coherence violation mapping to `COMMITTED_RECONCILIATION_REQUIRED` (since backend Apply contract always bumps revision + 1).
- Frozen submission enforcement: retry uses exact same key and mode. Resetting requires authoritative GET showing `READY_FOR_REVIEW`.
- `canApply` respects `drafts` presence across all segments.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --prefix apps/web test -- src/test/manga-studio-apply-hook.spec.tsx`
Expected: FAIL.

- [x] **Step 3: Implement API client call & hook orchestration**

1. Add `applyTranslationJob` in `apps/web/src/lib/api/translation.ts`.
2. Add single SSoT lifecycle states and methods in `useMangaReviewStudio.ts`.
3. Enforce coherence validation and freeze guards.

- [x] **Step 4: Run test to verify it passes**

Run: `npm --prefix apps/web test -- src/test/manga-studio-apply-hook.spec.tsx`
Expected: PASS.

- [x] **Step 5: Commit Task 4**

```bash
git add apps/web/src/lib/api/translation.ts \
        apps/web/src/lib/studio/use-manga-review-studio.ts \
        apps/web/src/test/manga-studio-apply-hook.spec.tsx
git commit -m "feat(web): orchestrate apply lifecycle SSoT and authoritative reconciliation in studio hook (#152)"
```

---

### Task 5: Reusable UI Component `ApplyTranslationModal`

**Files:**
- Create: `apps/web/src/components/studio/apply-translation-modal.tsx`
- Test: `apps/web/src/test/apply-translation-modal.spec.tsx`

**Interfaces:**
- Consumes: `Modal`, `ApplyTranslationMode`, `ApplyJobResult`, `ApplyLifecycleState`.
- Produces: `ApplyTranslationModal` component.

- [x] **Step 1: Write failing component tests in `apps/web/src/test/apply-translation-modal.spec.tsx`**

Test scenarios:
- Renders verification summary (< 100% warning: *"Còn {unverifiedCount} phân đoạn chưa được đánh dấu đã duyệt thủ công. Bạn vẫn muốn xuất bản?"*).
- Submit button disabled until user explicitly clicks one mode card.
- `OVERWRITE_ACTIVE_VERSION` card displays *"Tạo phiên bản mới và đặt làm bản đọc chính"* with amber warning.
- `CREATE_ALTERNATE_VERSION` card displays *"Tạo bản dịch phụ (Alternate Version)"* with cyan badge.
- Submitting state disables controls and displays spinner.
- Success state displays version information, button "Đọc chương này ngay" with `?versionId=`, button "Về Studio Dashboard", and button "Ở lại Studio".
- `COMMITTED_RECONCILIATION_REQUIRED` displays recovery message and "Làm mới / Đối chiếu lại" button.
- `SUBMISSION_OUTCOME_UNKNOWN` displays ambiguity notice ("Mất kết nối trong lúc gửi yêu cầu...") and "Thử lại (Retry same action)" button.
- Error state displays classified error and "Thử lại (Retry)" button.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --prefix apps/web test -- src/test/apply-translation-modal.spec.tsx`
Expected: FAIL.

- [x] **Step 3: Implement `apps/web/src/components/studio/apply-translation-modal.tsx`**

Implement the modal presentation following OmniNovel design standards, using Lucide icons (`Sparkles`, `CheckCircle2`, `AlertTriangle`, `Send`, `RefreshCw`, `BookOpen`, `ExternalLink`).

- [x] **Step 4: Run test to verify it passes**

Run: `npm --prefix apps/web test -- src/test/apply-translation-modal.spec.tsx`
Expected: PASS.

- [x] **Step 5: Commit Task 5**

```bash
git add apps/web/src/components/studio/apply-translation-modal.tsx apps/web/src/test/apply-translation-modal.spec.tsx
git commit -m "feat(web): implement reusable ApplyTranslationModal component (#152)"
```

---

### Task 6: Page Route Integration & Header Action Button

**Files:**
- Modify: `apps/web/src/app/(site)/(studio)/studio/ai/jobs/[jobId]/page.tsx:750-840`
- Modify: `apps/web/src/test/manga-studio-route.spec.tsx`

**Interfaces:**
- Consumes: `ApplyTranslationModal`, `useMangaReviewStudio.canApply`.
- Produces:
  - Header button: `btn-open-apply-modal` ("Xuất Bản").
  - Modal container rendering.

- [x] **Step 1: Write failing route test in `apps/web/src/test/manga-studio-route.spec.tsx`**

Test scenarios:
- Nút "Xuất Bản" renders in header next to "Kết Xuất".
- Disabled when `canApply === false`, tooltip shows block reason.
- Enabled when `canApply === true`. Clicking opens `ApplyTranslationModal`.
- Closing modal updates state.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --prefix apps/web test -- src/test/manga-studio-route.spec.tsx`
Expected: FAIL.

- [x] **Step 3: Implement route header button & modal binding in `page.tsx`**

- [x] **Step 4: Run test to verify it passes**

Run: `npm --prefix apps/web test -- src/test/manga-studio-route.spec.tsx`
Expected: PASS.

- [x] **Step 5: Commit Task 6**

```bash
git add apps/web/src/app/\(site\)/\(studio\)/studio/ai/jobs/\[jobId\]/page.tsx apps/web/src/test/manga-studio-route.spec.tsx
git commit -m "feat(web): integrate Apply CTA and modal into Manga Review Studio route (#152)"
```

---

### Task 7: Playwright E2E Tests & Monorepo Verification

**Files:**
- Create: `apps/web/e2e/manga-studio-apply.spec.ts`

- [x] **Step 1: Write Playwright E2E spec covering both flows**

- Flow 1: Alternate version happy path (`CREATE_ALTERNATE_VERSION`) -> modal opens -> user selects alternate -> submits -> verifies Reader deep link contains `?versionId=`.
- Flow 2: Overwrite version happy path (`OVERWRITE_ACTIVE_VERSION`) -> warning shown -> confirmed -> job transitions to `APPLIED`.

- [x] **Step 2: Run Playwright E2E tests**

Run: `npm --prefix apps/web run test:e2e -- manga-studio-apply.spec.ts`
Expected: PASS.

- [x] **Step 3: Full Monorepo Quality Gate Verification (Mirror CI)**

Run:
1. `npm --prefix packages/shared run build`
2. `npm --prefix services/api test` (Unit tests)
3. `npm --prefix services/api run migration:run`
4. `npm --prefix services/api run test:e2e -- apply-job-idempotency.e2e-spec.ts`
5. `npm --prefix apps/web run lint`
6. `npm --prefix apps/web run typecheck`
7. `npm --prefix apps/web test` (Vitest suites)
8. `npm --prefix apps/web run build` (Next.js production build)
9. `npm --prefix apps/web run test:e2e` (Playwright smoke suite)
Expected: All suites green, 0 errors.

- [x] **Step 4: Commit Task 7 & Update Roadmap Tracking**

```bash
git add apps/web/e2e/manga-studio-apply.spec.ts plans/phases/phase_04_web_client.md plans/README.md
git commit -m "test(web): add E2E tests for Manga Studio Apply/Publish flow (#152)"
```

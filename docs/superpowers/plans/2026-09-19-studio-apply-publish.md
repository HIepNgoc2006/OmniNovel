# Translation Job Apply / Publish UI (#152) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the end-to-end Apply / Publish UI for Translation Jobs (#152), allowing authorized reviewers to publish reviewed Manga translations as authoritative chapter versions with two explicit strategies (`OVERWRITE_ACTIVE_VERSION` and `CREATE_ALTERNATE_VERSION`), backed by server-driven permission gating, global draft fences, strict idempotency locking, and authoritative post-apply reconciliation.

**Architecture:** Contract-first in `@omninovel/shared`, followed by backend migration and idempotency/permission projection in `services/api`, pure policies and SSoT hook lifecycle orchestration in `apps/web`, and a decoupled `ApplyTranslationModal` reusable for both Manga and Novel studios.

**Tech Stack:** TypeScript, Next.js 16 (App Router), React 19, NestJS 10, TypeORM, PostgreSQL, Tailwind CSS, Vitest, Playwright.

## Global Constraints
- Target Issue: #152 ([Phase 4D][Web] Implement Apply/Publish preview with overwrite vs alternate-version strategies)
- Do not mutate client state optimistically; `useMangaReviewStudio` relies on `refetchDetail({ requirement: 'AUTHORITATIVE_REQUIRED' })` to confirm `status === 'APPLIED'`.
- All reader deep-links must format as: `/stories/${story.slug}/read/${chapterId}?versionId=${targetVersionId}`.
- Global draft presence fence: `hasUncommittedDrafts = Object.keys(drafts).length > 0`.
- Idempotency identity freezes `{ idempotencyKey: string, submittedMode: ApplyTranslationMode }`. Mode change requires verified `READY_FOR_REVIEW` state.
- Single SSoT lifecycle owner in hook: `applyLifecycle` (`IDLE`, `SUBMITTING`, `RECONCILING`, `SUCCEEDED`, `COMMITTED_RECONCILIATION_REQUIRED`, `FAILED`).

---

### Task 1: Canonical Shared Contracts in `@omninovel/shared`

**Files:**
- Modify: `packages/shared/src/index.ts:350-420`
- Test: `packages/shared/src/index.ts` (typecheck & build)

**Interfaces:**
- Consumes: `TranslationJobStatus`, `ChapterVersionType`, `ReviewSummaryDto` from `@omninovel/shared`.
- Produces:
  - `ApplyTranslationMode`: `'OVERWRITE_ACTIVE_VERSION' | 'CREATE_ALTERNATE_VERSION'`
  - `ApplyTranslationJobRequest`: `{ mode: ApplyTranslationMode }`
  - `ApplyTranslationJobResponse`: `{ chapterId: string, activeVersionId: string | null, targetVersionId: string, versionNumber: number, versionType: ChapterVersionType, isAlreadyApplied: boolean }`
  - `TranslationJobReviewDetailResponse.permissions`: `{ canApply: boolean, applyBlockReason?: 'INSUFFICIENT_ROLE' }`

- [ ] **Step 1: Write/Update shared types in `packages/shared/src/index.ts`**

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

- [ ] **Step 2: Build `@omninovel/shared` and verify compilation**

Run: `npm run build --workspace=@omninovel/shared`
Expected: PASS with 0 TypeScript errors.

- [ ] **Step 3: Commit Task 1**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): add canonical apply types and review detail permissions (#152)"
```

---

### Task 2: Backend Migration 0014, Entity, Idempotency & Permission Projection

**Files:**
- Create: `services/api/src/database/migrations/1700000000014-AddTranslationJobApplyMode.ts`
- Modify: `services/api/src/modules/translation/entities/translation-job.entity.ts:65-75`
- Modify: `services/api/src/modules/translation/dto/apply-translation-job.dto.ts:1-23`
- Modify: `services/api/src/modules/translation/translation.service.ts:600-750, 1615-1700`
- Test: `services/api/src/modules/translation/test/apply-job-idempotency.spec.ts`

**Interfaces:**
- Consumes: `ApplyTranslationMode`, `ApplyTranslationJobResponse`, `TranslationJobReviewDetailResponse` from `@omninovel/shared`.
- Produces:
  - `Migration 1700000000014`: adds `apply_mode VARCHAR(50) NULL` with CHECK constraint.
  - `resolveStoryAccess(storyId, user)`: returns `{ canReview: boolean, canApply: boolean, effectiveRole: string }`.
  - `GET /api/v1/ai/jobs/:id`: returns `permissions: { canApply: boolean, applyBlockReason?: 'INSUFFICIENT_ROLE' }`.
  - `POST /api/v1/ai/jobs/:id/apply`: enforces same-key same-mode replay (or legacy `apply_mode IS NULL`), 409 on mode mismatch, always returns `targetVersionId`.

- [ ] **Step 1: Write failing backend integration test**

In `services/api/src/modules/translation/test/apply-job-idempotency.spec.ts`:
- Test 1: Replay with same key + same mode returns `isAlreadyApplied: true` and `targetVersionId`.
- Test 2: Replay with same key + different mode throws 409 `IDEMPOTENCY_CONFLICT`.
- Test 3: Legacy job with `apply_idempotency_key` and `apply_mode = null` returns `isAlreadyApplied: true` without 409.
- Test 4: `getJob()` returns `canApply: true` for ADMIN/OWNER/EDITOR, and `canApply: false, applyBlockReason: 'INSUFFICIENT_ROLE'` for TRANSLATOR.
- Test 5: `applyJob()` throws 403 `FORBIDDEN` for TRANSLATOR.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=services/api -- services/api/src/modules/translation/test/apply-job-idempotency.spec.ts`
Expected: FAIL (missing `apply_mode` column / method signatures).

- [ ] **Step 3: Implement Migration 0014, Entity update, and Service refactoring**

1. Create migration `1700000000014-AddTranslationJobApplyMode.ts`:
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
): Promise<StoryAccessResolution> {
  if (user.role === 'ADMIN') {
    return { canReview: true, canApply: true, effectiveRole: 'ADMIN' };
  }
  const membership = await this.storyMemberRepo.findOne({
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
Update `getJob()` to populate `permissions: { canApply: access.canApply, applyBlockReason: access.canApply ? undefined : 'INSUFFICIENT_ROLE' }`.
Update `applyJob()` idempotency block to check `job.applyMode !== null && job.applyMode !== dto.mode -> 409`, save `apply_mode = dto.mode`, and always return `targetVersionId: job.targetVersionId`.

- [ ] **Step 4: Run integration test to verify it passes**

Run: `npm run test --workspace=services/api -- services/api/src/modules/translation/test/apply-job-idempotency.spec.ts`
Expected: PASS (5/5 tests green).

- [ ] **Step 5: Commit Task 2**

```bash
git add services/api/src/database/migrations/1700000000014-AddTranslationJobApplyMode.ts \
        services/api/src/modules/translation/entities/translation-job.entity.ts \
        services/api/src/modules/translation/dto/apply-translation-job.dto.ts \
        services/api/src/modules/translation/translation.service.ts \
        services/api/src/modules/translation/test/apply-job-idempotency.spec.ts
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

- [ ] **Step 1: Write failing policy tests in `apps/web/src/test/studio-apply-policy.spec.ts`**

Test scenarios:
- `canApplyJob` returns false if `jobStatus !== READY_FOR_REVIEW`.
- `canApplyJob` returns false if `canApplyPermission === false`.
- `canApplyJob` returns false if `freshnessStatus !== 'FRESH'`.
- `canApplyJob` returns false if `hasUncommittedDrafts === true` (global draft fence).
- `canApplyJob` returns false if `applyInFlight === true` or `materializationInFlight === true`.
- `canApplyJob` returns true only when all 6 conditions are satisfied.
- `resolvePostApplyReaderUrl` formats `/stories/${slug}/read/${chapterId}?versionId=${targetVersionId}` for both `OVERWRITE_ACTIVE_VERSION` and `CREATE_ALTERNATE_VERSION`.
- `classifyApplyError` extracts 400, 403, 409 (`IDEMPOTENCY_CONFLICT`), 409 (`ARTIFACT_STALE`), 500 into structured `ParsedApiError`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=apps/web -- apps/web/src/test/studio-apply-policy.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `apps/web/src/lib/studio/studio-apply-policy.ts`**

Implement all pure policy functions without external DOM or React dependencies.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=apps/web -- apps/web/src/test/studio-apply-policy.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add apps/web/src/lib/studio/studio-apply-policy.ts apps/web/src/test/studio-apply-policy.spec.ts
git commit -m "feat(web): implement studio apply pure policy and error classifier (#152)"
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
    - `applyLifecycle`: `'IDLE' | 'SUBMITTING' | 'RECONCILING' | 'SUCCEEDED' | 'COMMITTED_RECONCILIATION_REQUIRED' | 'FAILED'`
    - `applyError`: `ParsedApiError | null`
    - `applyResponse`: `ApplyTranslationJobResponse | null`
    - `canApply`: boolean
    - `applyJob(mode: ApplyTranslationMode)`: `Promise<ApplyJobResult>`
    - `retryApplyAction()`: `Promise<ApplyJobResult>`
    - `reconcileAfterCommitted()`: `Promise<boolean>`
    - `resetApplyState()`: boolean

- [ ] **Step 1: Write failing hook tests in `apps/web/src/test/manga-studio-apply-hook.spec.tsx`**

Test scenarios:
- Happy path: POST 200 -> RECONCILING -> refetchDetail confirms APPLIED -> outcome `SUCCEEDED`.
- Network failure during POST -> outcome `FAILED`, retains frozen submission for retry.
- Post succeeds on server but refetchDetail fails -> outcome `COMMITTED_RECONCILIATION_REQUIRED`, does not claim failure.
- Coherence failure: refetchDetail returns APPLIED but targetVersionId does not match -> outcome `COMMITTED_RECONCILIATION_REQUIRED`.
- Frozen submission enforcement: retry uses exact same key and mode. Resetting requires authoritative GET showing `READY_FOR_REVIEW`.
- `canApply` respects `drafts` presence across all segments.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=apps/web -- apps/web/src/test/manga-studio-apply-hook.spec.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement API client call & hook orchestration**

1. Add `applyTranslationJob` in `apps/web/src/lib/api/translation.ts`.
2. Add single SSoT lifecycle states and methods in `useMangaReviewStudio.ts`.
3. Enforce coherence validation and freeze guards.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=apps/web -- apps/web/src/test/manga-studio-apply-hook.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit Task 4**

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

- [ ] **Step 1: Write failing component tests in `apps/web/src/test/apply-translation-modal.spec.tsx`**

Test scenarios:
- Renders verification summary (< 100% warning: *"Còn {unverifiedCount} phân đoạn chưa được đánh dấu đã duyệt thủ công..."*).
- Submit button disabled until user explicitly clicks one mode card.
- `OVERWRITE_ACTIVE_VERSION` card displays *"Tạo phiên bản mới và đặt làm bản đọc chính"* with amber warning.
- `CREATE_ALTERNATE_VERSION` card displays *"Tạo bản dịch phụ (Alternate Version)"* with cyan badge.
- Submitting state disables controls and displays spinner.
- Success state displays version information, button "Đọc chương này ngay" with `?versionId=`, button "Về Studio Dashboard", and button "Ở lại Studio".
- `COMMITTED_RECONCILIATION_REQUIRED` displays recovery message and "Làm mới / Đối chiếu lại" button.
- Error state displays classified error and "Thử lại (Retry)" button.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=apps/web -- apps/web/src/test/apply-translation-modal.spec.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `apps/web/src/components/studio/apply-translation-modal.tsx`**

Implement the modal presentation following OmniNovel design standards, using Lucide icons (`Sparkles`, `CheckCircle2`, `AlertTriangle`, `Send`, `RefreshCw`, `BookOpen`, `ExternalLink`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=apps/web -- apps/web/src/test/apply-translation-modal.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit Task 5**

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

- [ ] **Step 1: Write failing route test in `apps/web/src/test/manga-studio-route.spec.tsx`**

Test scenarios:
- Nút "Xuất Bản" renders in header next to "Kết Xuất".
- Disabled when `canApply === false`, tooltip shows block reason.
- Enabled when `canApply === true`. Clicking opens `ApplyTranslationModal`.
- Closing modal updates state.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=apps/web -- apps/web/src/test/manga-studio-route.spec.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement Header Action Button & Modal Rendering in `page.tsx`**

Update `page.tsx` with `isApplyModalOpen` state and render `ApplyTranslationModal`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=apps/web -- apps/web/src/test/manga-studio-route.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add apps/web/src/app/\(site\)/\(studio\)/studio/ai/jobs/\[jobId\]/page.tsx apps/web/src/test/manga-studio-route.spec.tsx
git commit -m "feat(web): integrate Apply CTA and modal into Manga Review Studio route (#152)"
```

---

### Task 7: Playwright E2E Tests & Monorepo Verification

**Files:**
- Create: `apps/web/e2e/manga-studio-apply.spec.ts`

- [ ] **Step 1: Write Playwright E2E spec covering both flows**

- Flow 1: Alternate version happy path (`CREATE_ALTERNATE_VERSION`) -> modal opens -> user selects alternate -> submits -> verifies Reader deep link contains `?versionId=`.
- Flow 2: Overwrite version happy path (`OVERWRITE_ACTIVE_VERSION`) -> warning shown -> confirmed -> job transitions to `APPLIED`.

- [ ] **Step 2: Run Playwright E2E tests**

Run: `npx playwright test apps/web/e2e/manga-studio-apply.spec.ts`
Expected: PASS.

- [ ] **Step 3: Full Monorepo Quality Gate Verification**

Run:
1. `npm run typecheck --workspace=apps/web`
2. `npm run test --workspace=apps/web` (all Vitest suites)
3. `npx playwright test` (all Playwright specs)
4. `npm run build --workspace=apps/web`
5. `npm run test --workspace=services/api`
Expected: All suites green, 0 errors.

- [ ] **Step 4: Commit Task 7 & Update Roadmap Tracking**

```bash
git add apps/web/e2e/manga-studio-apply.spec.ts plans/phases/phase_04_web_client.md plans/README.md
git commit -m "test(web): add E2E tests for Manga Studio Apply/Publish flow (#152)"
```

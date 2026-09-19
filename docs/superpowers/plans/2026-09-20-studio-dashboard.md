# Studio Dashboard & Realtime Job Monitor (#145) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the production-ready Studio Dashboard (`/studio`), replacing the legacy UUID test input with a rich, interactive hub displaying managed stories/projects, paginated translation jobs with server-side multi-status filtering and search, live progress acceleration via `/ws/ai` with multi-job subscription persistence, authoritative REST reconciliation, and contextual CTAs navigating to review studios.

**Architecture:** Shared contracts in `@omninovel/shared` with required `mediaFormat`, `storySlug`, `heartbeatAt` and canonical status groups; backend query capability (`statuses` array + `search`) in `services/api`; multi-job reconnect persistence in `useTranslationSocket`; SSoT hook `useStudioDashboard` managing server-state and socket invalidation in `apps/web`; accessible sub-components; and comprehensive Vitest + Playwright E2E test suites.

**Tech Stack:** TypeScript, Next.js 16 (App Router), React 19, Socket.IO Client, Tailwind CSS 4, Lucide Icons, Vitest, Playwright.

## Global Constraints
- Target Issue: #145 ([Phase 4D][Web] Build Studio Dashboard with managed projects and realtime job monitor)
- **No Pseudo-Status:** There is NO `TranslationJobStatus.PROCESSING`. Use canonical status groups:
  - `ACTIVE`: `CREATED`, `VALIDATING`, `QUEUED`, `PREPROCESSING`, `OCR`, `TRANSLATING`, `INPAINTING`, `TYPESETTING`, `QUALITY_CHECK`
  - `REVIEW`: `READY_FOR_REVIEW`
  - `APPLIED`: `APPLIED`
  - `PROBLEM`: `FAILED`, `CANCELED`, `EXPIRED`
- **Canonical Story/Project Hierarchy:**
  - `GET /api/v1/studio/stories` → Managed stories (`ManagedStorySummaryDto`).
  - `GET /api/v1/ai/projects?storyId=...` → Projects belonging to story (`TranslationProjectSummaryDto`).
  - `GET /api/v1/ai/jobs` → Paginated jobs with server-side `statuses` array and `search`.
- **Authoritative Invariant:** REST is the authoritative source of truth; WebSocket `/ws/ai` is strictly for realtime acceleration and invalidation triggers.
- **Multi-Job Socket Persistence:** Reconnecting socket or rotating auth tokens must automatically resubscribe all active jobs in the current view.
- **All commands must use canonical `npm --prefix <path>` syntax.**
- Continuous Commit & Push on every task with semantic messages.

---

### Task 1: Dashboard Canonical Contracts, Query Capability & Web Client APIs

**Files:**
- Modify: `packages/shared/src/index.ts:323-345`
- Modify: `services/api/src/modules/translation/dto/find-translation-jobs-query.dto.ts`
- Modify: `services/api/src/modules/translation/translation.service.ts:515-590`
- Modify: `apps/web/src/lib/api/translation.ts`
- Create: `apps/web/src/test/fixtures/studio-dashboard-fixtures.ts`
- Test: `services/api/src/modules/translation/test/translation-foundation.spec.ts`
- Test: `apps/web/src/test/translation-api.spec.ts`

**Interfaces:**
- Consumes: `MediaFormat`, `TranslationJobStatus`, `ManagedStorySummaryDto`, `TranslationProjectSummaryDto`.
- Produces:
  - `TranslationJobSummaryDto`: Add required `mediaFormat: MediaFormat`, `storySlug: string`, `heartbeatAt: IsoDateString | null`.
  - Export canonical status groups: `JOB_STATUS_GROUPS`.
  - `FindTranslationJobsQueryDto`: Add `statuses?: TranslationJobStatus[]` and `search?: string` (preserve `status?: TranslationJobStatus` for backward compatibility).
  - Client APIs: `fetchManagedStories(query)`, `fetchTranslationProjects(query)`, `fetchTranslationJobs(query)`.

- [x] **Step 1: Update `@omninovel/shared` types and status groups**
Add required `mediaFormat`, `storySlug`, `heartbeatAt` to `TranslationJobSummaryDto`. Define and export `JOB_STATUS_GROUPS`.

- [x] **Step 2: Build `@omninovel/shared`**
Run: `npm --prefix packages/shared run build`
Expected: PASS with 0 errors.

- [x] **Step 3: Update `FindTranslationJobsQueryDto` & `getJobs` in backend**
Support `statuses` (array or comma-delimited) and `search` (LIKE query across `story.title`, `chapter.chapterNumber`, `chapter.title`). Map required `mediaFormat`, `storySlug`, `heartbeatAt`.

- [x] **Step 4: Verify backend unit tests pass**
Run: `npm --prefix services/api test`
Expected: PASS with 0 errors.

- [x] **Step 5: Implement Web Client APIs and Fixtures**
Implement `fetchManagedStories`, `fetchTranslationProjects`, `fetchTranslationJobs` in `apps/web/src/lib/api/translation.ts`. Create fixtures in `apps/web/src/test/fixtures/studio-dashboard-fixtures.ts`.

- [x] **Step 6: Verify Web client API unit tests pass**
Run: `npm --prefix apps/web test -- src/test/translation-api.spec.ts`
Expected: PASS.

- [x] **Step 7: Commit Task 1**
```bash
git add packages/shared/src/index.ts \
        services/api/src/modules/translation/ \
        apps/web/src/lib/api/translation.ts \
        apps/web/src/test/fixtures/studio-dashboard-fixtures.ts \
        apps/web/src/test/translation-api.spec.ts
git commit -m "feat(shared,api,web): add dashboard contracts, multi-status query capability, and client APIs (#145)"
```

---

### Task 2: Multi-Job Socket Subscription Persistence in `useTranslationSocket`

**Files:**
- Modify: `apps/web/src/lib/websocket/use-translation-socket.ts`
- Modify: `apps/web/src/test/use-translation-socket.spec.ts`

**Interfaces:**
- Consumes: Socket.IO client, `memoryAuthStore`.
- Produces:
  - Extended `useTranslationSocket` accepting `jobIds?: string[]`.
  - Added methods: `subscribeJobs(ids: string[])`, `unsubscribeJobs(ids: string[])`.
  - Automatic multi-job resubscription on socket `connect` / reconnect / token rotation.

- [x] **Step 1: Write failing test in `use-translation-socket.spec.ts`**
Scenarios:
- Supplying `jobIds: ['j1', 'j2']` emits `subscribe_job` for both.
- Calling `subscribeJobs(['j3'])` adds to internal Set and emits.
- When socket disconnects and reconnects, it automatically resubscribes all active job IDs in the Set.

- [x] **Step 2: Run test to verify it fails**
Run: `npm --prefix apps/web test -- src/test/use-translation-socket.spec.ts`
Expected: FAIL.

- [x] **Step 3: Implement multi-job subscription persistence in `use-translation-socket.ts`**
- [x] **Step 4: Run test to verify it passes**
Run: `npm --prefix apps/web test -- src/test/use-translation-socket.spec.ts`
Expected: PASS.

- [x] **Step 5: Commit Task 2**
```bash
git add apps/web/src/lib/websocket/use-translation-socket.ts apps/web/src/test/use-translation-socket.spec.ts
git commit -m "feat(web): add multi-job subscription persistence across reconnect to useTranslationSocket (#145)"
```

---

### Task 3: Studio Dashboard State Hook & Realtime Invalidation Orchestration

**Files:**
- Create: `apps/web/src/lib/studio/use-studio-dashboard.ts`
- Create: `apps/web/src/test/use-studio-dashboard.spec.ts`

**Interfaces:**
- Consumes: `fetchManagedStories`, `fetchTranslationProjects`, `fetchTranslationJobs`, `useTranslationSocket`.
- Produces:
  - Hook: `useStudioDashboard()`
  - State: `stories`, `projects`, `jobs`, `isLoading`, `error`, `filterGroup`, `searchKeyword`, `currentPage`, `totalPages`, `totalJobs`, `selectedStoryId`, `selectedProjectId`, `metrics`.
  - Actions: `setFilterGroup(group)`, `setSearchKeyword(keyword)`, `goToPage(page)`, `selectStory(id)`, `selectProject(id)`, `refetchJobs()`.

- [ ] **Step 1: Write failing hook tests in `use-studio-dashboard.spec.ts`**
Scenarios:
- Initial parallel fetch of managed stories, projects, and jobs.
- Selecting status group (`ACTIVE`, `REVIEW`, `APPLIED`, `PROBLEM`) maps to query `statuses` array and resets to page 1.
- Realtime `job_progress` accelerates matching job's progress in local state without full REST reload.
- Realtime `job_ready_for_review`, `job_failed`, `job_canceled` triggers authoritative `fetchTranslationJobs` refetch.
- Socket reconnect triggers full REST refresh.

- [ ] **Step 2: Run test to verify it fails**
Run: `npm --prefix apps/web test -- src/test/use-studio-dashboard.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `use-studio-dashboard.ts`**
- [ ] **Step 4: Run test to verify it passes**
Run: `npm --prefix apps/web test -- src/test/use-studio-dashboard.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit Task 3**
```bash
git add apps/web/src/lib/studio/use-studio-dashboard.ts apps/web/src/test/use-studio-dashboard.spec.ts
git commit -m "feat(web): implement useStudioDashboard hook with realtime acceleration and REST SSoT (#145)"
```

---

### Task 4: Sub-Components: Metrics, Managed Story Selector, Filter Bar & Job Cards

**Files:**
- Create: `apps/web/src/components/studio/dashboard/studio-metrics-cards.tsx`
- Create: `apps/web/src/components/studio/dashboard/studio-story-selector.tsx`
- Create: `apps/web/src/components/studio/dashboard/studio-job-filter-bar.tsx`
- Create: `apps/web/src/components/studio/dashboard/studio-job-card.tsx`
- Create: `apps/web/src/test/studio-dashboard-components.spec.tsx`

**Interfaces:**
- Consumes: `TranslationJobSummaryDto`, `ManagedStorySummaryDto`, `TranslationProjectSummaryDto`.
- Produces:
  - `StudioMetricsCards`: Quick metrics (Active, Ready, Applied, Problem).
  - `StudioStorySelector`: Dropdown / scrollable selector for managed stories and editions/projects.
  - `StudioJobFilterBar`: Filter pills (`ALL`, `ACTIVE`, `REVIEW`, `APPLIED`, `PROBLEM`) and search input.
  - `StudioJobCard`: Job item with media badge, progress bar, chapter info, heartbeat/completed time fallback, and contextual CTA button.

- [ ] **Step 1: Write failing component tests in `studio-dashboard-components.spec.tsx`**
- [ ] **Step 2: Run test to verify it fails**
Run: `npm --prefix apps/web test -- src/test/studio-dashboard-components.spec.tsx`
Expected: FAIL.
- [ ] **Step 3: Implement sub-components in `apps/web/src/components/studio/dashboard/`**
- [ ] **Step 4: Run test to verify it passes**
Run: `npm --prefix apps/web test -- src/test/studio-dashboard-components.spec.tsx`
Expected: PASS.
- [ ] **Step 5: Commit Task 4**
```bash
git add apps/web/src/components/studio/dashboard/ apps/web/src/test/studio-dashboard-components.spec.tsx
git commit -m "feat(web): create modular Studio Dashboard UI sub-components (#145)"
```

---

### Task 5: Studio Page Integration (`/studio`)

**Files:**
- Modify: `apps/web/src/app/(site)/(studio)/studio/page.tsx`
- Create: `apps/web/src/test/studio-dashboard-page.spec.tsx`

**Interfaces:**
- Integrates `useStudioDashboard`, `StudioMetricsCards`, `StudioStorySelector`, `StudioJobFilterBar`, `StudioJobCard`.
- Supports auth state check, empty state, pagination, and header CTA "Tạo Bản Dịch Mới".

- [ ] **Step 1: Write failing route integration tests in `studio-dashboard-page.spec.tsx`**
- [ ] **Step 2: Run test to verify it fails**
Run: `npm --prefix apps/web test -- src/test/studio-dashboard-page.spec.tsx`
Expected: FAIL.
- [ ] **Step 3: Implement complete Studio Dashboard page in `page.tsx`**
- [ ] **Step 4: Run test to verify it passes**
Run: `npm --prefix apps/web test -- src/test/studio-dashboard-page.spec.tsx`
Expected: PASS.
- [ ] **Step 5: Commit Task 5**
```bash
git add "apps/web/src/app/(site)/(studio)/studio/page.tsx" apps/web/src/test/studio-dashboard-page.spec.tsx
git commit -m "feat(web): integrate production Studio Dashboard into /studio route (#145)"
```

---

### Task 6: Playwright E2E Tests & Monorepo Quality Gate

**Files:**
- Create: `apps/web/e2e/studio-dashboard.spec.ts`

- [ ] **Step 1: Write Playwright E2E spec covering:**
  - Flow 1: Load Dashboard, view managed stories, filter jobs by `REVIEW` group, click CTA to navigate to Manga Review Studio.
  - Flow 2: Live Socket Acceleration — Verify job progress updates live from WebSocket event.
- [ ] **Step 2: Run Playwright E2E tests**
Run: `npm --prefix apps/web run test:e2e -- studio-dashboard.spec.ts`
Expected: PASS.
- [ ] **Step 3: Full Monorepo Quality Gate Verification (Mirror CI)**
Run:
1. `npm --prefix packages/shared run build`
2. `npm --prefix services/api test`
3. `npm --prefix apps/web run lint`
4. `npm --prefix apps/web run typecheck`
5. `npm --prefix apps/web test`
6. `npm --prefix apps/web run build`
7. `npm --prefix apps/web run test:e2e`
Expected: 100% Green on all suites.

- [ ] **Step 4: Commit Task 6**
```bash
git add apps/web/e2e/studio-dashboard.spec.ts
git commit -m "test(web): add Playwright E2E tests for Studio Dashboard (#145)"
```

---

### Task 7: Roadmap Update & Git Synchronization

**Files:**
- Modify: `plans/phases/phase_04_web_client.md`
- Modify: `docs/superpowers/plans/2026-09-20-studio-dashboard.md`

- [ ] **Step 1: Update Phase 4D roadmap in `phase_04_web_client.md`**
- [ ] **Step 2: Check CI on GitHub Actions across all 3 gates**
- [ ] **Step 3: Close Issue #145 via `gh` CLI**
- [ ] **Step 4: Commit Task 7**
```bash
git add plans/phases/phase_04_web_client.md docs/superpowers/plans/2026-09-20-studio-dashboard.md
git commit -m "docs(roadmap): update Phase 4D Studio Dashboard completion status (#145)"
```

# Translation Job Creation Workflow with Consent and Idempotency (#146) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây dựng quy trình khởi tạo Translation Job hoàn chỉnh từ Studio (`/studio/ai/jobs/new`), kết nối trực tiếp với Studio Dashboard (#145), khóa chặt 5 invariants, quy tắc consent cho external provider, bảo toàn định danh submission với UUID-v4 `Idempotency-Key`, chống double-submit, xử lý ambiguity timeout/5xx, và điều hướng chuẩn xác tới `/studio/ai/jobs/:jobId`.

**Architecture:** Mở rộng shared contract `@omninovel/shared`; bổ sung endpoint kiểm tra versions nhẹ và an toàn `GET /api/v1/studio/chapters/:id/versions` trong `services/api`; thiết lập pure policy module `studio-job-creation-policy.ts` trong `apps/web` xử lý validation, consent và phân loại ambiguity; hook quản lý state `useCreateTranslationJob`; các UI sub-components phân tầng trực quan (Story → Edition → Chapter → Version); trang `/studio/ai/jobs/new`; cập nhật Dashboard CTA; cùng bộ test tự động Vitest và Playwright E2E.

**Tech Stack:** TypeScript, Next.js 16 (App Router), React 19, NestJS, TypeORM, Tailwind CSS 4, Lucide Icons, Vitest, Playwright.

## Global Constraints
- **Target Issue:** #146 ([Phase 4D][Web] Implement translation job creation workflow with consent and idempotency)
- **5 Locked Invariants:**
  1. **Canonical hierarchy:** Managed Story → Edition → Chapter → source `ChapterVersion`. Backend creation authority MUST reject `sourceLang !== sourceVersion.language` and `targetLang === sourceLang`; UI validation is defense-in-depth only.
  2. **Consent:** External provider (`OPENAI`, `DEEPL`, `GEMINI`, `CLAUDE`) chỉ gửi `externalConsent: true` sau explicit user action; local/mock provider (`MOCK`, `LOCAL`, `LOCAL_LLM`) không ép consent.
  3. **Frozen submission identity:** Một logical submit giữ nguyên UUID-v4 `Idempotency-Key` khi retry/network ambiguity; chỉ sinh key mới khi user chỉnh sửa input form.
  4. **No double submit:** Disable/concurrency guard; canonical response `202 { jobId, status, isDuplicate }`; phân loại lỗi rõ ràng.
  5. **Successful handoff:** Cả thành công (`202 isDuplicate: false`) hoặc duplicate hợp lệ (`202 isDuplicate: true`) đều chuyển hướng đến `/studio/ai/jobs/:jobId`; tuyệt đối không lưu provider secret/API key trong browser persistence.
- **Ambiguity Resilience Pattern (Kế thừa từ #152):** HTTP 5xx và network timeout được xử lý theo hướng `SUBMISSION_OUTCOME_UNKNOWN`, không tự ý tạo idempotency key mới khi retry.
- **Tất cả các lệnh chạy phải dùng cú pháp canonical `npm --prefix <path>`**.
- **Continuous Commit & Push sau mỗi task với thông điệp rõ ràng**.

---

### Task 1: Shared Contracts & Backend Studio Chapter Versions Endpoint

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `services/api/src/modules/chapters/chapters.controller.ts`
- Modify: `services/api/src/modules/chapters/chapters.service.ts`
- Create: `services/api/src/modules/chapters/test/studio-chapter-versions.spec.ts`

**Interfaces:**
- Consumes: `ChapterVersion`, `StoryMemberGuard`, `JwtAuthGuard`.
- Produces:
  - `CreateTranslationJobRequest`: `{ chapterVersionId: string; sourceLang: string; targetLang: string; provider?: string; externalConsent?: boolean }`
  - `CreateTranslationJobResponse`: `{ jobId: string; status: TranslationJobStatus; isDuplicate: boolean }`
  - `StudioChapterVersionSummaryDto`: `{ id: string; chapterId: string; versionNumber: number; versionType: ChapterVersionType; language: string; isPublished: boolean; sourceVersionId: string | null; createdAt: IsoDateString }`
  - Endpoint: `GET /api/v1/studio/chapters/:id/versions`

- [x] **Step 1: Thêm types vào `@omninovel/shared`**
Thêm `CreateTranslationJobRequest`, `CreateTranslationJobResponse`, `StudioChapterVersionSummaryDto` vào `packages/shared/src/index.ts`.

- [x] **Step 2: Build `@omninovel/shared`**
Run: `npm --prefix packages/shared run build`
Expected: PASS với 0 lỗi.

- [x] **Step 3: Viết test cho `findVersionsForStudio` trong `services/api`**
Tạo file `services/api/src/modules/chapters/test/studio-chapter-versions.spec.ts` kiểm tra:
1. Trả về danh sách version theo thứ tự `versionNumber DESC`.
2. Ném `NotFoundException` nếu chapterId không tồn tại.

- [x] **Step 4: Chạy test để xác nhận fail**
Run: `npm --prefix services/api test -- src/modules/chapters/test/studio-chapter-versions.spec.ts`
Expected: FAIL do chưa có method `findVersionsForStudio`.

- [x] **Step 5: Cài đặt `findVersionsForStudio` và endpoint controller**
Cài đặt trong `chapters.service.ts` và thêm `@Get('studio/chapters/:id/versions')` có guard trong `chapters.controller.ts`.

- [x] **Step 6: Chạy test để xác nhận pass**
Run: `npm --prefix services/api test -- src/modules/chapters/test/studio-chapter-versions.spec.ts`
Expected: PASS.

- [x] **Step 7: Commit Task 1**
```bash
git add packages/shared/src/index.ts \
        services/api/src/modules/chapters/ \
        services/api/src/modules/chapters/test/studio-chapter-versions.spec.ts
git commit -m "feat(shared,api): add job creation contracts and studio chapter versions endpoint (#146)"
```

---

### Task 2: Web Client API & Job Creation Pure Policy

**Files:**
- Modify: `apps/web/src/lib/api/translation.ts`
- Create: `apps/web/src/lib/studio/studio-job-creation-policy.ts`
- Create: `apps/web/src/test/studio-job-creation-policy.spec.ts`
- Modify: `services/api/src/modules/translation/translation.service.ts`
- Create: `services/api/src/modules/translation/test/job-creation-invariants.spec.ts`

**Interfaces:**
- Consumes: `CreateTranslationJobRequest`, `CreateTranslationJobResponse`, `StudioChapterVersionSummaryDto`.
- Produces:
  - `createTranslationJobApi(payload, idempotencyKey)`
  - `fetchStudioChapterVersions(chapterId)`
  - `EXTERNAL_PROVIDERS`, `LOCAL_PROVIDERS`, `isExternalProvider(provider)`
  - `validateJobCreationForm(form)`
  - `shouldReuseIdempotencyKey(previous, current, isAmbiguous)`
  - `classifyJobCreationError(error)` (chuẩn hóa HTTP 5xx / timeout ambiguity)

- [x] **Step 1: Viết test cho pure policy trong `studio-job-creation-policy.spec.ts`**
Cover các case:
1. `validateJobCreationForm`: Thiếu chapterVersionId, trùng source/target language, external provider thiếu consent checkbox.
2. `shouldReuseIdempotencyKey`: Giữ nguyên key khi ambiguous error và form không đổi; tạo key mới khi đổi input.
3. `classifyJobCreationError`: 5xx / timeout / network abort là `isAmbiguous: true`; 400/403/404/409 là `isAmbiguous: false` có message chuẩn.
4. Backend authority hardening: `createJob()` phải reject khi `sourceLang` không khớp `ChapterVersion.language`, hoặc `targetLang === sourceLang`, để API trực tiếp không bypass canonical hierarchy/form policy.

- [x] **Step 2: Chạy test để xác nhận fail**
Run: `npm --prefix apps/web test -- src/test/studio-job-creation-policy.spec.ts`
Expected: FAIL do chưa có file policy.

- [x] **Step 3: Cài đặt `studio-job-creation-policy.ts` và client APIs trong `translation.ts`**
Triển khai hàm pure policy và các API `createTranslationJobApi`, `fetchStudioChapterVersions`. Đồng thời harden `TranslationService.createJob()` với canonical language invariants và test backend tương ứng.

- [x] **Step 4: Chạy test để xác nhận pass**
Run: `npm --prefix apps/web test -- src/test/studio-job-creation-policy.spec.ts`
Expected: PASS.

- [x] **Step 5: Commit Task 2**
```bash
git add apps/web/src/lib/api/translation.ts \
        apps/web/src/lib/studio/studio-job-creation-policy.ts \
        apps/web/src/test/studio-job-creation-policy.spec.ts
git commit -m "feat(web): add job creation client API, consent policy, and ambiguity classifier (#146)"
```

---

### Task 3: State Machine Hook `useCreateTranslationJob`

**Files:**
- Create: `apps/web/src/lib/studio/use-create-translation-job.ts`
- Create: `apps/web/src/test/use-create-translation-job.spec.ts`

**Interfaces:**
- Consumes: `studio-job-creation-policy`, `translation.ts`, `stories.ts#getStoryBySlugApi`, Next.js `useRouter`.
- Produces:
  - Hook `useCreateTranslationJob(options)`:
    - State: `stories`, `storyDetail`, `chapterVersions`, `selectedStoryId`, `selectedEditionId`, `selectedChapterId`, `selectedVersionId`, `sourceLang`, `targetLang`, `provider`, `externalConsent`.
    - Lifecycle: `IDLE` | `SUBMITTING` | `SUBMISSION_OUTCOME_UNKNOWN` | `SUCCEEDED` | `FAILED`.
    - Methods: `selectStory`, `selectEdition`, `selectChapter`, `selectVersion`, `setSourceLang`, `setTargetLang`, `setProvider`, `setExternalConsent`, `submit`, `retry`, `reset`.

- [x] **Step 1: Viết test cho hook `use-create-translation-job.spec.ts`**
Cover các case:
1. Hierarchy loading: Chọn managed story dùng canonical `slug` để tải hierarchy qua `getStoryBySlugApi(slug)`; chọn chapter tải chapterVersions.
2. Form defaults: Chọn version tự động fill `sourceLang` từ version/story.
3. Concurrency guard: Chặn click submit khi `isSubmitting === true`.
4. Frozen submission identity: Submit lần đầu sinh UUID-v4; khi gặp 500/timeout gọi `retry()` giữ nguyên UUID-v4; khi user sửa input form reset submission identity.
5. Canonical 202 handoff: Cả `isDuplicate: false` và `isDuplicate: true` đều kích hoạt router chuyển hướng tới `/studio/ai/jobs/:jobId`.

- [x] **Step 2: Chạy test để xác nhận fail**
Run: `npm --prefix apps/web test -- src/test/use-create-translation-job.spec.ts`
Expected: FAIL do chưa tạo hook.

- [x] **Step 3: Triển khai hook `useCreateTranslationJob`**
Cài đặt hook với quản lý hierarchy, frozen submission identity, và error classification.

- [x] **Step 4: Chạy test để xác nhận pass**
Run: `npm --prefix apps/web test -- src/test/use-create-translation-job.spec.ts`
Expected: PASS.

- [x] **Step 5: Commit Task 3**
```bash
git add apps/web/src/lib/studio/use-create-translation-job.ts \
        apps/web/src/test/use-create-translation-job.spec.ts
git commit -m "feat(web): implement useCreateTranslationJob hook with frozen submission identity (#146)"
```

---

### Task 4: UI Sub-components & Form Assembly

**Files:**
- Create: `apps/web/src/components/studio/job-creation/studio-hierarchy-selector.tsx`
- Create: `apps/web/src/components/studio/job-creation/studio-provider-consent-card.tsx`
- Create: `apps/web/src/components/studio/job-creation/create-job-form.tsx`
- Create: `apps/web/src/test/create-job-form.spec.tsx`

**Interfaces:**
- Consumes: `useCreateTranslationJob`.
- Produces:
  - Accessible UI sub-components: `StudioHierarchySelector`, `StudioProviderConsentCard`, `CreateJobForm`.

- [x] **Step 1: Viết test cho `create-job-form.spec.tsx`**
Cover các case:
1. Render form và hierarchy steps.
2. Khi chọn provider `OPENAI`, card disclosure & consent checkbox xuất hiện; submit button disabled nếu chưa check.
3. Khi chọn provider `MOCK`, consent checkbox ẩn; submit button cho phép bấm.
4. Khi state là `SUBMISSION_OUTCOME_UNKNOWN`, hiển thị warning alert kèm nút "Thử lại với cùng Idempotency Key".

- [x] **Step 2: Chạy test để xác nhận fail**
Run: `npm --prefix apps/web test -- src/test/create-job-form.spec.tsx`
Expected: FAIL do chưa có components.

- [x] **Step 3: Cài đặt các sub-components và `CreateJobForm`**
Xây dựng UI tuân thủ design system, rich aesthetics, Tailwind CSS 4, responsive layout.

- [x] **Step 4: Chạy test để xác nhận pass**
Run: `npm --prefix apps/web test -- src/test/create-job-form.spec.tsx`
Expected: PASS.

- [x] **Step 5: Commit Task 4**
```bash
git add apps/web/src/components/studio/job-creation/ \
        apps/web/src/test/create-job-form.spec.tsx
git commit -m "feat(web): build studio job creation UI components and consent card (#146)"
```

---

### Task 5: Production Route `/studio/ai/jobs/new` & Dashboard CTA Integration

**Files:**
- Create: `apps/web/src/app/(site)/(studio)/studio/ai/jobs/new/page.tsx`
- Modify: `apps/web/src/app/(site)/(studio)/studio/page.tsx`
- Test: `apps/web/src/test/studio-dashboard-page.spec.tsx`

**Interfaces:**
- Consumes: `CreateJobForm`, Dashboard CTA button.
- Produces:
  - Route `/studio/ai/jobs/new`
  - Dashboard CTA "Tạo Bản Dịch Mới" trỏ đến `/studio/ai/jobs/new`.

- [x] **Step 1: Tạo page `/studio/ai/jobs/new/page.tsx`**
Bọc `CreateJobForm` trong layout studio, hỗ trợ search params `?storySlug=...&chapterId=...`. Không quét nhiều trang managed stories để resolve một `storyId`.

- [x] **Step 2: Cập nhật Dashboard CTA link trong `studio/page.tsx`**
Đổi link "Tạo Bản Dịch Mới" từ placeholder `/studio/manga` thành `/studio/ai/jobs/new`.

- [x] **Step 3: Cập nhật và chạy unit tests của Dashboard**
Run: `npm --prefix apps/web test -- src/test/studio-dashboard-page.spec.tsx`
Expected: PASS với link mới `/studio/ai/jobs/new`.

- [x] **Step 4: Commit Task 5**
```bash
git add apps/web/src/app/\(site\)/\(studio\)/studio/ai/jobs/new/page.tsx \
        apps/web/src/app/\(site\)/\(studio\)/studio/page.tsx \
        apps/web/src/test/studio-dashboard-page.spec.tsx
git commit -m "feat(web): integrate job creation route and wire dashboard CTA (#146)"
```

---

### Task 6: Playwright E2E Verification & Integration Regression

**Files:**
- Create: `apps/web/e2e/studio-job-creation.spec.ts`

**Interfaces:**
- Consumes: Next.js Studio routes, mock API fixtures.
- Produces:
  - E2E coverage for:
    - Happy path: Dashboard → CTA Click → Chọn Hierarchy → Mock Provider → Submit → Điều hướng tới `/studio/ai/jobs/:jobId`.
    - Consent Gate: Chọn OpenAI → Bị chặn nếu chưa consent → Submit thành công sau khi consent.
    - Ambiguity Retry: Giả lập 500/timeout → Nhấn thử lại gửi cùng `Idempotency-Key`.

- [ ] **Step 1: Viết E2E test trong `apps/web/e2e/studio-job-creation.spec.ts`**
- [ ] **Step 2: Chạy E2E test bằng Playwright**
Run: `npm --prefix apps/web run test:e2e -- e2e/studio-job-creation.spec.ts`
Expected: PASS tất cả các flows.

- [ ] **Step 3: Chạy full test suite regression**
Run: `npm --prefix apps/web test --run`
Expected: Tất cả các bài test Vitest của web pass.

- [ ] **Step 4: Commit Task 6**
```bash
git add apps/web/e2e/studio-job-creation.spec.ts
git commit -m "test(web): add Playwright E2E test suite for studio job creation workflow (#146)"
```

---

### Task 7: Documentation & Roadmap Phase 4D Update

**Files:**
- Modify: `plans/ROADMAP.md` (hoặc tài liệu Phase 4D tương ứng)

- [ ] **Step 1: Cập nhật trạng thái Issue #146 hoàn thành**
- [ ] **Step 2: Commit & Push**
```bash
git add plans/
git commit -m "docs(roadmap): update Phase 4D translation job creation workflow completion status (#146)"
git push origin main
```

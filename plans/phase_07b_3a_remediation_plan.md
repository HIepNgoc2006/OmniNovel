# Task 7B.3a Web Client Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate 5 critical contract and data-integrity defects in Web Guest Claim Integration (shared contract fingerprint, login/register zero-mutation transitioning window, conflict-aware progress rebind, fail-closed crash recovery, and canonical register auth bridge) and establish real Core API HTTP integration tests.

**Architecture:** Amend shared contract `CommitGuestClaimPayload` to strictly require `expectedStateFingerprint: string`. Enforce zero-mutation invariant by passing `deferScopeResolution: true` through canonical login and register transitions in `AuthContext`. Make IndexedDB `rebindScope` strictly conflict-aware (`KEEP_CLOUD` vs `USE_GUEST`). Refactor `checkCrashRecovery` to tri-state fail-closed (`NONE | RESOLVED | PENDING_UNAVAILABLE`). Add end-to-end HTTP integration tests against NestJS `ValidationPipe` for prepare->commit.

**Tech Stack:** TypeScript, Next.js 16 (App Router), React 19, NestJS, TypeORM, PostgreSQL, IndexedDB (idb), Vitest, Jest, Supertest.

## Global Constraints
- Local isolation: All packages and builds run strictly inside project root `e:\Workspace 2\Doctruyen_project`.
- Continuous Git: Commit with clear messages and push to `origin/main` via `gh` CLI.
- KISS & YAGNI: Direct fixes without extraneous abstractions.
- All existing tests (Vitest 50 files, NestJS E2E, Flutter Analyze) must remain green.

---

### Task 1: Shared Contract Amendment & Web Commit Payload (`expectedStateFingerprint`)

**Files:**
- Modify: `packages/shared/src/types/claim.types.ts:114-121`
- Modify: `apps/mobile/lib/core/claim/models/guest_claim_models.dart:304-325`
- Modify: `apps/web/src/lib/claim/guest-claim-coordinator.ts:203-228`
- Test: `apps/web/src/test/guest-claim-coordinator.spec.ts:224-255`
- Test: `apps/mobile/test/core/claim/models/guest_claim_models_test.dart:184-202`

**Interfaces:**
- Consumes: `GuestClaimPreviewResult.stateFingerprint`
- Produces: `CommitGuestClaimPayload { expectedStateFingerprint: string; conflictDecisions?: Record<string, ConflictResolution>; }`

- [ ] **Step 1: Write the failing test for Web commit payload**
Update `apps/web/src/test/guest-claim-coordinator.spec.ts` asserting `commitSpy` is called with `{ expectedStateFingerprint: mockPreviewResult.stateFingerprint, conflictDecisions: decisions }`.

- [ ] **Step 2: Update shared contract and mobile Dart model**
In `packages/shared/src/types/claim.types.ts`, add `expectedStateFingerprint: string` to `CommitGuestClaimPayload`.
In `apps/mobile/lib/core/claim/models/guest_claim_models.dart`, add `final String expectedStateFingerprint` with serializing/deserializing logic.

- [ ] **Step 3: Build shared package and implement Web commit payload**
Run `npm --prefix packages/shared run build`.
In `apps/web/src/lib/claim/guest-claim-coordinator.ts`, retrieve `fingerprint = this._state.previewData?.stateFingerprint` and send in `commitGuestClaimApi`.

- [ ] **Step 4: Run tests to verify they pass**
Run `npm --prefix apps/web run test -- src/test/guest-claim-coordinator.spec.ts`.
Run `flutter test test/core/claim/models/guest_claim_models_test.dart` in `apps/mobile`.

- [ ] **Step 5: Commit**
`git commit -am "fix(shared,web,mobile): enforce expectedStateFingerprint in CommitGuestClaimPayload contract"`

---

### Task 2: Zero-Mutation Window Enforcement on Login Transition (`TRANSITIONING`)

**Files:**
- Modify: `apps/web/src/lib/auth/auth-context.tsx:88-106`
- Test: `apps/web/src/test/active-scope-coordinator.spec.ts`

**Interfaces:**
- Consumes: `activeScopeCoordinator.onAuthStatusChanged('authenticated', userId, { deferScopeResolution: true })`
- Produces: Atomic transition from login directly into `TRANSITIONING` without temporary `ACCOUNT` exposure.

- [ ] **Step 1: Write test for deferred scope resolution on login**
Verify in tests that passing `{ deferScopeResolution: true }` retains `TRANSITIONING` and prevents `canMutateUserState = true` until `checkAndPrepareClaim` resolves.

- [ ] **Step 2: Update `AuthContext.login`**
Change `activeScopeCoordinator.onAuthStatusChanged('authenticated', res.user.id)` to `{ deferScopeResolution: true }`.

- [ ] **Step 3: Run tests to verify**
Run `npm --prefix apps/web run test -- src/test/active-scope-coordinator.spec.ts`.

- [ ] **Step 4: Commit**
`git commit -am "fix(web): defer scope resolution on login to guarantee zero-mutation transitioning window"`

---

### Task 3: Canonical Register Authentication Flow (`AuthContext.register`)

**Files:**
- Modify: `apps/web/src/lib/auth/auth-context.tsx:18-28, 88-140`
- Modify: `apps/web/src/components/auth/auth-modal.tsx:61-95`
- Test: `apps/web/src/test/auth-context.spec.tsx` (or new test file)

**Interfaces:**
- Consumes: `registerApi(data)`
- Produces: `AuthContext.register: (data: RegisterRequest) => Promise<AuthResponse>` updating `user`, `status`, and coordinating claim.

- [ ] **Step 1: Add `register` to `AuthContextType` and implement in `AuthProvider`**
Implement canonical session transition in `AuthContext.register`: call `registerApi`, set `deferScopeResolution: true`, update `memoryAuthStore`, `setUser(res.user)`, `setStatus('authenticated')`, and call `checkAndPrepareClaim(res.user.id)`.

- [ ] **Step 2: Update `AuthModal` to consume `useAuth().register`**
Refactor `handleRegisterSubmit` in `AuthModal` to call `register(...)` from `useAuth()`.

- [ ] **Step 3: Run Web tests**
Run `npm --prefix apps/web run test`.

- [ ] **Step 4: Commit**
`git commit -am "fix(web): route register flow through canonical AuthContext to synchronize user session"`

---

### Task 4: Conflict-Aware Local Rebind Semantics (`rebindScope`)

**Files:**
- Modify: `apps/web/src/lib/storage/indexed-db-client.ts:531-607`
- Modify: `apps/web/src/lib/claim/guest-claim-coordinator.ts:225-237`
- Test: `apps/web/src/test/guest-indexed-db.spec.ts`
- Test: `apps/web/src/test/guest-claim-coordinator.spec.ts`

**Interfaces:**
- Consumes: `conflictDecisions?: Record<string, ConflictResolution>`
- Produces: `rebindScope(fromScope, toScope, conflictDecisions)` where `KEEP_CLOUD` prevents local overwrite of cloud progress, and `USE_GUEST` updates it.

- [ ] **Step 1: Write tests for conflict-aware `rebindScope`**
Add tests in `apps/web/src/test/guest-indexed-db.spec.ts` verifying:
1. When decision is `KEEP_CLOUD`, existing account progress in IndexedDB is NOT overwritten by guest progress.
2. When decision is `USE_GUEST`, guest progress updates account progress in IndexedDB.
3. When no existing account progress exists and no conflict, guest progress is safely inserted.

- [ ] **Step 2: Implement conflict-aware logic in `rebindScope`**
Update `rebindScope` in `indexed-db-client.ts` to inspect `conflictDecisions` for each progress record.

- [ ] **Step 3: Pass `conflictDecisions` from `confirmClaim`**
In `guest-claim-coordinator.ts`, pass `conflictDecisions` into `rebindScope(guestScope, accountScope, conflictDecisions)` and persist to `localStorage` for crash recovery.

- [ ] **Step 4: Run tests to verify**
Run `npm --prefix apps/web run test -- src/test/guest-indexed-db.spec.ts src/test/guest-claim-coordinator.spec.ts`.

- [ ] **Step 5: Commit**
`git commit -am "fix(web): make local progress rebind conflict-aware to preserve KEEP_CLOUD semantics"`

---

### Task 5: Fail-Closed Crash Recovery (`checkCrashRecovery`)

**Files:**
- Modify: `apps/web/src/lib/claim/guest-claim-coordinator.ts:272-327`
- Modify: `apps/web/src/lib/auth/auth-context.tsx:46-65`
- Test: `apps/web/src/test/guest-claim-coordinator.spec.ts`

**Interfaces:**
- Produces: `CrashRecoveryStatus = 'NONE' | 'RESOLVED' | 'PENDING_UNAVAILABLE'`
- Behavior: Network timeout with pending claim keeps `TRANSITIONING` and prevents `ACCOUNT` resolution.

- [ ] **Step 1: Write test for fail-closed crash recovery**
Add test in `guest-claim-coordinator.spec.ts` simulating network failure when `pendingClaimId` exists; verify it locks in `TRANSITIONING` and returns `'PENDING_UNAVAILABLE'`.

- [ ] **Step 2: Implement tri-state `checkCrashRecovery`**
Return `'NONE' | 'RESOLVED' | 'PENDING_UNAVAILABLE'`. In catch block, set coordinator to `TRANSITIONING` and return `'PENDING_UNAVAILABLE'`.

- [ ] **Step 3: Update `hydrateSession` in `AuthContext`**
If `'PENDING_UNAVAILABLE'`, pass `{ deferScopeResolution: true }` and keep mutations blocked.

- [ ] **Step 4: Run tests to verify**
Run `npm --prefix apps/web run test -- src/test/guest-claim-coordinator.spec.ts`.

- [ ] **Step 5: Commit**
`git commit -am "fix(web): implement fail-closed tri-state crash recovery on network error"`

---

### Task 6: Real Core API Integration Test for Prepare -> Commit

**Files:**
- Modify: `services/api/test/guest-claim.integration-spec.ts`

**Interfaces:**
- Consumes: HTTP `POST /api/v1/account/guest-claims/:claimId/commit`
- Produces: Real HTTP validation check verifying `CommitGuestClaimDto` rejects missing `expectedStateFingerprint` (400 Bad Request) and accepts valid payload (200 OK COMMITTED).

- [ ] **Step 1: Add HTTP supertest cases to `guest-claim.integration-spec.ts`**
Add supertest requests against NestJS `app.getHttpServer()`:
1. Commit request without `expectedStateFingerprint`: assert HTTP 400 Bad Request with message `expectedStateFingerprint must be a 64-character SHA-256 hash`.
2. Commit request with valid `expectedStateFingerprint` and `conflictDecisions`: assert HTTP 200 OK with `status: COMMITTED`.

- [ ] **Step 2: Run integration test**
Run `npm --prefix services/api run test:e2e -- test/guest-claim.integration-spec.ts`.

- [ ] **Step 3: Commit**
`git commit -am "test(api): add HTTP ValidationPipe integration tests for guest claim commit contract"`

---

### Task 7: Full Verification, Documentation Update & CI Trigger

**Files:**
- Modify: `plans/ROADMAP.md`
- Modify: `plans/phase_07b_account_claim_implementation_plan.md`

- [ ] **Step 1: Run comprehensive local tests**
1. `npm --prefix packages/shared run build`
2. `npm --prefix apps/web run lint`
3. `npx tsc --noEmit --project apps/web/tsconfig.json`
4. `npm --prefix apps/web run test`
5. `npm --prefix apps/web run build`
6. `npm --prefix services/api run test:e2e -- test/guest-claim.integration-spec.ts`
7. `flutter test` in `apps/mobile`

- [ ] **Step 2: Update ROADMAP.md**
Document Task 7B.3a remediation details and status.

- [ ] **Step 3: Push to GitHub and monitor CI**
Push commit to `origin/main` and verify GitHub Actions run.

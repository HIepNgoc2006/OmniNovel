# OmniNovel

> Multimodal Manga / Webtoon / Light Novel reader + AI-assisted translation and publishing studio.

OmniNovel là một **system monorepo** cho nền tảng đọc truyện đa phương thức và quy trình dịch thuật có AI hỗ trợ. Hệ thống hiện ưu tiên **business consistency, deterministic review/materialization và khả năng scale AI workload độc lập**.

> **Architecture classification:** **Monorepo + Modular Monolith Core + Independently Deployable AI Worker**.  
> Đây **không phải microservices thuần**: các domain nghiệp vụ chính vẫn được giữ trong một NestJS Core API để tận dụng transaction/consistency nội bộ, trong khi AI/CV workload được tách thành service Python riêng vì có runtime và scaling profile khác biệt.

---

## 1. Current Platform Baseline

**Baseline snapshot:** 2026-09-21

| Hạng mục | Trạng thái hiện tại |
| --- | --- |
| Repository model | npm workspaces monorepo |
| Core architecture | NestJS modular monolith |
| AI architecture | Python/FastAPI service độc lập |
| Web | Next.js App Router |
| Primary database | PostgreSQL 16 |
| Cache / queue | Redis 7 + BullMQ |
| Object storage | MinIO / S3-compatible private buckets |
| Realtime | Socket.IO / WebSocket |
| CI | GitHub Actions, 3 independent quality jobs |
| Active delivery phase | Phase 4D — AI Translation Studio & Apply Management |
| Latest completed Novel foundation | Versioned review-source structure snapshot (#163) |
| Major remaining Phase 4D work | Novel rebuild/materialization (#158), Glossary manager (#151), source artifact resolver (#165), final freeze (#153) |

Canonical progress/status lives in:

- [Phase 4 Web Client / Studio roadmap](plans/phases/phase_04_web_client.md)
- [Phase 4D tracking issue #143](https://github.com/HIepNgoc2006/OmniNovel/issues/143)
- [Plans & technical specifications](plans/README.md)

README này chỉ cung cấp **engineering snapshot**. Các số test/CI và issue status có thể thay đổi nhanh hơn README; GitHub Actions và phase trackers là nguồn xác nhận cuối cùng cho một closure/freeze gate.

---

## 2. System Architecture

```text
                         ┌─────────────────────────┐
                         │      Web Client         │
                         │ Next.js 16 / React 19   │
                         └────────────┬────────────┘
                                      │ REST / WebSocket
                                      ▼
                         ┌─────────────────────────┐
                         │      Core API           │
                         │ NestJS Modular Monolith │
                         │                         │
                         │ Auth / Catalog / Reader │
                         │ Upload / Translation    │
                         │ Studio / Apply / RBAC   │
                         └───────┬───────┬─────────┘
                                 │       │
                    ┌────────────┘       └────────────┐
                    ▼                                 ▼
             ┌──────────────┐                 ┌──────────────┐
             │ PostgreSQL 16│                 │ Redis 7      │
             │ SSoT DB      │                 │ BullMQ/cache │
             └──────────────┘                 └──────┬───────┘
                                                     │ queue / orchestration
                                                     ▼
                                             ┌──────────────────┐
                                             │ AI Worker        │
                                             │ Python / FastAPI │
                                             │ OCR / CV / LLM   │
                                             │ Manga / Novel    │
                                             └────────┬─────────┘
                                                      │ presigned I/O
                                                      ▼
                                             ┌──────────────────┐
                                             │ MinIO / S3       │
                                             │ Private storage  │
                                             └──────────────────┘
```

### Vì sao không dùng microservices thuần?

Core API giữ các domain cần transaction mạnh — Story, Chapter, Version, permissions, TranslationJob, review revision, apply/publish — trong cùng process và database boundary. Điều này giúp:

- tránh distributed transaction/saga không cần thiết;
- giữ OCC, locking và apply invariants trong một consistency boundary;
- giảm network/RPC overhead giữa các domain nghiệp vụ;
- đơn giản hóa debugging và local development.

AI Worker được tách riêng vì workload của nó có đặc tính khác hẳn Core API:

- Python / ML runtime;
- CPU/GPU intensive;
- OCR, image processing, translation và materialization;
- có thể scale worker độc lập với API.

Mô hình này cho phép tiến hóa dần sang service extraction khi traffic hoặc team topology thực sự yêu cầu, thay vì trả complexity cost của microservices quá sớm.

---

## 3. Tech Stack

### Web Client — `apps/web`

| Công nghệ | Baseline |
| --- | --- |
| Next.js | `^16.3.3` |
| React / React DOM | `^19.2.0` |
| TypeScript | `^5.7.3` |
| TanStack Query | `^5.66.0` |
| Zustand | `^5.0.3` |
| Socket.IO Client | `^4.8.1` |
| Tailwind CSS | `^4.0.7` |
| Axios | `^1.7.9` |
| Vitest | `^3.0.5` |
| Playwright | `^1.50.1` |
| Testing Library | React / DOM / User Event |

### Core Backend — `services/api`

| Công nghệ | Baseline |
| --- | --- |
| Node.js | `>=20.9.0` (CI uses Node 20) |
| NestJS | `^10.3.0` |
| TypeScript | `^5.3.3` |
| TypeORM | `^0.3.20` |
| PostgreSQL driver | `pg ^8.11.3` |
| PostgreSQL | 16 |
| Redis client | `ioredis ^5.3.2` |
| BullMQ | `^6.2.1` |
| Socket.IO | `^4.8.3` |
| AWS S3 SDK | `@aws-sdk/client-s3 ^3.1116.0` |
| Auth | Passport JWT + Argon2 |
| Validation | class-validator + Zod + shared runtime validators |
| Test | Jest 29 + Supertest |

### AI Worker — `services/ai-worker`

| Công nghệ | Baseline |
| --- | --- |
| Python | 3.11 in CI |
| FastAPI | `>=0.115,<0.120` |
| Uvicorn | `>=0.30,<0.35` |
| Pydantic | `>=2.8,<2.11` |
| HTTPX | `>=0.27,<0.29` |
| PyTorch | `>=2.2,<2.7` |
| Transformers | `>=4.45,<5.0` |
| Manga OCR | `0.1.16` |
| Pillow | `>=10,<12` |
| NumPy | `>=1.26,<2.3` |
| OpenCV Headless | `>=4.9,<5.0` |
| Test | Pytest 8 + pytest-asyncio |

### Shared Contracts — `packages/shared`

Shared TypeScript package là contract boundary giữa Web/Core và là SSoT cho nhiều DTO/manifest:

- TranslationJob states và DTOs;
- review/materialization contracts;
- strict result manifests;
- protected-anchor validator;
- Novel block types;
- content-addressed materialization/snapshot metadata.

Python Worker duy trì Pydantic models và corpus parity tests để chống contract drift giữa TypeScript và Python.

---

## 4. Infrastructure Baseline

### Local development — implemented

`deploy/docker-compose.dev.yml` hiện khởi tạo infrastructure:

| Service | Version / role | Default port |
| --- | --- | ---: |
| PostgreSQL | `postgres:16-alpine` | 5433 |
| Redis | `redis:7-alpine` | 6379 |
| MinIO API | S3-compatible private storage | 9000 |
| MinIO Console | administration UI | 9001 |
| MinIO init | creates private manga/novel buckets | one-shot |

Application processes thường chạy trực tiếp trên host trong local development:

| Process | Default port |
| --- | ---: |
| Web | 3000 |
| Core API | 8000 |
| AI Worker | 8001 |

### Production-scale target — architectural target

Các planning docs định hướng thêm Nginx/load balancing, containerized Web/API và GPU worker cluster. Đây là **deployment target**, không nên nhầm với compose dev hiện tại.

---

## 5. Data Consistency & Security Baseline

OmniNovel ưu tiên fail-closed behavior cho các luồng dịch/apply:

- **Database as authority:** PostgreSQL giữ canonical job/version/revision state.
- **Optimistic Concurrency Control:** segment mutations sử dụng `expectedVersion`.
- **Per-job locking:** critical translation/apply paths dùng DB locking để chống race.
- **Revision freshness gate:** `reviewRevision` / `materializedRevision` ngăn apply artifact cũ.
- **Idempotency keys:** job creation và apply flow chống duplicate logical submission.
- **Strict manifests:** unknown fields và invalid versions bị reject.
- **Protected Novel anchors:** client UX validation + server-authoritative topology validation.
- **Private object storage:** MinIO buckets không public; browser/worker dùng presigned URLs.
- **Content-addressed artifacts:** materialization/snapshot artifacts được pin bằng digest.
- **Novel structure snapshot (#163):** immutable structure reference, structural fingerprint, checksum-bound upload và server-side storage hash verification.
- **Internal service authentication:** Core ↔ AI Worker sử dụng `X-Internal-Service-Key`.
- **JWT + RBAC:** access/refresh token flow và Story-scoped roles; backend luôn là authorization authority.
- **Password hashing:** Argon2.

---

## 6. Repository Layout

```text
OmniNovel/
├── apps/
│   └── web/                    # Next.js reader + AI Translation Studio
├── services/
│   ├── api/                    # NestJS Core API / modular monolith
│   └── ai-worker/              # Python FastAPI AI/CV/translation worker
├── packages/
│   └── shared/                 # Shared TS contracts, DTOs, validators, manifests
├── deploy/
│   └── docker-compose.dev.yml  # Local PostgreSQL / Redis / MinIO
├── plans/
│   ├── planning/               # Architecture / API / security / NFR specifications
│   └── phases/                 # Delivery status by phase
└── .github/
    └── workflows/
        └── ci-cd.yml           # Monorepo quality pipeline
```

---

## 7. Local Development

### Requirements

- Node.js `>=20.9.0`
- npm
- Python 3.11 recommended for parity with CI
- Docker + Docker Compose

### Bootstrap

```bash
cp .env.example .env
npm install

# PostgreSQL + Redis + MinIO
npm run dev:infra

# Shared contracts
npm run build:shared
```

### Database migration + Core API

```bash
npm --prefix services/api run migration:run
npm --prefix services/api run start:dev
```

Core API: `http://localhost:8000`

### Web

```bash
npm --prefix apps/web run dev
```

Web: `http://localhost:3000`

### AI Worker

```bash
cd services/ai-worker

python -m venv .venv

# Windows
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8001

# Linux/macOS
# .venv/bin/python -m pip install -r requirements.txt
# .venv/bin/python -m uvicorn main:app --reload --port 8001
```

AI Worker: `http://localhost:8001`

### Stop infrastructure

```bash
npm run dev:infra:down
```

---

## 8. Quality Gates

GitHub Actions chạy ba job độc lập trên push/PR vào `main`:

### Web Client

```text
npm install
→ build @omninovel/shared
→ ESLint
→ TypeScript typecheck
→ Vitest
→ Next.js production build
→ Playwright Chromium E2E
```

### Core API

```text
PostgreSQL 16 + Redis 7 + MinIO
→ build @omninovel/shared
→ Jest unit tests
→ TypeORM migrations
→ integration / E2E tests
→ real Python-process cross-service coverage
```

### AI Worker

```text
Python 3.11
→ CPU-only CI dependencies
→ Pytest suite
→ real OCR model coverage
```

Một feature/issue không nên được xem là frozen chỉ vì local tests xanh; closure/freeze evidence phải dựa trên final `main` SHA và CI tương ứng.

---

## 9. Current Delivery State

High-level delivery status:

- **Phase 1:** setup / architecture baseline — completed.
- **Phase 2:** Core backend & security — completed.
- **Phase 3:** AI translation worker vertical slices — completed/frozen.
- **Phase 4A–4C:** Web foundation, discovery/catalog và multimodal reader — completed/frozen.
- **Phase 4D:** AI Translation Studio / review / materialization / publishing — active.

Các capability Phase 4D đã có gồm:

- Studio project/job contracts và dashboard;
- Translation job creation với consent + idempotency;
- Manga Review Studio;
- Novel Review Studio với protected-anchor validation;
- segment OCC + verification;
- Manga source previews / clean bases / reviewed re-render;
- materialization revision fencing;
- Apply/Publish overwrite vs alternate-version flow;
- versioned Novel review-source structure snapshot (#163).

Các workstream còn lại được theo dõi trong [Phase 4 roadmap](plans/phases/phase_04_web_client.md) và [tracking #143](https://github.com/HIepNgoc2006/OmniNovel/issues/143).

---

## 10. Engineering Principles

1. **SSoT before convenience** — canonical state nằm ở backend/database, UI không tự suy diễn state quan trọng.
2. **Fail closed** — manifest, permissions, storage jail, protected anchors và revisions phải reject khi không chắc chắn.
3. **Idempotent distributed boundaries** — retry network không được sinh duplicate business outcome.
4. **Immutable/content-addressed artifacts** — artifact dùng cho review/materialization phải có identity có thể verify.
5. **Deterministic reconstruction** — Novel/Manga publishing không được phụ thuộc vào parser/segmenter “phiên bản hiện tại” khi job cũ đã pin snapshot.
6. **Modular first, split services when justified** — giữ transaction-heavy business logic trong Core; tách workload khác runtime/scaling profile.
7. **CI is the acceptance gate** — local green là cần thiết nhưng chưa đủ cho freeze.

---

## 11. Documentation

Toàn bộ tài liệu quy hoạch kỹ thuật và tiến độ nằm tại **[`plans/`](plans/README.md)**.

Các tài liệu nên đọc đầu tiên:

- [System Architecture](plans/planning/12_SYSTEM_ARCHITECTURE.md)
- [Database & Storage](plans/planning/09_DATABASE_AND_STORAGE.md)
- [API & Event Contracts](plans/planning/10_API_AND_EVENT_CONTRACTS.md)
- [AI Translation Architecture](plans/planning/11_AI_TRANSLATION_ARCHITECTURE.md)
- [Architecture Decisions](plans/planning/13_ARCHITECTURE_DECISIONS.md)
- [Security Threat Model](plans/planning/15_SECURITY_THREAT_MODEL.md)
- [Testing & QA](plans/planning/17_TESTING_AND_QA.md)
- [DevOps / Observability / DR](plans/planning/18_DEVOPS_OBSERVABILITY_DR.md)
- [Phase tracking](plans/phases/)

---

## 12. Notes on Planned Components

Một số planning docs mô tả **future/target architecture** (ví dụ Flutter mobile app, Nginx deployment profile, Prometheus/Grafana production observability hoặc multi-node GPU cluster). Chỉ xem các thành phần đó là “implemented” khi chúng tồn tại trong code/deploy manifests và đã đi qua acceptance gate tương ứng.

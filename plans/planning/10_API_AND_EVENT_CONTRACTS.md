# 🔌 10. Hợp Đồng Giao Tiếp API, WebSocket & Chuẩn Phản Hồi Lỗi

Tài liệu này đặc tả toàn bộ RESTful API Endpoints phiên bản `/api/v1`, cấu trúc Request/Response Body schemas, chính sách khóa trùng lặp (**Idempotency Policy**), chuẩn phản hồi lỗi JSON và giao thức WebSocket.

---

## 1. CHUẨN PHẢN HỒI LỖI (STANDARD ERROR RESPONSE FORMAT)

Toàn bộ các API khi gặp lỗi bắt buộc phải trả về định dạng JSON chuẩn:

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Xung đột phiên bản (OCC Conflict). Phiên bản hiện tại: 2, phiên bản gửi lên: 1",
    "requestId": "req-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "timestamp": "2026-08-22T19:00:00.000Z",
    "meta": {
      "currentVersion": 2,
      "expectedVersion": 1
    },
    "details": [
      {
        "field": "expectedVersion",
        "issue": "Version mismatch detected"
      }
    ]
  }
}
```

> [!NOTE]
> **Quy chuẩn Bảo mật Error Metadata:** Trường `error.meta` chỉ cho phép xuất bản các trường public allowlisted (`currentVersion`, `expectedVersion`, `reviewRevision`, `materializedRevision`). Mọi unhandled exception 500 đều được che giấu với thông điệp chung `Đã có lỗi không mong muốn xảy ra từ máy chủ.` để triệt tiêu nguy cơ rò rỉ stack trace, URL nội bộ hoặc token.

---

## 2. CHÍNH SÁCH XỬ LÝ KHÓA TRÙNG LẶP (IDEMPOTENCY POLICY)

Hệ thống phân biệt 2 cấp độ Idempotency:
1. **HTTP Request Level Idempotency:** Client gửi header `Idempotency-Key: <UUID-v4>` cho các request nhạy cảm (`POST /gamification/checkin`, `POST /ai/jobs`, `POST /ai/jobs/:id/apply`). Redis lưu key với TTL 120s bằng lệnh `SETNX`.
2. **Database Ledger Level Idempotency:** CSDL lưu chuỗi khóa duy nhất trong `reward_transactions.idempotency_key` (ví dụ: `CHECKIN:<user_id>:<date>:EXP` và `CHECKIN:<user_id>:<date>:OMNICOIN`) để bảo vệ tính toàn vẹn tuyệt đối ở tầng cơ sở dữ liệu.

---

## 3. DANH MỤC RESTFUL API ENDPOINTS CHI TIẾT (/api/v1)

### 3.1. Phân Hệ Xác Thực (Auth)
| Method | Endpoint | Yêu Cầu Header / Body | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/auth/register` | Body: `{ email, username, password }` | `201 Created` + `{ user }` |
| `POST` | `/api/v1/auth/login` | Body: `{ identifier, password }` | `200 OK` + `{ accessToken, user }` (Set-Cookie: refreshToken) |
| `POST` | `/api/v1/auth/refresh` | Cookie: `refreshToken` | `200 OK` + `{ accessToken }` |
| `POST` | `/api/v1/auth/logout` | Auth: Bearer Token | `200 OK` + `{ success: true }` |
| `GET` | `/api/v1/auth/me` | Auth: Bearer Token | `200 OK` + `{ user, permissions }` |

### 3.2. Phân Hệ Khám Phá & Bộ Truyện (Catalog & Discovery)
| Method | Endpoint | Yêu Cầu Query / Body | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/stories` | Query: `q`, `search`, `genre` (slug), `format` (`MediaFormat`), `status` (`StoryStatus`), `sort` (`LATEST` \| `VIEWS` \| `POPULAR`), `page`, `limit` (max 50) | `200 OK` + `{ data: [...], pagination: { page, limit, total, totalPages } }` (Mỗi story kèm `genres: []` và `latestChapter` đã xuất bản) |
| `GET` | `/api/v1/stories/featured` | None | `200 OK` + `{ hotStories: [...], banners: [...] }` |
| `GET` | `/api/v1/stories/rankings` | None | `200 OK` + `{ topComics: [...], topNovels: [...] }` |
| `GET` | `/api/v1/stories/:slug` | Params: `slug` | `200 OK` + `{ story, editions, volumes, chapters }` |
| `PATCH`| `/api/v1/stories/:id/visibility` | Auth: Story Owner / Global Admin, Body: `{ visibility: 'PUBLIC' \| 'UNLISTED' \| 'PRIVATE' }` | `200 OK` + `{ storyId, visibility }` |

### 3.3. Phân Hệ Quản Trị Thành Viên Bộ Truyện (Story Members CRUD)
| Method | Endpoint | Yêu Cầu Body / Header | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/stories/:id/members` | Auth: Story Member / Story Owner / Global Admin | `200 OK` + `{ members: [...] }` |
| `POST` | `/api/v1/stories/:id/members` | Auth: Story Owner / Global Admin, Body: `{ userId, role: 'EDITOR' \| 'TRANSLATOR' \| 'UPLOADER' }` | `201 Created` + `{ member }` |
| `PATCH`| `/api/v1/stories/:id/members/:userId` | Auth: Story Owner / Global Admin, Body: `{ role }` | `200 OK` + `{ updatedMember }` |
| `DELETE`| `/api/v1/stories/:id/members/:userId` | Auth: Story Owner / Global Admin | `200 OK` + `{ success: true }` |

### 3.4. Phân Hệ Trình Đọc & Tủ Sách (Reader & Library)
| Method | Endpoint | Yêu Cầu Query / Body | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/chapters/:id` | Params: `id`, Query: `versionId` (optional) | `200 OK` + `{ chapter, activeVersion, pages/content }` |
| `POST` | `/api/v1/chapters/:id/reports` | Auth: Reader, Body: `{ pageNumber, errorType, description }` | `201 Created` + `{ reportId }` |
| `GET` | `/api/v1/library` | Auth: Bearer Token | `200 OK` + `{ bookmarks: [...], history: [...] }` |
| `PUT` | `/api/v1/library/reading-progress` | Auth: Bearer Token, Body: `{ chapterId: UUID, chapterVersionId?: UUID, readingMode?: 'WEBTOON' \| 'PAGED' \| 'NOVEL', progressPercentage: number, scrollPosition: number, storyId?: UUID }` | `200 OK` + `{ readingProgress }` |
| `GET` | `/api/v1/library/reading-progress/:storyId` | Auth: Bearer Token, Params: `storyId: UUID` | `200 OK` + `{ readingProgress, readChapterIds: string[] }` |
| `POST` | `/api/v1/library/bookmarks`| Auth: Bearer Token, Body: `{ storyId: UUID, isBookmarked: boolean }` | `200 OK` + `{ isBookmarked: boolean, followersCount: number }` (Idempotent state) |
| `GET` | `/api/v1/library/bookmarks/:storyId`| Optional Auth: Bearer Token, Params: `storyId` | `200 OK` + `{ isBookmarked: boolean }` |

### 3.5. Phân Hệ Studio & Dịch Thuật AI (Studio & AI)
| Method | Endpoint | Yêu Cầu Body / Header | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/studio/stories` | Auth: Story Member (OWNER/EDITOR/TRANSLATOR) / Global Admin, Query: `page`, `limit`, `search` | `200 OK` + `{ data: ManagedStorySummaryDto[], pagination }` |
| `POST` | `/api/v1/studio/stories` | Auth: Global Translator / Global Admin, Body: `{ title, mediaFormat, publicationFormat, originCountry, originalLanguage, summary, coverUrl }` | `201 Created` + `{ storyId }` |
| `POST` | `/api/v1/studio/stories/:id/editions` | Auth: Story Owner / Global Admin, Body: `{ editionName, language, isDefault }` | `201 Created` + `{ editionId }` |
| `POST` | `/api/v1/studio/editions/:id/volumes` | Auth: Story Editor / Story Owner / Global Admin, Body: `{ volumeNumber, title, coverUrl }` | `201 Created` + `{ volumeId }` |
| `POST` | `/api/v1/studio/volumes/:id/chapters` | Auth: Story Editor / Story Owner / Global Admin, Body: `{ chapterNumber, title }` | `201 Created` + `{ chapterId }` |
| `GET` | `/api/v1/studio/chapters/:id/versions` | Auth: Story Member (OWNER/EDITOR/TRANSLATOR) / Global Admin, Params: `id` (UUID) | `200 OK` + `StudioChapterVersionSummaryDto[]` |
| `POST` | `/api/v1/uploads/sessions`| Auth: Story Uploader / Story Translator / Story Editor / Story Owner / Global Admin, Body: `{ storyEditionId, chapterNumber, fileType: 'ZIP' \| 'TEXT' \| 'EPUB' \| 'MARKDOWN', fileSize }` | `201 Created` + `{ uploadId, presignedUrls: [...] }` |
| `GET` | `/api/v1/ai/projects` | Auth: Story Member / Global Admin, Query: `page`, `limit`, `storyId` | `200 OK` + `{ data: TranslationProjectSummaryDto[], pagination }` |
| `GET` | `/api/v1/ai/jobs` | Auth: Story Member / Global Admin, Query: `page`, `limit`, `storyId`, `projectId`, `status` | `200 OK` + `{ data: TranslationJobSummaryDto[], pagination }` |
| `POST` | `/api/v1/ai/jobs` | Header: `Idempotency-Key` (UUID-v4), Auth: Story Translator / Story Editor / Story Owner / Global Admin, Body: `{ chapterVersionId, sourceLang, targetLang, provider, externalConsent?: boolean }` | `202 Accepted` + `{ jobId, status: 'QUEUED' }` (Errors: `400 SOURCE_VERSION_ARTIFACT_UNAVAILABLE` khi version thiếu session tải lên #165, `400 EXTERNAL_PROVIDER_CONSENT_REQUIRED`, `400 SOURCE_LANGUAGE_MISMATCH`, `400 IDENTICAL_LANGUAGES`) |
| `GET` | `/api/v1/ai/jobs/:id` | Auth: Story Translator / Story Editor / Story Owner / Global Admin, Params: `id` | `200 OK` + `{ job, context, reviewSummary: { ... reviewSummary, resultPageCount? }, permissions: { canApply }, glossarySnapshot?, error? }` |
| `GET` | `/api/v1/ai/jobs/:id/previews` | Auth: Story Translator / Story Editor / Story Owner / Global Admin, Params: `id` (UUID), Query: `pageNumber` HOẶC `fromPage` & `toPage` (bounded $\le 5$ trang) | `200 OK` + `TranslationJobPreviewsResponse` (`{ workspaceRevision, sourceAssets, resultAssets }`) |
| `GET` | `/api/v1/ai/jobs/:id/segments` | Auth: Story Translator / Story Editor / Story Owner / Global Admin, Params: `id` (UUID), Query: `page`, `limit`, `pageNumber?` | `200 OK` + `TranslationJobSegmentsResponse` (`{ data: TranslationSegmentDto[], pagination, workspaceRevision }`) |
| `PATCH`| `/api/v1/ai/jobs/:jobId/segments/:segmentId` | Auth: Story Member (`OWNER`/`EDITOR`/`TRANSLATOR`) / Global Admin, Params: `jobId` (UUID-v4), `segmentId` (UUID-v4), Body: `{ translatedText?: string (max 50k), isHumanVerified?: boolean, expectedVersion: number (min 1, max 2147483647) }` | `200 OK` + `TranslationSegmentDto` (Errors: `400 EMPTY_MUTATION`, `400 ANCHOR_TOPOLOGY_VIOLATION`, `400 Validation/Immutable field`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 VERSION_CONFLICT` kèm `meta: { currentVersion, expectedVersion }`, `409 NOT_REVIEWABLE`) |
| `POST` | `/api/v1/ai/jobs/:id/cancel` | Auth: Story Translator / Story Editor / Story Owner / Global Admin, Params: `id` (UUID) | `200 OK` + `{ jobId, status: 'CANCELED' }` |
| `POST` | `/api/v1/ai/jobs/:id/apply` | Header: `Idempotency-Key` (UUID-v4), Auth: Story Editor / Story Owner / Global Admin, Params: `id` (UUID), Body: `{ mode: 'OVERWRITE_ACTIVE_VERSION' \| 'CREATE_ALTERNATE_VERSION' }` | `200 OK` + `ApplyTranslationJobResponse` (Errors: `409 ARTIFACT_STALE` khi `materializedRevision !== reviewRevision` kèm `meta: { reviewRevision, materializedRevision }`, `400 / 409 NOT_READY`) |
| `POST` | `/api/v1/ai/jobs/:id/materializations` | Auth: Story Translator / Story Editor / Story Owner / Global Admin, Params: `id` (UUID) | `202 Accepted` + `{ status: 'ENQUEUED' \| 'ALREADY_ENQUEUED', targetRevision }` HOẶC `200 OK` + `{ status: 'ALREADY_FRESH', targetRevision }` (Errors: `403 FORBIDDEN` cho `UPLOADER`, `409 NOT_REVIEWABLE`, `409 REVISION_INVARIANT_VIOLATION`) |
| `GET` | `/api/v1/ai/glossary` | Auth: Story Translator / Story Editor / Story Owner / Global Admin, Query: `projectId` (UUID) | `200 OK` + `TranslationGlossaryItemDto[]` |
| `POST` | `/api/v1/ai/glossary` | Auth: Story Translator / Story Editor / Story Owner / Global Admin, Body: `{ projectId, sourceTerm (1..100), targetTerm (1..100), category? (<=50) }` | `201 Created` + `TranslationGlossaryItemDto` (Exact-upsert semantics, whitespace normalized #189 & #151) |
| `POST` | `/internal/v1/ai/jobs/:id/events` | Header: `X-Internal-Service-Key`, Body: `{ eventId, attemptNumber, sequence, stage, progress, resultManifest, segments }` | `200 OK` + `{ received: true, status, sequence }` |
| `POST` | `/internal/v1/ai/jobs/:id/materializations/complete` | Header: `X-Internal-Service-Key`, Params: `id` (UUID), Body: `{ targetRevision, mediaFormat, result }` | `200 OK` + `{ outcome: 'APPLIED' \| 'ALREADY_APPLIED' \| 'STALE_DISCARDED', targetRevision, materializedRevision }` (Errors: `400 ARTIFACT_SIZE_MISMATCH`, `400 PREFIX_JAIL_VIOLATION`, `400 ARTIFACT_NOT_FOUND_IN_STORAGE`, `409 MATERIALIZATION_RESULT_CONFLICT`) |

### 3.6. Phân Hệ Gamification & Sổ Cái (Gamification)
| Method | Endpoint | Yêu Cầu Header / Body | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/gamification/progression` | Auth: Bearer Token | `200 OK` + `{ level: 12, totalExp: 8450, currentLevelExp: 450, nextLevelExp: 900, omnicoinBalance: 428, streak: 7, rankTitle: "Kim Đan Kỳ" }` |
| `POST` | `/api/v1/gamification/checkin` | Header: `Idempotency-Key`, Auth: Bearer Token | `200 OK` + `{ coinsEarned: 5, expEarned: 10, newStreak: 7 }` |
| `PATCH`| `/api/v1/gamification/rank-theme` | Auth: Bearer Token, Body: `{ themeId: 'TU_TIEN' \| 'GAME' \| 'DEMON_KING' \| 'MAGICIAN' \| 'SCI_FI' }` | `200 OK` + `{ activeTheme, rankTitle }` |
| `POST` | `/api/v1/gamification/rewards/claim`| Header: `Idempotency-Key`, Auth: Bearer Token, Body: `{ milestoneLevel: 10 }` | `200 OK` + `{ rewardCoins: 100, claimedAt }` |
| `GET` | `/api/v1/gamification/transactions` | Auth: Bearer Token, Query: `page`, `limit`, `rewardType: 'EXP' \| 'OMNICOIN'` | `200 OK` + `{ transactions: [...], pagination }` |

### 3.7. Phân Hệ Quản Trị Hệ Thống (Admin)
| Method | Endpoint | Yêu Cầu Header / Body | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/admin/reports` | Auth: Global Admin, Query: `status: PENDING \| RESOLVED` | `200 OK` + `{ reports: [...] }` |
| `PATCH`| `/api/v1/admin/reports/:id/resolve`| Auth: Global Admin, Body: `{ resolutionNote }` | `200 OK` + `{ reportId, status: 'RESOLVED' }` |
| `PATCH`| `/api/v1/admin/users/:id/role` | Auth: Global Admin, Body: `{ role: 'READER' \| 'TRANSLATOR' \| 'ADMIN' }` | `200 OK` + `{ userId, newRole }` |

---

## 4. GIAO THỨC WEBSOCKET TIẾN TRÌNH DỊCH THUẬT (SANITIZED & RECONNECT-AWARE)

Giao thức WebSocket (`/ws/ai`) sử dụng Socket.IO với JWT Authentication qua `socket.handshake.auth.token`. Toàn bộ payload được khử khuẩn nghiêm ngặt (sanitized), loại bỏ hoàn toàn raw manifests, internal S3 keys, error traces và canaries (#166):

```
Client ──[ Connect & Handshake (JWT Auth) ]──> WebSocket Gateway (/ws/ai)
Client ──[ Subscribe Event: { event: "subscribe_job", data: { jobId: "job-123" } } ]──> Gateway
Server ──[ Emit: "job_progress", payload: { jobId, status, progress, heartbeatAt?, timestamp } ]──> Client
Server ──[ Emit: "job_ready_for_review", payload: { jobId, status: 'READY_FOR_REVIEW', timestamp } ]──> Client
Server ──[ Emit: "job_failed", payload: { jobId, status: 'FAILED', timestamp } ]──> Client
Server ──[ Emit: "job_canceled", payload: { jobId, status: 'CANCELED', timestamp } ]──> Client
```
* **Chính sách Reconnection & Source of Truth:** WebSocket đóng vai trò là tín hiệu đánh thức thời gian thực (realtime acceleration signal). HTTP GET endpoints (`/api/v1/ai/jobs/:id`) là Source of Truth tối cao (authoritative truth). Khi socket reconnect hoặc token xoay vòng, Client tự động kết nối lại và kích hoạt reconciliation HTTP an toàn.


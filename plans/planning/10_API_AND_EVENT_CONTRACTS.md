# 🔌 10. Hợp Đồng Giao Tiếp API, WebSocket & Chuẩn Phản Hồi Lỗi

Tài liệu này đặc tả toàn bộ RESTful API Endpoints phiên bản `/api/v1`, cấu trúc Request/Response Body schemas, chính sách khóa trùng lặp (**Idempotency Policy**), chuẩn phản hồi lỗi JSON và giao thức WebSocket.

---

## 1. CHUẨN PHẢN HỒI LỖI (STANDARD ERROR RESPONSE FORMAT)

Toàn bộ các API khi gặp lỗi bắt buộc phải trả về định dạng JSON chuẩn:

```json
{
  "error": {
    "code": "TRANSLATION_JOB_NOT_READY",
    "message": "Tác vụ dịch thuật chưa hoàn tất để thực hiện xuất bản.",
    "requestId": "req-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "timestamp": "2026-08-22T19:00:00.000Z",
    "details": [
      {
        "field": "job_id",
        "issue": "Job is currently in OCR stage (45%)"
      }
    ]
  }
}
```

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
| `GET` | `/api/v1/stories` | Query: `genre`, `format`, `status`, `page`, `limit` | `200 OK` + `{ data: [...], pagination }` |
| `GET` | `/api/v1/stories/featured` | None | `200 OK` + `{ hotStories: [...], banners: [...] }` |
| `GET` | `/api/v1/stories/recent` | Query: `page`, `limit` | `200 OK` + `{ recentStories: [...] }` |
| `GET` | `/api/v1/stories/rankings` | Query: `timeframe: daily \| weekly \| monthly` | `200 OK` + `{ rankings: [...] }` |
| `GET` | `/api/v1/stories/search` | Query: `q` (từ khóa debounce 300ms) | `200 OK` + `{ results: [...] }` (Tối đa 10) |
| `GET` | `/api/v1/stories/:slug` | Params: `slug` | `200 OK` + `{ story, editions, volumes, chapters }` |
| `PATCH`| `/api/v1/stories/:id/visibility` | Auth: Story Owner / Global Admin, Body: `{ visibility: 'PUBLIC' \| 'UNLISTED' \| 'PRIVATE' }` | `200 OK` + `{ storyId, visibility }` |

### 3.3. Phân Hệ Quản Trị Thành Viên Bộ Truyện (Story Members CRUD)
| Method | Endpoint | Yêu Cầu Body / Header | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/stories/:id/members` | Auth: Bearer Token | `200 OK` + `{ members: [...] }` |
| `POST` | `/api/v1/stories/:id/members` | Auth: Story Owner / Admin, Body: `{ userId, role: 'EDITOR' \| 'TRANSLATOR' \| 'UPLOADER' }` | `201 Created` + `{ member }` |
| `PATCH`| `/api/v1/stories/:id/members/:userId` | Auth: Story Owner / Admin, Body: `{ role }` | `200 OK` + `{ updatedMember }` |
| `DELETE`| `/api/v1/stories/:id/members/:userId` | Auth: Story Owner / Admin | `200 OK` + `{ success: true }` |

### 3.4. Phân Hệ Trình Đọc & Tủ Sách (Reader & Library)
| Method | Endpoint | Yêu Cầu Query / Body | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/chapters/:id` | Params: `id`, Query: `versionId` (optional) | `200 OK` + `{ chapter, activeVersion, pages/content }` |
| `POST` | `/api/v1/chapters/:id/reports` | Auth: Reader, Body: `{ pageNumber, errorType, description }` | `201 Created` + `{ reportId }` |
| `GET` | `/api/v1/library` | Auth: Bearer Token | `200 OK` + `{ bookmarks: [...], history: [...] }` |
| `POST` | `/api/v1/library/progress` | Body: `{ storyId, chapterId, pageIndex, anchorBlockId, textOffset }` | `200 OK` + `{ syncedAt }` |
| `POST` | `/api/v1/library/bookmarks`| Body: `{ storyId, isBookmarked: boolean }` | `200 OK` + `{ isBookmarked, followersCount }` |

### 3.5. Phân Hệ Studio & Dịch Thuật AI (Studio & AI)
| Method | Endpoint | Yêu Cầu Body / Header | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/studio/stories` | Auth: Global Translator / Global Admin | `200 OK` + `{ managedStories: [...] }` |
| `POST` | `/api/v1/studio/stories` | Auth: Global Translator / Admin, Body: `{ title, mediaFormat, publicationFormat, originCountry, originalLanguage, summary, coverUrl }` | `201 Created` + `{ storyId }` |
| `POST` | `/api/v1/studio/stories/:id/editions` | Auth: Story Owner / Admin, Body: `{ editionName, language, isDefault }` | `201 Created` + `{ editionId }` |
| `POST` | `/api/v1/studio/editions/:id/volumes` | Auth: Story Editor / Owner / Admin, Body: `{ volumeNumber, title, coverUrl }` | `201 Created` + `{ volumeId }` |
| `POST` | `/api/v1/studio/volumes/:id/chapters` | Auth: Story Editor / Owner / Admin, Body: `{ chapterNumber, title }` | `201 Created` + `{ chapterId }` |
| `POST` | `/api/v1/uploads/sessions`| Auth: Story Uploader / Translator / Editor / Owner, Body: `{ storyEditionId, chapterNumber, fileType: 'ZIP' \| 'TEXT' \| 'EPUB' \| 'MARKDOWN', fileSize }` | `201 Created` + `{ uploadId, presignedUrls: [...] }` |
| `POST` | `/api/v1/ai/jobs` | Header: `Idempotency-Key`, Auth: Story Translator / Editor / Owner, Body: `{ chapterVersionId, sourceLang, targetLang, provider }` | `202 Accepted` + `{ jobId, status: 'QUEUED' }` |
| `GET` | `/api/v1/ai/jobs/:id` | Params: `id` | `200 OK` + `{ job, segments, diffPreviewUrls }` |
| `POST` | `/api/v1/ai/jobs/:id/apply` | Header: `Idempotency-Key`, Auth: Story Editor / Story Owner / Global Admin, Body: `{ mode: 'OVERWRITE_ACTIVE_VERSION' \| 'CREATE_ALTERNATE_VERSION' }` | `200 OK` + `{ chapterId, activeVersionId, versionNumber }` |
| `GET/POST` | `/api/v1/ai/glossary` | Auth: Story Translator / Editor / Owner, Body (POST): `{ projectId, sourceTerm, targetTerm, category }` | `200 OK / 201 Created` + `{ glossaryTerm }` |

### 3.6. Phân Hệ Gamification & Sổ Cái (Gamification)
| Method | Endpoint | Yêu Cầu Header / Body | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/gamification/progression` | Auth: Bearer Token | `200 OK` + `{ level: 12, totalExp: 8450, currentLevelExp: 450, nextLevelExp: 900, omnicoinBalance: 428, streak: 7, rankTitle: "Kim Đan Kỳ" }` |
| `POST` | `/api/v1/gamification/checkin` | Header: `Idempotency-Key`, Auth: Bearer | `200 OK` + `{ coinsEarned: 5, expEarned: 10, newStreak: 7 }` |
| `PATCH`| `/api/v1/gamification/rank-theme` | Body: `{ themeId: 'TU_TIEN' \| 'GAME' \| 'DEMON_KING' }` | `200 OK` + `{ activeTheme, rankTitle }` |
| `POST` | `/api/v1/gamification/rewards/claim`| Header: `Idempotency-Key`, Body: `{ milestoneLevel: 10 }` | `200 OK` + `{ rewardCoins: 100, claimedAt }` |
| `GET` | `/api/v1/gamification/transactions` | Query: `page`, `limit`, `rewardType: 'EXP' \| 'OMNICOIN'` | `200 OK` + `{ transactions: [...], pagination }` |

### 3.7. Phân Hệ Quản Trị Hệ Thống (Admin)
| Method | Endpoint | Yêu Cầu Header / Body | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/admin/reports` | Auth: Global Admin, Query: `status: PENDING \| RESOLVED` | `200 OK` + `{ reports: [...] }` |
| `PATCH`| `/api/v1/admin/reports/:id/resolve`| Auth: Global Admin, Body: `{ resolutionNote }` | `200 OK` + `{ reportId, status: 'RESOLVED' }` |
| `PATCH`| `/api/v1/admin/users/:id/role` | Auth: Global Admin, Body: `{ role: 'READER' \| 'TRANSLATOR' \| 'ADMIN' }` | `200 OK` + `{ userId, newRole }` |

---

## 4. GIAO THỨC WEBSOCKET TIẾN TRÌNH DỊCH THUẬT (RECONNECT-AWARE)

```
Client ──[ Connect & Handshake (JWT Auth) ]──> WebSocket Gateway (/ws/ai)
Client ──[ Subscribe Event: { event: "subscribe_job", data: { jobId: "job-123" } } ]──> Gateway
Server ──[ Emit: "job_progress", payload: { stage: "OCR", current: 15, total: 30, overall: 45 } ]──> Client
Server ──[ Emit: "job_completed", payload: { jobId: "job-123", previewReady: true } ]──> Client
```
* **Chính sách Reconnection:** Nếu kết nối WebSocket bị đứt, Client tự động kết nối lại theo Exponential Backoff (1s, 2s, 4s, tối đa 10s) và gọi `GET /api/v1/ai/jobs/:id` để lấy trạng thái mới nhất từ Redis/DB.

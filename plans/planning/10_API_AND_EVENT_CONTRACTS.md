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

Đối với các endpoint có tính nhạy cảm về giao dịch điểm hoặc tác vụ nặng:
* `POST /api/v1/gamification/checkin`
* `POST /api/v1/gamification/rewards/claim`
* `POST /api/v1/ai/jobs`
* `POST /api/v1/ai/jobs/:id/apply`

Client bắt buộc phải gửi kèm HTTP Header:
```http
Idempotency-Key: <UUID-v4-generated-by-client>
```
Hệ thống sử dụng Redis `SETNX` với TTL 120 giây để đảm bảo nếu mạng bị retry hoặc người dùng bấm 2 lần thì chỉ duy nhất một request đầu tiên được thực thi.

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
| `GET` | `/api/v1/stories/rankings` | Query: `timeframe: daily | weekly | monthly` | `200 OK` + `{ rankings: [...] }` |
| `GET` | `/api/v1/stories/search` | Query: `q` (từ khóa debounce 300ms) | `200 OK` + `{ results: [...] }` (Tối đa 10) |
| `GET` | `/api/v1/stories/:slug` | Params: `slug` | `200 OK` + `{ story, editions, volumes, chapters }` |

### 3.3. Phân Hệ Trình Đọc & Tủ Sách (Reader & Library)
| Method | Endpoint | Yêu Cầu Query / Body | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/chapters/:id` | Params: `id`, Query: `versionId` (optional) | `200 OK` + `{ chapter, activeVersion, pages/content }` |
| `GET` | `/api/v1/library` | Auth: Bearer Token | `200 OK` + `{ bookmarks: [...], history: [...] }` |
| `POST` | `/api/v1/library/progress` | Body: `{ storyId, chapterId, pageIndex, anchorBlockId, textOffset }` | `200 OK` + `{ syncedAt }` |
| `POST` | `/api/v1/library/bookmarks`| Body: `{ storyId, isBookmarked: boolean }` | `200 OK` + `{ isBookmarked, followersCount }` |

### 3.4. Phân Hệ Studio & Dịch Thuật AI (Studio & AI)
| Method | Endpoint | Yêu Cầu Body / Header | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/studio/stories` | Auth: Translator/Admin | `200 OK` + `{ managedStories: [...] }` |
| `POST` | `/api/v1/studio/stories` | Body: `{ title, mediaFormat, originCountry, summary, coverUrl }` | `201 Created` + `{ storyId }` |
| `POST` | `/api/v1/uploads/sessions`| Body: `{ storyEditionId, chapterNumber, fileType: 'ZIP' \| 'TEXT', fileSize }` | `201 Created` + `{ uploadId, presignedUrls: [...] }` |
| `POST` | `/api/v1/ai/jobs` | Header: `Idempotency-Key`, Body: `{ chapterVersionId, sourceLang, targetLang, provider }` | `202 Accepted` + `{ jobId, status: 'QUEUED' }` |
| `GET` | `/api/v1/ai/jobs/:id` | Params: `id` | `200 OK` + `{ job, segments, diffPreviewUrls }` |
| `POST` | `/api/v1/ai/jobs/:id/apply` | Header: `Idempotency-Key`, Body: `{ mode: 'OVERWRITE_ACTIVE_VERSION' \| 'CREATE_ALTERNATE_VERSION' }` | `200 OK` + `{ chapterId, activeVersionId, versionNumber }` |
| `GET/POST` | `/api/v1/ai/glossary` | Body (POST): `{ projectId, sourceTerm, targetTerm, category }` | `200 OK / 201 Created` + `{ glossaryTerm }` |

### 3.5. Phân Hệ Gamification & Sổ Cái (Gamification)
| Method | Endpoint | Yêu Cầu Header / Body | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/gamification/progression` | Auth: Bearer Token | `200 OK` + `{ level, currentExp, nextLevelExp, omnicoinBalance, streak, rankTitle }` |
| `POST` | `/api/v1/gamification/checkin` | Header: `Idempotency-Key`, Auth: Bearer | `200 OK` + `{ coinsEarned: 5, expEarned: 10, newStreak: 7 }` |
| `PATCH`| `/api/v1/gamification/rank-theme` | Body: `{ themeId: 'TU_TIEN' \| 'GAME' \| 'DEMON_KING' }` | `200 OK` + `{ activeTheme, rankTitle }` |
| `POST` | `/api/v1/gamification/rewards/claim`| Header: `Idempotency-Key`, Body: `{ milestoneLevel: 10 }` | `200 OK` + `{ rewardCoins: 100, claimedAt }` |
| `GET` | `/api/v1/gamification/transactions` | Query: `page`, `limit`, `rewardType: 'EXP' \| 'OMNICOIN'` | `200 OK` + `{ transactions: [...], pagination }` |

### 3.6. Phân Hệ Quản Trị Hệ Thống (Admin)
| Method | Endpoint | Yêu Cầu Header / Body | Response Thành Công |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/admin/reports` | Auth: Admin, Query: `status: PENDING \| RESOLVED` | `200 OK` + `{ reports: [...] }` |
| `PATCH`| `/api/v1/admin/reports/:id/resolve`| Body: `{ resolutionNote }` | `200 OK` + `{ reportId, status: 'RESOLVED' }` |
| `PATCH`| `/api/v1/admin/users/:id/role` | Body: `{ role: 'READER' \| 'TRANSLATOR' \| 'ADMIN' }` | `200 OK` + `{ userId, newRole }` |

---

## 4. GIAO THỨC WEBSOCKET TIẾN TRÌNH DỊCH THUẬT (RECONNECT-AWARE)

```
Client ──[ Connect & Handshake (JWT Auth) ]──> WebSocket Gateway (/ws/ai)
Client ──[ Subscribe Event: { event: "subscribe_job", data: { jobId: "job-123" } } ]──> Gateway
Server ──[ Emit: "job_progress", payload: { stage: "OCR", current: 15, total: 30, overall: 45 } ]──> Client
Server ──[ Emit: "job_completed", payload: { jobId: "job-123", previewReady: true } ]──> Client
```
* **Chính sách Reconnection:** Nếu kết nối WebSocket bị đứt, Client tự động kết nối lại theo Exponential Backoff (1s, 2s, 4s, tối đa 10s) và gọi `GET /api/v1/ai/jobs/:id` để lấy trạng thái mới nhất từ Redis/DB.

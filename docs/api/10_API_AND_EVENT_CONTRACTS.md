# 🔌 10. Hợp Đồng Giao Tiếp API, WebSocket & Chuẩn Phản Hồi Lỗi

Tài liệu này đặc tả toàn bộ RESTful API Endpoints phiên bản `/api/v1`, cấu trúc chuẩn của Request/Response, cơ chế kiểm soát lỗi (Standard Error Response) và giao thức WebSocket.

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

## 2. DANH MỤC RESTFUL API ENDPOINTS CHÍNH (/api/v1)

| Method | Endpoint | Mô Tả & Header Yêu Cầu | Response Success | Error Codes |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/auth/login` | Đăng nhập tài khoản | `200 OK` + `{ accessToken, user }` | `AUTH_INVALID_CREDENTIALS` |
| `GET` | `/api/v1/stories` | Danh sách truyện có phân trang, filter | `200 OK` + `{ data: [...], meta }` | `INVALID_QUERY_PARAMS` |
| `GET` | `/api/v1/stories/:slug` | Chi tiết truyện kèm danh sách chapter | `200 OK` + `{ story, volumes }` | `STORY_NOT_FOUND` |
| `GET` | `/api/v1/chapters/:id` | Lấy nội dung đọc (Kèm HMAC Signed URLs) | `200 OK` + `{ chapter, pages/content }` | `CHAPTER_NOT_FOUND` |
| `POST` | `/api/v1/uploads/sessions` | Khởi tạo Resumable Upload Session | `201 Created` + `{ uploadId, parts }` | `QUOTA_EXCEEDED` |
| `POST` | `/api/v1/ai/jobs` | Tạo Task dịch AI cho một ChapterVersion | `202 Accepted` + `{ jobId, status }` | `JOB_ALREADY_EXISTS` |
| `GET` | `/api/v1/ai/jobs/:id` | Lấy tiến trình dịch và Diff Preview | `200 OK` + `{ job, segments }` | `JOB_NOT_FOUND` |
| `POST` | `/api/v1/ai/jobs/:id/apply` | Áp dụng Ghi đè hoặc Nhân bản | `200 OK` + `{ chapterId, activeVersion }` | `JOB_NOT_READY` |

---

## 3. GIAO THỨC WEBSOCKET TIẾN TRÌNH DỊCH THUẬT (RECONNECT-AWARE MODEL)

```
Client ──[ Connect & Auth Token ]──> WebSocket Gateway
Client ──[ Subscribe: "translation:job-123" ]──> Gateway
Server ──[ Event: "job_progress", payload: { stage: "OCR", current: 15, total: 30, overall: 45 } ]──> Client
Server ──[ Event: "job_completed", payload: { jobId: "job-123", previewUrl: "..." } ]──> Client
```
* **Chính sách Mất kết nối (Reconnect Model):** Nếu mất mạng, Client kết nối lại chỉ cần gửi `GET /api/v1/ai/jobs/:id` để lấy trạng thái mới nhất từ PostgreSQL/Redis, sau đó tiếp tục lắng nghe WebSocket.

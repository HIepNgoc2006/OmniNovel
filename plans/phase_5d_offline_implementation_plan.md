# 📱 Phase 5D: Lưu Trữ Offline (MOB-012) & Hoàn Thiện Nghiệm Thu — Kế Hoạch Kỹ Thuật Chi Tiết

> **Trạng thái:** DRAFT FOR REVIEW  
> **Tài liệu cha:** [plans/phases/phase_05_mobile_app.md](file:///e:/Workspace%202/Doctruyen_project/plans/phases/phase_05_mobile_app.md)  
> **Master Tracker:** [GitHub Issue #192](https://github.com/HIepNgoc2006/OmniNovel/issues/192)  
> **Backend Prerequisite:** [GitHub Issue #190](https://github.com/HIepNgoc2006/OmniNovel/issues/190) — *Canonical Reverse Packaging*  
> **Mobile Feature:** MOB-012 — *Offline Download Manager & Reader Storage Engine*  

---

## 1. TỔNG QUAN & MỤC TIÊU (EXECUTIVE SUMMARY)

Phase 5D là chặng cuối cùng của **Phase 5: Ứng dụng Di động OmniNovel (Flutter Android-First)**. Mục tiêu cốt lõi:
1. **Backend Core API ([Issue #190](https://github.com/HIepNgoc2006/OmniNovel/issues/190)):** Triển khai *Canonical Reverse Packaging Service* để tổng hợp các `MediaAsset`s rời rạc của các `ChapterVersion` cũ (legacy upload) thành các gói artifact chuẩn lưu trên MinIO/S3, giải quyết dứt điểm rào cản `#165` cho Translation Worker và cung cấp endpoint tải gói offline cho Mobile.
2. **Mobile Client (MOB-012):** Xây dựng hạ tầng *Durable Download Manager* và *Offline Storage Engine* trên Flutter, cho phép độc giả tải chương truyện về máy, lưu trữ an toàn trong sandbox ứng dụng, và tự động chuyển đổi sang chế độ đọc ngoại tuyến (Offline Reader Mode) mượt mà 120Hz khi không có mạng Internet.
3. **Hardware Acceptance Gate:** Thực hiện nghiệm thu đo đạc phần cứng thực địa trên thiết bị Android vật lý (RAM 2–3GB và 4–6GB) nhằm chốt chuẩn RAM RSS $< 150\text{ MB}$ và Frame Budget 120Hz/90Hz/60Hz trước khi chuyển giao sang Phase 6.

---

## 2. SÁU BẤT BIẾN KIẾN TRÚC BẮT BUỘC (6 CORE INVARIANTS)

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                           6 CORE ARCHITECTURAL INVARIANTS                         │
├─────────────────────────┬─────────────────────────┬───────────────────────────────┤
│ 1. Exact-Version Bind   │ 2. Canonical Manifest   │ 3. Lifecycle & Single-Flight  │
│ • chapterVersionId SSoT │ • Zero presigned URLs   │ • MISSING➔BUILDING➔READY      │
│ • Content SHA-256 hash  │ • Relative path files[] │ • Distributed Redis Lock      │
├─────────────────────────┼─────────────────────────┼───────────────────────────────┤
│ 4. Atomic Publish/Verify│ 5. DB / File Boundary   │ 6. Queue State Machine        │
│ • Upload S3 ➔ Atomic DB │ • SQLite metadata only  │ • QUEUED➔DOWNLOADING➔VERIFYING│
│ • Stream .part ➔ Promote│ • App-Private Sandbox   │ • Crash recovery & idempotency│
└─────────────────────────┴─────────────────────────┴───────────────────────────────┘
```

### Invariant 1: Exact-Version Artifact Identity (Ràng Buộc Phiên Bản Tuyệt Đối)
- Mọi gói artifact đóng gói (cả Translation Source và Offline Bundle) **BẮT BUỘC bind trực tiếp vào `chapterVersionId` (bất biến)**, tuyệt đối **KHÔNG bind vào `chapter.activeVersionId` (khả biến)**.
- Khi người dùng hoặc Editor cập nhật/thay đổi phiên bản active của chapter, các gói offline đã tải của version cũ vẫn toàn vẹn về mặt dữ liệu.
- Định danh tệp trên MinIO/S3 được chuẩn hóa:
  - Mobile Offline Bundle: `artifacts/chapters/:chapterId/versions/:chapterVersionId/offline-bundle.zip`
  - Translation Source: `artifacts/chapters/:chapterId/versions/:chapterVersionId/source-package.zip`
- Mỗi artifact hoàn chỉnh phải có **SHA-256 hash** và **kích thước byte chính xác (`fileSizeBytes`)** được lưu cố định trong CSDL.

### Invariant 2: Canonical Manifest Format (Định Dạng Manifest Chuẩn Hóa)
- Tệp `manifest.json` nằm tại thư mục gốc bên trong gói ZIP offline.
- **Ràng buộc nghiêm ngặt:** Tuyệt đối **KHÔNG chứa Signed URLs có hạn sử dụng** bên trong bundle offline! Mọi tệp tin hình ảnh/nội dung đều được tham chiếu theo **đường dẫn tương đối cục bộ (relative path)** bên trong tệp nén (`pages/001.webp`, `content.html`, `novel.json`).
- Cấu trúc chuẩn của `manifest.json` (Schema Version 1):
  ```json
  {
    "schemaVersion": 1,
    "bundleType": "OFFLINE_READER",
    "chapterId": "c0a80123-4567-89ab-cdef-0123456789ab",
    "chapterVersionId": "d0b90123-4567-89ab-cdef-0123456789cd",
    "storyId": "a0a10123-4567-89ab-cdef-0123456789ef",
    "storyTitle": "Thần Đạo Đan Tôn",
    "chapterNumber": "150",
    "chapterTitle": "Đột phá Cảnh giới",
    "mediaFormat": "COMIC",
    "publicationFormat": "WEBTOON",
    "language": "vi",
    "versionNumber": 2,
    "versionType": "HUMAN_EDITED",
    "createdAt": "2026-09-24T14:00:00.000Z",
    "files": [
      {
        "path": "pages/001.webp",
        "assetId": "e0c10123-4567-89ab-cdef-0123456789aa",
        "mimeType": "image/webp",
        "size": 245100,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "sortOrder": 1,
        "width": 1080,
        "height": 2400
      }
    ],
    "novelMetadata": null
  }
  ```
- Đối với tiểu thuyết (`mediaFormat: "NOVEL"`): trường `novelMetadata` lưu danh sách `anchorBlocks` và đoạn text thô/HTML đã được tách định danh tương thích 100% với `NovelReaderView` và `NovelSettingsController`.

### Invariant 3: Artifact Lifecycle & Single-Flight Idempotency (Vòng Đời & Đóng Gói Đồng Quy)
- Vòng đời artifact trên Backend được quản lý qua State Machine nghiêm ngặt:
  $$\text{MISSING} \longrightarrow \text{BUILDING} \longrightarrow \text{READY} \quad \text{hoặc} \quad \text{FAILED}$$
- `artifactReady: boolean` trả về trên API là **projection tương thích** (`status === 'READY'`).
- **Single-Flight Concurrency Guard:** Khi có nhiều request đồng thời (ví dụ: nhiều thiết bị mobile cùng bấm tải một chapter chưa được đóng gói), hệ thống sử dụng **Redis Distributed Lock** (`lock:package:chapter_version:${chapterVersionId}:${artifactType}`) với TTL an toàn 300s:
  - Request đầu tiên giành được Lock: chuyển trạng thái sang `BUILDING` và kích hoạt Worker đóng gói.
  - Các request tiếp theo: nhận ngay trạng thái `202 Accepted` với body `{ status: 'BUILDING', retryAfter: 5 }`, không tạo tác vụ trùng lặp.
- Cơ chế Idempotent: Nếu trạng thái đã là `READY`, lập tức trả về URL tải về mà không đóng gói lại.

### Invariant 4: Atomic Publish & Integrity Verification (Phát Hành Nguyên Tử & Toàn Vẹn)
- **Backend Atomic Publish:**
  1. Tổng hợp các tệp từ S3 hoặc DB vào tệp ZIP tạm thời trên ổ cứng worker.
  2. Tính toán mã băm SHA-256 và kích thước byte thực tế của tệp ZIP.
  3. Upload tệp ZIP lên MinIO/S3 theo đúng canonical key.
  4. Thực hiện transaction CSDL chuyển trạng thái `chapter_artifacts` sang `READY` kèm `storageKey`, `sha256`, `fileSizeBytes`.
  5. Xóa tệp tạm thời trên worker.
  6. Nếu xảy ra bất kỳ lỗi nào ở bước 1–3: chuyển trạng thái `FAILED`, dọn sạch tệp mồ côi trên MinIO/worker.
- **Mobile Atomic Promotion:**
  1. Stream tải gói về tệp tạm: `downloads/tmp/<chapterVersionId>.part`.
  2. Vừa tải vừa tính mã băm SHA-256 (hoặc tính sau khi stream hoàn tất).
  3. Đối chiếu SHA-256 và `fileSizeBytes` với thông tin do Backend cung cấp trong header/API. Nếu sai lệch: lập tức xóa tệp `.part` và ném lỗi `CHECKSUM_MISMATCH`.
  4. Giải nén vào thư mục staging: `offline/staging/<chapterVersionId>/`.
  5. Kiểm tra tệp `manifest.json` hợp lệ và đối chiếu SHA-256 từng tệp con trong `files[]`.
  6. **Atomic Rename/Promote:** Đổi tên thư mục staging thành thư mục chính thức `offline/installed/<chapterVersionId>/`.
  7. Thực thi transaction SQLite ghi nhận chương đã sẵn sàng (`status = 'READY'`).
  8. Xóa tệp `.part`.
  9. *Chống trạng thái giả:* Nếu app bị crash/tắt đột ngột ở bất kỳ bước nào từ 1–6, khi khởi động lại, thư mục `staging` hoặc file `.part` sẽ bị dọn dẹp, SQLite vẫn giữ trạng thái `FAILED` hoặc `PAUSED`, tuyệt đối không có "chương READY giả".

### Invariant 5: Offline DB / File Boundary & Security Architecture (Ranh Giới Bảo Mật)
- **Ranh giới CSDL vs Hệ thống Tệp:**
  - **CSDL SQLite (`sqflite`):** Lưu trữ metadata cấu trúc, chỉ mục tìm kiếm offline, lịch sử đọc checkpoint offline, hàng đợi tải (`download_tasks`), và bảng map `(assetId, relativePath)`.
  - **Hệ thống tệp (Filesystem):** Lưu trữ tệp ảnh WebP, tệp JSON manifest, tệp HTML truyện chữ.
- **Phân định rõ giải pháp mã hóa & Bộ nhớ Sandbox:**
  - `SQLCipher` chỉ mã hóa tệp CSDL `.db`, **KHÔNG mã hóa các tệp ảnh ngoài hệ thống tệp**.
  - **Quy chuẩn Bảo mật Phase 5D:** Toàn bộ nội dung ngoại tuyến được lưu trữ trong **Internal App-Private Storage Directory** (`context.filesDir` / `data/user/0/<package>/files/offline/`).
  - **Cơ chế Bảo vệ Tự nhiên của Android:**
    1. *Sandbox Permission:* Phân quyền hệ điều hành `0700` ngăn chặn 100% các ứng dụng khác truy cập vào dữ liệu nếu không có quyền root.
    2. *Hardware File-Based Encryption (FBE):* Android (minSdk 24 $\rightarrow$ targetSdk 36) tự động mã hóa toàn bộ phân vùng User Data bằng khóa phần cứng (Keystore / TEE) khi thiết bị ở trạng thái khóa màn hình.
    3. *Hiệu năng 120Hz:* Đọc trực tiếp tệp ảnh từ App-Private Storage qua `FileImage` mà không phải gánh chi phí CPU giải mã AES theo từng frame cuộn, đảm bảo giữ vững **Frame Budget $< 8.33\text{ ms}$** và RAM working-set $< 150\text{ MB}$.

### Invariant 6: Queue State Machine & Crash Recovery (Máy Trạng Thái Hàng Đợi & Phục Hồi Lỗi)
- Hàng đợi tải chương Mobile quản lý qua State Machine:
  $$\text{QUEUED} \longrightarrow \text{DOWNLOADING} \longrightarrow \text{VERIFYING} \longrightarrow \text{READY}$$
  Kèm các trạng thái ngắt/kết thúc: $\text{PAUSED}$, $\text{FAILED}$, $\text{CANCELLED}$.
- **Phục hồi sau Crash/Tắt App:**
  - Khi ứng dụng khởi động lại, `DownloadManager` quét CSDL SQLite:
    - Bất kỳ task nào đang ở trạng thái `DOWNLOADING` hoặc `VERIFYING` lập tức được chuyển thành `PAUSED` (hỗ trợ tiếp tục tải qua HTTP `Range` header nếu máy chủ hỗ trợ, hoặc tải lại từ đầu an toàn).
    - Xóa các thư mục rác `offline/staging/` còn sót lại do crash.
- **Thao tác Hủy (Cancel):**
  - Kích hoạt Dio `CancelToken.cancel()`.
  - Xóa ngay lập tức file `.part` và thư mục staging tương ứng.
  - Cập nhật bản ghi trong SQLite thành `CANCELLED` hoặc xóa bản ghi theo cấu hình dọn dẹp.
- **Thử lại (Retry):**
  - Thao tác Retry mang tính idempotent: tái sử dụng ID task cũ, reset số byte đã tải về 0, chuyển trạng thái về `QUEUED`, không sinh trùng lặp bản ghi.

---

## 3. PHÂN ĐỊNH RANH GIỚI CONTRACT: TRANSLATION SOURCE VS. OFFLINE READER BUNDLE

> [!IMPORTANT]
> **Quyết định Thiết kế:** Translation Source Package (cho AI Worker) và Offline Reader Bundle (cho Mobile) **dùng chung hạ tầng đóng gói (Packaging Infrastructure & MinIO Storage)** nhưng **phân tách thành 2 Artifact Types độc lập với Schema riêng biệt**.

| Đặc tính So sánh | Translation Source Package (AI Worker) | Offline Reader Bundle (Mobile MOB-012) |
| :--- | :--- | :--- |
| **Mục đích** | Phục vụ OCR, Text Detection và Inpainting | Phục vụ hiển thị Reader Webtoon/Manga/Novel ngoại tuyến |
| **Đối tượng tiêu thụ** | Python FastAPI AI Worker | Flutter Mobile App |
| **Artifact Type** | `TRANSLATION_SOURCE` | `OFFLINE_BUNDLE` |
| **Manifest bên trong** | `source_manifest.json` (tối giản: file list, raw language) | `manifest.json` chuẩn hóa (đầy đủ schema v1, SHA-256, sortOrder, width/height, Novel anchors) |
| **Định dạng Novel** | Tệp văn bản thô `.txt` / `.docx` / `.epub` | JSON chứa các `NovelAnchorBlock` đã parse sẵn cho Flutter DOM |
| **Hạ tầng Dùng chung** | `PackagingService`, MinIO S3 Bucket, TypeORM `ChapterArtifact`, Distributed Lock | `PackagingService`, MinIO S3 Bucket, TypeORM `ChapterArtifact`, Distributed Lock |

---

## 4. THIẾT KẾ CƠ SỞ DỮ LIỆU & LƯỢC ĐỒ (SCHEMA DESIGN)

### 4.1. Backend PostgreSQL: Bảng `chapter_artifacts` (Migration 17)
Bảng chuyên dụng quản lý tất cả các artifact phái sinh của `ChapterVersion`, thay thế việc lạm dụng trường `UploadSession` đơn lẻ.

```sql
-- Migration: 1700000000017-AddChapterArtifactsTable.ts

CREATE TYPE chapter_artifact_type_enum AS ENUM ('OFFLINE_BUNDLE', 'TRANSLATION_SOURCE');
CREATE TYPE chapter_artifact_status_enum AS ENUM ('MISSING', 'BUILDING', 'READY', 'FAILED');

CREATE TABLE chapter_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_version_id UUID NOT NULL REFERENCES chapter_versions(id) ON DELETE CASCADE,
    artifact_type chapter_artifact_type_enum NOT NULL,
    status chapter_artifact_status_enum NOT NULL DEFAULT 'MISSING',
    storage_key VARCHAR(255) NULL,
    file_size_bytes BIGINT NULL,
    sha256_hash VARCHAR(64) NULL,
    manifest_metadata JSONB NULL,
    error_message TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_chapter_version_artifact_type UNIQUE (chapter_version_id, artifact_type)
);

CREATE INDEX idx_chapter_artifacts_version_lookup ON chapter_artifacts(chapter_version_id, artifact_type);
```

### 4.2. Mobile SQLite: Lược đồ Lưu Trữ Ngoại Tuyến (Local SQLite Schema v1)

```sql
-- Quản lý các chương đã tải thành công
CREATE TABLE offline_chapters (
    chapter_version_id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL,
    story_id TEXT NOT NULL,
    story_title TEXT NOT NULL,
    chapter_number TEXT NOT NULL,
    chapter_title TEXT,
    media_format TEXT NOT NULL, -- 'COMIC' | 'NOVEL'
    publication_format TEXT,
    installed_dir TEXT NOT NULL, -- Đường dẫn tương đối trong App-Private storage
    total_files INTEGER NOT NULL,
    total_bytes INTEGER NOT NULL,
    installed_at INTEGER NOT NULL, -- Epoch ms
    last_read_at INTEGER,          -- Epoch ms (phục vụ LRU eviction)
    manifest_json TEXT NOT NULL    -- Raw manifest backup
);

-- Quản lý tiến trình hàng đợi tải xuống
CREATE TABLE download_tasks (
    task_id TEXT PRIMARY KEY,
    chapter_version_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    story_id TEXT NOT NULL,
    story_title TEXT NOT NULL,
    chapter_number TEXT NOT NULL,
    media_format TEXT NOT NULL,
    status TEXT NOT NULL, -- 'QUEUED' | 'DOWNLOADING' | 'VERIFYING' | 'READY' | 'PAUSED' | 'FAILED' | 'CANCELLED'
    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    progress_fraction REAL NOT NULL DEFAULT 0.0,
    download_url TEXT,
    sha256_hash TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Chỉ mục tối ưu truy vấn
CREATE INDEX idx_offline_chapters_story ON offline_chapters(story_id);
CREATE INDEX idx_offline_chapters_last_read ON offline_chapters(last_read_at);
CREATE INDEX idx_download_tasks_status ON download_tasks(status);
```

---

## 5. ĐẶC TẢ HỢP ĐỒNG API (API CONTRACTS & PROTOCOL)

### 5.1. Kiểm Tra Trạng Thái & Lấy URL Tải Về Artifact
- **Endpoint:** `GET /api/v1/chapters/:chapterId/versions/:versionId/artifact`
- **Query Params:** `?type=OFFLINE_BUNDLE` (mặc định) hoặc `?type=TRANSLATION_SOURCE`
- **Bảo mật:** `OptionalJwtAuthGuard` (hoặc `JwtAuthGuard` đối với private/draft chapter).
- **Phản hồi 200 OK (Artifact đã sẵn sàng):**
  ```json
  {
    "status": "READY",
    "artifactReady": true,
    "artifactType": "OFFLINE_BUNDLE",
    "chapterVersionId": "d0b90123-4567-89ab-cdef-0123456789cd",
    "downloadUrl": "https://storage.omninovel.local/omninovel-media/artifacts/chapters/...?X-Amz-Signature=...",
    "fileSizeBytes": 14502390,
    "sha256": "3a7b8c...",
    "expiresAt": "2026-09-24T15:00:00.000Z"
  }
  ```
- **Phản hồi 200 OK (Đang đóng gói hoặc chưa có):**
  ```json
  {
    "status": "BUILDING", // hoặc "MISSING" | "FAILED"
    "artifactReady": false,
    "artifactType": "OFFLINE_BUNDLE",
    "chapterVersionId": "d0b90123-4567-89ab-cdef-0123456789cd",
    "downloadUrl": null,
    "fileSizeBytes": null,
    "sha256": null,
    "retryAfter": 5
  }
  ```

### 5.2. Yêu Cầu Kích Hoạt Đóng Gói (Trigger Packaging)
- **Endpoint:** `POST /api/v1/chapters/:chapterId/versions/:versionId/package`
- **Headers:** `Authorization: Bearer <token>`
- **Body:** `{ "artifactType": "OFFLINE_BUNDLE" }`
- **Rate Limit:** 5 requests / 60s per-IP / user.
- **Phản hồi:**
  - `200 OK`: Nếu artifact đã `READY` (idempotent).
  - `202 Accepted`: Bắt đầu tiến trình đóng gói nền (background job/promise) kèm `{ "status": "BUILDING", "retryAfter": 5 }`.
  - `409 Conflict`: Phiên bản đang được đóng gói bởi worker khác (trả về trạng thái `BUILDING`).

### 5.3. Cập Nhật API Studio Chapter Versions ([Issue #190](https://github.com/HIepNgoc2006/OmniNovel/issues/190))
- **Endpoint:** `GET /api/v1/studio/chapters/:id/versions`
- Cập nhật DTO `StudioChapterVersionSummaryDto`:
  ```typescript
  export interface StudioChapterVersionSummaryDto {
    id: string;
    chapterId: string;
    versionNumber: number;
    versionType: ChapterVersionType;
    language: string;
    isPublished: boolean;
    sourceVersionId: string | null;
    createdAt: IsoDateString;
    artifactReady: boolean; // Bổ sung theo Issue #190
    artifactStatus: 'MISSING' | 'BUILDING' | 'READY' | 'FAILED'; // Chi tiết trạng thái
  }
  ```

---

## 6. KIẾN TRÚC CLIENT MOBILE (OFFLINE STORAGE & READER RESOLVER)

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              MOBILE OFFLINE ARCHITECTURE                               │
├──────────────────────────┬─────────────────────────────┬───────────────────────────────┤
│ 1. Download Service      │ 2. Storage Coordinator      │ 3. Offline Reader Resolver    │
│ • Dio Stream with .part  │ • Local SQLite (sqflite)    │ • OfflineFirst Policy         │
│ • Background Isolate     │ • App-Private Sandbox       │ • Local file:// vs CDN http://│
│ • Pause / Resume / Retry │ • SHA-256 & Unzip Staging   │ • Reading Progress Local SSoT │
└──────────────────────────┴─────────────────────────────┴───────────────────────────────┘
```

### 6.1. Luồng Giải Quyết Tài Nguyên của Reader (Offline Reader Resolver)
Khi người dùng mở `WebtoonReader`, `MangaReader` hoặc `NovelReader`:
1. **Kiểm tra CSDL Ngoại tuyến:** `OfflineStorageService.getInstalledChapter(chapterVersionId)`.
2. **Nếu đã cài đặt (`READY`):**
   - Đọc trực tiếp `manifest.json` từ thư mục `installedDir`.
   - Đối với Webtoon/Manga: Ánh xạ danh sách trang thành đường dẫn tệp cục bộ (`FileImage(File(pagePath))`). **Không gọi bất kỳ API mạng nào**, không phụ thuộc Presigned URL CDN.
   - Đối với Novel: Nạp `NovelAnchorBlock` từ manifest vào `NovelReaderView`.
3. **Nếu chưa cài đặt (Online Fallback):**
   - Nạp dữ liệu qua API mạng `GET /api/v1/chapters/:id` như hiện tại.
4. **Tiến độ đọc khi Offline:**
   - Khi đọc offline, tiến độ đọc được lưu vào `SharedPreferences` và bảng checkpoint SQLite cục bộ.
   - Khi có kết nối mạng trở lại, `ReadingProgressCoordinator` tự động đồng bộ checkpoint mới nhất lên server Core API (`PUT /api/v1/library/reading-progress`).

---

## 7. KẾ HOẠCH TRIỂN KHAI PHÂN RÃ (SUB-PHASES 5D.0 ➔ 5D.8)

### 📌 Phase 5D.0: Contract Freeze & DTO Parity
- [ ] Cập nhật `packages/shared/src/index.ts`: Bổ sung `ChapterArtifactType`, `ChapterArtifactStatus`, `ChapterArtifactDto`, `manifest.json` TypeScript interfaces.
- [ ] Bổ sung trường `artifactReady` và `artifactStatus` vào `StudioChapterVersionSummaryDto`.
- [ ] Định nghĩa mã lỗi chuẩn hóa: `ARTIFACT_NOT_READY`, `ARTIFACT_BUILD_FAILED`, `CHECKSUM_MISMATCH`, `STORAGE_QUOTA_EXCEEDED`.

### 📌 Phase 5D.1: Canonical Reverse Packaging ([Issue #190](https://github.com/HIepNgoc2006/OmniNovel/issues/190) - Core Backend API)
- [ ] **Migration 17:** Tạo bảng `chapter_artifacts` và các enums tương ứng trong NestJS API.
- [ ] Tạo Entity TypeORM `ChapterArtifact` trong `services/api/src/modules/chapters/entities/chapter-artifact.entity.ts`.
- [ ] Xây dựng `CanonicalPackagingService` trong `modules/chapters/`:
  - Gom các `MediaAsset`s theo thứ tự `sortOrder ASC`.
  - Tải stream từ MinIO/S3, đóng gói tệp ZIP chuẩn hóa kèm `manifest.json` (dùng `archiver` hoặc streaming zip).
  - Tính SHA-256 hash và kích thước byte.
  - Tích hợp Redis Distributed Lock chống build trùng lặp (`Single-Flight`).
- [ ] Cập nhật `TranslationService` (gỡ bỏ rào cản fail-closed `#165`): Khi `UploadSession` không tồn tại, tự động điều hướng sang kiểm tra hoặc kích hoạt đóng gói `TRANSLATION_SOURCE` qua `CanonicalPackagingService`.

### 📌 Phase 5D.2: Artifact Download & Readiness API
- [ ] Bổ sung endpoint `GET /api/v1/chapters/:chapterId/versions/:versionId/artifact` trả về URL presigned có chữ ký bảo mật.
- [ ] Bổ sung endpoint `POST /api/v1/chapters/:chapterId/versions/:versionId/package` kích hoạt đóng gói nền.
- [ ] Cập nhật `findVersionsForStudio` trong `ChaptersService` truy vấn trạng thái `chapter_artifacts` để trả về `artifactReady`.
- [ ] Bộ kiểm thử Unit & Integration Tests cho Backend Packaging (đạt 100% test coverage cho lifecycle `MISSING -> BUILDING -> READY`).

### 📌 Phase 5D.3: Mobile Durable Download Manager (Flutter Engine)
- [ ] Cập nhật `apps/mobile/pubspec.yaml`: Bổ sung `sqflite`, `path_provider`, `archive`, `crypto`, `path`.
- [ ] Khởi tạo CSDL SQLite `omninovel_offline.db` trong `core/storage/` với bảng `offline_chapters` và `download_tasks`.
- [ ] Xây dựng `DownloadQueueManager`:
  - Quản lý State Machine (`QUEUED -> DOWNLOADING -> VERIFYING -> READY`).
  - Hỗ trợ tải nền qua Dio stream tệp `.part`.
  - Hỗ trợ Pause, Resume, Cancel dọn sạch tệp tạm thời.
  - Tự động khôi phục hàng đợi khi app khởi động lại sau crash/kill.

### 📌 Phase 5D.4: Offline Bundle Installation & Integrity Verification
- [ ] Xây dựng `BundleInstaller`:
  - Kiểm tra mã băm SHA-256 của tệp `.part` trước khi giải nén.
  - Giải nén trong background Isolate (`compute`) chống đơ giao diện UI.
  - Xác thực cấu trúc tệp và `manifest.json`.
  - Thao tác Atomic Promotion (rename thư mục `staging` sang `installed`).
  - Ghi nhận trạng thái `READY` vào bảng `offline_chapters` trong SQLite transaction.

### 📌 Phase 5D.5: Reader Offline Resolution (Tích Hợp Trình Đọc)
- [ ] Cập nhật `WebtoonReader`: Khi chapter đã có trong `offline_chapters`, nạp trực tiếp danh sách tệp từ `FileImage(File(pagePath))`, bỏ qua gọi API presigned URL.
- [ ] Cập nhật `MangaPagedReader`: Tương thích hoàn toàn với chế độ đọc offline từ local storage.
- [ ] Cập nhật `NovelReader`: Nạp typography và `anchorBlocks` trực tiếp từ offline manifest.
- [ ] Đồng bộ tiến độ đọc offline: Lưu checkpoint ngoại tuyến và tự động đẩy lên Core API khi có mạng.

### 📌 Phase 5D.6: Quản Lý Dung Lượng, Eviction & Cách Ly Người Dùng
- [ ] Giới hạn dung lượng bộ nhớ tải về (Storage Quota): Cảnh báo khi bộ nhớ thiết bị còn trống dưới 200MB.
- [ ] Tính năng Xóa thủ công từng chương hoặc toàn bộ bộ truyện đã tải.
- [ ] Chiến lược LRU Eviction: Tùy chọn tự động dọn dẹp các chương cũ nhất khi chạm trần dung lượng người dùng thiết lập.
- [ ] Cô lập người dùng: Phân vùng dữ liệu tải theo `userId` (hoặc cấu hình dùng chung giữa các user trên cùng thiết bị nhưng bảo vệ bookmark cá nhân).

### 📌 Phase 5D.7: Studio Quick-Approval Action Sheet (Polish - Non-blocking)
- [ ] Xây dựng Bottom Sheet / Dialog xác nhận duyệt nhanh bản dịch AI cho Editor/Owner khi job dịch hoàn tất.
- [ ] Cho phép xem nhanh so sánh bản dịch gốc và kích hoạt ghi đè bản dịch mà không cần mở toàn bộ Web Studio.

### 📌 Phase 5D.8: Nghiệm Thu Thiết Bị Vật Lý & Hoàn Tất Phase 5
- [ ] Chạy ma trận kiểm thử tương thích Android (Android 7.0 Nougat $\rightarrow$ Android 16).
- [ ] Tiến hành đo đạc thực địa trên thiết bị Android vật lý (Low-End 2–3GB RAM & Mid-Range 4–6GB RAM).
- [ ] Lập báo cáo đo đạc phần cứng `phase_5d_hardware_evidence.md` xác nhận RAM RSS $< 150\text{ MB}$, Frame Budget 120Hz/90Hz/60Hz.
- [ ] Khóa chính thức Baseline hoàn thành **Phase 5 Mobile App**.

---

## 8. TIÊU CHUẨN NGHIỆM THU THEO CÁC GATES (8 VERIFICATION GATES)

| Gate | Tiêu Chí Kiểm Tra (Acceptance Criteria) | Công Cụ Xác Minh |
| :--- | :--- | :--- |
| **Gate 1: Schema & Migration** | Migration 17 chạy up/down không lỗi; bảng `chapter_artifacts` có unique key `(chapter_version_id, artifact_type)` và index chuẩn. | TypeORM Migration CLI + Jest |
| **Gate 2: Exact-Version Identity** | Bundle bind đúng `chapterVersionId`; khi `activeVersionId` của chapter thay đổi, artifact của version cũ không bị ghi đè hay mất dữ liệu. | Backend Integration Tests |
| **Gate 3: Single-Flight Packaging** | 5 requests đóng gói đồng thời trên cùng 1 version chỉ kích hoạt đúng 1 tác vụ worker, 4 requests còn lại nhận `202 BUILDING`. | Concurrent Supertest Suite |
| **Gate 4: Atomic Integrity & SHA-256** | Tệp bị ngắt mạng giữa chừng không để lại file rác; mã băm SHA-256 sai lệch lập tức bị từ chối; không có trạng thái "READY giả". | Mobile Unit & Isolation Tests |
| **Gate 5: App-Private Sandbox** | Tệp tải về nằm hoàn toàn trong internal storage (`files/offline`), không lưu bừa bãi ra Public External Storage; phân quyền an toàn. | Flutter Tests & Android Inspect |
| **Gate 6: Offline Reader Resolution** | Bật Airplane Mode (ngắt toàn bộ mạng); mở các chương đã tải: Webtoon/Manga/Novel hiển thị 100% nội dung, 0 request mạng. | Mock Network & Integration Tests |
| **Gate 7: Queue State & Recovery** | Giả lập crash app khi đang tải: khởi động lại app chuyển trạng thái `PAUSED`, hủy task dọn sạch `.part` và thư mục staging. | Mobile State Machine Tests |
| **Gate 8: Physical Hardware Metrics** | Đo đạc trên thiết bị Android thật: RAM working-set $< 150\text{ MB}$, P90 Frame time đạt chuẩn tần số quét màn hình. | ADB dumpsys meminfo & GFXInfo |

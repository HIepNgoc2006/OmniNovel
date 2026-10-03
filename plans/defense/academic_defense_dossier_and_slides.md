# 🎓 Hồ Sơ Bảo Vệ Đồ Án & Dàn Ý Slide Thuyết Trình 5 Môn Học (Academic Defense Dossier & Slide Outline)

> **Mã tài liệu:** DOSSIER-SLIDES-GATE-6.4.5  
> **Dự án:** OmniNovel (MangaVerse) - Nền tảng Đọc truyện Đa phương thức & AI Translation Hub  
> **Hệ quy chiếu bằng chứng:** [`plans/evidence_matrix_5_subjects.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/90e303b/plans/evidence_matrix_5_subjects.md) (Commit [`90e303b`](https://github.com/HIepNgoc2006/OmniNovel/commit/90e303b))  
> **Nguyên tắc vàng khi bảo vệ:** **"Talking Point không bao giờ được tự động trở thành Benchmark Claim"**. Mọi phát biểu trên slide đều có con trỏ mã nguồn (permalink), kiểm thử tự động xác thực, và ranh giới bảo vệ (Boundary Defense) để triệt tiêu hoàn toàn nguy cơ overclaiming trước Hội đồng chấm thi.

---

## 🧭 CẤU TRÚC BỘ SLIDE THUYẾT TRÌNH (SLIDE DECK ARCHITECTURE)

Bộ slide được thiết kế tinh gọn gồm **18 Slides**, bao quát trọn vẹn 5 môn học theo thứ tự logic kỹ thuật:

```
[Slide 01] Tổng quan Đề tài & Bối cảnh Kỹ thuật OmniNovel
├── PHẦN 1: KỸ NĂNG LẬP TRÌNH NÂNG CAO (Slides 02 - 04)
├── PHẦN 2: PHÁT TRIỂN ỨNG DỤNG DI ĐỘNG (Slides 05 - 07)
├── PHẦN 3: TRIỂN KHAI PHẦN MỀM / DEVOPS (Slides 08 - 10)
├── PHẦN 4: AN TOÀN THÔNG TIN (Slides 11 - 14)
├── PHẦN 5: QUẢN LÝ DỰ ÁN CNTT (Slides 15 - 17)
└── [Slide 18] Kết luận, Ranh giới Khoa học & Hỏi đáp (Q&A)
```

---

## 📊 CHI TIẾT NỘI DUNG TỪNG SLIDE & ÁNH XẠ BẰNG CHỨNG (SLIDE-BY-SLIDE SPECIFICATION)

---

### SLIDE 01: TỔNG QUAN HỆ THỐNG OMNINOVEL & BỐI CẢNH 5 MÔN HỌC

- **Tiêu đề Slide:** OmniNovel — Nền Tảng Đọc Truyện Đa Phương Thức & AI Translation Studio
- **Mục tiêu:** Giới thiệu bài toán kỹ thuật thực tế, kiến trúc Monorepo và sự tích hợp hài hòa giữa 5 phân môn CNTT.
- **Nội dung trọng tâm:**
  - *Vấn đề thực tế:* Đọc truyện đa định dạng (Webtoon, Manga, Light Novel) đòi hỏi xử lý ảnh lớn, bất đồng bộ tác vụ AI dịch thuật và bảo vệ bản quyền nội dung số.
  - *Kiến trúc tổng thể:* Monorepo gồm NestJS Core API, AI Translation Worker (FastAPI + manga-ocr), Flutter Mobile App, Next.js Web Client, Nginx Dynamic Reverse Proxy, cụm Prometheus/Grafana Observability.
  - *Phục vụ 5 môn đồ án:* Lập trình nâng cao, Di động, Triển khai phần mềm, An toàn thông tin, Quản lý dự án.
- **Ranh giới (Boundary):** Không trình bày như một startup thương mại quy mô triệu USD; định vị chính xác là hệ thống đồ án chuẩn kỹ sư phần mềm với đầy đủ kiểm thử thực tế.

---

### PHẦN 1: MÔN KỸ NĂNG LẬP TRÌNH NÂNG CAO (ADVANCED PROGRAMMING SKILLS)

#### SLIDE 02: Phân Tán Cache & Distributed Lock Ownership Với Redis 7
- **Tiêu đề Slide:** Quản Lý Trạng Thái Đồng Thời: Redis Distributed Lock & Cache Invalidation
- **Nội dung hiển thị trên Slide:**
  - *Vấn đề:* Race condition khi nhiều tiến trình/workers cùng xử lý đóng gói chương hoặc trừ điểm thưởng; quá tải CSDL với các truy vấn đọc danh mục lặp lại.
  - *Giải pháp thiết kế:*
    - Cung cấp `setnx`, `renewLock` và `releaseLock` qua Lua script atomic check-and-delete (chỉ giải phóng lock khi token khớp, chống xóa nhầm lock của worker khác).
    - Cache danh mục truyện hot/bảng xếp hạng (`stories:featured`, `stories:rankings`) với TTL 300s; cơ chế chủ động hủy cache (`del`) ngay khi có sự kiện cập nhật dữ liệu.
- **Ánh xạ Claim ID:** **`KNL-01`** (PASS)
- **Source Permalinks:**
  - Source: [`services/api/src/redis/redis.service.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/redis/redis.service.ts)
  - Source: [`services/api/src/modules/stories/stories.service.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/modules/stories/stories.service.ts)
  - Test: [`canonical-packaging.spec.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/modules/chapters/test/canonical-packaging.spec.ts)
  - Test: [`gamification.spec.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/modules/gamification/test/gamification.spec.ts)
- **Hosted Run:** Run [`37131693246`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/37131693246) (Commit [`53604b4`](https://github.com/HIepNgoc2006/OmniNovel/commit/53604b4))
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Hệ thống giảm 90% tải database"* hoặc *"Chịu tải 100,000 req/s không nghẽn"*.  
  > ✅ **Phát biểu chuẩn:** *"Đã chứng minh tính toàn vẹn logic của distributed lock qua unit test và khả năng phục hồi an toàn khi Redis rớt kết nối; cơ chế cache query được xác thực ở cấp mã nguồn (code-level inspection)."*
- **Q&A Playbook:**
  - *Hội đồng hỏi:* "Nếu Redis bị chết đột ngột khi đang giữ lock thì hệ thống xử lý sao?"
  - *Sinh viên trả lời:* "Lock được cấp phát kèm TTL hết hạn tự động (`EX ttlSeconds`), đồng thời unit test trong `gamification.spec.ts` chứng minh khi Redis rớt kết nối, transaction vẫn hoàn tất và service log warning an toàn chứ không ném crash 500."

---

#### SLIDE 03: Xử Lý Bất Đồng Bộ Đa Hàng Đợi BullMQ & Giám Sát Độ Trễ
- **Tiêu đề Slide:** Kiến Trúc Asynchronous Job Processing Với BullMQ & Telemetry Collector
- **Nội dung hiển thị trên Slide:**
  - *Vấn đề:* Các tác vụ OCR, AI translation và nén file ZIP kéo dài hàng chục giây; nếu xử lý đồng bộ sẽ gây nghẽn Event Loop của Node.js.
  - *Giải pháp thiết kế:*
    - Phân chia 3 hàng đợi nghiệp vụ độc lập: `translation` (gọi AI Worker), `translation-materialization` (ghi nhận kết quả dịch), `chapter-packaging` (đóng gói ảnh).
    - Bộ thu thập `BullmqMetricsCollector` tự động trích xuất các chỉ số `active`, `waiting`, `failed`, `completed`, `delayed` và xuất bản metric sức khỏe collector (`bullmq_metrics_collection_success`).
- **Ánh xạ Claim ID:** **`KNL-02`** (PASS)
- **Source Permalinks:**
  - Source: [`bullmq-metrics.collector.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/modules/metrics/bullmq-metrics.collector.ts)
  - Source: [`translation.module.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/modules/translation/translation.module.ts)
  - Source: [`chapters.module.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/modules/chapters/chapters.module.ts)
  - Test: [`bullmq-metrics.collector.spec.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/modules/metrics/test/bullmq-metrics.collector.spec.ts)
- **Hosted Run:** Run [`37131693246`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/37131693246) (Check 5 Acceptance PASS)
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Fast Path phản hồi < 100ms"* hoặc *"Xử lý được 1 triệu jobs/giờ"*.  
  > ✅ **Phát biểu chuẩn:** *"Chứng minh 3 hàng đợi được cấu hình đúng chuẩn, có collector độc lập giám sát hàng đợi thời gian thực; chưa đo đạc throughput tải cực đoan."*

---

#### SLIDE 04: Cardinality Protection & Versioned Database Migrations
- **Tiêu đề Slide:** Bảo Vệ Hạ Tầng Đo Lường & Quản Trị Tiến Hóa CSDL Chuẩn Doanh Nghiệp
- **Nội dung hiển thị trên Slide:**
  - *Phòng vệ Cardinality Explosion:* Middleware `MetricsMiddleware` kết hợp `normalizeRoute` tự động chuẩn hóa URL động (thay UUID bằng `:id`), thu gọn toàn bộ scanner bot/garbage probes về label cố định `/__unmatched__`, bảo vệ RAM Prometheus khỏi cạn kiệt (OOM).
  - *Tiến hóa lược đồ dữ liệu:* 18 migrations TypeORM chạy tuần tự trên PostgreSQL 16; tắt hoàn toàn `synchronize: true` trong môi trường sản xuất.
- **Ánh xạ Claim ID:** **`KNL-03`** (PASS) & **`KNL-04`** (PASS)
- **Source Permalinks:**
  - Source: [`metrics.middleware.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/modules/metrics/metrics.middleware.ts)
  - Source: [`route-normalizer.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/modules/metrics/utils/route-normalizer.ts)
  - Source: [`database/migrations/`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/database/migrations/)
  - Test: [`route-normalizer.spec.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/modules/metrics/test/route-normalizer.spec.ts) (Fuzzing 500 URLs)
  - Test: Step `Run Database Migrations` (Core API Test Job CI)
- **Hosted Run:** Run [`37131693246`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/37131693246)
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"18 migrations đã được thử nghiệm rollback sạch"* hoặc *"Đảm bảo zero-downtime trên bảng 10 triệu dòng"*.  
  > ✅ **Phát biểu chuẩn:** *"Đã chứng minh 18 forward migrations chạy thành công tự động trong CI pipeline; Cardinality normalizer đã vượt qua bài test adversarial fuzzing 500 URLs ngẫu nhiên."*

---

### PHẦN 2: MÔN PHÁT TRIỂN ỨNG DỤNG DI ĐỘNG (MOBILE APPLICATION DEVELOPMENT)

#### SLIDE 05: Xử Lý Bất Đồng Bộ & Mutex Token Refresh Trên Flutter
- **Tiêu đề Slide:** Concurrency-Safe Authentication & Token Lifecycle Trên Flutter
- **Nội dung hiển thị trên Slide:**
  - *Vấn đề Race-Condition:* Khi Access Token hết hạn, người dùng kích hoạt đồng thời nhiều yêu cầu mạng (ví dụ tải danh mục, tải profile, tải lịch sử đọc). Nếu phát nhiều request refresh token cùng lúc sẽ vi phạm cơ chế Token Rotation ở Backend và làm người dùng bị văng đăng nhập (401 loop).
  - *Giải pháp:* `AuthInterceptor` kế thừa `QueuedInterceptor` của Dio, sử dụng mẫu hình `Completer<String?>` đóng vai trò Mutex: Chỉ request đầu tiên được gọi endpoint refresh, các request còn lại được giữ trong hàng đợi và dùng lại token mới sau khi làm mới thành công.
- **Ánh xạ Claim ID:** **`MOB-01`** (PASS)
- **Source Permalinks:**
  - Source: [`auth_interceptor.dart`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/apps/mobile/lib/core/api/interceptors/auth_interceptor.dart)
  - Test: [`auth_interceptor_concurrency_test.dart`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/apps/mobile/test/core/api/auth_interceptor_concurrency_test.dart)
- **Hosted Run:** Run [`37131693246`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/37131693246) (Job `mobile-foundation-test`)
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Bảo đảm kết nối trong mọi điều kiện mạng chập chờn 3G/4G"*.  
  > ✅ **Phát biểu chuẩn:** *"Unit test đã chứng minh giải quyết triệt để race condition khi 5 requests đồng thời nhận 401; chưa bao quát trường hợp rớt mạng đúng vào miligiây gọi refresh token."*

---

#### SLIDE 06: Kiến Trúc Reader Engine Đa Phương Thức (Webtoon & Novel)
- **Tiêu đề Slide:** Đọc Truyện Đa Phương Thức: Quản Lý Bộ Nhớ & Tối Ưu Hóa Trải Nghiệm Đọc
- **Nội dung hiển thị trên Slide:**
  - *Hai chế độ đọc:*
    - Webtoon: Cuộn dọc liên tục, prefetching các trang ảnh tiếp theo vào bộ nhớ đệm trước khi độc giả cuộn tới.
    - Manga/Light Novel: Lật trang ngang, bố cục kiểu chữ (Typography) tùy biến kích thước font, giãn dòng và chế độ ban đêm (Dark Mode).
  - *Tách biệt trạng thái:* Tách State quản lý chương truyện (State Management) độc lập với Widget hiển thị ảnh nhằm hạn chế việc rebuild widget không cần thiết.
- **Ánh xạ Claim ID:** **`MOB-02`** (PASS)
- **Source Permalinks:**
  - Source: [`apps/mobile/lib/features/reader/`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/apps/mobile/lib/features/reader/)
  - Test: Step `Run Flutter Foundation Tests` (`flutter test --coverage` 100% pass)
- **Hosted Run:** Run [`37131693246`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/37131693246)
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Đảm bảo 120 FPS không giật lag trên mọi điện thoại"*.  
  > ✅ **Phát biểu chuẩn:** *"Kiến trúc thiết kế theo nguyên lý bounded memory và prefetching để hướng tới trải nghiệm mượt mà; các bài kiểm thử hiện thực thi trên môi trường máy ảo CI (headless test), chưa có benchmark FPS trên phần cứng vật lý."*

---

#### SLIDE 07: Kiểm Soát Chất Lượng Mã Nguồn & Static Analysis (0 Errors Gate)
- **Tiêu đề Slide:** Quản Trị Chất Lượng Mã Nguồn Ứng Dụng Di Động Với Flutter Analyze
- **Nội dung hiển thị trên Slide:**
  - *Tiêu chuẩn Linting nghiêm ngặt:* Tích hợp bộ quy tắc phân tích tĩnh cho Flutter SDK 3.44.0.
  - *Cổng kiểm soát CI:* Bắt buộc vượt qua `flutter analyze` với **0 errors, 0 warnings** trước khi cho phép đóng gói build.
  - *Bảo đảm an toàn kiểu:* Tuân thủ Dart Sound Null-Safety, loại bỏ triệt để các biến không sử dụng và các pattern phản thiết kế (anti-patterns).
- **Ánh xạ Claim ID:** **`MOB-03`** (PASS)
- **Source Permalinks:**
  - Source: [`apps/mobile/`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/apps/mobile/)
  - Test: Step `Run Flutter Analyze (0 errors gate)` trong CI
- **Hosted Run:** Run [`37131693246`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/37131693246) (Result: `No issues found! exit code 0`)
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Chứng minh loại bỏ hoàn toàn rò rỉ bộ nhớ StreamController"*.  
  > ✅ **Phát biểu chuẩn:** *"Chứng minh tính đúng đắn về cú pháp, quy tắc kiểu dữ liệu tĩnh và chuẩn coding convention của Dart SDK; không đo đạc rò rỉ bộ nhớ lúc runtime."*

---

### PHẦN 3: MÔN TRIỂN KHAI PHẦN MỀM / DEVOPS (SOFTWARE DEPLOYMENT)

#### SLIDE 08: Pipeline CI/CD Monorepo Đa Tầng Tự Động Hóa 100%
- **Tiêu đề Slide:** Monorepo Pipeline: Tự Động Hóa Kiểm Thử, Quét Bảo Mật & Đóng Gói
- **Nội dung hiển thị trên Slide:**
  - *Mô hình 7 Jobs liên hoàn:*
    - 4 Jobs kiểm thử song song: `web-client-test`, `core-api-test`, `ai-worker-test`, `mobile-foundation-test`.
    - 1 Job kiểm toán bí mật: `security-scan` (chạy song song ngay từ đầu).
    - 1 Job đóng gói & quét lỗ hổng: `docker-build-scan` (chỉ chạy khi cả 4 test jobs đều PASS).
    - 1 Job kiểm chứng cấu hình: `deploy-vps` (Topology dry-run validation).
  - *Hiệu năng:* Tận dụng caching đa tầng (npm, pip, pub, docker buildx) hoàn tất toàn bộ pipeline trong ~8-9 phút.
- **Ánh xạ Claim ID:** **`DEP-01`** (PASS)
- **Source Permalinks:**
  - Source: [`.github/workflows/ci-cd.yml`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/.github/workflows/ci-cd.yml)
- **Hosted Run:** Run [`37131693246`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/37131693246) (7/7 Jobs Success)
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Đã triển khai tự động lên cụm máy chủ Kubernetes on-premise"*.  
  > ✅ **Phát biểu chuẩn:** *"Pipeline chạy ổn định trên GitHub-hosted runners tiêu chuẩn; các bước build và test được chứng minh qua run log thực tế."*

---

#### SLIDE 09: Nginx Reverse Proxy Động: Runtime DNS Re-Resolution & 0-Downtime
- **Tiêu đề Slide:** Kiến Trúc Gateway Nginx: Dynamic DNS Re-resolution & Rate Limiting
- **Nội dung hiển thị trên Slide:**
  - *Vấn đề lỗi 502 kinh điển:* Nginx mặc định phân giải IP của upstream container khi khởi động và cache vĩnh viễn; khi container backend khởi động lại và nhận IP mới từ Docker bridge, Nginx sẽ gửi request vào IP cũ và trả về lỗi 502 Bad Gateway.
  - *Giải pháp thiết kế:*
    - Cấu hình `resolver 127.0.0.11 valid=10s ipv6=off;` kết hợp khối `upstream api_backend { zone api_backend 64k; server api:8000 resolve; }`.
    - Nginx định kỳ làm tươi lại địa chỉ IP nội bộ của backend mỗi 10 giây mà không cần reload tiến trình.
- **Ánh xạ Claim ID:** **`DEP-02`** (PASS)
- **Source Permalinks:**
  - Source: [`deploy/nginx/conf.d/omninovel.conf`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/deploy/nginx/conf.d/omninovel.conf)
  - Source: [`deploy/nginx/Dockerfile`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/deploy/nginx/Dockerfile)
  - Test: Acceptance Gate G12 (`test-acceptance-phase6-2.ts`)
- **Hosted Run:** Phase 6.2 Report Artifact (Commit `4ac5118`)
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Nginx có Multi-level Caching"* hoặc *"Hỗ trợ HTTP/3 QUIC"*.  
  > ✅ **Phát biểu chuẩn:** *"Nginx đóng vai trò Reverse Proxy, Rate Limiting và SSL Termination; đã chứng minh không phát sinh lỗi 502 trong kịch bản G12 recreate container được kiểm thử."*

---

#### SLIDE 10: Docker Compose Overlay & Giám Sát Prometheus / Grafana
- **Tiêu đề Slide:** Triển Khai Hạ Tầng Đo Lường Độc Lập Qua Docker Compose Overlay
- **Nội dung hiển thị trên Slide:**
  - *Nguyên lý Open-Closed:* Không sửa đổi file `docker-compose.yml` gốc của production. Tách phân hệ giám sát thành file overlay riêng: `deploy/docker-compose.observability.yml`.
  - *Triển khai linh hoạt:* Kích hoạt giám sát bằng lệnh gộp: `docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d`.
  - *Xác thực trong CI:* Step `Validate Docker Compose Deployment Specification` kiểm tra tính hợp lệ cú pháp của cả core compose và merged overlay trước khi deploy.
- **Ánh xạ Claim ID:** **`DEP-03`** (PASS)
- **Source Permalinks:**
  - Source: [`docker-compose.observability.yml`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/deploy/docker-compose.observability.yml)
  - Source: [`docker-compose.yml`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/deploy/docker-compose.yml)
  - Test: Check 10 Acceptance 6.4.4 & CI Job `deploy-vps`
- **Hosted Run:** Run [`37131693246`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/37131693246) (Exit code 0)
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Hệ thống đã tự động rollout ra live VPS thực tế"*.  
  > ✅ **Phát biểu chuẩn:** *"Bước này kiểm chứng tính hợp lệ của cấu hình và cấu trúc liên kết môi trường (Topology Dry-run Validation); không tự động deploy ra VPS production vì lý do bảo mật không lưu SSH Private Key trên public runner."*

---

### PHẦN 4: MÔN AN TOÀN THÔNG TIN (INFORMATION SECURITY)

#### SLIDE 11: Kiểm Soát Chuỗi Cung Ứng CI/CD (Two-Layer Pinning)
- **Tiêu đề Slide:** Phòng Ngừa Supply Chain Poisoning: Khóa Hai Lớp Công Cụ Quét An Ninh
- **Nội dung hiển thị trên Slide:**
  - *Rủi ro chuỗi cung ứng:* Phụ thuộc vào mutable tag `@main` hoặc `@latest` của GitHub Actions khiến dự án có nguy cơ bị tấn công đầu độc khi tài khoản bên thứ ba bị xâm nhập.
  - *Cơ chế phòng thủ:*
    - **TruffleHog (Two-Layer Pinning):** Khóa immutable commit SHA cho Action repository (`c1f2e912239240108482d79ea01ab25d90b27ac7`) + ghim tường minh CLI container version (`3.88.16`).
    - **Trivy Action:** Khóa commit SHA bất biến (`ed142fd0673e97e23eac54620cfb913e5ce36c25`).
- **Ánh xạ Claim ID:** **`SEC-01`** (PASS)
- **Source Permalinks:**
  - Source: [`.github/workflows/ci-cd.yml`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/.github/workflows/ci-cd.yml#L277-L284)
- **Hosted Run:** Run [`37131693246`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/37131693246) (Job `security-scan`)
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Ngăn chặn triệt để 100% mọi cuộc tấn công chuỗi cung ứng"*.  
  > ✅ **Phát biểu chuẩn:** *"Kiểm soát và giảm thiểu tối đa tính khả biến (mutability) của Actions; không thể loại bỏ hoàn toàn nếu chính mã nguồn gốc của bên thứ ba bị dính lỗ hổng bảo mật tại phiên bản được ghim."*

---

#### SLIDE 12: Vệ Sinh Git & Quét Rò Rỉ Bí Mật (Reachable History Audit)
- **Tiêu đề Slide:** Kiểm Soát Vệ Sinh Git & Quét Secret Toàn Bộ Lịch Sử Nhánh Main
- **Nội dung hiển thị trên Slide:**
  - *Tầng 1 - Git Tracking Hygiene:* Script shell tự động quét `git ls-files` trước mỗi build, lập tức ngắt build nếu phát hiện bất kỳ file nhạy cảm nào (`.env`, `.pem`, `.key`) bị theo dõi.
  - *Tầng 2 - TruffleHog Reachable History Scan:* Cấu hình quét toàn bộ lịch sử các commit tiếp cận được từ `main` (`base: ""` và `head: ${{ github.ref_name }}`), chặn đứng verified secrets.
  - *Authoritative Proof cho secret cũ:* Biên bản thu hồi và xoay vòng (Revocation & Rotation Record) tại G00 & G08.
- **Ánh xạ Claim ID:** **`SEC-02`** (PASS)
- **Source Permalinks:**
  - Source: [`.github/workflows/ci-cd.yml`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/.github/workflows/ci-cd.yml#L265-L284)
  - Evidence: [`plans/phases/phase_06_devops_final.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/8cebc5b/plans/phases/phase_06_devops_final.md)
- **Hosted Run:** Run [`37131693246`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/37131693246) (Result: 0 secrets leak)
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Đã xóa sạch các commit dangling trong cache của GitHub"*.  
  > ✅ **Phát biểu chuẩn:** *"Toàn bộ git tree hiện hữu đều sạch 100%; các secret cũ trong quá khứ được xử lý bằng biện pháp thu hồi và thay mới triệt để (Revocation Proof)."*

---

#### SLIDE 13: Cổng Quét Lỗ Hổng Container Fail-Closed & Sổ Quản Trị Rủi Ro
- **Tiêu đề Slide:** Quản Trị Lỗ Hổng Container: Trivy Fail-Closed Gate & Governed Risk Register
- **Nội dung hiển thị trên Slide:**
  - *Tiêu chuẩn Fail-Closed:* Cả 5 container images đều chịu sự kiểm soát của Trivy với `severity: CRITICAL,HIGH` và `exit-code: '1'`.
  - *Phân định chuỗi cung ứng:*
    - 2 third-party images (`prometheus`, `grafana`): Pin bằng SHA256 digest bất biến.
    - 3 first-party images (`api`, `ai-worker`, `nginx`): Được build từ pinned Git commit baseline và scan trước khi deploy.
  - *Quy trình quản trị ngoại lệ:* 100% CVEs trong `.trivyignore` đều được định danh có vòng đời trong Sổ Quản trị Rủi ro (`trivy-exception-register.md`) kèm phân tích khả năng khai thác và biện pháp bù đắp (Compensating Controls).
- **Ánh xạ Claim ID:** **`SEC-03`** (PASS)
- **Source Permalinks:**
  - Source: [`.trivyignore`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/.trivyignore)
  - Source: [`deploy/security/trivy-exception-register.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/deploy/security/trivy-exception-register.md)
  - Workflow: [`.github/workflows/ci-cd.yml`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/.github/workflows/ci-cd.yml#L308-L362)
- **Hosted Run:** Run [`37131693246`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/37131693246) (5 scans exit-code 0)
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Ứng dụng miễn nhiễm với mọi lỗ hổng bảo mật"*.  
  > ✅ **Phát biểu chuẩn:** *"Đảm bảo không phát sinh lỗ hổng đã biết ở mức HIGH/CRITICAL trong các gói container; không bảo vệ khỏi lỗi logic nghiệp vụ nội bộ (Business Logic Flaws) hoặc zero-day."*

---

#### SLIDE 14: Cách Ly Mạng Container & Bảo Vệ Điểm Đo Lường `/metrics`
- **Tiêu đề Slide:** Bảo Vệ Bề Mặt Trinh Sát Hạ Tầng: Nginx Deny & Container Loopback Isolation
- **Nội dung hiển thị trên Slide:**
  - *Chặn đứng từ Gateway:* Nginx cấu hình `location = /metrics { return 404; }` ở cả cổng 80 và 443; người dùng Internet hoàn toàn không thể truy cập endpoint telemetry.
  - *Cách ly mạng nội bộ:* Prometheus và Grafana chỉ kết nối mạng bridge nội bộ `omninovel-internal`, loại bỏ hoàn toàn khỏi `omninovel-edge`. Cổng giám sát chỉ bind vào loopback `127.0.0.1:9090` và `127.0.0.1:3000`.
  - *Mật khẩu fail-closed:* Mật khẩu Grafana bắt buộc truyền qua biến môi trường (`${GRAFANA_ADMIN_PASSWORD:?...}`), triệt tiêu hoàn toàn mật khẩu mặc định hardcoded.
- **Ánh xạ Claim ID:** **`SEC-04`** (PASS)
- **Source Permalinks:**
  - Source: [`deploy/nginx/conf.d/omninovel.conf`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/deploy/nginx/conf.d/omninovel.conf)
  - Source: [`deploy/docker-compose.observability.yml`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/deploy/docker-compose.observability.yml)
  - Test: Check 2 & Check 10 Acceptance 6.4.4 (`test-acceptance-gate-6-4-4.ts`)
- **Hosted Run:** Run [`37131693246`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/37131693246) (Checks 10/10 PASS)
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Bảo vệ an toàn kể cả khi kẻ tấn công đã chiếm được quyền root trên máy chủ host Linux"*.  
  > ✅ **Phát biểu chuẩn:** *"Đã chứng minh triệt tiêu bề mặt tấn công qua mạng bên ngoài vào hạ tầng telemetry; giả định môi trường host Linux duy trì quyền kiểm soát an toàn."*

---

### PHẦN 5: MÔN QUẢN LÝ DỰ ÁN CNTT (IT PROJECT MANAGEMENT)

#### SLIDE 15: Khung Quản Trị Agile/Scrum, Phân Rã WBS 4 Cấp & RACI
- **Tiêu đề Slide:** Quản Trị Dự Án Phần Mềm: Scrum 4 Sprints, WBS 4 Cấp & Ma Trận RACI
- **Nội dung hiển thị trên Slide:**
  - *Lịch trình 4 Sprints Scrum:* Ánh xạ tương ứng với 6 Phases kỹ thuật của đồ án (Sprint 1: Setup & CSDL; Sprint 2: AI Pipeline & BullMQ; Sprint 3: Web & Mobile Reader; Sprint 4: Testing, Security & DevOps).
  - *Cấu trúc WBS 4 Cấp:* Phân rã từ mức Platform đến từng component kỹ thuật chi tiết (Hạ tầng, API, AI Worker, Client Apps, QA & DevOps).
  - *Ma trận RACI & Tiêu chuẩn hoàn thành (DoD):* Định rõ trách nhiệm giữa các vai trò (Dev, QA, DevOps) và điều kiện nghiệm thu trước khi chuyển giao.
- **Ánh xạ Claim ID:** **`QDA-01`** (PASS)
- **Source Permalinks:**
  - Source: [`plans/planning/19_PROJECT_MANAGEMENT.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/plans/planning/19_PROJECT_MANAGEMENT.md)
  - Source: [`plans/planning/20_RISK_AND_COST.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/plans/planning/20_RISK_AND_COST.md)
- **Hosted Run:** Chuỗi commits lịch sử từ Phase 1 tới Phase 6.4
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Quy trình loại bỏ hoàn toàn rủi ro Scope Creep"*.  
  > ✅ **Phát biểu chuẩn:** *"Quy trình phân rã và nghiệm thu theo gate giúp giảm thiểu và kiểm soát rủi ro trượt tiến độ (Scope Creep) trong môi trường phát triển học thuật."*

---

#### SLIDE 16: Quản Trị Rủi Ro Kỹ Thuật, Chi Phí Vận Hành & Khắc Phục Sự Cố
- **Tiêu đề Slide:** Quản Trị Rủi Ro Kỹ Thuật, Unit Economics & Hồ Sơ Khắc Phục Sự Cố
- **Nội dung hiển thị trên Slide:**
  - *Ma trận 16 Rủi ro trọng yếu (R1 - R16):* Đánh giá xác suất và mức độ ảnh hưởng (Kỹ thuật, An toàn thông tin, AI Compute, Bản quyền).
  - *Mô hình bài toán chi phí (Unit Economics):* Dự toán chi phí AI Token cho 1 chapter $\approx \$0.00095\text{ USD}$ (< 25 VNĐ), băng thông CDN và lưu trữ Cloudflare R2 miễn phí egress.
  - *Hồ sơ khắc phục sự cố:* Minh bạch quá trình thu hồi secret, đánh giá rủi ro và đưa cơ chế kiểm soát tự động vào CI/CD (TruffleHog & Trivy) để ngăn ngừa tái diễn.
- **Ánh xạ Claim ID:** **`QDA-02`** (PASS)
- **Source Permalinks:**
  - Source: [`plans/planning/20_RISK_AND_COST.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/plans/planning/20_RISK_AND_COST.md)
  - Source: [`deploy/security/trivy-exception-register.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/deploy/security/trivy-exception-register.md)
  - Source: [`plans/phases/phase_06_devops_final.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/8cebc5b/plans/phases/phase_06_devops_final.md)
- **Hosted Run:** Commit `5425f3f` & Commit [`53604b4`](https://github.com/HIepNgoc2006/OmniNovel/commit/53604b4)
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Hệ thống có bảo hiểm tài chính thương mại hoặc cam kết SLA bồi thường tiền mặt"*.  
  > ✅ **Phát biểu chuẩn:** *"Thể hiện phương pháp quản trị rủi ro kỹ thuật có hệ thống: Phân tích nguyên nhân, đánh giá rủi ro, lập biện pháp khắc phục và đưa kiểm soát vào tự động hóa để hạn chế tái diễn."*

---

#### SLIDE 17: Ma Trận Bằng Chứng Thực Chứng & Quy Trình Kiểm Toán Độc Lập
- **Tiêu đề Slide:** Đảm Bảo Tính Toàn Vẹn Học Thuật: Ma Trận Bằng Chứng Thực Chứng (Evidence Matrix)
- **Nội dung hiển thị trên Slide:**
  - *Nguyên tắc Ground-Truth:* Mỗi phát biểu kỹ thuật trên slide đều đối chiếu trực tiếp về: Mã nguồn thực tế $\rightarrow$ Bài test tự động $\rightarrow$ Run ID trên GitHub Actions $\rightarrow$ Commit SHA $\rightarrow$ Giới hạn chứng minh.
  - *Công cụ kiểm toán mở:* Hội đồng có thể quét mã QR hoặc click trực tiếp vào GitHub permalinks để kiểm chứng trực tiếp từng dòng code.
  - *Tác phong kỹ sư chuyên nghiệp:* Dám khẳng định những gì hệ thống làm được và thẳng thắn chỉ rõ những ranh giới hệ thống chưa kiểm nghiệm (Boundary Defense).
- **Ánh xạ Claim ID:** **`QDA-03`** (Đủ điều kiện chuyển **PASS** sau khi hoàn tất Cross-Verification)
- **Source Permalinks:**
  - Source: [`plans/evidence_matrix_5_subjects.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/90e303b/plans/evidence_matrix_5_subjects.md)
- **Hosted Run:** Run [`37131693246`](https://github.com/HIepNgoc2006/OmniNovel/actions/runs/37131693246)
- **Ranh giới (What this does NOT prove):**
  > ⚠️ **Tuyệt đối không nói:** *"Ma trận này thay thế cho việc trả lời chất vấn trực tiếp trước Hội đồng"*.  
  > ✅ **Phát biểu chuẩn:** *"Ma trận cung cấp bằng chứng truy xuất nguồn gốc minh bạch để Hội đồng thẩm định độc lập."*

---

### SLIDE 18: TỔNG KẾT & PHIÊN HỎI ĐÁP PHẢN BIỆN (Q&A)

- **Tiêu đề Slide:** Kết Luận & Phiên Hỏi Đáp (Questions & Answers)
- **Nội dung hiển thị trên Slide:**
  - Tóm tắt 5 trụ cột đồ án: Lập trình nâng cao, Di động, Triển khai, An toàn thông tin, Quản lý dự án.
  - 100% các tiêu chí kỹ thuật đều có bằng chứng ground-truth có thể tái lập (reproducible).
  - Mã nguồn dự án: `https://github.com/HIepNgoc2006/OmniNovel`
  - Sẵn sàng tiếp nhận câu hỏi phản biện từ Hội đồng thẩm định.

---

## 🔍 BẢNG ĐỐI CHIẾU CHÉO HỌC THUẬT (CROSS-VERIFICATION AUDIT TABLE)

| Slide # | Phân môn | Tuyên bố trọng tâm (Key Claim) | Claim ID trong Ma Trận | Mã Nguồn Thực Tế (Source Permalink) | Bài Kiểm Thử / Gate Thực Tế | Hosted Run ID (Status) | Ranh giới phòng thủ (Boundary Checked) | Kết quả Audit |
| :---: | :--- | :--- | :---: | :--- | :--- | :---: | :---: | :---: |
| **02** | Lập trình nâng cao | Redis Distributed Lock ownership & cache invalidation | **KNL-01** | [`redis.service.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/redis/redis.service.ts)<br>[`stories.service.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/modules/stories/stories.service.ts) | `canonical-packaging.spec.ts`<br>`gamification.spec.ts` | `37131693246` (PASS) | Không claim 90% benchmark | ✅ **VERIFIED** |
| **03** | Lập trình nâng cao | BullMQ 3 queues processing & collector health gauges | **KNL-02** | [`bullmq-metrics.collector.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/modules/metrics/bullmq-metrics.collector.ts) | `bullmq-metrics.collector.spec.ts`<br>Check 5 Acceptance | `37131693246` (PASS) | Không claim Fast Path < 100ms | ✅ **VERIFIED** |
| **04** | Lập trình nâng cao | Cardinality bounding via normalizer & 18 migrations | **KNL-03**<br>**KNL-04** | [`metrics.middleware.ts`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/modules/metrics/metrics.middleware.ts)<br>[`database/migrations/`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/services/api/src/database/migrations/) | `route-normalizer.spec.ts`<br>CI Step Migrations | `37131693246` (PASS) | Không claim rollback 18 migrations | ✅ **VERIFIED** |
| **05** | Ứng dụng di động | Mutex Token Refresh xử lý Race-Condition 401 | **MOB-01** | [`auth_interceptor.dart`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/apps/mobile/lib/core/api/interceptors/auth_interceptor.dart) | `auth_interceptor_concurrency_test.dart` | `37131693246` (PASS) | Không claim mạng rớt chập chờn | ✅ **VERIFIED** |
| **06** | Ứng dụng di động | Reader Engine Webtoon/Novel bounded memory prefetch | **MOB-02** | [`apps/mobile/lib/features/reader/`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/apps/mobile/lib/features/reader/) | Flutter Foundation Tests | `37131693246` (PASS) | Không claim 120 FPS phần cứng thật | ✅ **VERIFIED** |
| **07** | Ứng dụng di động | Flutter Analyze 0 errors sound-null-safety | **MOB-03** | [`apps/mobile/`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/apps/mobile/) | Flutter Analyze Step CI | `37131693246` (PASS) | Không claim memory leak elimination | ✅ **VERIFIED** |
| **08** | Triển khai DevOps | CI/CD Monorepo đa tầng 7 jobs chạy ~8-9 phút | **DEP-01** | [`.github/workflows/ci-cd.yml`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/.github/workflows/ci-cd.yml) | GitHub Actions Hosted Run | `37131693246` (PASS) | Không claim on-premise K8s | ✅ **VERIFIED** |
| **09** | Triển khai DevOps | Nginx Dynamic DNS re-resolution không lỗi 502 | **DEP-02** | [`deploy/nginx/conf.d/omninovel.conf`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/deploy/nginx/conf.d/omninovel.conf) | Acceptance Gate G12 Test | Commit `4ac5118` (PASS) | Không claim multi-level cache | ✅ **VERIFIED** |
| **10** | Triển khai DevOps | Compose Overlay giám sát tách biệt core baseline | **DEP-03** | [`docker-compose.observability.yml`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/deploy/docker-compose.observability.yml) | Check 10 & CI Step `deploy-vps` | `37131693246` (PASS) | Không claim live VPS rollout | ✅ **VERIFIED** |
| **11** | An toàn thông tin | Two-Layer Pinning TruffleHog & Commit SHA Trivy | **SEC-01** | [`.github/workflows/ci-cd.yml`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/.github/workflows/ci-cd.yml#L277-L284) | CI Step TruffleHog Execution | `37131693246` (PASS) | Không claim miễn nhiễm 100% | ✅ **VERIFIED** |
| **12** | An toàn thông tin | Zero Tracked Secrets & Reachable commits scan clean | **SEC-02** | [`.github/workflows/ci-cd.yml`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/.github/workflows/ci-cd.yml#L265-L284) | CI Step Git Hygiene & Secret Scan | `37131693246` (PASS) | Không claim xóa dangling GitHub cache | ✅ **VERIFIED** |
| **13** | An toàn thông tin | Fail-Closed 5 containers & Governed Risk Register | **SEC-03** | [`.trivyignore`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/.trivyignore)<br>[`trivy-exception-register.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/deploy/security/trivy-exception-register.md) | 5 Trivy Scan Steps CI | `37131693246` (PASS) | Không claim chặn logic flaws | ✅ **VERIFIED** |
| **14** | An toàn thông tin | Nginx deny `/metrics` 404 & Loopback isolation | **SEC-04** | [`deploy/nginx/conf.d/omninovel.conf`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/deploy/nginx/conf.d/omninovel.conf)<br>[`docker-compose.observability.yml`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/deploy/docker-compose.observability.yml) | Check 2 & Check 10 Suite | `37131693246` (PASS) | Không claim bảo vệ khi root host bị hack | ✅ **VERIFIED** |
| **15** | Quản lý dự án | Scrum 4 Sprints, WBS 4 Cấp, RACI & Definition of Done | **QDA-01** | [`19_PROJECT_MANAGEMENT.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/plans/planning/19_PROJECT_MANAGEMENT.md)<br>[`20_RISK_AND_COST.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/plans/planning/20_RISK_AND_COST.md) | Sprint-Phase Mapping Schedule | Git History Phase 1-6.4 | Không claim triệt tiêu mọi rủi ro | ✅ **VERIFIED** |
| **16** | Quản lý dự án | 16 Rủi ro (R1-R16), Unit Economics & Hồ sơ thu hồi | **QDA-02** | [`trivy-exception-register.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/53604b4/deploy/security/trivy-exception-register.md)<br>[`phase_06_devops_final.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/8cebc5b/plans/phases/phase_06_devops_final.md) | Post-Incident Audit Trail | Commit `5425f3f` / `53604b4` | Không claim có SLA phạt tiền | ✅ **VERIFIED** |
| **17** | Quản lý dự án | Ma trận bằng chứng thực chứng phục vụ kiểm toán | **QDA-03** | [`plans/evidence_matrix_5_subjects.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/90e303b/plans/evidence_matrix_5_subjects.md) | Cross-Verification hoàn tất 16/16 claims | `37131693246` (PASS) | Không thay thế trả lời vấn đáp | ✅ **VERIFIED & PASS** |

---

## 🏆 KẾT LUẬN NGHIỆM THU GATE 6.4.5 & PHASE 6.4

Sau khi hoàn tất quá trình kiểm toán đối chiếu chéo (Cross-Verification) từng dòng nội dung slide đối sánh với mã nguồn thật, bài test, hosted run và ranh giới phòng thủ:

1. **Ma Trận Bằng Chứng [`plans/evidence_matrix_5_subjects.md`](https://github.com/HIepNgoc2006/OmniNovel/blob/90e303b/plans/evidence_matrix_5_subjects.md):**
   - 17 / 17 claims đều đạt trạng thái: **`PASS`** (Bao gồm cả claim `QDA-03` sau khi đã nghiệm thu bảng đối chiếu chéo độc lập).
2. **Trạng thái Gate 6.4.5:** **`CLOSED / FROZEN CLEAN ✅`**
3. **Trạng thái Toàn Bộ Phase 6.4 (Hardening, Observability & Hồ Sơ Bảo Vệ 5 Môn):**
   - **`CHÍNH THỨC HOÀN THÀNH 100% & KHÓA BĂNG TOÀN DIỆN (FROZEN CLEAN) ✅`**
4. **Tài sản bàn giao:**
   - Mã nguồn & cấu hình an ninh đã kiểm chứng trên hosted CI.
   - Sổ đăng ký rủi ro ngoại lệ container có vòng đời kiểm soát.
   - Kịch bản kiểm thử nghiệm thu tự động 10/10 PASS.
   - Ma trận bằng chứng thực chứng 5 môn học kèm ranh giới bảo vệ.
   - Dàn ý 18 slide thuyết trình và cẩm nang trả lời phản biện (Q&A Playbook) chuẩn mực khoa học.

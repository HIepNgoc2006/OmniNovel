# 📚 00. Bộ Từ Điển Thuật Ngữ & Quyết Định Kiến Trúc Cốt Lõi (Single Source of Truth)

Tài liệu này là **Nguồn Sự Thật Duy Nhất (Single Source of Truth - SSoT)** cho toàn bộ dự án **OmniNovel**. Mọi tài liệu kỹ thuật, đặc tả và mã nguồn bắt buộc phải tuân thủ nghiêm ngặt các thuật ngữ và quyết định kiến trúc đã được chốt tại đây.

---

## 1. TỪ ĐIỂN THUẬT NGỮ CHUẨN (PROJECT GLOSSARY)

| Thuật ngữ | Định nghĩa kỹ thuật chuẩn | Quy ước sử dụng trong toàn bộ dự án |
| :--- | :--- | :--- |
| **Work / Story** | Thực thể tác phẩm cao nhất (ví dụ: bộ truyện *One Piece*, tiểu thuyết *Re:Zero*). | Chứa metadata tổng quan (Title, Slug, MediaFormat, OriginCountry). |
| **StoryEdition** | Ấn bản của một tác phẩm theo ngôn ngữ hoặc phiên bản xuất bản (Original Japanese, Vietnamese Official, Fan Translation). | Một Story có thể có 1 hoặc nhiều StoryEditions. |
| **Volume** | Tập truyện / Hồi truyện (đặc biệt trong Light Novel). | Phân cấp: Story $\rightarrow$ Volume $\rightarrow$ Chapter. |
| **Chapter** | Chương truyện cụ thể trong tác phẩm. | Là container logic chứa nhiều **ChapterVersions**. |
| **ChapterVersion** | **Bản phát hành cụ thể của một Chapter** (Original Raw, AI Vietnamese v1, Human Edited v1, English). | **Quy tắc bất biến:** Không bao giờ ghi đè vật lý file gốc. Thao tác "Ghi đè" chỉ là trỏ con trỏ `active_version_id` sang version mới. |
| **MediaAsset** | Tệp tin đa phương tiện cụ thể (Trang ảnh Manga WebP, file Markdown/HTML Novel, ảnh minh họa). | Thuộc về một ChapterVersion cụ thể, lưu trữ trên MinIO. |
| **TranslationProject** | Không gian quản trị dịch thuật của một bộ truyện (chứa Cặp ngôn ngữ, Từ điển Glossary, Style Guide). | Dự án dịch lâu dài của 1 nhóm hoặc cá nhân. |
| **TranslationJob** | Một phiên xử lý dịch cho 1 ChapterVersion cụ thể. | Chứa State Machine 14 trạng thái từ `CREATED` đến `APPLIED`. |
| **TranslationSegment** | Đơn vị dịch thuật nhỏ nhất (Một bóng thoại tranh Manga hoặc một đoạn văn bản Light Novel). | Chứa tọa độ BBox, Text gốc, Text dịch, Confidence Score, Status. |
| **GlossaryTerm** | Cặp từ vựng cố định trong từ điển (Tên nhân vật, chiêu thức, địa danh) để ép AI dịch nhất quán. | Áp dụng ưu tiên cao hơn kết quả sinh tự do của LLM. |
| **High Refresh Rate (HRR)** | Khả năng đáp ứng tần số quét màn hình 90Hz / 120Hz / 144Hz. | Yêu cầu ngân sách khung hình $< 8.33ms$/frame trên Mobile. |

---

## 2. NHẬT KÝ QUYẾT ĐỊNH KIẾN TRÚC (ARCHITECTURE DECISION RECORDS - ADRs)

### ADR-001: Lựa Chọn Nền Tảng Di Động (Mobile Framework)
* **Quyết định (Decision):** **Flutter (Dart)**.
* **Trạng thái (Status):** Accepted (Đã chốt).
* **Bối cảnh & Lý do:** Flutter cung cấp Engine đồ họa Impeller/Skia với khả năng can thiệp sâu vào luồng vẽ Canvas, quản lý bộ nhớ đệm hình ảnh (Image Cache Eviction) và hỗ trợ hoàn hảo ProMotion 120Hz / 144Hz trên cả Android và iOS.
* **Hệ quả (Consequences):** Toàn bộ nhóm Mobile chỉ viết mã nguồn trong `apps/mobile` bằng Flutter/Dart.

### ADR-002: Lựa Chọn Framework Backend Core
* **Quyết định (Decision):** **NestJS (TypeScript)**.
* **Trạng thái (Status):** Accepted (Đã chốt).
* **Bối cảnh & Lý do:** Hỗ trợ cấu trúc Clean Architecture chuẩn mực, Dependency Injection mạnh mẽ, tích hợp sẵn TypeORM, Redis Throttler và Swagger.

### ADR-003: Kiến Trúc Hàng Đợi AI Translation Worker
* **Quyết định (Decision):** **NestJS Core API $\rightarrow$ BullMQ (Node.js Producer) $\rightarrow$ Redis $\rightarrow$ Python FastAPI Worker (Consumer qua Worker/HTTP/gRPC)**.
* **Trạng thái (Status):** Accepted (Đã chốt).
* **Bối cảnh & Lý do:** Tách biệt hoàn toàn API chính khỏi Worker xử lý AI nặng CPU/GPU (OpenCV, Manga-OCR, PyTorch).

### ADR-004: Mô Hình Quản Lý Phiên Bản Chương (Chapter Versioning Model)
* **Quyết định (Decision):** Áp dụng mô hình **Immutable Chapter Versions**.
* **Trạng thái (Status):** Accepted (Đã chốt).
* **Bối cảnh & Lý do:** Mọi bản dịch AI mới đều tạo ra một `ChapterVersion` mới. Lựa chọn "Ghi đè (Overwrite)" của người dùng chỉ cập nhật `chapter.active_version_id = new_version_id`. Bản gốc không bao giờ bị xóa, hỗ trợ rollback tức thì và so sánh đối chiếu (Diff).

### ADR-005: Chiến Lược Lưu Trữ Đối Tượng (Object Storage)
* **Quyết định (Decision):** **MinIO (Self-hosted S3-compatible Object Storage)**.
* **Trạng thái (Status):** Accepted (Đã chốt).
* **Bối cảnh & Lý do:** Miễn phí lưu trữ trên VPS/Local, tương thích 100% chuẩn AWS S3 SDK, dễ dàng chuyển đổi sang Cloudflare R2 / AWS S3 trong tương lai.

---

## 3. DANH MỤC 22 TÀI LIỆU QUY HOẠCH KẾ HOẠCH (PLANNING V2 STRUCTURE)

```
plans/planning/
├── 00_README_AND_DOCUMENT_INDEX.md           # [SSoT] Từ điển thuật ngữ & Nhật ký ADRs
├── 01_PRODUCT_VISION.md                      # [Product] Tầm nhìn, Problem, Value Proposition & Pillars
├── 02_PRODUCT_SCOPE_AND_ROADMAP.md           # [Scope] Phân chia MVP, V1, V2 & Out-of-Scope
├── 03_PERSONAS_JTBD_USER_JOURNEYS.md         # [Users] 5 Personas chi tiết, Jobs To Be Done & Journeys
├── 04_USER_REQUIREMENTS.md                   # [Requirements] Bảng User Requirements (MoSCoW P0-P3)
├── 05_FUNCTIONAL_REQUIREMENTS.md             # [Specs] Functional Requirements kèm Acceptance Criteria (GWT)
├── 06_USE_CASES_AND_PERMISSIONS.md           # [Use Cases] 28 Use Cases Spec & Ma Trận Phân Quyền Ownership
├── 07_INFORMATION_ARCHITECTURE.md            # [IA] Sitemap Web/Mobile, Screen Inventory & Navigation
├── 08_DOMAIN_MODEL.md                        # [Domain] Mô hình nghiệp vụ, Entities & Domain Events
├── 09_DATABASE_AND_STORAGE.md                # [Database] Lược đồ CSDL PostgreSQL 20+ bảng & MinIO Storage
├── 10_API_AND_EVENT_CONTRACTS.md             # [API] Đặc tả RESTful API Endpoints, WebSocket & Errors
├── 11_AI_TRANSLATION_ARCHITECTURE.md         # [AI Engine] Kiến trúc Manga/Novel AI Pipeline & State Machine
├── 12_SYSTEM_ARCHITECTURE.md                 # [Architecture] Kiến trúc tổng thể, Monorepo & Module Boundaries
├── 13_ARCHITECTURE_DECISIONS.md              # [ADRs] Toàn văn các quyết định kiến trúc chi tiết
├── 14_NON_FUNCTIONAL_REQUIREMENTS.md         # [NFRs] Yêu cầu phi chức năng đo lường được (120Hz, RAM, SLAs)
├── 15_SECURITY_THREAT_MODEL.md               # [Security] Mô hình đe dọa STRIDE, Anti-Leech & File Sanitization
├── 16_PRIVACY_CONTENT_AND_RIGHTS.md          # [Privacy & Rights] Quyền riêng tư, Bản quyền tác giả & Takedown
├── 17_TESTING_AND_QA.md                      # [QA] Chiến lược kiểm thử toàn diện, Benchmark Dataset & E2E
├── 18_DEVOPS_OBSERVABILITY_DR.md             # [DevOps] Docker 7 Containers, CI/CD, Nginx, Prometheus/Grafana & DR
├── 19_PROJECT_MANAGEMENT.md                  # [PM] Quy trình Scrum 4 Sprint, WBS 4 Cấp, RACI & DoD
├── 20_RISK_AND_COST.md                       # [Risk & Cost] Ma trận 16 rủi ro (R1-R16) & Mô hình Unit Economics
├── 21_REQUIREMENTS_TRACEABILITY.md           # [Traceability] Ma trận ánh xạ UR -> FR -> UC -> API -> DB -> Test
└── 22_COURSE_MAPPING.md                      # [Academic] Bằng chứng kỹ thuật nghiệm thu 5 môn học
```

# 📚 00. Bộ Từ Điển Thuật Ngữ & Quyết Định Kiến Trúc Cốt Lõi (Single Source of Truth)

Tài liệu này là **Nguồn Sự Thật Duy Nhất (Single Source of Truth - SSoT)** cho toàn bộ dự án **OmniNovel**. Mọi tài liệu kỹ thuật, đặc tả và mã nguồn bắt buộc phải tuân thủ nghiêm ngặt các thuật ngữ và quyết định kiến trúc đã được chốt tại đây.

---

## 1. TỪ ĐIỂN THUẬT NGỮ CHUẨN (PROJECT GLOSSARY)

| Thuật ngữ | Định nghĩa kỹ thuật chuẩn | Quy ước sử dụng trong toàn bộ dự án |
| :--- | :--- | :--- |
| **Work / Story** | Thực thể tác phẩm cao nhất (ví dụ: bộ truyện *One Piece*, tiểu thuyết *Re:Zero*). | Chứa metadata tổng quan (`id`, `title`, `slug`, `media_format`, `origin_country`, `created_by`). |
| **StoryEdition** | **Dòng xuất bản / Nhóm phát hành** của tác phẩm (ví dụ: *Bản Dịch Chính Thức*, *Bản Dịch Cộng Đồng OmniNovel*). | Phân cấp: `Story` $\rightarrow$ `StoryEdition` $\rightarrow$ `Volume` $\rightarrow$ `Chapter`. Ngôn ngữ của Edition đóng vai trò mặc định, nhưng từng `ChapterVersion` bên trong có thể mang ngôn ngữ/phiên bản cụ thể khác. |
| **Volume** | Tập truyện / Hồi truyện (đặc biệt trong Light Novel). | Phân nhóm các chương truyện theo từng tập xuất bản. |
| **Chapter** | Chương truyện logic cụ thể trong tác phẩm. | Là container logic chứa nhiều **ChapterVersions**, có con trỏ `active_version_id`. |
| **ChapterVersion** | **Bản phát hành bất biến cụ thể của một Chapter** (Original Raw, AI Vietnamese v1, Human Edited v1). | **Quy tắc bất biến (Immutable):** Bản raw không bao giờ bị xóa. Ghi đè (Overwrite) = trỏ `active_version_id` sang version mới. Nhân bản (Duplicate) = tạo version mới giữ nguyên `active_version_id`. |
| **MediaAsset** | Tệp tin đa phương tiện cụ thể (Trang ảnh Manga WebP, file Markdown/HTML Novel, ảnh minh họa). | Thuộc về một `ChapterVersion` cụ thể, lưu trữ trên MinIO theo thứ tự `sort_order`. |
| **StoryMember** | **Nguồn Sự Thật Duy Nhất (Single Source of Truth) về Quyền Sở Hữu & Phân Quyền Bộ Truyện**. | Gồm các vai trò: `OWNER` (toàn quyền), `EDITOR` (duyệt/xuất bản/apply), `TRANSLATOR` (dịch/tạo job), `UPLOADER` (tải raw). |
| **TranslationProject** | Không gian quản trị dịch thuật của một ấn bản (`StoryEdition`). | Quản lý Cặp ngôn ngữ gốc - đích và Từ điển Glossary. |
| **TranslationJob** | Một phiên xử lý dịch cho 1 ChapterVersion cụ thể. | Quản lý State Machine 14 trạng thái từ `CREATED` đến `APPLIED`. |
| **TranslationSegment** | Đơn vị dịch thuật nhỏ nhất (Một bóng thoại tranh Manga hoặc một đoạn văn bản Light Novel). | Chứa tọa độ BBox, Text gốc, Text dịch, Confidence Score, Status. |
| **GlossaryTerm** | Cặp từ vựng cố định trong từ điển (Tên nhân vật, chiêu thức, địa danh) để ép AI dịch nhất quán. | Áp dụng ưu tiên cao hơn kết quả sinh tự do của LLM. |
| **Total EXP** | **Nguồn Sự Thật Duy Nhất về Điểm Kinh Nghiệm** tích lũy vĩnh viễn của người dùng (`total_exp`). | Level được tính toán dẫn xuất (Derived) từ `total_exp` theo công thức cố định. Không bao giờ bị trừ hay đem tiêu dùng. |
| **OmniCoin** | Đơn vị tiền thưởng ảo trong hệ thống nhận qua Điểm danh (Daily Check-in) và Nhiệm vụ. | Dùng để mở khóa quyền lợi, theme, vật phẩm; quản lý qua Sổ cái bất biến (Immutable Ledger). |
| **Rank / Title** | Cấp bậc danh hiệu hiển thị trên Profile theo cấp Level (Tu Tiên, Game Thủ, Ma Vương, Pháp Sư, Tinh Không). | Lựa chọn theme hiển thị mà không ảnh hưởng tới Level và EXP thực tế. |
| **High Refresh Rate (HRR)** | Khả năng đáp ứng tần số quét màn hình 90Hz / 120Hz / 144Hz. | Yêu cầu ngân sách khung hình $< 8.33ms$/frame trên Mobile Flutter. |

---

## 2. NHẬT KÝ QUYẾT ĐỊNH KIẾN TRÚC (CANONICAL ADR INDEX)

*Chi tiết toàn văn của từng quyết định kiến trúc được quy định chính thức tại [13_ARCHITECTURE_DECISIONS.md](13_ARCHITECTURE_DECISIONS.md).*

| Mã ADR | Tiêu Đề Quyết Định Kiến Trúc | Trạng Thái | Tóm Tắt Quyết Định |
| :---: | :--- | :---: | :--- |
| **ADR-001** | Lựa Chọn Framework Mobile Độc Quyền | **Accepted** | Sử dụng **Flutter (Dart)** với Skia/Impeller engine tối ưu 120Hz và cache bộ nhớ. |
| **ADR-002** | Lựa Chọn Framework Backend Core | **Accepted** | Sử dụng **NestJS (TypeScript)** theo Clean Architecture và Module Boundaries. |
| **ADR-003** | Lựa Chọn Hệ Quản Trị CSDL Quan Hệ | **Accepted** | Sử dụng **PostgreSQL 16** với JSONB, Full-Text Search và DDL Constraints. |
| **ADR-004** | Chiến Lược Lưu Trữ Đối Tượng (Object Storage) | **Accepted** | Sử dụng **MinIO (Self-hosted S3-compatible)** quản lý đa tầng media assets. |
| **ADR-005** | Mô Hình Quản Lý Phiên Bản Chương (Versioning) | **Accepted** | Áp dụng **Immutable ChapterVersion** và con trỏ `active_version_id`. |
| **ADR-006** | Kiến Trúc Phân Tách Hàng Đợi AI Worker | **Accepted** | **NestJS BullMQ (Producer/Consumer)** $\rightarrow$ HTTP/gRPC $\rightarrow$ **Python FastAPI (Engine)**. |
| **ADR-007** | Mô Hình WebSocket Reconnect-Aware | **Accepted** | Quản lý tiến trình dịch AI qua WebSocket kèm REST fallback query. |
| **ADR-008** | Trừu Tượng Hóa Nhà Cung Cấp AI (Provider) | **Accepted** | Áp dụng Adapter Pattern cho OpenAI, DeepL và Local LLM. |
| **ADR-009** | Bảo Vệ Bản Quyền Hình Ảnh (Anti-Leech) | **Accepted** | Sử dụng **Dynamic HMAC-SHA256 Signed URLs** thời hạn ngắn (15 phút) và Watermark ẩn danh. |
| **ADR-010** | Mã Hóa Mật Khẩu Người Dùng | **Accepted** | Sử dụng thuật toán **Argon2id** với thông số an toàn chống tấn công GPU/ASIC. |

---

## 3. DANH MỤC 24 TÀI LIỆU QUY HOẠCH KẾ HOẠCH (CANONICAL PLANNING STRUCTURE)

```
plans/planning/
├── 00_README_AND_DOCUMENT_INDEX.md           # [SSoT] Từ điển thuật ngữ chuẩn & Index 10 ADRs
├── 01_PRODUCT_VISION.md                      # [Product] Tầm nhìn, Problem, Value Proposition & 5 Pillars
├── 02_PRODUCT_SCOPE_AND_ROADMAP.md           # [Scope] Phân định MVP, V1, V2 & Ranh giới Out-of-Scope
├── 03_PERSONAS_JTBD_USER_JOURNEYS.md         # [Users] 5 Personas, Jobs To Be Done & 6 User Journeys
├── 04_USER_REQUIREMENTS.md                   # [Requirements] Bảng User Requirements (MoSCoW P0-P3)
├── 05_FUNCTIONAL_REQUIREMENTS.md             # [Specs] Full Functional Requirements kèm Given-When-Then
├── 06_USE_CASES_AND_PERMISSIONS.md           # [Use Cases] Catalog 28 Use Cases, 10 Core Specs & RBAC
├── 07_INFORMATION_ARCHITECTURE.md            # [IA] Sitemap Web/Mobile, Navigation & Full Screen Inventory
├── 08_DOMAIN_MODEL.md                        # [Domain] Mô hình nghiệp vụ DDD, Aggregates & Domain Events
├── 09_DATABASE_AND_STORAGE.md                # [Database] Lược đồ CSDL PostgreSQL 20+ bảng & MinIO Storage
├── 10_API_AND_EVENT_CONTRACTS.md             # [API] Đặc tả RESTful Endpoints /api/v1, WebSocket & Errors
├── 11_AI_TRANSLATION_ARCHITECTURE.md         # [AI Engine] Pipeline Manga/Novel AI, State Machine & Worker
├── 12_SYSTEM_ARCHITECTURE.md                 # [Architecture] Kiến trúc tổng thể Monorepo & Module Boundaries
├── 13_ARCHITECTURE_DECISIONS.md              # [ADRs] Toàn văn 10 quyết định kiến trúc chuẩn MADR
├── 14_NON_FUNCTIONAL_REQUIREMENTS.md         # [NFRs] Yêu cầu phi chức năng định lượng (120Hz, RAM, SLAs)
├── 15_SECURITY_THREAT_MODEL.md               # [Security] Mô hình đe dọa STRIDE, Anti-Leech & File Sanitization
├── 16_PRIVACY_CONTENT_AND_RIGHTS.md          # [Privacy & Rights] Quyền riêng tư, Bản quyền tác giả & Takedown
├── 17_TESTING_AND_QA.md                      # [QA] Chiến lược kiểm thử đa tầng, Test Case Catalog & Benchmarks
├── 18_DEVOPS_OBSERVABILITY_DR.md             # [DevOps] Docker Compose 7 Containers, CI/CD, Nginx & Kế hoạch DR
├── 19_PROJECT_MANAGEMENT.md                  # [PM] Quy trình Scrum 4 Sprint, WBS 4 Cấp, RACI & Definition of Done
├── 20_RISK_AND_COST.md                       # [Risk & Cost] Ma trận 16 rủi ro (R1-R16) & Mô hình Unit Economics
├── 21_REQUIREMENTS_TRACEABILITY.md           # [Traceability] Ma trận truy vết chuẩn UR ➔ FR ➔ UC ➔ API ➔ DB ➔ TC
├── 22_COURSE_MAPPING.md                      # [Academic] Ma trận minh chứng kỹ thuật nghiệm thu 5 môn học
└── 23_GAMIFICATION_AND_REWARDS.md            # [Gamification] Hệ thống EXP, OmniCoin, Chuỗi điểm danh & Rank Themes
```

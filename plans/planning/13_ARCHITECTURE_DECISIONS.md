# 📝 13. Tuyển Tập Toàn Văn Quyết Định Kiến Trúc (ADRs 001 - 010)

Tài liệu này ghi nhận toàn văn 10 Quyết định Kiến trúc cốt lõi đã được phê duyệt theo chuẩn **MADR (Markdown Architectural Decision Records)** cho dự án OmniNovel.

---

### ADR-001: Lựa Chọn Framework Mobile Độc Quyền
* **Trạng thái (Status):** Accepted
* **Bối cảnh (Context):** Đồ án yêu cầu phát triển ứng dụng di động đọc truyện tranh (Webtoon) cuộn liên tục nhiều trang ảnh phân giải cao 2K/4K và tiểu thuyết Light Novel, đòi hỏi tối ưu khung hình 90Hz/120Hz/144Hz (frame budget $< 8.33ms$) và kiểm soát bộ nhớ RAM $< 150MB$.
* **Quyết định (Decision):** Lựa chọn **Flutter (Dart)** làm framework phát triển ứng dụng di động độc quyền trong `apps/mobile`.
* **Các phương án thay thế (Alternatives Considered):**
  * *React Native:* Khó tối ưu sâu Virtualized List cuộn ảnh dài 120Hz qua JavaScript Bridge mà không bị hiện tượng trắng khung hình (blank frames).
  * *Native Android/iOS riêng biệt:* Chi phí và thời gian phát triển tăng gấp đôi, vượt quá khung thời gian 8 tuần.
* **Hệ quả (Consequences):** Toàn bộ tính năng Mobile được xây dựng bằng Dart/Flutter, tận dụng tối đa Skia/Impeller engine và Image Memory Cache Eviction.

---

### ADR-002: Lựa Chọn Framework Backend Core API
* **Trạng thái (Status):** Accepted
* **Bối cảnh (Context):** Cần một nền tảng Backend vững chắc phục vụ môn Kỹ năng lập trình nâng cao và An toàn thông tin, hỗ trợ kiến trúc Clean Architecture, Dependency Injection mạnh mẽ và khả năng mở rộng module.
* **Quyết định (Decision):** Lựa chọn **NestJS (TypeScript)** làm Core API framework đặt tại `services/api`.
* **Các phương án thay thế (Alternatives Considered):**
  * *Express.js thuần:* Quá tự do, thiếu cấu trúc Module/IoC chuẩn mực dẫn đến khó bảo trì codebase lớn.
  * *Golang (Gin/Fiber):* Hiệu năng cao nhưng chia sẻ DTOs/Types TypeScript với Web client (Next.js) phức tạp hơn.
* **Hệ quả (Consequences):** Hệ thống có cấu trúc module rõ ràng (`AuthModule`, `CatalogModule`, `GamificationModule`, `TranslationModule`...), hỗ trợ Swagger tự động và TypeORM.

---

### ADR-003: Lựa Chọn Hệ Quản Trị Cơ Sở Dữ Liệu Quan Hệ
* **Trạng thái (Status):** Accepted
* **Bối cảnh (Context):** Dữ liệu truyện tranh, tài khoản, quan hệ phân cấp (Story $\rightarrow$ Edition $\rightarrow$ Volume $\rightarrow$ Chapter $\rightarrow$ Version), giao dịch sổ cái Gamification và từ điển thuật ngữ đòi hỏi tính toàn vẹn dữ liệu (ACID), Foreign Keys và Indexing mạnh mẽ.
* **Quyết định (Decision):** Lựa chọn **PostgreSQL 16** làm CSDL quan hệ chính.
* **Các phương án thay thế (Alternatives Considered):**
  * *MongoDB (NoSQL):* Khó đảm bảo ràng buộc toàn vẹn dữ liệu phân cấp truyện và sổ cái giao dịch điểm thưởng.
  * *MySQL 8:* Kém linh hoạt hơn PostgreSQL trong việc xử lý kiểu dữ liệu `JSONB`, `UUID` và Full-Text Search đa ngôn ngữ.
* **Hệ quả (Consequences):** Toàn bộ schema được định nghĩa qua DDL nghiêm ngặt với 20+ bảng quan hệ và Foreign Keys có quy tắc Cascade/Set Null chuẩn mực.

---

### ADR-004: Chiến Lược Lưu Trữ Đối Tượng Đa Phương Tiện (Object Storage)
* **Trạng thái (Status):** Accepted
* **Bối cảnh (Context):** Dự án cần lưu trữ hàng chục nghìn trang ảnh Manga (WebP) và file nội dung Novel. Cần một giải pháp lưu trữ đối tượng tương thích chuẩn AWS S3 có thể chạy cục bộ không tốn phí dịch vụ đám mây trong giai đoạn học tập.
* **Quyết định (Decision):** Sử dụng **MinIO (Self-hosted S3-compatible Object Storage)** trong môi trường Docker.
* **Các phương án thay thế (Alternatives Considered):**
  * *Lưu trực tiếp vào Local Filesystem của API:* Gây nghẽn I/O server, không hỗ trợ Presigned URLs và khó mở rộng sang Cloud Storage sau này.
  * *AWS S3 / Cloudflare R2 trực tiếp:* Phát sinh chi phí trong quá trình dev/test và phụ thuộc vào kết nối Internet.
* **Hệ quả (Consequences):** Backend sử dụng AWS SDK để giao tiếp với MinIO; khi đưa lên Production chỉ cần thay đổi biến môi trường Endpoint/AccessKey mà không cần sửa code.

---

### ADR-005: Mô Hình Quản Lý Phiên Bản Chương Bất Biến (Immutable Chapter Versions)
* **Trạng thái (Status):** Accepted
* **Bối cảnh (Context):** Khi uploader tải lên bản dịch AI hoặc chỉnh sửa biên tập, nếu ghi đè vật lý vào file gốc thì sẽ làm mất vĩnh viễn bản raw gốc, không thể đối chiếu (Diff), rollback hoặc cung cấp chế độ đọc song ngữ cho độc giả.
* **Quyết định (Decision):** Áp dụng mô hình **Immutable ChapterVersion**. Mọi bản dịch mới đều sinh một bản ghi `ChapterVersion` mới. Thao tác "Ghi đè (Overwrite)" chỉ là cập nhật con trỏ `chapter.active_version_id = new_version_id`. Thao tác "Nhân bản (Duplicate)" là tạo version mới nhưng giữ nguyên `active_version_id` hiện tại và hiển thị trong menu chọn bản dịch.
* **Các phương án thay thế (Alternatives Considered):**
  * *Xóa file cũ và ghi đè vật lý:* Làm mất dữ liệu gốc, không rollback được.
  * *Tạo một Chapter logic mới:* Làm vỡ cây mục lục và làm trùng lặp số thứ tự chương (ví dụ có 2 chương cùng mang tên "Chương 1").
* **Hệ quả (Consequences):** Dữ liệu raw luôn an toàn tuyệt đối; độc giả có thể chuyển đổi mượt mà giữa Bản Raw và Bản Dịch AI ngay trên thanh công cụ đọc truyện.

---

### ADR-006: Kiến Trúc Phân Tách Hàng Đợi & AI Worker
* **Trạng thái (Status):** Accepted
* **Bối cảnh (Context):** Tác vụ OCR bóng thoại, inpainting và gọi LLM dịch tốn nhiều thời gian (vài chục giây đến vài phút) và tài nguyên CPU/GPU/RAM. Không thể chạy đồng bộ trên main thread của Backend Core API.
* **Quyết định (Decision):** Phân tách theo cấu trúc:
  ```
  NestJS Core API ──[ Push Job ]──> BullMQ (Redis) ──[ Worker Processor ]──> HTTP/gRPC ──> Python AI Engine (FastAPI)
  ```
  NestJS quản lý vòng đời Job qua BullMQ; Python AI Service đóng vai trò là Engine phi trạng thái (Stateless RPC Engine) xử lý thuật toán CV/ML.
* **Các phương án thay thế (Alternatives Considered):**
  * *Python Worker đọc trực tiếp BullMQ:* Phụ thuộc vào thư viện BullMQ cho Python chưa thực sự ổn định, làm tăng coupling giữa 2 ngôn ngữ.
  * *Chạy tác vụ AI trực tiếp trong Node.js:* Thư viện OpenCV/PyTorch trong Node.js kém tối ưu và dễ gây crash tiến trình API.
* **Hệ quả (Consequences):** Phân định ranh giới rõ ràng; Python Worker tập trung xử lý thuật toán ảnh; NestJS quản lý trạng thái, socket realtime và nghiệp vụ xuất bản.

---

### ADR-007: Mô Hình WebSocket Reconnect-Aware Cho Tiến Trình Dịch AI
* **Trạng thái (Status):** Accepted
* **Bối cảnh (Context):** Quá trình dịch 1 chapter truyện gồm 30-50 trang diễn ra lâu. Client cần cập nhật tiến trình % thời gian thực, nhưng kết nối mạng có thể bị gián đoạn (chuyển mạng Wifi/4G).
* **Quyết định (Decision):** Áp dụng mô hình kết hợp: **WebSocket Gateway** đẩy event tiến trình thời gian thực (`job_progress`, `job_completed`) kèm **REST API Fallback Query (`GET /api/v1/ai/jobs/:id`)**. Khi Client bị ngắt kết nối và reconnect, Client sẽ gọi REST API để đồng bộ trạng thái mới nhất từ Redis/DB rồi tiếp tục lắng nghe WebSocket.
* **Các phương án thay thế (Alternatives Considered):**
  * *Chỉ dùng HTTP Polling (mỗi 2 giây gọi 1 lần):* Tốn tài nguyên server và băng thông mạng không cần thiết.
  * *Chỉ dùng WebSocket thuần:* Mất thông tin nếu gói tin socket bị rớt trong lúc client offline.
* **Hệ quả (Consequences):** Trải nghiệm người dùng mượt mà, không bao giờ bị kẹt trạng thái tiến trình ảo.

---

### ADR-008: Trừu Tượng Hóa Nhà Cung Cấp Dịch Thuật AI (Provider Abstraction)
* **Trạng thái (Status):** Accepted
* **Bối cảnh (Context):** Chi phí, độ trễ và chất lượng của các mô hình AI (OpenAI GPT-4o-mini, DeepL, Claude, Local LLM Ollama) liên tục thay đổi. Cần đảm bảo hệ thống không bị vendor lock-in vào một nhà cung cấp duy nhất.
* **Quyết định (Decision):** Thiết kế `ITranslationProvider` interface theo **Adapter Pattern**. Tầng Core chỉ giao tiếp qua interface này. Việc chuyển đổi từ OpenAI sang DeepL hoặc Local LLM chỉ cần thay đổi cấu hình adapter.
* **Các phương án thay thế (Alternatives Considered):**
  * *Gọi trực tiếp OpenAI SDK trong nghiệp vụ:* Gây phụ thuộc chặt chẽ, khó mock test và không thể đổi nhà cung cấp khi bị lỗi quota/rate-limit.
* **Hệ quả (Consequences):** Dễ dàng mở rộng thêm nhà cung cấp mới, viết unit test mock đơn giản và hỗ trợ fallback tự động giữa các provider.

---

### ADR-009: Bảo Vệ Bản Quyền Hình Ảnh & Giảm Thiểu Tình Trạng Cào Trộm Dữ Liệu (Anti-Leech URLs)
* **Trạng thái (Status):** Accepted
* **Bối cảnh (Context):** Các website truyện lậu thường xuyên dùng bot cào URL trực tiếp từ CDN/Storage để hotlink làm hao tốn băng thông và vi phạm bản quyền nội dung.
* **Quyết định (Decision):** Áp dụng **Dynamic HMAC-SHA256 Signed URLs** có thời hạn ngắn (15 phút) kết hợp Nginx Rate Limiting nhằm giảm thiểu tối đa khả năng hotlink và scraping hàng loạt, kết hợp nhúng mã truy vết ẩn danh (Pseudonymous Trace Code) trên canvas đọc truyện.
* **Các phương án thay thế (Alternatives Considered):**
  * *Public Static URLs:* Rất dễ bị leech toàn bộ kho truyện bằng script tải hàng loạt.
  * *Mã hóa toàn bộ file ảnh phía server và giải mã bằng WebAssembly trên browser:* Chi phí giải mã cao, gây giật lag trên thiết bị yếu.
* **Hệ quả (Consequences):** Giảm thiểu tối đa nguy cơ hotlink trực tiếp; đáp ứng xuất sắc tiêu chí chấm điểm môn An toàn thông tin.

---

### ADR-010: Mã Hóa Mật Khẩu Người Dùng Bằng Argon2id & Cấp Phát JWT HS256
* **Trạng thái (Status):** Accepted
* **Bối cảnh (Context):** Mật khẩu người dùng là dữ liệu nhạy cảm hàng đầu, cần được bảo vệ chống lại các hình thức tấn công vét cạn (Brute-force) và tấn công bằng phần cứng chuyên dụng (GPU/ASIC/FPGA). Token xác thực cần cơ chế ký gọn nhẹ và an toàn.
* **Quyết định (Decision):** Sử dụng thuật toán băm mật khẩu chuẩn quốc tế **Argon2id** (memory cost 64MB, time cost 3 iterations, parallelism 4 threads) và cấp phát JWT ký đối xứng bằng **`HS256`** với secret key an toàn lưu trong biến môi trường `.env`.
* **Các phương án thay thế (Alternatives Considered):**
  * *MD5 / SHA-256 thuần:* Rất yếu, bị giải mã trong vài mili-giây qua Rainbow Table.
  * *Bcrypt:* Tốt nhưng không có cơ chế chống tấn công bộ nhớ bằng GPU/FPGA mạnh mẽ như Argon2id.
* **Hệ quả (Consequences):** Đảm bảo an toàn tối đa cho mật khẩu người dùng, tuân thủ các khuyến nghị bảo mật khắt khe nhất của OWASP.

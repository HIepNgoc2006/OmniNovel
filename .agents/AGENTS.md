# Cấu hình Dự án OmniNovel (Đọc truyện Đa phương thức & AI Translation Hub)

## 1. Thông tin chung
- **Tên dự án:** OmniNovel (MangaVerse)
- **Mục tiêu:** Nền tảng Đọc truyện Đa phương thức (Webtoon, Manga, Light Novel / Truyện chữ) tích hợp Studio Dịch truyện tự động bằng AI (OCR, Inpainting, Translation, Glossary).
- **Phục vụ đồ án 5 môn:**
  1. Kỹ năng lập trình nâng cao (Clean Architecture, Worker Queue, Redis Multi-level Caching, Full-Text Search).
  2. Phát triển ứng dụng di động (Flutter / React Native, Webtoon & Light Novel Reader, Offline Caching, AI Action Popup).
  3. Triển khai phần mềm (Docker Compose Multi-Container, Nginx Caching Proxy, CI/CD GitHub Actions).
  4. An toàn thông tin (Anti-Leech Bot, Rate Limiting, File Upload Malware/MIME Scan, RBAC, JWT Rotation).
  5. Quản lý dự án CNTT (Agile/Scrum, WBS, Gantt Chart, Phân tích rủi ro & Chi phí AI/S3).

## 2. Quy chuẩn kiến trúc & Mã nguồn
- **Monorepo Structure:**
  - `apps/web`: Ứng dụng Web Đọc truyện & Studio (Next.js / React).
  - `apps/mobile`: Ứng dụng Di động iOS/Android (Flutter / React Native).
  - `services/api`: Backend Core API (NestJS / Go).
  - `services/ai-worker`: Dịch vụ xử lý ảnh & AI Translation Worker (Python FastAPI / Celery).
  - `packages/shared`: Kiểu dữ liệu, DTOs, utilities dùng chung.
  - `deploy`: Dockerfile, Docker Compose, Nginx config, CI/CD workflows.
  - `plans`: Tài liệu kế hoạch, roadmap, theo dõi tiến độ.
- **Tiêu chuẩn Code:** Clean Architecture, KISS & YAGNI, không tạo tầng trừu tượng dư thừa.
- **Quản lý biến môi trường:** Mọi secret, key AI, DB credentials đều đặt trong `.env`, không commit `.env` lên git.

## 3. Quy định Cài đặt Môi trường & Đồng bộ Git
- **Cô lập Môi trường Cục bộ (Local Isolation - Bắt buộc):**
  - Tuyệt đối **KHÔNG ĐƯỢC PHÉP** cài đặt bất kỳ công cụ, package, thư viện, CLI, Skill hay Plugin nào ra ngoài phạm vi dự án (toàn cục máy tính / Global PATH / User directory).
  - Mọi công cụ và thư viện chỉ được phép cài đặt cục bộ bên trong thư mục dự án `e:\Workspace2\Doctruyen_project` (ví dụ: `node_modules`, `.venv`, `.agents/skills/...`).
  - Luôn chỉ rõ đường dẫn cụ thể của bất kỳ file/thư mục nào được tạo ra hoặc cài đặt.
- **Kỷ luật Ranh giới Sandbox & Ngăn chặn Tạo Thư mục Bừa bãi (Strict Sandbox Boundaries):**
  - **Ranh giới Tuyệt đối (Absolute Sandbox Boundary):** Phạm vi hoạt động duy nhất của AI, Subagent, Background Worker và tất cả tiến trình phát triển là bên trong thư mục dự án `e:\Workspace2\Doctruyen_project`. Tuyệt đối **KHÔNG ĐƯỢC PHÉP** tự ý tạo file, thư mục, thư mục clone, hay workspace ngang cấp tại `e:\Workspace2\` hoặc bất kỳ đâu ngoài ranh giới dự án.
  - **Quy chuẩn Quản lý Phân nhánh & Git Worktree (Git Worktree Discipline):**
    - Nghiêm cấm chạy lệnh `git worktree add ../<path>` ra ngoài thư mục gốc của dự án.
    - Trong trường hợp bắt buộc phải sử dụng Git Worktree để cô lập phân nhánh song song, vị trí DUY NHẤT được phép đặt là thư mục con ẩn trong dự án: `e:\Workspace2\Doctruyen_project\.worktrees/<tên-nhánh>` (đã được cấu hình trong `.gitignore`).
    - **Nghĩa vụ Dọn dẹp Ngay lập tức (Immediate Lifecycle Cleanup):** Ngay sau khi tác vụ hoàn thành (tạo PR, chạy test xong hoặc merge), AI **BẮT BUỘC phải thực hiện dọn dẹp sạch sẽ**:
      1. Chạy `git worktree remove --force` để gỡ bỏ liên kết worktree.
      2. Chạy `git worktree prune` để làm sạch siêu dữ liệu git.
      3. Xóa triệt để thư mục vật lý (đặc biệt là `node_modules` hay các file untracked/ignored mà git bỏ lại), không để bất kỳ tàn tích nào tồn tại trên đĩa.
  - **Quy chế Dọn dẹp File & Thư mục Tạm (Temp & Artifact Hygiene):** Mọi file tạm phục vụ debug/script phải được lưu trong `<appDataDir>\brain\<conversation-id>/scratch/` hoặc tự động xóa sạch sau khi hoàn thành. Không được xả rác ra root dự án hay ổ đĩa máy tính.
- **Đồng bộ Git Tự động & Liên tục (Continuous Commit & Push):**
  - Bất cứ khi nào có thay đổi (tạo mới, sửa đổi, xóa) các file không nằm trong danh sách loại trừ của `.gitignore`, phải lập tức thực hiện `git add`, `git commit` với thông điệp rõ ràng và `git push` lên repository từ xa ngay.
  - **Git Remote / Organization:** `https://github.com/HIepNgoc2006/OmniNovel` (Repository: `https://github.com/HIepNgoc2006/OmniNovel`).
- **GitHub CLI (`gh`) — Ưu tiên tuyệt đối:**
  - Luôn dùng `gh` CLI (đã cài sẵn trên máy) cho mọi thao tác GitHub: Issues (tạo/sửa/đóng/xem), Pull Requests, Branches, Labels, Milestones, Releases, v.v.
  - **Không dùng MCP GitHub tools** trừ khi `gh` CLI gặp lỗi hoặc không hỗ trợ thao tác cần thiết.
  - Lý do: `gh` CLI nhanh hơn đáng kể, output dễ parse, và chạy trực tiếp trong terminal.
- **Xác minh Đường dẫn & Trạng thái Thực tế (Ground-Truth Verification - Tuyệt đối không suy đoán):**
  - Tuyệt đối **KHÔNG ĐƯỢC PHÉP** suy đoán hoặc trả lời dựa trên các đường dẫn mặc định (default paths) của phần mềm/công cụ (ví dụ: vị trí Docker data, WSL VHDX, cache SDK, output build...).
  - Trước khi khẳng định bất kỳ đường dẫn nào với người dùng, **BẮT BUỘC phải chạy lệnh kiểm tra thực tế** (CLI, PowerShell, Registry hoặc hệ thống file) để lấy đúng đường dẫn và trạng thái đang cấu hình trên máy.
  - Luôn kiểm tra dung lượng và phân biệt rành mạch giữa file dữ liệu nặng thực sự (như `.vhdx`, database volume, binary build) và các thư mục log/metadata tạm thời.


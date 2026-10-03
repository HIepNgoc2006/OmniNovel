# 📱💻 OmniNovel Architecture: Web ↔ Mobile Capability Parity Matrix

> **Tài liệu Canonical SSoT số 4** thuộc **Phase 7.0 — Product Architecture & Data Ownership Design Gate**.  
> Xác lập ma trận năng lực tính năng, ranh giới thiết kế trải nghiệm người dùng (UX) và chuẩn hóa hợp đồng giữa Next.js Web Client và Flutter Mobile App.

---

## 1. Nền Tảng Công Nghệ Hiện Hữu & Ranh Giới Thiết Kế

| Đặc Tính | Next.js Web Client (`apps/web`) | Flutter Mobile App (`apps/mobile`) |
|---|---|---|
| **Framework & Ngôn ngữ** | **Next.js 16.3.3 / React 19.2** (TypeScript) | **Flutter 3.x / Dart 3.x** |
| **Styling & Design System** | Tailwind CSS v4, Glassmorphism, CSS Variables | Flutter Material 3 + Custom Canvas Design System |
| **Kho Lưu Trữ Cục Bộ (Local)** | **IndexedDB** (`omninovel_local_v2`) + `localStorage` | **SQLite** (Floor/sqflite) + `SharedPreferences` |
| **Cơ Chế Ngoại Tuyến (Offline)** | Service Worker Cache API + IndexedDB | Local Filesystem Sandbox + SQLite Storage Quota LRU |
| **Triết Lý Trải Nghiệm** | Tối ưu màn hình lớn, phím tắt, đọc nhiều tab | Tối ưu cảm ứng 120Hz, vuốt chạm (gestures), haptic feedback |

---

## 2. Ma Trận Năng Lực Chi Tiết (Feature Parity Breakdown)

Ký hiệu:
- `[x] Hoàn chỉnh`: Tính năng đã hoạt động production-grade.
- `[/] Cần nâng cấp`: Đã có nền móng nhưng cần hoàn thiện theo chuẩn Phase 7.
- `[ ] Cần xây dựng`: Tính năng mới cần triển khai.

| Tính Năng (Capability) | Web Client (`apps/web`) | Mobile App (`apps/mobile`) | Ghi Chú Ranh Giới Kỹ Thuật |
|---|:---:|:---:|---|
| **Khám phá (Home / Discovery)** | `[x]` Hoàn chỉnh | `[x]` Hoàn chỉnh | Cùng cấu trúc dữ liệu Banner, Top Thịnh Hành, Mới Cập Nhật. |
| **Tìm kiếm & Bộ lọc (Search)** | `[x]` Hoàn chỉnh | `[x]` Hoàn chỉnh | Hỗ trợ lọc theo thể loại, trạng thái, media format (Manga/Novel). |
| **Trang Chi tiết Truyện (Story Detail)**| `[x]` Hoàn chỉnh | `[x]` Hoàn chỉnh | Hiển thị danh sách chương, tác giả, nhóm dịch, đánh giá. |
| **Trình Đọc Manga (LTR / RTL)** | `[x]` Hoàn chỉnh | `[x]` Hoàn chỉnh | Web hỗ trợ phím mũi tên A/D; Mobile hỗ trợ vuốt trang mượt mà. |
| **Trình Đọc Webtoon (Vertical Scroll)**| `[x]` Hoàn chỉnh | `[x]` Hoàn chỉnh | Cuộn dọc liên tục, tự động ghi nhận vị trí phần trăm. |
| **Trình Đọc Novel (Light Novel)** | `[x]` Hoàn chỉnh | `[x]` Hoàn chỉnh | Định vị theo `anchorBlockId` (đoạn văn) và `textOffset`. |
| **Cài đặt Trình Đọc (Reader Settings)**| `[x]` Hoàn chỉnh | `[x]` Hoàn chỉnh | Cỡ chữ, dãn dòng, phông chữ, nền (Sáng/Tối/Sepia/AMOLED). |
| **Chế độ Khách (Guest Mode)** | `[/]` Cần nâng cấp | `[/]` Cần nâng cấp | **Phase 7A:** Chuyển sang IndexedDB (Web) & SQLite Scope (App). |
| **Chuyển Giao Dữ Liệu (Guest Claim)** | `[ ]` Cần xây dựng | `[ ]` Cần xây dựng | **Phase 7B:** Áp dụng Two-Step Claim Protocol (`prepare` & `commit`). |
| **Đồng Bộ Đa Thiết Bị (Multi-Device Sync)**| `[ ]` Cần xây dựng | `[ ]` Cần xây dựng | **Phase 7C:** Unified Revision-based Sync Protocol. |
| **Đọc Ngoại Tuyến (Offline Reading)** | `[/]` Cần nâng cấp | `[x]` Rất mạnh | Mobile quản lý LRU/Quota; Web triển khai Cache API cho chương đang đọc. |
| **Cộng Đồng (Community / Comments)** | `[/]` Đang là Mock UI | `[ ]` Cần xây dựng | **Phase 7E:** Thay thế Mock bằng REST API thật, lưu trữ PostgreSQL. |
| **Theo Dõi Truyện (Following)** | `[/]` Bookmark only | `[/]` Bookmark only | **Phase 7F:** Tách biệt Bookmark cá nhân và Follow nhận thông báo. |
| **Trung Tâm Thông Báo (Notifications)**| `[ ]` Cần xây dựng | `[ ]` Cần xây dựng | **Phase 7F:** In-App Notification Center khi có chương mới. |
| **Studio Dịch Truyện AI (Studio Hub)** | `[x]` Đầy đủ Studio | `[x]` Quick Approval | Web cho phép can thiệp sâu; Mobile tập trung duyệt nhanh bản dịch. |

---

## 3. Chuẩn Hóa 8 Trạng Thái Hệ Thống (The 8 Canonical System States)

Mọi màn hình trên cả Web và Mobile bắt buộc phải hỗ trợ đầy đủ 8 trạng thái, không để xảy ra trường hợp màn hình trắng hoặc lỗi crash:

```text
1. LOADING          Skeleton loader có animation shimmer, giữ nguyên layout, không gây giật khung hình (Layout Shift = 0).
2. ERROR            Thông báo lỗi thân thiện, phân biệt rõ (Mạng chập chờn / Lỗi máy chủ / Không tìm thấy), có nút "Thử lại".
3. EMPTY            Hình minh họa đẹp, thông báo rõ ràng kèm nút gợi ý hành động (vd: "Thư viện trống -> Khám phá truyện mới").
4. OFFLINE          Hiển thị huy hiệu Ngoại tuyến, tự động chuyển nguồn dữ liệu sang cache cục bộ (IndexedDB/SQLite).
5. UNAUTHORIZED     Thông báo nhẹ nhàng yêu cầu đăng nhập khi dùng tính năng nâng cao, không chặn các tác vụ cơ bản.
6. FORBIDDEN        Giải thích lý do không có quyền truy cập (vd: "Chương này yêu cầu quyền Translator/Editor").
7. EXPIRED SESSION  Tự động kích hoạt luồng Refresh Token ngầm (Silent Refresh); nếu thất bại thì đăng xuất an toàn.
8. PARTIAL DATA     Hiển thị ngay phần dữ liệu đã tải thành công, tiếp tục tải bù phần còn thiếu ở chế độ nền.
```

---

## 4. Quy Chuẩn Đồng Nhất Mã Nguồn & Hợp Đồng Dữ Liệu

1. **Tuyệt Đối Không Phân Rẽ Logic Nghiệp Vụ (No Divergent Business Logic):**
   - `@omninovel/shared` là Single Source of Truth cho toàn bộ:
     - DTOs & Schemas.
     - Enums (`PublicationFormat`, `ReadingMode`, `GlobalRole`, `TranslationJobStatus`).
     - Error Codes (`AUTH_UNAUTHORIZED`, `CLAIM_EXPIRED`, `TOMBSTONE_CONFLICT`).
     - Quy tắc tính phần trăm đọc và định danh chương.
2. **Đối Ứng Với Flutter (Dart Contract Parity):**
   - Mọi model trong `apps/mobile/lib/core/network/models` hoặc `features/*/domain/entities` phải ánh xạ 1-1 chính xác với TypeScript interfaces trong `@omninovel/shared`.
   - Có bộ kiểm thử Contract Parity Test để phát hiện sớm nếu một bên thay đổi trường dữ liệu.

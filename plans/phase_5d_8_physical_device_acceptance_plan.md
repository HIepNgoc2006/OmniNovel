# Kế Hoạch Nghiệm Thu Phase 5D.8: Physical Android Device Acceptance, Performance Evidence & Phase 5 Final Freeze

- **Tên Phase:** Phase 5D.8 — Physical Android Device Acceptance, Performance Evidence & Phase 5 Final Freeze
- **Trạng Thái:** **ACTIVE — EVIDENCE COLLECTION IN PROGRESS 🟡**
- **Tracking Issue:** [Issue #208](https://github.com/HIepNgoc2006/OmniNovel/issues/208)
- **Living Master Tracker:** [Issue #192](https://github.com/HIepNgoc2006/OmniNovel/issues/192)
- **Baseline Tham Chiếu Cứng (Pinned Baseline):**
  - **Application logic baseline:** Commit [`e6b8cbe`](https://github.com/HIepNgoc2006/OmniNovel/commit/e6b8cbe) (`main@e6b8cbed76080da75ced4ea0055e4da1054a3b59`)
  - **Build/acceptance baseline:** Commit [`34a6771`](https://github.com/HIepNgoc2006/OmniNovel/commit/34a6771) (`main@34a6771712c3f966bbdb56cb9e99f905ffb907ab`, thêm `kotlin.incremental=false` giải quyết build cross-drive)
- **Suite Baseline Hiện Tại:** 314/314 tests PASS 100%, `flutter analyze` 0 issues.
- **Tính Chất Phase:** **Acceptance / Evidence Phase** (Nghiêm cấm thêm feature mới; chỉ tập trung thu thập bằng chứng thực nghiệm trên phần cứng thật).
- **Môi Trường Toolchain Cố Định (Pinned Toolchain):** Project-local OpenJDK 17.0.20.1 LTS binary (`.tools/jdk-17`) + Flutter CLI pinned qua `flutter config --jdk-dir`, Gradle 8.10.2, AGP 8.7.0, Flutter 3.47.5 (Dart 3.13.4).

---

## 1. NGUYÊN TẮC BẤT BIẾN NGHIỆM THU (STRICT EVIDENCE INVARIANTS)

1. **Physical Hardware Evidence Only:**
   - Tuyệt đối **không được dùng số đo từ Android Emulator** để thay thế cho biên bản nghiệm thu Physical Device Acceptance.
   - Toàn bộ metrics về RAM (TOTAL PSS, TOTAL RSS, Native/Dalvik Heap), GPU rendering (Frame time P90/P95, Jank rate), và IO Disk Space (`StatFs`) phải được trích xuất trực tiếp từ thiết bị vật lý qua ADB / Android Studio Profiler.
2. **Fail-Closed Reporting (Tuyệt Đối Không Đoán / Ước Lượng PASS):**
   - Nếu chưa có thiết bị thuộc phân khúc tương ứng (ví dụ: máy Low-End 2–3 GB RAM hoặc máy màn hình 90/120 Hz), mục kiểm thử đó **bắt buộc phải ghi rõ trạng thái `NOT VERIFIED` hoặc `PENDING_PHYSICAL_DEVICE`**. Tuyệt đối không tự tiện đánh dấu PASS.
3. **Commit Invalidation & Re-Verification Protocol:**
   - Nếu trong quá trình kiểm thử phần cứng phát hiện lỗi thực tế buộc phải sửa code (fix bug/regression), baseline tham chiếu sẽ phải chuyển sang commit mới.
   - Ngay lập tức, AI phải **chạy lại toàn bộ 314/314 tests + `flutter analyze` đạt 100% GREEN** trước khi tiếp tục đo đạc lấy evidence.
4. **Clean Workspace & SSoT Integrity:**
   - Mọi logcat, trace file, dump file hoặc ảnh chụp màn hình bằng chứng phải được lưu trữ có cấu trúc rõ ràng trong thư mục tài liệu `docs/evidence/phase_5d_8/` hoặc đính kèm trực tiếp vào Issue #208.

---

## 2. MA TRẬN 10 DANH MỤC NGHIỆM THU (ACCEPTANCE MATRIX)

| Danh Mục (Category) | Tiêu Chí Nghiệm Thu (Acceptance Criteria) | Công Cụ & Phương Pháp Đo Đạc | Target Chuẩn | Trạng Thái Hiện Tại |
| :--- | :--- | :--- | :---: | :---: |
| **1. Device Matrix** | Ít nhất 1 máy Mid-Range (4–6 GB RAM) và 1 máy Low-End (2–3 GB RAM). Ít nhất 1 máy hỗ trợ màn hình 90/120 Hz. | `adb shell getprop ro.product.model`, `adb shell cat /proc/meminfo`, `dumpsys display` | Đạt đủ 2 phân khúc phần cứng | **PENDING_HARDWARE_CONNECTION** |
| **2. Reader Performance & Frame Budget** | Webtoon (>50 trang ảnh), Manga (zoom/pan), Novel (>10k từ). Đo Frame time P90/P95, Jank rate khi cuộn/lật trang liên tục. | `adb shell dumpsys gfxinfo com.omninovel.mobile framestats` | 120Hz: P90 < 8.3ms; 90Hz: P90 < 11.1ms; 60Hz: P90 < 16.6ms; Jank < 1.5% | **PENDING_HARDWARE_CONNECTION** |
| **3. Memory Pressure & Leak Prevention** | Đọc liên tục >30 phút, đổi qua 10+ chapters, background/foreground cycling, kích hoạt trim memory. Đo đạc minh bạch TOTAL PSS, TOTAL RSS (Process RSS), Native Heap và Dalvik Heap. | `adb shell dumpsys meminfo com.omninovel.mobile`, Android Profiler | Acceptance chính: Working-set TOTAL PSS < 120 MB / RSS < 150 MB; Native + Dalvik breakdown rõ ràng; 0 Leak sau GC | **PENDING_HARDWARE_CONNECTION** |
| **4. Offline E2E Lifecycle** | Download 3 chapters song song ➔ Pause/Resume ➔ Unzip isolate ➔ Bật Chế độ máy bay ➔ Đọc 100% offline ➔ Process death ➔ Resume ➔ Delete/LRU. | `adb shell cmd connectivity airplane-mode enable`, `adb logcat`, Network Profiler | Zero Network Requests; Content hiển thị nguyên vẹn | **PENDING_HARDWARE_CONNECTION** |
| **5. Real Disk Pressure & StatFs** | Thử nghiệm trên thiết bị khi dung lượng trống gần chạm ngưỡng bảo vệ (`dynamicHeadroom` ~500 MB). | Native Android `StatFs` qua MethodChannel `com.omninovel.mobile/disk_space` | Fail-closed từ chối tải khi thiếu chỗ; Zero giả định 10GB | **PENDING_HARDWARE_CONNECTION** |
| **6. Account Isolation & Data Privacy** | User A tải 2 chapters. Đăng xuất User A, đăng nhập User B (hoặc Guest). User B không truy cập được dữ liệu User A. | Kiểm tra SQLite DB v2 (`user_id` query) & Sandbox Filesystem `0700` | Cách ly 100%; User B 0 nhìn thấy file/row của User A | **PENDING_HARDWARE_CONNECTION** |
| **7. Studio 5D.7 Physical Verification** | Mở Action Sheet duyệt AI trên máy thật: Preview Manga Trước/Sau, Novel song ngữ, Permission guard, Stale guard, Apply + offline hint. | Tương tác UI thực tế + Server Mock/Live Dev API | UI hiển thị mượt mà; Freshness & Permission chặn đúng; Hint bật đúng | **PENDING_HARDWARE_CONNECTION** |
| **8. Lifecycle, Process Death & Recovery** | Xoay màn hình, Split-screen, Screen-off khi đang đọc/tải, Kill app từ Recent Apps (`am kill`). Khởi động lại app. | `adb shell am kill com.omninovel.mobile`, kiểm tra checkpoint SQLite | Download queue ở trạng thái `PAUSED`; Vị trí đọc resume 100% | **PENDING_HARDWARE_CONNECTION** |
| **9. Network Degradation & Resilience** | Ngắt kết nối Wi-Fi đột ngột khi đang tải dở hoặc đang gửi POST `/apply`. Giả lập timeout / reconnect. | Thao tác ngắt mạng vật lý + Proxy Throttling | Queue pause fail-safe; Apply giữ `SUBMISSION_OUTCOME_UNKNOWN`, không tạo duplicate | **PENDING_HARDWARE_CONNECTION** |
| **10. Evidence Pack Generation** | Biên soạn đầy đủ thông số thiết bị, bảng số liệu RSS/Frame, Logcat, Profiler trace, ảnh/video chụp màn hình. | Trích xuất báo cáo đính kèm vào Issue #208 | Minh bạch 100%, có chữ ký số SHA commit & SHA-256 APK | **PENDING_HARDWARE_CONNECTION** |

---

## 3. HƯỚNG DẪN KẾT NỐI & THU THẬP DỮ LIỆU BẰNG ADB

Đường dẫn công cụ ADB trên máy tính của bạn:
```powershell
& "D:\Users\hiep\AppData\Local\Android\Sdk\platform-tools\adb.exe" devices -l
```

### 3.1. Các bước kết nối thiết bị thật
1. **Bật Chế độ Nhà phát triển (Developer Options):**
   - Vào *Cài đặt (Settings)* ➔ *Thông tin điện thoại (About Phone)* ➔ Nhấn liên tục 7 lần vào *Số hiệu bản dựng (Build Number)*.
2. **Bật Gỡ lỗi USB (USB Debugging):**
   - Vào *Cài đặt* ➔ *Tùy chọn nhà phát triển* ➔ Bật *Gỡ lỗi qua USB (USB Debugging)*.
3. **Cắm cáp USB vào máy tính:**
   - Trên màn hình điện thoại, chọn *"Luôn cho phép từ máy tính này"* và bấm *OK*.
4. **(Tùy chọn) Kết nối qua Wi-Fi (Wireless Debugging trên Android 11+):**
   ```powershell
   & "D:\Users\hiep\AppData\Local\Android\Sdk\platform-tools\adb.exe" pair <ip-address>:<port>
   & "D:\Users\hiep\AppData\Local\Android\Sdk\platform-tools\adb.exe" connect <ip-address>:<port>
   ```

### 3.2. Lệnh Build Release / Profile APK phục vụ đo đạc
Để số liệu đo đạc chính xác (không bị ảnh hưởng bởi overhead của debug mode JIT compiler), ứng dụng phải được chạy ở chế độ **Profile** hoặc **Release**:
```powershell
# Chạy ở chế độ profile trên thiết bị thật có gắn cờ profiling
flutter run --profile -d <device-id>

# Hoặc build file APK Release độc lập để cài đặt
flutter build apk --release
```

### 3.3. Các lệnh ADB trích xuất Evidence chuẩn
```powershell
$ADB = "D:\Users\hiep\AppData\Local\Android\Sdk\platform-tools\adb.exe"

# 1. Lấy thông số thiết bị
& $ADB shell getprop ro.product.model
& $ADB shell getprop ro.build.version.release
& $ADB shell cat /proc/meminfo | Select-String "MemTotal"

# 2. Đo bộ nhớ RAM (RSS / Native Heap / Dalvik)
& $ADB shell dumpsys meminfo com.omninovel.mobile

# 3. Đo độ mượt đồ họa (GPU Rendering & Frame Time)
& $ADB shell dumpsys gfxinfo com.omninovel.mobile reset
# (Thực hiện cuộn trang trên điện thoại trong 10-20 giây)
& $ADB shell dumpsys gfxinfo com.omninovel.mobile

# 4. Kích hoạt dọn dẹp bộ nhớ hệ thống (Memory Pressure Test)
& $ADB shell am send-trim-memory com.omninovel.mobile MODERATE

# 5. Giả lập kill app để kiểm tra Process Death Recovery
& $ADB shell am kill com.omninovel.mobile
```

### 3.4. Bằng Chứng Biên Dịch Acceptance APK (Pre-Hardware Gate Verified ✅)
- **Phân Định Provenance & Baseline:**
  - **Application logic baseline:** Commit [`e6b8cbe`](https://github.com/HIepNgoc2006/OmniNovel/commit/e6b8cbe) (Logic app 100% nguyên vẹn, zero thay đổi code nghiệp vụ).
  - **Build/acceptance baseline:** Commit [`34a6771`](https://github.com/HIepNgoc2006/OmniNovel/commit/34a6771) (`main@34a6771712c3f966bbdb56cb9e99f905ffb907ab`, thêm `kotlin.incremental=false` tại `apps/mobile/android/gradle.properties`).
- **Môi Trường Toolchain Cố Định (Pinned Toolchain):**
  - **Java Runtime:** Project-local OpenJDK 17.0.20.1 LTS binary (`.tools/jdk-17`) + Flutter CLI pinned qua `flutter config --jdk-dir`.
  - **Gradle / AGP:** Gradle 8.10.2 + Android Gradle Plugin 8.7.0.
  - **Android SDK & NDK:** SDK Platform 36/34, Build-Tools 34.0.0, NDK `27.0.12077973`.
  - **Flutter SDK:** Channel stable 3.47.5 (Engine af7e796e16, Dart 3.13.4).
- **Phân Loại & Bản Chất Binary (Artifact Classification):**
  - **Loại file:** **Acceptance APK — release build, debug-signed** (Biên dịch ở chế độ Release với đầy đủ R8 code shrinking, obfuscation, resource shrinking, AOT release compilation, nhưng được ký bằng debug key nội bộ phục vụ kiểm thử hiệu năng phần cứng Phase 5D.8; chưa phải production distribution RC).
  - **Đường dẫn:** `apps/mobile/build/app/outputs/flutter-apk/app-release.apk`
  - **Dung lượng:** 57,982,080 bytes (55.3 MB).
  - **Mã băm SHA-256 (Tái lập độc lập từ clean worktree):**
    ```text
    015FEC94E1481B1C07A5D22F0B960B1D61E3ADEB398B6B3429945282BDBFB395
    ```
- **Trạng Thái ADB Thiết Bị Hiện Tại:**
  - Lệnh kiểm tra: `& "D:\Users\hiep\AppData\Local\Android\Sdk\platform-tools\adb.exe" devices -l`
  - Kết quả: `List of devices attached` (Rỗng / Chưa kết nối cáp USB hoặc Wi-Fi Debugging)
  - **Quy tắc nghiệm thu:** Tất cả 10 Physical Gates tiếp tục giữ trạng thái **`PENDING_HARDWARE_CONNECTION`**, tuyệt đối không giả định hay chuyển PASS sớm.

---

## 4. TIẾN TRÌNH & ĐIỀU KIỆN ĐÓNG BĂNG PHASE 5 FINAL

1. Khi thiết bị Android vật lý được kết nối và xác nhận qua lệnh `adb devices`, AI sẽ đồng hành cùng người dùng lần lượt thực hiện và trích xuất số liệu cho từng danh mục trong Ma trận 10 Gates.
2. Mọi số liệu thực tế sẽ được cập nhật trực tiếp vào file kế hoạch này và đính kèm vào [Issue #208](https://github.com/HIepNgoc2006/OmniNovel/issues/208).
3. Chỉ khi các gate vật lý đạt chuẩn cam kết:
   - Đóng Issue #208.
   - Cập nhật Living Master Tracker #192 sang trạng thái: **Phase 5 — FINAL FROZEN BASELINE ✅**.
   - Khóa release candidate commit cho ứng dụng di động OmniNovel.

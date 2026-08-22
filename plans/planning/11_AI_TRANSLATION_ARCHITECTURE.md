# 🤖 11. Kiến Trúc Pipeline Dịch Truyện AI & State Machine 14 Trạng Thái

Tài liệu này đặc tả chi tiết toàn bộ thuật toán xử lý ảnh Manga, xử lý văn bản Light Novel, State Machine 14 trạng thái của AI Job, kiến trúc hàng đợi Worker và cơ chế trừu tượng hóa Provider (**TranslationProvider Abstraction**).

---

## 1. PIPELINE XỬ LÝ ẢNH TRUYỆN TRANH TOÀN DIỆN (MANGA CV/AI PIPELINE)

Quy trình tự động hóa xử lý 1 trang ảnh Manga gồm 11 bước khép kín:

```
[1. Ingestion] ➔ [2. Preprocessing] ➔ [3. Text Detection] ➔ [4. Reading Order] ➔ [5. OCR Engine]
                                                                                      │
                                                                                      ▼
[10. Visual QA] ◄── [9. Typesetting] ◄── [8. Inpainting] ◄── [7. LLM Translate] ◄── [6. Glossary]
```

1. **Ingestion & Validation:** Tiếp nhận file ảnh WebP/PNG, kiểm tra magic bytes, độ phân giải tối đa (4096x4096px).
2. **Preprocessing (Tiền xử lý):** Tự động cân bằng độ tương phản (Auto-contrast), khử nhiễu và chuẩn hóa hệ tọa độ pixel.
3. **Text Region Detection (Phát hiện bóng thoại):** Sử dụng mô hình Deep Learning (CRAFT / YOLO / OpenCV Connected Components) để xác định các khung chứa chữ (Bounding Boxes: $x, y, w, h$).
4. **Reading Order Sorting (Sắp xếp thứ tự đọc):** Sắp xếp các bóng thoại theo quy chuẩn:
   * **Manga Nhật:** Từ Phải sang Trái, từ Trên xuống Dưới.
   * **Webtoon Hàn / Manhua Trung:** Từ Trên xuống Dưới theo luồng cuộn dọc.
5. **OCR Engine (Nhận dạng chữ quang học):** Sử dụng **Manga-OCR** (Vision-Transformer chuyên biệt cho chữ tượng hình tiếng Nhật/Hàn/Trung) với ngưỡng độ tin cậy $Confidence \ge 0.85$.
6. **Context Building & Glossary Matching:** Ghép các bóng thoại liên tiếp thành ngữ cảnh hội thoại hoàn chỉnh và đối soát với bảng Từ Điển Thuật Ngữ (`translation_glossaries`) để cố định tên riêng/chiêu thức.
7. **LLM Contextual Translation:** Gửi prompt có kèm ngữ cảnh và glossary tới Translation Adapter (OpenAI GPT-4o-mini / DeepL / Local LLM) để dịch sang tiếng Việt tự nhiên.
8. **Inpainting / Text Removal (Tẩy chữ nền tranh):** Tạo mask phủ chữ cũ và sử dụng mô hình **LaMa (Large Mask Inpainting)** để tái tạo hoàn hảo nét vẽ và chi tiết nền tranh phía sau bóng thoại.
9. **Typesetting & Text Rendering (Dàn chữ tự động):** Tự động tính toán kích thước font chữ, tự động xuống dòng (Auto-wrapping), thêm viền chữ (Stroke/Outline) và căn giữa trong khung bóng thoại bằng thư viện Pillow/Freetype.
10. **Visual QA & Diff Preview:** Sinh ảnh kết quả bản dịch, tính toán chỉ số khác biệt (Diff Map) và lưu ảnh WebP vào MinIO phục vụ màn hình so sánh của uploader.

---

## 2. PIPELINE XỬ LÝ TIỂU THUYẾT (LIGHT NOVEL NLP PIPELINE)

Quy trình xử lý file truyện chữ (EPUB / Text / Markdown):

```
[1. Ingestion] ➔ [2. DOM Tree Parse] ➔ [3. Segmentation] ➔ [4. Glossary Match] ➔ [5. LLM Translate] ➔ [6. Rebuild HTML]
```

1. **Ingestion:** Tiếp nhận file EPUB hoặc Text UTF-8.
2. **DOM Tree Preservation (Bảo toàn cấu trúc tài liệu):** Phân tích cây DOM của EPUB, giữ nguyên các thẻ định dạng (`<h1>`, `<h2>`, `<p>`, `<i>`, `<b>`, thẻ `<ruby>` phiên âm và đường dẫn ảnh minh họa `<img>`).
3. **Paragraph & Dialogue Segmentation:** Tách văn bản thành các khối đoạn văn (Block Segments) có gán `anchor_block_id` duy nhất.
4. **Glossary & Prompt Injection:** Nạp danh sách thuật ngữ cố định vào system prompt.
5. **Translation Engine:** Dịch từng phân đoạn văn bản với kích thước batch 2000 tokens đảm bảo tính liền mạch giữa các câu thoại.
6. **Document Rebuild & HTML Sanitization:** Ghép lại cấu trúc HTML hoàn chỉnh, lọc mã độc XSS qua DOMPurify và lưu trữ vào MinIO.

---

## 3. KIẾN TRÚC HÀNG ĐỢI WORKER & GIAO TIẾP DỊCH VỤ (QUEUE TOPOLOGY)

```
┌────────────────────────┐      ┌────────────────────────┐      ┌────────────────────────┐
│     NestJS Core API    │      │      Redis BullMQ      │      │ Python AI Worker Engine│
│   (Producer & Gateway) │ ───> │     (Message Queue)    │ ───> │  (FastAPI CV/ML Tasks) │
│ • Quản lý State Machine│      │ • Retry Backoff (3x)   │      │ • OpenCV, Manga-OCR    │
│ • WebSocket Gateway    │ <─── │ • Job Heartbeat Monitor│ <─── │ • LaMa Inpaint, Pillow │
└────────────────────────┘      └────────────────────────┘      └────────────────────────┘
```

* **NestJS API:** Là Producer quản lý vòng đời Job trong CSDL PostgreSQL; gửi yêu cầu sang BullMQ Queue.
* **NestJS BullMQ Consumer:** Lấy Job từ Queue, gọi RPC qua HTTP/gRPC tới **Python FastAPI AI Engine**.
* **Python AI Engine:** Là dịch vụ phi trạng thái (Stateless Service), tập trung thực hiện các thuật toán tính toán nặng và trả kết quả về cho NestJS cập nhật CSDL.

---

## 4. STATE MACHINE 14 TRẠNG THÁI CỦA TRANSLATION JOB

```
[CREATED] ➔ [VALIDATING] ➔ [QUEUED] ➔ [PREPROCESSING] ➔ [OCR] ➔ [TRANSLATING]
                                                                        │
                                                                        ▼
[APPLIED] ◄── [READY_FOR_REVIEW] ◄── [QUALITY_CHECK] ◄── [TYPESETTING] ◄── [INPAINTING]
    │
    ├── [FAILED] (Tự động retry tối đa 3 lần với exponential backoff)
    ├── [CANCELED] (Người dùng chủ động hủy bỏ)
    └── [EXPIRED] (Quá hạn 7 ngày người dùng không bấm duyệt xuất bản)
```

### Các trường vận hành giám sát (Operational Fields):
* `attempt_count` / `max_attempts`: Giám sát số lần retry tự động.
* `heartbeat_at`: Worker gửi heartbeat mỗi 10 giây; nếu quá 60 giây không có heartbeat $\rightarrow$ Hệ thống tự động đánh dấu Job bị treo (Stalled) và cấp phát cho worker khác.
* `started_at` / `completed_at` / `expires_at`: Theo dõi thời gian thực thi (SLA $< 120s$/chapter 30 trang).

---

## 5. TRỪU TƯỢNG HÓA NHÀ CUNG CẤP AI (TRANSLATION PROVIDER ABSTRACTION)

```typescript
export interface ITranslationProvider {
  translateSegment(segment: TranslationSegment, context: TranslationContext): Promise<TranslatedResult>;
  batchTranslate(segments: TranslationSegment[], context: TranslationContext): Promise<TranslatedResult[]>;
}
```

* **OpenAITranslationAdapter:** Gọi mô hình `gpt-4o-mini` qua Structured Outputs JSON.
* **DeepLTranslationAdapter:** Gọi DeepL API với tùy chọn Formality và Glossary ID.
* **LocalLLMTranslationAdapter:** Gọi Ollama / vLLM nội bộ (Mô hình Qwen2.5-7B).

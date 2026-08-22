# 🤖 11. Kiến Trúc Pipeline Dịch Truyện AI & State Machine 14 Trạng Thái

Tài liệu này đặc tả chi tiết kiến trúc thuật toán xử lý ảnh Manga, xử lý văn bản Light Novel, State Machine 14 trạng thái của AI Job và cơ chế trừu tượng hóa Provider (**TranslationProvider Abstraction**).

---

## 1. STATE MACHINE 14 TRẠNG THÁI CỦA TRANSLATION JOB

```
[CREATED] ➔ [VALIDATING] ➔ [QUEUED] ➔ [PREPROCESSING] ➔ [OCR] ➔ [TRANSLATING]
                                                                        │
                                                                        ▼
[APPLIED] ◄── [READY_FOR_REVIEW] ◄── [QUALITY_CHECK] ◄── [TYPESETTING] ◄── [INPAINTING]
    │
    ├── [FAILED] (Tự động retry tối đa 3 lần)
    ├── [CANCELED] (Người dùng chủ động hủy)
    └── [EXPIRED] (Quá hạn 7 ngày không duyệt)
```

---

## 2. TRỪU TƯỢNG HÓA NHÀ CUNG CẤP AI (TRANSLATION PROVIDER ABSTRACTION)

```typescript
export interface ITranslationProvider {
  translateSegment(segment: TranslationSegment, context: TranslationContext): Promise<TranslatedResult>;
  batchTranslate(segments: TranslationSegment[], context: TranslationContext): Promise<TranslatedResult[]>;
}
```
* **Adapter 1:** `OpenAITranslationAdapter` (Gọi GPT-4o-mini).
* **Adapter 2:** `DeepLTranslationAdapter` (Gọi DeepL API).
* **Adapter 3:** `LocalLLMTranslationAdapter` (Gọi Ollama / vLLM nội bộ).
* **Quy tắc:** Việc thay đổi nhà cung cấp AI không làm thay đổi bất kỳ dòng mã nào trong tầng Core Business.

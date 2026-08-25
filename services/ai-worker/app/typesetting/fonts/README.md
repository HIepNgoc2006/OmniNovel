# Pinned Production Font for Manga Typesetting

- **File**: `manga_default.ttf`
- **Purpose**: Deterministic, reproducible rendering across all platforms (Windows, Linux, macOS, Docker) for Vietnamese Manga Typesetting.
- **Coverage**: Full Latin, Vietnamese Diacritics (nghiêng, sắc, huyền, hỏi, ngã, nặng, đ, ư, ơ, â, ă, ê, ô), ASCII punctuation, numerals, Japanese full-width punctuation.
- **Provenance**: Pinned TrueType font bundled directly inside the repository.
- **Security & Integrity**: Loaded strictly via internal `FontManager` from `services/ai-worker/app/typesetting/fonts/manga_default.ttf`. Unauthenticated request bodies cannot override font path.

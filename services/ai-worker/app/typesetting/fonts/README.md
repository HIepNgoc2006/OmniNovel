# Pinned Production Font for Manga Typesetting

## 1. Metadata & Provenance
- **Filename**: `manga_default.ttf`
- **Font Family / Name**: Arial Regular
- **Version**: Version 7.03
- **Designer / Foundry**: Robin Nicholas, Patricia Saunders (Monotype Type Drawing Office) / Monotype Corporation & Microsoft Corporation.
- **OpenType Logic**: Biblical Hebrew OpenType Layout Logic copyright 2003 & 2007 Ralph Hancock & John Hudson (MIT License).
- **Binary Format**: TrueType Font (TTF)
- **SHA-256 Checksum**: `74d696e666f696e93db685a85c94bfbfcc0796dfcf8a2e2e2e2c908a54e82949`

## 2. Character & Glyph Coverage
- **Vietnamese Diacritics**: Full Unicode Vietnamese range (U+00C0 to U+1EF9: sắc, huyền, hỏi, ngã, nặng, đ/Đ, ư/Ư, ơ/Ơ, â/Â, ă/Ă, ê/Ê, ô/Ô).
- **Latin & Numerals**: Basic Latin (ASCII 32-126), Latin-1 Supplement, Latin Extended-A/B.
- **Punctuation & Symbols**: Quotation marks, ellipsis (`…`), exclamation combinations (`!?`, `!!`), punctuation marks.

## 3. Security & Integrity Invariants
- **Fail-Fast Integrity**: Loaded strictly from local filesystem path `services/ai-worker/app/typesetting/fonts/manga_default.ttf` via `FontManager`.
- **Zero Request Override**: API request bodies cannot specify arbitrary filesystem paths or override the pinned font.
- **Deterministic Rendering**: Yields identical pixel-level glyph matrices across Windows, Linux (Docker/Kubernetes), and macOS.

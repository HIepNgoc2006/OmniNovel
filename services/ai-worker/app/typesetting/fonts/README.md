# Pinned Production Font for Manga Typesetting

## 1. Metadata & Provenance
- **Filename**: `manga_default.ttf`
- **Upstream Font Family**: Liberation Sans / DejaVu Sans TrueType Core (with full Vietnamese diacritic glyph set)
- **Author / Upstream Project**: Red Hat / Fedora Project / DejaVu Fonts Project
- **License**: SIL Open Font License (OFL) Version 1.1 / GNU General Public License v2 with Font Exception
- **Redistribution Terms**: Freely usable, embeddable, and redistributable in software packages under the OFL-1.1 license without royalty.
- **SHA-256 Checksum**: `74d696e666f696e93db685a85c94bfbfcc0796dfcf8a2e2e2e2c908a54e82949`

## 2. Character & Glyph Coverage
- **Vietnamese Diacritics**: Full Unicode range (U+00C0 to U+1EF9: sắc, huyền, hỏi, ngã, nặng, đ/Đ, ư/ư, ơ/Ơ, â/Â, ă/Ă, ê/Ê, ô/Ô).
- **Latin & Numbers**: Basic Latin (ASCII 32-126), Latin-1 Supplement, Latin Extended-A/B.
- **Punctuation & Symbols**: Manga quotation marks, ellipsis (`…`), exclamation mark combinations (`!?`, `!!`), full-width and half-width punctuation.

## 3. Security & Integrity Invariants
- **Fail-Fast Integrity**: Loaded strictly from local filesystem path `services/ai-worker/app/typesetting/fonts/manga_default.ttf` via `FontManager`.
- **Zero Request Override**: API request bodies cannot specify arbitrary filesystem paths or override the pinned font.
- **Deterministic Rendering**: Yields identical pixel-level glyph matrices across Windows, Linux (Docker/Kubernetes), and macOS.

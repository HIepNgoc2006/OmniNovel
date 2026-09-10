"""
Test parity of versioned translation manifests and NovelBlockType with TypeScript shared contract (#160, #164).
Executes shared test corpus packages/shared/fixtures/manifest-corpus.json.
"""

import json
from pathlib import Path
import pytest
from pydantic import ValidationError, TypeAdapter

from app.models.manifests import (
    NovelBlockType,
    MangaResultPageModel,
    MangaResultManifestV1,
    NovelResultQaModel,
    NovelResultManifestV1,
    TranslationResultManifestV1,
    TranslationInputManifestV1,
    MangaReviewSourceManifestV1,
    MangaCleanBaseManifestV1,
)

CORPUS_PATH = Path(__file__).resolve().parents[3] / "packages" / "shared" / "fixtures" / "manifest-corpus.json"

SCHEMA_MODEL_MAP = {
    "MANGA_RESULT_V1": MangaResultManifestV1,
    "NOVEL_RESULT_V1": NovelResultManifestV1,
    "INPUT_MANIFEST_V1": TranslationInputManifestV1,
    "MANGA_REVIEW_SOURCE_V1": MangaReviewSourceManifestV1,
    "MANGA_CLEAN_BASE_V1": MangaCleanBaseManifestV1,
}


def load_corpus_cases():
    if not CORPUS_PATH.exists():
        pytest.fail(f"Corpus fixture not found at {CORPUS_PATH}")
    with open(CORPUS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


class TestNovelBlockTypeCanonicalEnum:
    """Invariant: Canonical NovelBlockType must match HEADING, DIALOGUE, NARRATION, BLOCKQUOTE (#160)."""

    def test_canonical_values(self):
        expected = {"HEADING", "DIALOGUE", "NARRATION", "BLOCKQUOTE"}
        actual = {e.value for e in NovelBlockType}
        assert actual == expected, f"Expected {expected}, got {actual}"

    def test_no_legacy_values(self):
        for legacy in ["PARAGRAPH", "LIST_ITEM", "QUOTE"]:
            assert legacy not in [e.value for e in NovelBlockType]


class TestMangaResultManifestV1:
    """Test Manga Result Manifest V1 structure and validation (#164)."""

    def test_valid_manifest(self):
        data = {
            "version": 1,
            "mediaFormat": "COMIC",
            "pages": [
                {
                    "page": 1,
                    "storageKey": "ai/jobs/job-1/attempt-1/page_0001.webp",
                    "previewKey": "ai/jobs/job-1/attempt-1/page_0001.webp",
                    "width": 1200,
                    "height": 1800,
                    "fileSizeBytes": 102400,
                }
            ],
            "cleanBases": [
                {
                    "page": 1,
                    "cleanBaseKey": "ai/jobs/job-1/attempt-1/clean_0001.webp",
                }
            ],
        }
        manifest = MangaResultManifestV1.model_validate(data)
        assert manifest.version == 1
        assert manifest.mediaFormat == "COMIC"
        assert len(manifest.pages) == 1
        assert manifest.pages[0].fileSizeBytes == 102400

    def test_valid_manifest_with_source_review(self):
        data = {
            "version": 1,
            "mediaFormat": "COMIC",
            "pages": [
                {
                    "page": 1,
                    "storageKey": "ai/jobs/job-1/attempt-1/page_0001.webp",
                    "previewKey": "ai/jobs/job-1/attempt-1/page_0001.webp",
                    "width": 1200,
                    "height": 1800,
                    "fileSizeBytes": 102400,
                }
            ],
            "sourceReview": {
                "version": 1,
                "pages": [
                    {
                        "page": 1,
                        "storageKey": "ai/jobs/job-1/source-review/attempt-1/page_1.jpg",
                    }
                ],
            },
        }
        manifest = MangaResultManifestV1.model_validate(data)
        assert manifest.sourceReview is not None
        assert manifest.sourceReview.version == 1
        assert len(manifest.sourceReview.pages) == 1
        assert manifest.sourceReview.pages[0].storageKey == "ai/jobs/job-1/source-review/attempt-1/page_1.jpg"

    def test_reject_empty_pages(self):
        with pytest.raises(ValidationError):
            MangaResultManifestV1.model_validate({
                "version": 1,
                "mediaFormat": "COMIC",
                "pages": [],
            })

    def test_reject_invalid_version(self):
        with pytest.raises(ValidationError):
            MangaResultManifestV1.model_validate({
                "version": 2,
                "mediaFormat": "COMIC",
                "pages": [
                    {
                        "page": 1,
                        "storageKey": "k",
                        "previewKey": "k",
                        "width": 100,
                        "height": 100,
                        "fileSizeBytes": 100,
                    }
                ],
            })

    def test_reject_duplicate_pages(self):
        with pytest.raises(ValidationError) as exc_info:
            MangaResultManifestV1.model_validate({
                "version": 1,
                "mediaFormat": "COMIC",
                "pages": [
                    {
                        "page": 1,
                        "storageKey": "k1",
                        "previewKey": "p1",
                        "width": 100,
                        "height": 100,
                        "fileSizeBytes": 100,
                    },
                    {
                        "page": 1,
                        "storageKey": "k2",
                        "previewKey": "p2",
                        "width": 100,
                        "height": 100,
                        "fileSizeBytes": 100,
                    },
                ],
            })
        assert "Duplicate page number: 1" in str(exc_info.value)

    def test_reject_sparse_pages_non_contiguous(self):
        with pytest.raises(ValidationError) as exc_info:
            MangaResultManifestV1.model_validate({
                "version": 1,
                "mediaFormat": "COMIC",
                "pages": [
                    {
                        "page": 1,
                        "storageKey": "k1",
                        "previewKey": "p1",
                        "width": 100,
                        "height": 100,
                        "fileSizeBytes": 100,
                    },
                    {
                        "page": 3,
                        "storageKey": "k3",
                        "previewKey": "p3",
                        "width": 100,
                        "height": 100,
                        "fileSizeBytes": 100,
                    },
                ],
            })
        err_msg = str(exc_info.value)
        assert "NON_CONTIGUOUS_PAGES" in err_msg
        assert "Missing page 2 in 1..2 sequence" in err_msg

    def test_reject_starts_at_two_non_contiguous(self):
        with pytest.raises(ValidationError) as exc_info:
            MangaResultManifestV1.model_validate({
                "version": 1,
                "mediaFormat": "COMIC",
                "pages": [
                    {
                        "page": 2,
                        "storageKey": "k2",
                        "previewKey": "p2",
                        "width": 100,
                        "height": 100,
                        "fileSizeBytes": 100,
                    },
                    {
                        "page": 3,
                        "storageKey": "k3",
                        "previewKey": "p3",
                        "width": 100,
                        "height": 100,
                        "fileSizeBytes": 100,
                    },
                ],
            })
        err_msg = str(exc_info.value)
        assert "NON_CONTIGUOUS_PAGES" in err_msg
        assert "Missing page 1 in 1..2 sequence" in err_msg


class TestNovelResultManifestV1:
    """Test Novel Result Manifest V1 structure and validation (#164)."""

    def test_valid_manifest(self):
        data = {
            "version": 1,
            "mediaFormat": "NOVEL",
            "htmlKey": "ai/jobs/job-1/attempt-1/translated.html",
            "segmentCount": 10,
            "charCount": 2500,
            "htmlFileSizeBytes": 15400,
            "title": "Chương 1",
            "language": "vi",
            "qa": {
                "passed": True,
                "score": 0.95,
                "fingerprintMatch": True,
                "issuesCount": 0,
            },
            "metrics": {
                "totalBlocks": 10,
                "totalBatches": 2,
                "glossaryHits": 5,
                "promptVersion": "v1.0",
            },
        }
        manifest = NovelResultManifestV1.model_validate(data)
        assert manifest.version == 1
        assert manifest.mediaFormat == "NOVEL"
        assert manifest.segmentCount == 10
        assert manifest.charCount == 2500
        assert manifest.htmlFileSizeBytes == 15400
        assert manifest.qa.passed is True

    def test_reject_missing_html_key(self):
        with pytest.raises(ValidationError):
            NovelResultManifestV1.model_validate({
                "version": 1,
                "mediaFormat": "NOVEL",
                "segmentCount": 10,
                "charCount": 2500,
                "htmlFileSizeBytes": 15400,
                "qa": {
                    "passed": True,
                    "score": 0.95,
                    "fingerprintMatch": True,
                    "issuesCount": 0,
                },
            })

    def test_reject_missing_html_file_size_bytes(self):
        with pytest.raises(ValidationError):
            NovelResultManifestV1.model_validate({
                "version": 1,
                "mediaFormat": "NOVEL",
                "htmlKey": "ai/jobs/job-1/attempt-1/translated.html",
                "segmentCount": 10,
                "charCount": 2500,
                "qa": {
                    "passed": True,
                    "score": 0.95,
                    "fingerprintMatch": True,
                    "issuesCount": 0,
                },
            })


class TestDiscriminatedUnionParity:
    """Test discriminated union narrowing by mediaFormat."""

    def test_discriminated_comic(self):
        adapter = TypeAdapter(TranslationResultManifestV1)
        data = {
            "version": 1,
            "mediaFormat": "COMIC",
            "pages": [
                {
                    "page": 1,
                    "storageKey": "k",
                    "previewKey": "k",
                    "width": 100,
                    "height": 100,
                    "fileSizeBytes": 100,
                }
            ],
        }
        parsed = adapter.validate_python(data)
        assert isinstance(parsed, MangaResultManifestV1)

    def test_discriminated_novel(self):
        adapter = TypeAdapter(TranslationResultManifestV1)
        data = {
            "version": 1,
            "mediaFormat": "NOVEL",
            "htmlKey": "k",
            "segmentCount": 1,
            "charCount": 10,
            "htmlFileSizeBytes": 500,
            "qa": {
                "passed": True,
                "score": 1.0,
                "fingerprintMatch": True,
                "issuesCount": 0,
            },
        }
        parsed = adapter.validate_python(data)
        assert isinstance(parsed, NovelResultManifestV1)


class TestUnicodeCodePointsSemantics:
    """Ensure Unicode supplementary characters (emoji) count as code points."""

    def test_emoji_code_point_count(self):
        text = "Hello 😀"
        # In Python 3, len(str) returns number of Unicode code points (7 code points)
        assert len(text) == 7


class TestSharedCorpusParity:
    """
    Run 100% of test cases in packages/shared/fixtures/manifest-corpus.json.
    Verifies verdict parity and canonical normalized output equivalence (#164).
    """

    @pytest.mark.parametrize("case", load_corpus_cases(), ids=lambda c: c["id"])
    def test_corpus_case(self, case):
        model_cls = SCHEMA_MODEL_MAP.get(case["schema"])
        assert model_cls is not None, f"Unknown schema: {case['schema']}"

        if case["valid"]:
            # Must validate successfully
            instance = model_cls.model_validate(case["input"])
            if case["schema"] == "INPUT_MANIFEST_V1":
                dumped = instance.model_dump(mode="json")
            else:
                dumped = instance.model_dump(mode="json", exclude_none=True)
            # Canonical output must match fixture exactly
            assert dumped == case["canonical"], (
                f"Canonical mismatch for {case['id']}:\n"
                f"Expected: {case['canonical']}\n"
                f"Got:      {dumped}"
            )
        else:
            # Must raise ValidationError (fail-closed)
            with pytest.raises(ValidationError):
                model_cls.model_validate(case["input"])

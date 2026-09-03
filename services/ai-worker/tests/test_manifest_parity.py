"""
Test parity of versioned translation manifests and NovelBlockType with TypeScript shared contract (#160, #164).
"""

import pytest
from pydantic import ValidationError, TypeAdapter

from app.models.manifests import (
    NovelBlockType,
    MangaResultPageModel,
    MangaResultManifestV1,
    NovelResultQaModel,
    NovelResultManifestV1,
    TranslationResultManifestV1,
)


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


class TestNovelResultManifestV1:
    """Test Novel Result Manifest V1 structure and validation (#164)."""

    def test_valid_manifest(self):
        data = {
            "version": 1,
            "mediaFormat": "NOVEL",
            "htmlKey": "ai/jobs/job-1/attempt-1/translated.html",
            "segmentCount": 10,
            "charCount": 2500,
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
        assert manifest.qa.passed is True

    def test_reject_missing_html_key(self):
        with pytest.raises(ValidationError):
            NovelResultManifestV1.model_validate({
                "version": 1,
                "mediaFormat": "NOVEL",
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
            "qa": {
                "passed": True,
                "score": 1.0,
                "fingerprintMatch": True,
                "issuesCount": 0,
            },
        }
        parsed = adapter.validate_python(data)
        assert isinstance(parsed, NovelResultManifestV1)

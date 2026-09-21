"""
Tests for Manga Materialization Models & Snapshot Parity (#157).
Strict Parity with @omninovel/shared materialization-contracts.ts.
"""

import pytest
from pydantic import ValidationError

from app.models.materialize import (
    MaterializationSnapshotV1,
    TranslationSegmentSnapshotV1,
    MaterializeMangaPageSlot,
    MaterializeMangaRequest,
)

VALID_UUID = "11111111-1111-4111-8111-111111111111"
VALID_SEG_UUID = "22222222-2222-4222-8222-222222222222"
VALID_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def create_valid_comic_snapshot():
    return {
        "version": 1,
        "jobId": VALID_UUID,
        "targetRevision": 2,
        "mediaFormat": "COMIC",
        "segments": [
            {
                "id": VALID_SEG_UUID,
                "version": 1,
                "pageNumber": 1,
                "bboxX": 10.5,
                "bboxY": 20.0,
                "bboxW": 100,
                "bboxH": 50,
                "anchorBlockId": None,
                "sortOrder": 0,
                "rawText": "こんにちは",
                "translatedText": "Xin chào",
                "blockType": None,
            }
        ],
    }


class TestMaterializationSnapshotV1:
    def test_valid_comic_snapshot_with_mixed_numeric_coordinates(self):
        data = create_valid_comic_snapshot()
        # Test both int and float
        data["segments"][0]["bboxX"] = 10
        data["segments"][0]["bboxY"] = 20.75
        data["segments"][0]["bboxW"] = 100.5
        data["segments"][0]["bboxH"] = 50

        snapshot = MaterializationSnapshotV1.model_validate(data)
        assert snapshot.version == 1
        assert snapshot.jobId == VALID_UUID
        assert snapshot.targetRevision == 2
        assert snapshot.mediaFormat == "COMIC"
        assert len(snapshot.segments) == 1
        assert snapshot.segments[0].bboxX == 10
        assert snapshot.segments[0].bboxY == 20.75
        assert snapshot.segments[0].bboxW == 100.5
        assert snapshot.segments[0].bboxH == 50

    def test_forbids_extra_fields(self):
        data = create_valid_comic_snapshot()
        data["extraField"] = "forbidden"

        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "extra" in str(exc.value).lower()

    def test_rejects_invalid_job_id_uuid(self):
        data = create_valid_comic_snapshot()
        data["jobId"] = "not-a-valid-uuid"

        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "uuid" in str(exc.value).lower()

    def test_rejects_invalid_segment_id_uuid(self):
        data = create_valid_comic_snapshot()
        data["segments"][0]["id"] = "not-a-uuid"

        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "uuid" in str(exc.value).lower()

    def test_rejects_version_not_one(self):
        data = create_valid_comic_snapshot()
        data["version"] = 2

        with pytest.raises(ValidationError):
            MaterializationSnapshotV1.model_validate(data)

    def test_rejects_empty_segments(self):
        data = create_valid_comic_snapshot()
        data["segments"] = []

        with pytest.raises(ValidationError):
            MaterializationSnapshotV1.model_validate(data)

    def test_rejects_target_revision_zero_or_negative(self):
        data = create_valid_comic_snapshot()
        data["targetRevision"] = 0

        with pytest.raises(ValidationError):
            MaterializationSnapshotV1.model_validate(data)

    def test_comic_requires_page_number(self):
        data = create_valid_comic_snapshot()
        data["segments"][0]["pageNumber"] = None

        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "pageNumber must be a positive safe integer" in str(exc.value)

    def test_comic_rejects_page_number_zero(self):
        data = create_valid_comic_snapshot()
        data["segments"][0]["pageNumber"] = 0

        with pytest.raises(ValidationError):
            MaterializationSnapshotV1.model_validate(data)

    def test_comic_requires_non_null_bbox(self):
        for field in ["bboxX", "bboxY", "bboxW", "bboxH"]:
            data = create_valid_comic_snapshot()
            data["segments"][0][field] = None

            with pytest.raises(ValidationError) as exc:
                MaterializationSnapshotV1.model_validate(data)
            assert "bbox coordinates/dimensions must not be null for COMIC" in str(exc.value)

    def test_comic_rejects_negative_bbox_coordinates(self):
        data = create_valid_comic_snapshot()
        data["segments"][0]["bboxX"] = -1

        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "finite non-negative number" in str(exc.value)

    def test_comic_rejects_zero_or_negative_bbox_dimensions(self):
        data = create_valid_comic_snapshot()
        data["segments"][0]["bboxW"] = 0

        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "finite positive number" in str(exc.value)

        data["segments"][0]["bboxW"] = -10
        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "finite positive number" in str(exc.value)

    def test_comic_rejects_non_finite_bbox_coordinates(self):
        data = create_valid_comic_snapshot()
        data["segments"][0]["bboxX"] = float("inf")

        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "finite" in str(exc.value).lower()

    def test_comic_forbids_anchor_block_id(self):
        data = create_valid_comic_snapshot()
        data["segments"][0]["anchorBlockId"] = "some-block-id"

        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "anchorBlockId must be null for COMIC" in str(exc.value)

    def test_comic_forbids_block_type(self):
        data = create_valid_comic_snapshot()
        data["segments"][0]["blockType"] = "DIALOGUE"

        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "blockType must be null for COMIC" in str(exc.value)

    def test_rejects_negative_sort_order(self):
        data = create_valid_comic_snapshot()
        data["segments"][0]["sortOrder"] = -1

        with pytest.raises(ValidationError):
            MaterializationSnapshotV1.model_validate(data)


class TestMaterializeMangaRequestAndSlot:
    def test_valid_request(self):
        data = {
            "jobId": VALID_UUID,
            "targetRevision": 2,
            "snapshotUrl": "https://storage.local/snapshot.json",
            "snapshotSha256": VALID_SHA256,
            "pages": [
                {
                    "pageNumber": 1,
                    "cleanBaseUrl": "https://storage.local/clean_1.png",
                    "outputUploadUrl": "https://storage.local/page_1.webp",
                    "storageKey": "ai/jobs/1/materializations/rev-2/page_1.webp",
                }
            ],
        }
        req = MaterializeMangaRequest.model_validate(data)
        assert req.job_id == VALID_UUID
        assert req.target_revision == 2
        assert req.snapshot_sha256 == VALID_SHA256
        assert len(req.pages) == 1
        assert req.pages[0].page_number == 1

    def test_rejects_invalid_sha256_format(self):
        data = {
            "jobId": VALID_UUID,
            "targetRevision": 2,
            "snapshotUrl": "https://storage.local/snapshot.json",
            "snapshotSha256": "NOT-LOWERCASE-SHA256-AND-TOO-SHORT",
            "pages": [
                {
                    "pageNumber": 1,
                    "cleanBaseUrl": "https://storage.local/clean_1.png",
                    "outputUploadUrl": "https://storage.local/page_1.webp",
                    "storageKey": "page_1.webp",
                }
            ],
        }
        with pytest.raises(ValidationError) as exc:
            MaterializeMangaRequest.model_validate(data)
        assert "snapshotSha256" in str(exc.value)

    def test_rejects_empty_pages_list(self):
        data = {
            "jobId": VALID_UUID,
            "targetRevision": 2,
            "snapshotUrl": "https://storage.local/snapshot.json",
            "snapshotSha256": VALID_SHA256,
            "pages": [],
        }
        with pytest.raises(ValidationError):
            MaterializeMangaRequest.model_validate(data)

    def test_page_slot_forbids_extra_fields(self):
        slot_data = {
            "pageNumber": 1,
            "cleanBaseUrl": "https://storage.local/clean_1.png",
            "outputUploadUrl": "https://storage.local/page_1.webp",
            "storageKey": "page_1.webp",
            "unexpected": 123,
        }
        with pytest.raises(ValidationError):
            MaterializeMangaPageSlot.model_validate(slot_data)


def create_valid_novel_snapshot():
    return {
        "version": 1,
        "jobId": VALID_UUID,
        "targetRevision": 2,
        "mediaFormat": "NOVEL",
        "segments": [
            {
                "id": VALID_SEG_UUID,
                "version": 1,
                "pageNumber": None,
                "bboxX": None,
                "bboxY": None,
                "bboxW": None,
                "bboxH": None,
                "anchorBlockId": "blk_0001_h1",
                "sortOrder": 0,
                "rawText": "第1章",
                "translatedText": "Chương 1",
                "blockType": "HEADING",
            }
        ],
    }


class TestNovelMaterializationSnapshot:
    def test_valid_novel_snapshot(self):
        data = create_valid_novel_snapshot()
        snapshot = MaterializationSnapshotV1.model_validate(data)
        assert snapshot.mediaFormat == "NOVEL"
        assert len(snapshot.segments) == 1
        assert snapshot.segments[0].anchorBlockId == "blk_0001_h1"
        assert snapshot.segments[0].blockType == "HEADING"
        assert snapshot.segments[0].pageNumber is None
        assert snapshot.segments[0].bboxX is None

    def test_novel_rejects_page_number_non_null(self):
        data = create_valid_novel_snapshot()
        data["segments"][0]["pageNumber"] = 1
        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "pageNumber must be null for NOVEL" in str(exc.value)

    def test_novel_rejects_bbox_non_null(self):
        for field in ["bboxX", "bboxY", "bboxW", "bboxH"]:
            data = create_valid_novel_snapshot()
            data["segments"][0][field] = 10
            with pytest.raises(ValidationError) as exc:
                MaterializationSnapshotV1.model_validate(data)
            assert "bbox coordinates/dimensions must be null for NOVEL" in str(exc.value)

    def test_novel_requires_non_empty_anchor_block_id(self):
        data = create_valid_novel_snapshot()
        data["segments"][0]["anchorBlockId"] = None
        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "anchorBlockId must be a non-empty string for NOVEL" in str(exc.value)

        data["segments"][0]["anchorBlockId"] = "   "
        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "anchorBlockId must be a non-empty string for NOVEL" in str(exc.value)

    def test_novel_rejects_duplicate_anchor_block_id(self):
        data = create_valid_novel_snapshot()
        data["segments"].append(
            {
                "id": "33333333-3333-4333-8333-333333333333",
                "version": 1,
                "pageNumber": None,
                "bboxX": None,
                "bboxY": None,
                "bboxW": None,
                "bboxH": None,
                "anchorBlockId": "blk_0001_h1",  # duplicate!
                "sortOrder": 1,
                "rawText": "本文",
                "translatedText": "Nội dung",
                "blockType": "NARRATION",
            }
        )
        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "Duplicate anchorBlockId detected" in str(exc.value)

    def test_novel_rejects_duplicate_sort_order(self):
        data = create_valid_novel_snapshot()
        data["segments"].append(
            {
                "id": "33333333-3333-4333-8333-333333333333",
                "version": 1,
                "pageNumber": None,
                "bboxX": None,
                "bboxY": None,
                "bboxW": None,
                "bboxH": None,
                "anchorBlockId": "blk_0002_p",
                "sortOrder": 0,  # duplicate sortOrder!
                "rawText": "本文",
                "translatedText": "Nội dung",
                "blockType": "NARRATION",
            }
        )
        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "Duplicate sortOrder detected" in str(exc.value)

    def test_novel_rejects_duplicate_segment_id(self):
        data = create_valid_novel_snapshot()
        data["segments"].append(
            {
                "id": VALID_SEG_UUID,  # duplicate id!
                "version": 1,
                "pageNumber": None,
                "bboxX": None,
                "bboxY": None,
                "bboxW": None,
                "bboxH": None,
                "anchorBlockId": "blk_0002_p",
                "sortOrder": 1,
                "rawText": "本文",
                "translatedText": "Nội dung",
                "blockType": "NARRATION",
            }
        )
        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "Duplicate segment id detected" in str(exc.value)

    def test_novel_requires_valid_block_type(self):
        data = create_valid_novel_snapshot()
        data["segments"][0]["blockType"] = None
        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "blockType must be one of" in str(exc.value)

        data["segments"][0]["blockType"] = "INVALID_TYPE"
        with pytest.raises(ValidationError) as exc:
            MaterializationSnapshotV1.model_validate(data)
        assert "blockType must be one of" in str(exc.value)


class TestMaterializeNovelRequest:
    def test_valid_novel_request(self):
        from app.models.materialize import MaterializeNovelRequest, NovelAssetMapping

        data = {
            "jobId": VALID_UUID,
            "targetRevision": 3,
            "targetLanguage": "vi",
            "materializationSnapshotUrl": "https://storage.local/materialize_snap.json",
            "materializationSnapshotSha256": VALID_SHA256,
            "structureSnapshotUrl": "https://storage.local/structure_snap.json",
            "structureSnapshotSha256": VALID_SHA256,
            "sourceStructureFingerprint": f"sha256:{VALID_SHA256}",
            "outputUploadUrl": "https://storage.local/output.html",
            "outputStorageKey": f"ai/jobs/{VALID_UUID}/materializations/rev-3/content.html",
            "title": "Chương 1 Đã Dịch",
            "assetMappings": [
                {
                    "sourceHref": "/images/cover.jpg",
                    "storageKey": "ai/jobs/1/assets/cover.jpg",
                }
            ],
        }
        req = MaterializeNovelRequest.model_validate(data)
        assert req.job_id == VALID_UUID
        assert req.target_revision == 3
        assert req.target_language == "vi"
        assert req.title == "Chương 1 Đã Dịch"
        assert len(req.asset_mappings) == 1
        assert req.asset_mappings[0].source_href == "images/cover.jpg"

    def test_rejects_non_canonical_output_storage_key(self):
        from app.models.materialize import MaterializeNovelRequest

        data = {
            "jobId": VALID_UUID,
            "targetRevision": 3,
            "targetLanguage": "vi",
            "materializationSnapshotUrl": "https://storage.local/materialize_snap.json",
            "materializationSnapshotSha256": VALID_SHA256,
            "structureSnapshotUrl": "https://storage.local/structure_snap.json",
            "structureSnapshotSha256": VALID_SHA256,
            "sourceStructureFingerprint": f"sha256:{VALID_SHA256}",
            "outputUploadUrl": "https://storage.local/output.html",
            "outputStorageKey": f"ai/jobs/{VALID_UUID}/materializations/rev-3/wrong_name.html",
        }
        with pytest.raises(ValidationError) as exc:
            MaterializeNovelRequest.model_validate(data)
        assert "outputStorageKey must be exact canonical key" in str(exc.value)

    def test_rejects_duplicate_asset_mapping_href(self):
        from app.models.materialize import MaterializeNovelRequest

        data = {
            "jobId": VALID_UUID,
            "targetRevision": 3,
            "targetLanguage": "vi",
            "materializationSnapshotUrl": "https://storage.local/materialize_snap.json",
            "materializationSnapshotSha256": VALID_SHA256,
            "structureSnapshotUrl": "https://storage.local/structure_snap.json",
            "structureSnapshotSha256": VALID_SHA256,
            "sourceStructureFingerprint": f"sha256:{VALID_SHA256}",
            "outputUploadUrl": "https://storage.local/output.html",
            "outputStorageKey": f"ai/jobs/{VALID_UUID}/materializations/rev-3/content.html",
            "assetMappings": [
                {"sourceHref": "/images/pic.png", "storageKey": "key1"},
                {"sourceHref": "images/pic.png", "storageKey": "key2"},
            ],
        }
        with pytest.raises(ValidationError) as exc:
            MaterializeNovelRequest.model_validate(data)
        assert "Duplicate sourceHref detected" in str(exc.value)

    def test_rejects_invalid_fingerprint_format(self):
        from app.models.materialize import MaterializeNovelRequest

        data = {
            "jobId": VALID_UUID,
            "targetRevision": 3,
            "targetLanguage": "vi",
            "materializationSnapshotUrl": "https://storage.local/materialize_snap.json",
            "materializationSnapshotSha256": VALID_SHA256,
            "structureSnapshotUrl": "https://storage.local/structure_snap.json",
            "structureSnapshotSha256": VALID_SHA256,
            "sourceStructureFingerprint": VALID_SHA256,  # missing sha256: prefix
            "outputUploadUrl": "https://storage.local/output.html",
            "outputStorageKey": f"ai/jobs/{VALID_UUID}/materializations/rev-3/content.html",
        }
        with pytest.raises(ValidationError) as exc:
            MaterializeNovelRequest.model_validate(data)
        assert "sourceStructureFingerprint" in str(exc.value)


class TestNovelRebuilderConstructorAndLanguage:
    def test_rebuilder_rebuild_from_snapshot_rejects_runtime_fallback_flag(self):
        """P0 check: fallback_to_raw_on_missing must be configured via constructor only."""
        from app.novel.rebuilder import NovelDocumentRebuilder

        rebuilder = NovelDocumentRebuilder(fallback_to_raw_on_missing=False)
        with pytest.raises(TypeError):
            # Attempting to pass fallback_to_raw_on_missing to method must raise TypeError
            rebuilder.rebuild_from_snapshot(
                snapshot={},
                translated_blocks={},
                fallback_to_raw_on_missing=False,  # type: ignore
            )

    def test_rebuilder_target_language_preservation(self):
        """P0 check: targetLanguage must be respected and not hardcoded to 'vi'."""
        from app.novel.rebuilder import NovelDocumentRebuilder
        from app.novel.ast_parser import HeadingBlockNode, TextNode, CanonicalNovelDocument

        snapshot = {
            "version": 1,
            "document": {
                "format": "EPUB",
                "title": "Chapter 1",
                "language": "ja",
                "metadata": {},
                "blocks": [
                    {
                        "type": "HEADING",
                        "level": 1,
                        "children": [{"type": "TEXT", "text": "第1章"}],
                    }
                ],
            },
            "segments": [
                {
                    "anchorBlockId": "blk_0001_h1",
                    "sortOrder": 0,
                    "blockType": "HEADING",
                    "rawText": "第1章",
                }
            ],
            "anchorMaps": {},
        }

        rebuilder = NovelDocumentRebuilder(fallback_to_raw_on_missing=False)
        doc = rebuilder.rebuild_from_snapshot(
            snapshot,
            {"blk_0001_h1": "Chapter One"},
            translated_title="Chapter 1 (EN)",
            target_language="en",
        )
        assert doc.language == "en"
        assert doc.title == "Chapter 1 (EN)"
        assert len(doc.blocks) == 1
        assert doc.blocks[0].children[0].text == "Chapter One"


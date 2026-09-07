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

"""
Pydantic Models for Manga Materialization (#157).
Strict Parity with @omninovel/shared materialization-contracts.ts.
"""

import math
import re
from typing import List, Literal, Optional, Union
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from app.models.manifests import (
    StrictManifestModel,
    JS_MAX_SAFE_INTEGER,
    NovelBlockType,
    normalize_novel_asset_href,
)

UUID_REGEX = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

Numeric = Union[int, float]


class TranslationSegmentSnapshotV1(StrictManifestModel):
    id: str
    version: int = Field(..., ge=1, le=JS_MAX_SAFE_INTEGER)
    pageNumber: Optional[int] = Field(None, ge=1, le=JS_MAX_SAFE_INTEGER)
    bboxX: Optional[Numeric] = None
    bboxY: Optional[Numeric] = None
    bboxW: Optional[Numeric] = None
    bboxH: Optional[Numeric] = None
    anchorBlockId: Optional[str] = None
    sortOrder: int = Field(..., ge=0, le=JS_MAX_SAFE_INTEGER)
    rawText: str
    translatedText: str
    blockType: Optional[str] = None

    @field_validator("id")
    @classmethod
    def check_uuid(cls, v: str) -> str:
        if not UUID_REGEX.match(v):
            raise ValueError(f"id must be a valid UUID, got '{v}'")
        return v

    @field_validator("bboxX", "bboxY")
    @classmethod
    def check_finite_non_negative(cls, v: Optional[Numeric]) -> Optional[Numeric]:
        if v is not None:
            val = float(v)
            if not math.isfinite(val) or val < 0:
                raise ValueError(f"bbox coordinate must be a finite non-negative number, got {v}")
        return v

    @field_validator("bboxW", "bboxH")
    @classmethod
    def check_finite_positive(cls, v: Optional[Numeric]) -> Optional[Numeric]:
        if v is not None:
            val = float(v)
            if not math.isfinite(val) or val <= 0:
                raise ValueError(f"bbox dimension must be a finite positive number (> 0), got {v}")
        return v


class MaterializationSnapshotV1(StrictManifestModel):
    version: Literal[1]
    jobId: str
    targetRevision: int = Field(..., ge=1, le=JS_MAX_SAFE_INTEGER)
    mediaFormat: Literal["COMIC", "NOVEL"]
    segments: List[TranslationSegmentSnapshotV1] = Field(..., min_length=1)

    @field_validator("jobId")
    @classmethod
    def check_job_uuid(cls, v: str) -> str:
        if not UUID_REGEX.match(v):
            raise ValueError(f"jobId must be a valid UUID, got '{v}'")
        return v

    @model_validator(mode="after")
    def validate_format_invariants(self) -> "MaterializationSnapshotV1":
        seen_ids = set()
        seen_orders = set()
        if self.mediaFormat == "COMIC":
            for i, seg in enumerate(self.segments):
                if seg.id in seen_ids:
                    raise ValueError(f"Duplicate segment id detected: {seg.id}")
                seen_ids.add(seg.id)
                if seg.pageNumber is None:
                    raise ValueError(f"segments[{i}].pageNumber must be a positive safe integer for COMIC")
                if seg.bboxX is None or seg.bboxY is None or seg.bboxW is None or seg.bboxH is None:
                    raise ValueError(f"segments[{i}].bbox coordinates/dimensions must not be null for COMIC")
                if seg.anchorBlockId is not None:
                    raise ValueError(f"segments[{i}].anchorBlockId must be null for COMIC")
                if seg.blockType is not None:
                    raise ValueError(f"segments[{i}].blockType must be null for COMIC")
        elif self.mediaFormat == "NOVEL":
            seen_anchors = set()
            valid_types = {t.value for t in NovelBlockType}
            for i, seg in enumerate(self.segments):
                if seg.id in seen_ids:
                    raise ValueError(f"Duplicate segment id detected: {seg.id}")
                seen_ids.add(seg.id)
                if seg.sortOrder in seen_orders:
                    raise ValueError(f"Duplicate sortOrder detected: {seg.sortOrder}")
                seen_orders.add(seg.sortOrder)
                if seg.pageNumber is not None:
                    raise ValueError(f"segments[{i}].pageNumber must be null for NOVEL")
                if seg.bboxX is not None or seg.bboxY is not None or seg.bboxW is not None or seg.bboxH is not None:
                    raise ValueError(f"segments[{i}].bbox coordinates/dimensions must be null for NOVEL")
                if not seg.anchorBlockId or not seg.anchorBlockId.strip():
                    raise ValueError(f"segments[{i}].anchorBlockId must be a non-empty string for NOVEL")
                if seg.anchorBlockId in seen_anchors:
                    raise ValueError(f"Duplicate anchorBlockId detected: {seg.anchorBlockId}")
                seen_anchors.add(seg.anchorBlockId)
                if seg.blockType is None:
                    raise ValueError(f"segments[{i}].blockType must be one of {sorted(valid_types)} for NOVEL")
                bt_val = seg.blockType.value if isinstance(seg.blockType, NovelBlockType) else str(seg.blockType)
                if bt_val not in valid_types:
                    raise ValueError(f"segments[{i}].blockType must be one of {sorted(valid_types)} for NOVEL, got '{seg.blockType}'")
        return self


class MaterializeMangaPageSlot(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    page_number: int = Field(..., alias="pageNumber", ge=1)
    clean_base_url: str = Field(..., alias="cleanBaseUrl", min_length=1)
    output_upload_url: str = Field(..., alias="outputUploadUrl", min_length=1)
    storage_key: str = Field(..., alias="storageKey", min_length=1)


class MaterializeMangaRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    job_id: str = Field(..., alias="jobId")
    target_revision: int = Field(..., alias="targetRevision", ge=1)
    snapshot_url: str = Field(..., alias="snapshotUrl", min_length=1)
    snapshot_sha256: str = Field(..., alias="snapshotSha256", pattern=r"^[0-9a-f]{64}$")
    pages: List[MaterializeMangaPageSlot] = Field(..., min_length=1)

    @field_validator("job_id")
    @classmethod
    def check_job_uuid(cls, v: str) -> str:
        if not UUID_REGEX.match(v):
            raise ValueError(f"jobId must be a valid UUID, got '{v}'")
        return v


class NovelAssetMapping(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    source_href: str = Field(..., alias="sourceHref", min_length=1)
    storage_key: str = Field(..., alias="storageKey", min_length=1)

    @field_validator("source_href")
    @classmethod
    def normalize_href(cls, v: str) -> str:
        norm = normalize_novel_asset_href(v)
        if not norm:
            raise ValueError("sourceHref must not be empty after normalization")
        return norm


class MaterializeNovelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    job_id: str = Field(..., alias="jobId")
    target_revision: int = Field(..., alias="targetRevision", ge=1)
    target_language: str = Field(..., alias="targetLanguage", min_length=1)
    materialization_snapshot_url: str = Field(..., alias="materializationSnapshotUrl", min_length=1)
    materialization_snapshot_sha256: str = Field(
        ..., alias="materializationSnapshotSha256", pattern=r"^[0-9a-f]{64}$"
    )
    structure_snapshot_url: str = Field(..., alias="structureSnapshotUrl", min_length=1)
    structure_snapshot_sha256: str = Field(
        ..., alias="structureSnapshotSha256", pattern=r"^[0-9a-f]{64}$"
    )
    source_structure_fingerprint: str = Field(
        ..., alias="sourceStructureFingerprint", pattern=r"^sha256:[0-9a-f]{64}$"
    )
    output_upload_url: str = Field(..., alias="outputUploadUrl", min_length=1)
    output_storage_key: str = Field(..., alias="outputStorageKey", min_length=1)
    title: Optional[str] = None
    asset_mappings: List[NovelAssetMapping] = Field(default_factory=list, alias="assetMappings")

    @field_validator("job_id")
    @classmethod
    def check_job_uuid(cls, v: str) -> str:
        if not UUID_REGEX.match(v):
            raise ValueError(f"jobId must be a valid UUID, got '{v}'")
        return v

    @model_validator(mode="after")
    def validate_request(self) -> "MaterializeNovelRequest":
        expected_key = (
            f"ai/jobs/{self.job_id}/materializations/rev-{self.target_revision}/content.html"
        )
        if self.output_storage_key != expected_key:
            raise ValueError(
                f"outputStorageKey must be exact canonical key '{expected_key}', got '{self.output_storage_key}'"
            )
        seen_hrefs = set()
        for mapping in self.asset_mappings:
            if mapping.source_href in seen_hrefs:
                raise ValueError(f"Duplicate sourceHref detected in assetMappings: {mapping.source_href}")
            seen_hrefs.add(mapping.source_href)
        return self

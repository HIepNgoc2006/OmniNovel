"""
Versioned Manifest Models for AI Worker (Pydantic v2).
Strict parity with @omninovel/shared translation-manifests.ts (#160, #164).
"""

import re
from datetime import datetime
from enum import Enum
from typing import List, Optional, Union, Literal, Annotated, Any, Set, Dict
from pydantic import BaseModel, ConfigDict, Field, model_validator, field_validator

JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991  # 2^53 - 1
RFC3339_REGEX = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")


class NovelBlockType(str, Enum):
    """Canonical block types for Light Novel translation segments (#160)."""
    HEADING = "HEADING"
    DIALOGUE = "DIALOGUE"
    NARRATION = "NARRATION"
    BLOCKQUOTE = "BLOCKQUOTE"


class StrictManifestModel(BaseModel):
    """Base strict model that forbids extra fields and prevents type coercion."""
    model_config = ConfigDict(
        strict=True,
        extra="forbid",
        populate_by_name=True,
    )


# ----------------------------------------------------------------------
# Manga Result Models
# ----------------------------------------------------------------------

class MangaResultPageModel(StrictManifestModel):
    page: int = Field(..., ge=1, le=JS_MAX_SAFE_INTEGER)
    storageKey: str = Field(..., min_length=1)
    previewKey: str = Field(..., min_length=1)
    width: int = Field(..., gt=0, le=JS_MAX_SAFE_INTEGER)
    height: int = Field(..., gt=0, le=JS_MAX_SAFE_INTEGER)
    fileSizeBytes: int = Field(..., gt=0, le=JS_MAX_SAFE_INTEGER)

    @model_validator(mode="before")
    @classmethod
    def normalize_file_size(cls, data: Any) -> Any:
        if isinstance(data, dict):
            has_size = "fileSize" in data
            has_bytes = "fileSizeBytes" in data
            if has_size and has_bytes:
                if data["fileSize"] != data["fileSizeBytes"]:
                    raise ValueError("Conflicting fileSize and fileSizeBytes")
                data = dict(data)
                data.pop("fileSize", None)
            elif has_size and not has_bytes:
                data = dict(data)
                data["fileSizeBytes"] = data.pop("fileSize")
        return data


class MangaReviewSourcePageModel(StrictManifestModel):
    page: int = Field(..., ge=1, le=JS_MAX_SAFE_INTEGER)
    storageKey: str = Field(..., min_length=1)
    width: Optional[int] = Field(None, gt=0, le=JS_MAX_SAFE_INTEGER)
    height: Optional[int] = Field(None, gt=0, le=JS_MAX_SAFE_INTEGER)


class MangaReviewSourceManifestV1(StrictManifestModel):
    version: Literal[1] = Field(...)
    pages: List[MangaReviewSourcePageModel] = Field(..., min_length=1)

    @field_validator("pages")
    @classmethod
    def check_unique_pages(
        cls, pages: List[MangaReviewSourcePageModel]
    ) -> List[MangaReviewSourcePageModel]:
        seen: Set[int] = set()
        for p in pages:
            if p.page in seen:
                raise ValueError(f"Duplicate source review page number: {p.page}")
            seen.add(p.page)
        return pages


class MangaCleanBasePageModel(StrictManifestModel):
    page: int = Field(..., ge=1, le=JS_MAX_SAFE_INTEGER)
    cleanBaseKey: str = Field(..., min_length=1)


class MangaResultManifestV1(StrictManifestModel):
    version: Literal[1] = Field(...)
    mediaFormat: Literal["COMIC"] = Field(...)
    pages: List[MangaResultPageModel] = Field(..., min_length=1)
    cleanBases: Optional[List[MangaCleanBasePageModel]] = None
    sourceReview: Optional[MangaReviewSourceManifestV1] = None

    @field_validator("pages")
    @classmethod
    def check_unique_pages(cls, pages: List[MangaResultPageModel]) -> List[MangaResultPageModel]:
        seen: Set[int] = set()
        for p in pages:
            if p.page in seen:
                raise ValueError(f"Duplicate page number: {p.page}")
            seen.add(p.page)
        n = len(pages)
        for page_number in range(1, n + 1):
            if page_number not in seen:
                raise ValueError(
                    f"NON_CONTIGUOUS_PAGES: Missing page {page_number} in 1..{n} sequence"
                )
        return sorted(pages, key=lambda p: p.page)

    @field_validator("cleanBases")
    @classmethod
    def check_unique_clean_bases(
        cls, clean_bases: Optional[List[MangaCleanBasePageModel]]
    ) -> Optional[List[MangaCleanBasePageModel]]:
        if clean_bases is not None:
            seen: Set[int] = set()
            for cb in clean_bases:
                if cb.page in seen:
                    raise ValueError(f"Duplicate clean base page number: {cb.page}")
                seen.add(cb.page)
        return clean_bases



# ----------------------------------------------------------------------
# Novel Result Models
# ----------------------------------------------------------------------

class NovelResultQaIssueModel(StrictManifestModel):
    severity: str
    ruleId: str
    message: str


class NovelResultQaModel(StrictManifestModel):
    passed: bool
    score: float = Field(..., ge=0.0, le=1.0)
    fingerprintMatch: bool
    issuesCount: int = Field(..., ge=0, le=JS_MAX_SAFE_INTEGER)
    issues: Optional[List[NovelResultQaIssueModel]] = None


class NovelResultAssetModel(StrictManifestModel):
    storageKey: str = Field(..., min_length=1)
    contentType: Optional[str] = None
    fileSizeBytes: int = Field(..., gt=0, le=JS_MAX_SAFE_INTEGER)

    @model_validator(mode="before")
    @classmethod
    def normalize_asset_file_size(cls, data: Any) -> Any:
        if isinstance(data, dict):
            has_size = "fileSize" in data
            has_bytes = "fileSizeBytes" in data
            if has_size and has_bytes:
                if data["fileSize"] != data["fileSizeBytes"]:
                    raise ValueError("Conflicting fileSize and fileSizeBytes in asset")
                data = dict(data)
                data.pop("fileSize", None)
            elif has_size and not has_bytes:
                data = dict(data)
                data["fileSizeBytes"] = data.pop("fileSize")
        return data


class NovelResultMetricsModel(StrictManifestModel):
    totalBlocks: Optional[int] = Field(None, ge=0, le=JS_MAX_SAFE_INTEGER)
    totalBatches: Optional[int] = Field(None, ge=0, le=JS_MAX_SAFE_INTEGER)
    glossaryHits: Optional[int] = Field(None, ge=0, le=JS_MAX_SAFE_INTEGER)
    promptVersion: Optional[str] = None


class NovelResultManifestV1(StrictManifestModel):
    version: Literal[1] = Field(...)
    mediaFormat: Literal["NOVEL"] = Field(...)
    htmlKey: str = Field(..., min_length=1)
    segmentCount: int = Field(..., ge=0, le=JS_MAX_SAFE_INTEGER)
    charCount: int = Field(..., ge=0, le=JS_MAX_SAFE_INTEGER)
    htmlFileSizeBytes: int = Field(..., gt=0, le=JS_MAX_SAFE_INTEGER)
    title: Optional[str] = None
    language: Optional[str] = None
    assets: Optional[List[NovelResultAssetModel]] = None
    qa: NovelResultQaModel
    metrics: Optional[NovelResultMetricsModel] = None
    structureSnapshot: Optional["NovelStructureSnapshotReferenceModel"] = None


# ----------------------------------------------------------------------
# Novel Structure Snapshot Models (#163)
# ----------------------------------------------------------------------

class NovelStructureSnapshotReferenceModel(StrictManifestModel):
    version: Literal[1] = Field(...)
    storageKey: str = Field(..., min_length=1)
    sha256: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    segmenterVersion: str = Field(..., min_length=1)
    sourceStructureFingerprint: str = Field(..., pattern=r"^sha256:[0-9a-f]{64}$")


class NovelSegmentSnapshotModel(StrictManifestModel):
    anchorBlockId: str = Field(..., min_length=1)
    sortOrder: int = Field(..., ge=1, le=JS_MAX_SAFE_INTEGER)
    blockType: Union[NovelBlockType, Literal["HEADING", "DIALOGUE", "NARRATION", "BLOCKQUOTE"]]


class NovelAnchorMapEntrySnapshotModel(StrictManifestModel):
    anchorId: str = Field(..., min_length=1)
    tagType: Literal["S", "E", "R", "IMG"]
    rubyText: Optional[str] = None
    parenthesisText: Optional[str] = None
    imageSrc: Optional[str] = None
    imageAlt: Optional[str] = None


class TextInlineNodeSnapshotModel(StrictManifestModel):
    type: Literal["TEXT"] = "TEXT"
    text: str


class RubyInlineNodeSnapshotModel(StrictManifestModel):
    type: Literal["RUBY"] = "RUBY"
    baseText: str = Field(..., min_length=1)
    rubyText: str = Field(..., min_length=1)
    parenthesisText: Optional[str] = None


class InlineImageNodeSnapshotModel(StrictManifestModel):
    type: Literal["INLINE_IMAGE"] = "INLINE_IMAGE"
    src: str = Field(..., min_length=1)
    alt: Optional[str] = None


class StrongInlineNodeSnapshotModel(StrictManifestModel):
    type: Literal["STRONG"] = "STRONG"
    children: List["NovelInlineNodeSnapshotModel"] = Field(default_factory=list)


class EmphasisInlineNodeSnapshotModel(StrictManifestModel):
    type: Literal["EMPHASIS"] = "EMPHASIS"
    children: List["NovelInlineNodeSnapshotModel"] = Field(default_factory=list)


NovelInlineNodeSnapshotModel = Annotated[
    Union[
        TextInlineNodeSnapshotModel,
        RubyInlineNodeSnapshotModel,
        InlineImageNodeSnapshotModel,
        StrongInlineNodeSnapshotModel,
        EmphasisInlineNodeSnapshotModel,
    ],
    Field(discriminator="type"),
]


class HeadingBlockNodeSnapshotModel(StrictManifestModel):
    type: Literal["HEADING"] = "HEADING"
    level: int = Field(..., ge=1, le=6)
    children: List[NovelInlineNodeSnapshotModel] = Field(default_factory=list)


class ParagraphBlockNodeSnapshotModel(StrictManifestModel):
    type: Literal["PARAGRAPH"] = "PARAGRAPH"
    children: List[NovelInlineNodeSnapshotModel] = Field(default_factory=list)


class BlockquoteBlockNodeSnapshotModel(StrictManifestModel):
    type: Literal["BLOCKQUOTE"] = "BLOCKQUOTE"
    children: List["NovelBlockNodeSnapshotModel"] = Field(default_factory=list)


class IllustrationBlockNodeSnapshotModel(StrictManifestModel):
    type: Literal["ILLUSTRATION"] = "ILLUSTRATION"
    src: str = Field(..., min_length=1)
    alt: Optional[str] = None
    caption: Optional[str] = None
    width: Optional[int] = Field(None, gt=0, le=JS_MAX_SAFE_INTEGER)
    height: Optional[int] = Field(None, gt=0, le=JS_MAX_SAFE_INTEGER)


class DividerBlockNodeSnapshotModel(StrictManifestModel):
    type: Literal["DIVIDER"] = "DIVIDER"


NovelBlockNodeSnapshotModel = Annotated[
    Union[
        HeadingBlockNodeSnapshotModel,
        ParagraphBlockNodeSnapshotModel,
        BlockquoteBlockNodeSnapshotModel,
        IllustrationBlockNodeSnapshotModel,
        DividerBlockNodeSnapshotModel,
    ],
    Field(discriminator="type"),
]


class CanonicalNovelDocumentSnapshotModel(StrictManifestModel):
    title: Optional[str] = None
    language: str = Field(..., min_length=1)
    format: str = Field(..., min_length=1)
    metadata: Optional[Dict[str, Any]] = None
    blocks: List[NovelBlockNodeSnapshotModel] = Field(default_factory=list)


class NovelStructureSnapshotModel(StrictManifestModel):
    version: Literal[1] = Field(...)
    segmenterVersion: str = Field(..., min_length=1)
    sourceStructureFingerprint: str = Field(..., pattern=r"^sha256:[0-9a-f]{64}$")
    document: CanonicalNovelDocumentSnapshotModel
    segments: List[NovelSegmentSnapshotModel] = Field(..., min_length=1)
    anchorMaps: Dict[str, List[NovelAnchorMapEntrySnapshotModel]] = Field(default_factory=dict)

    @field_validator("segments")
    @classmethod
    def validate_segments(
        cls, segments: List[NovelSegmentSnapshotModel]
    ) -> List[NovelSegmentSnapshotModel]:
        seen_ids: Set[str] = set()
        seen_orders: Set[int] = set()
        for s in segments:
            if s.anchorBlockId in seen_ids:
                raise ValueError(f"Duplicate anchorBlockId in segments: {s.anchorBlockId}")
            seen_ids.add(s.anchorBlockId)
            if s.sortOrder in seen_orders:
                raise ValueError(f"Duplicate sortOrder in segments: {s.sortOrder}")
            seen_orders.add(s.sortOrder)
        n = len(segments)
        for order in range(1, n + 1):
            if order not in seen_orders:
                raise ValueError(f"NON_CONTIGUOUS_SEGMENTS: Missing sortOrder {order} in 1..{n} sequence")
        return sorted(segments, key=lambda s: s.sortOrder)

    @model_validator(mode="after")
    def validate_anchor_maps_reference_existing_blocks(self) -> "NovelStructureSnapshotModel":
        valid_block_ids = {s.anchorBlockId for s in self.segments}
        for block_id, entries in self.anchorMaps.items():
            if block_id not in valid_block_ids:
                raise ValueError(
                    f"ANCHOR_MAP_ORPHAN_BLOCK: Anchor map key '{block_id}' does not exist in segments list"
                )
            seen_anchor_ids: Set[str] = set()
            for entry in entries:
                if entry.anchorId in seen_anchor_ids:
                    raise ValueError(
                        f"Duplicate anchorId '{entry.anchorId}' in anchor map for block '{block_id}'"
                    )
                seen_anchor_ids.add(entry.anchorId)
        return self


TranslationResultManifestV1 = Annotated[
    Union[MangaResultManifestV1, NovelResultManifestV1],
    Field(discriminator="mediaFormat")
]


# ----------------------------------------------------------------------
# Auxiliary & Input Manifest Models
# ----------------------------------------------------------------------

class MangaCleanBaseManifestV1(StrictManifestModel):
    version: Literal[1] = Field(...)
    pages: List[MangaCleanBasePageModel]


class TranslationGlossaryTermSnapshotModel(StrictManifestModel):
    sourceTerm: str
    targetTerm: str
    category: str


class TranslationExternalConsentSnapshotModel(StrictManifestModel):
    consented: bool
    consentedAt: Optional[str] = None
    provider: str

    @model_validator(mode="after")
    def validate_consent_timestamp(self) -> "TranslationExternalConsentSnapshotModel":
        if self.consented is True:
            if not self.consentedAt or not isinstance(self.consentedAt, str):
                raise ValueError("consentedAt must be provided as a string when consented is True")
            if not RFC3339_REGEX.match(self.consentedAt):
                raise ValueError(
                    "consentedAt must match RFC3339 format with timezone (e.g. '2026-09-03T10:00:00Z' or '2026-09-03T17:00:00+07:00')"
                )
            try:
                dt_str = self.consentedAt.replace("Z", "+00:00")
                datetime.fromisoformat(dt_str)
            except Exception as e:
                raise ValueError(f"consentedAt contains invalid calendar date or time: {e}")
        else:
            if self.consentedAt is not None:
                raise ValueError("consentedAt must be None when consented is False")
        return self


class TranslationInputManifestV1(StrictManifestModel):
    version: Literal[1] = Field(...)
    sourceLang: str = Field(..., min_length=1)
    targetLang: str = Field(..., min_length=1)
    provider: str = Field(..., min_length=1)
    model: str = Field(..., min_length=1)
    promptVersion: str = Field(..., min_length=1)
    glossarySnapshot: List[TranslationGlossaryTermSnapshotModel]
    glossaryHash: str = Field(..., pattern=r"^sha256:[0-9a-f]{64}$")
    externalConsent: TranslationExternalConsentSnapshotModel

    @model_validator(mode="after")
    def validate_provider_match(self) -> "TranslationInputManifestV1":
        if self.externalConsent.provider != self.provider:
            raise ValueError(
                f"externalConsent.provider ('{self.externalConsent.provider}') must match provider ('{self.provider}')"
            )
        return self

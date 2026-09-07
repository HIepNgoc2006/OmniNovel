"""
Versioned Manifest Models for AI Worker (Pydantic v2).
Strict parity with @omninovel/shared translation-manifests.ts (#160, #164).
"""

import re
from datetime import datetime
from enum import Enum
from typing import List, Optional, Union, Literal, Annotated, Any, Set
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
        return pages

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

"""
Versioned Manifest Models for AI Worker (Pydantic v2).
Parity with @omninovel/shared translation-manifests.ts (#160, #164).
"""

from enum import Enum
from typing import List, Optional, Union, Literal, Annotated
from pydantic import BaseModel, Field


class NovelBlockType(str, Enum):
    """Canonical block types for Light Novel translation segments (#160)."""
    HEADING = "HEADING"
    DIALOGUE = "DIALOGUE"
    NARRATION = "NARRATION"
    BLOCKQUOTE = "BLOCKQUOTE"


class MangaResultPageModel(BaseModel):
    page: int = Field(..., ge=1)
    storageKey: str
    previewKey: str
    width: int = Field(..., gt=0)
    height: int = Field(..., gt=0)
    fileSizeBytes: int = Field(..., ge=0)
    fileSize: Optional[int] = None


class MangaCleanBasePageModel(BaseModel):
    page: int = Field(..., ge=1)
    cleanBaseKey: str


class MangaResultManifestV1(BaseModel):
    version: Literal[1] = 1
    mediaFormat: Literal["COMIC"] = "COMIC"
    pages: List[MangaResultPageModel] = Field(..., min_length=1)
    cleanBases: Optional[List[MangaCleanBasePageModel]] = None


class NovelResultQaIssueModel(BaseModel):
    severity: str
    ruleId: str
    message: str


class NovelResultQaModel(BaseModel):
    passed: bool
    score: float = Field(..., ge=0.0, le=1.0)
    fingerprintMatch: bool
    issuesCount: int = Field(..., ge=0)
    issues: Optional[List[NovelResultQaIssueModel]] = None


class NovelResultAssetModel(BaseModel):
    storageKey: str
    contentType: Optional[str] = None
    fileSizeBytes: Optional[int] = None
    fileSize: Optional[int] = None


class NovelResultMetricsModel(BaseModel):
    totalBlocks: Optional[int] = None
    totalBatches: Optional[int] = None
    glossaryHits: Optional[int] = None
    promptVersion: Optional[str] = None


class NovelResultManifestV1(BaseModel):
    version: Literal[1] = 1
    mediaFormat: Literal["NOVEL"] = "NOVEL"
    htmlKey: str
    segmentCount: int = Field(..., ge=0)
    charCount: int = Field(..., ge=0)
    title: Optional[str] = None
    language: Optional[str] = None
    assets: Optional[List[NovelResultAssetModel]] = None
    qa: NovelResultQaModel
    metrics: Optional[NovelResultMetricsModel] = None


TranslationResultManifestV1 = Annotated[
    Union[MangaResultManifestV1, NovelResultManifestV1],
    Field(discriminator="mediaFormat")
]

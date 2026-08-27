"""
OmniNovel Light Novel Module.
Bao gồm:
- Parser & EPUB/Archive Security Sandbox
- Document AST & Deterministic Block Segmenter
- Context Windowing & Glossary Shadow Matching
- Structured Translation & Structural QA Rebuilder
- FullNovelPipeline Orchestrator
"""

from app.novel.security import (
    NovelSecurityError,
    PathTraversalError,
    ZipBombError,
    SymlinkDetectedError,
    MalformedEpubError,
    MultiChapterPackageError,
    ExternalResourceForbiddenError,
    ExcessiveArchiveEntriesError,
    ExcessiveArchiveSizeError,
    SafeNovelPackageExtractor,
    ExtractedEpubChapter,
)

__all__ = [
    "NovelSecurityError",
    "PathTraversalError",
    "ZipBombError",
    "SymlinkDetectedError",
    "MalformedEpubError",
    "MultiChapterPackageError",
    "ExternalResourceForbiddenError",
    "ExcessiveArchiveEntriesError",
    "ExcessiveArchiveSizeError",
    "SafeNovelPackageExtractor",
    "ExtractedEpubChapter",
]

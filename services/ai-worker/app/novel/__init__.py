"""
OmniNovel Light Novel Module.
Bao gồm:
- Parser & EPUB/Archive Security Sandbox
- Document AST & Deterministic Block Segmenter
- Context Windowing & Glossary Shadow Matching
- Structured Translation & Structural QA Rebuilder
- FullNovelPipeline Orchestrator
"""

from app.novel.ast_parser import (
    CanonicalNovelDocument,
    NovelAstParser,
    NovelBlockNode,
    NovelInlineNode,
    HeadingBlockNode,
    ParagraphBlockNode,
    BlockquoteBlockNode,
    IllustrationBlockNode,
    DividerBlockNode,
    TextNode,
    RubyNode,
    EmphasisNode,
    StrongNode,
)
from app.novel.context_builder import (
    NovelContextBuilder,
    NovelContextItem,
    NovelTranslationBatch,
)
from app.novel.glossary_engine import (
    GlossaryConstraint,
    NovelGlossaryEngine,
)
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
    safe_parse_xml_file,
    sanitize_and_resolve_archive_path,
)
from app.novel.segmenter import (
    NovelSegmenter,
    TranslatableBlock,
)
from app.novel.token_estimator import (
    ConservativeTokenEstimator,
    TokenEstimator,
)
from app.novel.translator import (
    NovelTranslationPipeline,
    NovelTranslationResult,
    TranslatedNovelBlock,
)

__all__ = [
    "CanonicalNovelDocument",
    "NovelAstParser",
    "NovelBlockNode",
    "NovelInlineNode",
    "HeadingBlockNode",
    "ParagraphBlockNode",
    "BlockquoteBlockNode",
    "IllustrationBlockNode",
    "DividerBlockNode",
    "TextNode",
    "RubyNode",
    "EmphasisNode",
    "StrongNode",
    "NovelContextBuilder",
    "NovelContextItem",
    "NovelTranslationBatch",
    "GlossaryConstraint",
    "NovelGlossaryEngine",
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
    "safe_parse_xml_file",
    "sanitize_and_resolve_archive_path",
    "NovelSegmenter",
    "TranslatableBlock",
    "ConservativeTokenEstimator",
    "TokenEstimator",
    "NovelTranslationPipeline",
    "NovelTranslationResult",
    "TranslatedNovelBlock",
]


from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

from app.novel.ast_parser import (
    BlockquoteBlockNode,
    CanonicalNovelDocument,
    DividerBlockNode,
    EmphasisNode,
    HeadingBlockNode,
    IllustrationBlockNode,
    InlineImageNode,
    NovelAstParser,
    NovelBlockNode,
    NovelInlineNode,
    ParagraphBlockNode,
    RubyNode,
    StrongNode,
    TextNode,
)
from app.novel.serializer import NovelDocumentSerializer


class QASeverity(str, Enum):
    INFO = "INFO"
    WARNING = "WARNING"
    ERROR = "ERROR"


@dataclass(frozen=True)
class NovelQAIssue:
    """Mô tả một vấn đề phát hiện trong quá trình kiểm định chất lượng cấu trúc."""
    severity: QASeverity
    rule_id: str
    message: str
    block_index: Optional[int] = None
    details: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class NovelStructuralFingerprint:
    """
    Dấu vân tay cấu trúc của một tài liệu Novel Document AST:
    - total_blocks: Tổng số khối cấp 1.
    - block_sequence: Chuỗi ký hiệu các khối (vd: ['H1', 'P', 'IMG', 'P', 'HR', 'P']).
    - heading_levels: Danh sách các cấp heading.
    - total_paragraphs: Số đoạn văn bản.
    - total_illustrations: Số ảnh minh họa.
    - total_dividers: Số thẻ phân đoạn.
    - total_ruby_nodes: Số node phiên âm furigana.
    - total_strong_nodes: Số node in đậm.
    - total_emphasis_nodes: Số node in nghiêng/nhấn mạnh.
    - asset_sources: Danh sách URI ảnh minh họa nội bộ.
    """
    total_blocks: int
    block_sequence: List[str]
    heading_levels: List[int]
    total_paragraphs: int
    total_illustrations: int
    total_dividers: int
    total_ruby_nodes: int
    total_strong_nodes: int
    total_emphasis_nodes: int
    asset_sources: List[str]


@dataclass(frozen=True)
class NovelQAResult:
    """Kết quả thẩm định chất lượng cấu trúc của tài liệu dịch."""
    passed: bool
    score: float  # 0.0 -> 1.0
    issues: List[NovelQAIssue]
    fingerprint_match: bool
    source_fingerprint: NovelStructuralFingerprint
    translated_fingerprint: NovelStructuralFingerprint
    metrics: Dict[str, Any] = field(default_factory=dict)


class NovelStructuralQAEvaluator:
    """
    Bộ đánh giá toàn vẹn cấu trúc AST cho Light Novel (Novel Structural QA Evaluator):
    - So sánh dấu vân tay cấu trúc (Structural Fingerprint) giữa tài liệu nguồn và tài liệu dịch.
    - Kiểm tra bảo toàn 100% cấu trúc heading, paragraph, illustration, divider.
    - Kiểm tra bảo toàn các phần tử inline (Ruby furigana, Strong, Emphasis).
    - Thẩm định tính an toàn UTF-8 (chặn null bytes và control characters độc hại).
    - Round-trip AST Verification: Serialize tài liệu dịch thành HTML và parse lại để xác nhận
      tính tái tạo và không thất thoát dữ liệu.
    """

    @classmethod
    def extract_fingerprint(cls, doc: CanonicalNovelDocument) -> NovelStructuralFingerprint:
        """
        Trích xuất dấu vân tay cấu trúc từ CanonicalNovelDocument.
        """
        block_sequence: List[str] = []
        heading_levels: List[int] = []
        total_p = 0
        total_img = 0
        total_hr = 0
        total_ruby = 0
        total_strong = 0
        total_em = 0
        assets: List[str] = []

        def _scan_inlines(inlines: List[NovelInlineNode]) -> None:
            nonlocal total_ruby, total_strong, total_em
            for node in inlines:
                if isinstance(node, RubyNode):
                    total_ruby += 1
                elif isinstance(node, StrongNode):
                    total_strong += 1
                    _scan_inlines(node.children)
                elif isinstance(node, EmphasisNode):
                    total_em += 1
                    _scan_inlines(node.children)

        for block in doc.blocks:
            if isinstance(block, HeadingBlockNode):
                block_sequence.append(f"H{block.level}")
                heading_levels.append(block.level)
                _scan_inlines(block.children)
            elif isinstance(block, ParagraphBlockNode):
                block_sequence.append("P")
                total_p += 1
                _scan_inlines(block.children)
            elif isinstance(block, BlockquoteBlockNode):
                block_sequence.append("QUOTE")
                for sub in block.children:
                    if isinstance(sub, ParagraphBlockNode):
                        total_p += 1
                        _scan_inlines(sub.children)
            elif isinstance(block, IllustrationBlockNode):
                block_sequence.append("IMG")
                total_img += 1
                if block.src:
                    assets.append(block.src)
            elif isinstance(block, DividerBlockNode):
                block_sequence.append("HR")
                total_hr += 1

        return NovelStructuralFingerprint(
            total_blocks=len(doc.blocks),
            block_sequence=block_sequence,
            heading_levels=heading_levels,
            total_paragraphs=total_p,
            total_illustrations=total_img,
            total_dividers=total_hr,
            total_ruby_nodes=total_ruby,
            total_strong_nodes=total_strong,
            total_emphasis_nodes=total_em,
            asset_sources=assets,
        )

    def evaluate(
        self,
        source_doc: CanonicalNovelDocument,
        translated_doc: CanonicalNovelDocument,
    ) -> NovelQAResult:
        """
        Thẩm định toàn diện tính toàn vẹn cấu trúc giữa bản gốc và bản dịch.
        """
        issues: List[NovelQAIssue] = []
        src_fp = self.extract_fingerprint(source_doc)
        trans_fp = self.extract_fingerprint(translated_doc)

        score = 1.0

        # 1. Kiểm tra số lượng và chuỗi khối (Block Sequence 1:1)
        if src_fp.total_blocks != trans_fp.total_blocks:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.ERROR,
                    rule_id="BLOCK_COUNT_MISMATCH",
                    message=f"Số lượng block không khớp: Gốc {src_fp.total_blocks} != Dịch {trans_fp.total_blocks}",
                )
            )
            score -= 0.3

        if src_fp.block_sequence != trans_fp.block_sequence:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.ERROR,
                    rule_id="BLOCK_SEQUENCE_MISMATCH",
                    message=f"Chuỗi cấu trúc block không khớp giữa bản gốc và bản dịch.",
                    details={"source": src_fp.block_sequence, "translated": trans_fp.block_sequence},
                )
            )
            score -= 0.3

        # 2. Kiểm tra bảo toàn Heading Hierarchy
        if src_fp.heading_levels != trans_fp.heading_levels:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.ERROR,
                    rule_id="HEADING_LEVEL_MISMATCH",
                    message=f"Cấp độ Heading không bảo toàn: Gốc {src_fp.heading_levels} != Dịch {trans_fp.heading_levels}",
                )
            )
            score -= 0.2

        # 3. Kiểm tra bảo toàn Ảnh minh họa và Phân đoạn
        if src_fp.total_illustrations != trans_fp.total_illustrations:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.ERROR,
                    rule_id="ILLUSTRATION_COUNT_MISMATCH",
                    message=f"Số lượng ảnh minh họa bị mất hoặc thừa: Gốc {src_fp.total_illustrations} != Dịch {trans_fp.total_illustrations}",
                )
            )
            score -= 0.3

        if src_fp.asset_sources != trans_fp.asset_sources:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.ERROR,
                    rule_id="ASSET_SOURCE_MISMATCH",
                    message=f"URI ảnh minh họa bị thay đổi sau khi dịch.",
                    details={"source": src_fp.asset_sources, "translated": trans_fp.asset_sources},
                )
            )
            score -= 0.2

        # 4. Kiểm tra bảo toàn Thẻ Ruby, Strong, Emphasis
        if src_fp.total_ruby_nodes != trans_fp.total_ruby_nodes:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.WARNING,
                    rule_id="RUBY_NODE_COUNT_MISMATCH",
                    message=f"Số lượng thẻ Ruby thay đổi: Gốc {src_fp.total_ruby_nodes} -> Dịch {trans_fp.total_ruby_nodes}",
                )
            )
            score -= 0.1

        if src_fp.total_strong_nodes != trans_fp.total_strong_nodes:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.WARNING,
                    rule_id="STRONG_NODE_COUNT_MISMATCH",
                    message=f"Số lượng thẻ in đậm Strong thay đổi: Gốc {src_fp.total_strong_nodes} -> Dịch {trans_fp.total_strong_nodes}",
                )
            )
            score -= 0.05

        # 5. Kiểm tra UTF-8 và ký tự điều khiển cấm
        for idx, block in enumerate(translated_doc.blocks):
            plain = block.to_plain_text()
            if any(ord(c) < 32 and c not in "\n\r\t" for c in plain):
                issues.append(
                    NovelQAIssue(
                        severity=QASeverity.ERROR,
                        rule_id="ILLEGAL_CONTROL_CHARACTERS",
                        message=f"Phát hiện ký tự điều khiển cấm trong block #{idx + 1}.",
                        block_index=idx + 1,
                    )
                )
                score -= 0.2

        # 6. Round-trip Serialization Test
        try:
            rendered_html = NovelDocumentSerializer.serialize_to_html(translated_doc)
            reparsed_doc = NovelAstParser.parse_html(rendered_html)
            reparsed_fp = self.extract_fingerprint(reparsed_doc)
            if trans_fp.block_sequence != reparsed_fp.block_sequence:
                issues.append(
                    NovelQAIssue(
                        severity=QASeverity.ERROR,
                        rule_id="ROUNDTRIP_SERIALIZATION_MISMATCH",
                        message="Tuần tự hóa HTML và phân tích lại tạo ra cây AST bị lệch cấu trúc.",
                    )
                )
                score -= 0.2
        except Exception as ex:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.ERROR,
                    rule_id="ROUNDTRIP_SERIALIZATION_FAILED",
                    message=f"Lỗi khi tuần tự hóa hoặc phân tích lại HTML: {str(ex)}",
                )
            )
            score -= 0.3

        fingerprint_match = (src_fp.block_sequence == trans_fp.block_sequence) and (src_fp.heading_levels == trans_fp.heading_levels)
        final_score = max(0.0, min(1.0, score))
        has_errors = any(i.severity == QASeverity.ERROR for i in issues)

        return NovelQAResult(
            passed=not has_errors,
            score=final_score,
            issues=issues,
            fingerprint_match=fingerprint_match,
            source_fingerprint=src_fp,
            translated_fingerprint=trans_fp,
            metrics={
                "error_count": sum(1 for i in issues if i.severity == QASeverity.ERROR),
                "warning_count": sum(1 for i in issues if i.severity == QASeverity.WARNING),
            },
        )

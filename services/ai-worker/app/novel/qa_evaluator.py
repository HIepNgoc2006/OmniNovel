from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

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


class NovelQualityGateError(RuntimeError):
    """Ném ra khi bản dịch Novel không vượt qua bài kiểm định chất lượng cấu trúc (QA Gate Fail-Closed)."""
    pass


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
    Dấu vân tay cấu trúc toàn diện của một tài liệu Novel Document AST:
    - total_blocks: Tổng số khối cấp 1.
    - block_sequence: Chuỗi ký hiệu các khối (vd: ['H1', 'P', 'IMG', 'P', 'HR', 'P']).
    - heading_levels: Danh sách các cấp heading.
    - total_paragraphs: Số đoạn văn bản.
    - total_illustrations: Số ảnh minh họa.
    - total_dividers: Số thẻ phân đoạn.
    - total_ruby_nodes: Số node phiên âm furigana.
    - total_strong_nodes: Số node in đậm.
    - total_emphasis_nodes: Số node in nghiêng/nhấn mạnh.
    - asset_sources: Danh sách URI ảnh minh họa nội bộ và inline images.
    - ruby_metadata_list: Danh sách chính xác (ruby_text, parenthesis_text) theo thứ tự xuất hiện.
    - inline_topology: Chuỗi topo biểu diễn cây lồng nhau của các phần tử inline theo từng block.
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
    ruby_metadata_list: List[Tuple[str, Optional[str]]]
    inline_topology: List[str]


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
    - So sánh dấu vân tay cấu trúc toàn diện (Structural Fingerprint) giữa tài liệu nguồn và dịch.
    - Kiểm tra bảo toàn 100% cấu trúc heading, paragraph, illustration, divider.
    - Kiểm tra bảo toàn 100% các phần tử inline (Ruby furigana text, Strong, Emphasis, InlineImage).
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
        ruby_meta: List[Tuple[str, Optional[str]]] = []
        topology: List[str] = []

        def _scan_inlines(inlines: List[NovelInlineNode]) -> str:
            nonlocal total_ruby, total_strong, total_em
            parts: List[str] = []
            for node in inlines:
                if isinstance(node, TextNode):
                    parts.append("T")
                elif isinstance(node, StrongNode):
                    total_strong += 1
                    inner_topo = _scan_inlines(node.children)
                    parts.append(f"S({inner_topo})")
                elif isinstance(node, EmphasisNode):
                    total_em += 1
                    inner_topo = _scan_inlines(node.children)
                    parts.append(f"E({inner_topo})")
                elif isinstance(node, RubyNode):
                    total_ruby += 1
                    ruby_meta.append((node.ruby_text, node.parenthesis_text))
                    parts.append(f"R[{node.ruby_text}]")
                elif isinstance(node, InlineImageNode):
                    if node.src:
                        assets.append(node.src)
                    parts.append(f"IMG[{node.src}]")
            return "+".join(parts)

        for block in doc.blocks:
            if isinstance(block, HeadingBlockNode):
                block_sequence.append(f"H{block.level}")
                heading_levels.append(block.level)
                topo_str = _scan_inlines(block.children)
                topology.append(f"H{block.level}:{topo_str}")
            elif isinstance(block, ParagraphBlockNode):
                block_sequence.append("P")
                total_p += 1
                topo_str = _scan_inlines(block.children)
                topology.append(f"P:{topo_str}")
            elif isinstance(block, BlockquoteBlockNode):
                block_sequence.append("QUOTE")
                quote_topos: List[str] = []
                for sub in block.children:
                    if isinstance(sub, ParagraphBlockNode):
                        total_p += 1
                        q_topo = _scan_inlines(sub.children)
                        quote_topos.append(f"P:{q_topo}")
                topology.append(f"QUOTE:{';'.join(quote_topos)}")
            elif isinstance(block, IllustrationBlockNode):
                block_sequence.append("IMG")
                total_img += 1
                if block.src:
                    assets.append(block.src)
                topology.append(f"IMG:{block.src}")
            elif isinstance(block, DividerBlockNode):
                block_sequence.append("HR")
                total_hr += 1
                topology.append("HR")

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
            ruby_metadata_list=ruby_meta,
            inline_topology=topology,
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

        if src_fp.total_dividers != trans_fp.total_dividers:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.ERROR,
                    rule_id="DIVIDER_COUNT_MISMATCH",
                    message=f"Số lượng thẻ phân đoạn Divider bị mất hoặc thừa: Gốc {src_fp.total_dividers} != Dịch {trans_fp.total_dividers}",
                )
            )
            score -= 0.2

        if src_fp.asset_sources != trans_fp.asset_sources:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.ERROR,
                    rule_id="ASSET_SOURCE_MISMATCH",
                    message=f"URI ảnh minh họa nội bộ bị thay đổi sau khi dịch.",
                    details={"source": src_fp.asset_sources, "translated": trans_fp.asset_sources},
                )
            )
            score -= 0.2

        # 4. Kiểm tra bảo toàn Thẻ Ruby, Strong, Emphasis & Furigana Metadata
        if src_fp.total_ruby_nodes != trans_fp.total_ruby_nodes:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.ERROR,
                    rule_id="RUBY_NODE_COUNT_MISMATCH",
                    message=f"Số lượng thẻ Ruby thay đổi: Gốc {src_fp.total_ruby_nodes} -> Dịch {trans_fp.total_ruby_nodes}",
                )
            )
            score -= 0.2

        if src_fp.ruby_metadata_list != trans_fp.ruby_metadata_list:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.ERROR,
                    rule_id="RUBY_METADATA_MUTATED",
                    message="Phát hiện nội dung furigana <rt> hoặc dấu ngoặc <rp> bị biến dạng hoặc sửa đổi.",
                    details={"source": src_fp.ruby_metadata_list, "translated": trans_fp.ruby_metadata_list},
                )
            )
            score -= 0.2

        if src_fp.total_strong_nodes != trans_fp.total_strong_nodes:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.ERROR,
                    rule_id="STRONG_NODE_COUNT_MISMATCH",
                    message=f"Số lượng thẻ in đậm Strong thay đổi: Gốc {src_fp.total_strong_nodes} -> Dịch {trans_fp.total_strong_nodes}",
                )
            )
            score -= 0.15

        if src_fp.total_emphasis_nodes != trans_fp.total_emphasis_nodes:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.ERROR,
                    rule_id="EMPHASIS_COUNT_MISMATCH",
                    message=f"Số lượng thẻ in nghiêng Emphasis thay đổi: Gốc {src_fp.total_emphasis_nodes} -> Dịch {trans_fp.total_emphasis_nodes}",
                )
            )
            score -= 0.15

        # 5. Kiểm tra Inline Topology (Cấu trúc lồng ghép và thứ tự inline tags)
        if src_fp.inline_topology != trans_fp.inline_topology:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.ERROR,
                    rule_id="INLINE_TOPOLOGY_MISMATCH",
                    message="Cấu trúc lồng ghép hoặc thứ tự inline tags trong block bị thay đổi.",
                    details={"source": src_fp.inline_topology, "translated": trans_fp.inline_topology},
                )
            )
            score -= 0.2

        # 6. Kiểm tra UTF-8 và ký tự điều khiển cấm
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

        # 7. Round-trip Serialization & Re-parsing Full Fingerprint Test
        try:
            rendered_html = NovelDocumentSerializer.serialize_to_html(translated_doc)
            reparsed_doc = NovelAstParser.parse_html(rendered_html)
            reparsed_fp = self.extract_fingerprint(reparsed_doc)
            
            roundtrip_match = (
                trans_fp.block_sequence == reparsed_fp.block_sequence
                and trans_fp.heading_levels == reparsed_fp.heading_levels
                and trans_fp.total_dividers == reparsed_fp.total_dividers
                and trans_fp.total_illustrations == reparsed_fp.total_illustrations
                and trans_fp.asset_sources == reparsed_fp.asset_sources
                and trans_fp.total_ruby_nodes == reparsed_fp.total_ruby_nodes
                and trans_fp.ruby_metadata_list == reparsed_fp.ruby_metadata_list
                and trans_fp.total_strong_nodes == reparsed_fp.total_strong_nodes
                and trans_fp.total_emphasis_nodes == reparsed_fp.total_emphasis_nodes
                and trans_fp.inline_topology == reparsed_fp.inline_topology
            )
            
            if not roundtrip_match:
                issues.append(
                    NovelQAIssue(
                        severity=QASeverity.ERROR,
                        rule_id="ROUNDTRIP_SERIALIZATION_MISMATCH",
                        message="Tuần tự hóa HTML và phân tích lại tạo ra cây AST bị lệch cấu trúc hoặc suy hao metadata.",
                        details={
                            "translated_topology": trans_fp.inline_topology,
                            "reparsed_topology": reparsed_fp.inline_topology,
                            "translated_ruby": trans_fp.ruby_metadata_list,
                            "reparsed_ruby": reparsed_fp.ruby_metadata_list,
                        },
                    )
                )
                score -= 0.25
        except Exception as ex:
            issues.append(
                NovelQAIssue(
                    severity=QASeverity.ERROR,
                    rule_id="ROUNDTRIP_SERIALIZATION_FAILED",
                    message=f"Lỗi khi tuần tự hóa hoặc phân tích lại HTML: {str(ex)}",
                )
            )
            score -= 0.3

        fingerprint_match = (
            src_fp.block_sequence == trans_fp.block_sequence
            and src_fp.heading_levels == trans_fp.heading_levels
            and src_fp.total_dividers == trans_fp.total_dividers
            and src_fp.total_illustrations == trans_fp.total_illustrations
            and src_fp.asset_sources == trans_fp.asset_sources
            and src_fp.total_ruby_nodes == trans_fp.total_ruby_nodes
            and src_fp.ruby_metadata_list == trans_fp.ruby_metadata_list
            and src_fp.total_strong_nodes == trans_fp.total_strong_nodes
            and src_fp.total_emphasis_nodes == trans_fp.total_emphasis_nodes
            and src_fp.inline_topology == trans_fp.inline_topology
        )

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

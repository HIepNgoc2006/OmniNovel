from dataclasses import dataclass, field
import logging
from typing import Any, Dict, List, Optional, Union

from app.novel.ast_parser import CanonicalNovelDocument
from app.novel.context_builder import NovelContextBuilder, NovelTranslationBatch
from app.novel.glossary_engine import NovelGlossaryEngine
from app.novel.segmenter import NovelSegmenter, TranslatableBlock
from app.pipeline.progress_sink import ProgressSink
from app.translation.providers.base import TranslationProvider, TranslatedNovelBlockItem

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TranslatedNovelBlock:
    """
    Kết quả dịch của một TranslatableBlock:
    - anchor_block_id: Định danh duy nhất bất biến của khối.
    - sort_order: Thứ tự tuyến tính.
    - block_type: HEADING, PARAGRAPH, DIALOGUE, NARRATION, BLOCKQUOTE.
    - raw_text: Văn bản gốc tiếng Nhật bất biến.
    - translated_text: Văn bản đã dịch tiếng Việt.
    - meta: Thông tin bổ trợ.
    """
    anchor_block_id: str
    sort_order: int
    block_type: str
    raw_text: str
    translated_text: str
    meta: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class NovelTranslationResult:
    """
    Tổng kết kết quả dịch toàn bộ tài liệu Novel:
    - blocks: Danh sách các TranslatedNovelBlock theo đúng thứ tự đọc.
    - total_blocks: Tổng số khối đã dịch.
    - total_batches: Tổng số batch đã xử lý.
    - glossary_hits: Tổng số lượt áp dụng thuật ngữ thành công.
    """
    blocks: List[TranslatedNovelBlock]
    total_blocks: int
    total_batches: int
    glossary_hits: int


class NovelTranslationPipeline:
    """
    Pipeline dịch thuật Light Novel / Tiểu thuyết hoàn chỉnh:
    - Kết nối NovelSegmenter, NovelGlossaryEngine (Shadow String), NovelContextBuilder (Sliding Window),
      và TranslationProvider (Mock / OpenAI-Compatible).
    - Bảo toàn 100% tính bất biến của raw_text gốc.
    - Xác thực 1:1 anchorBlockId không cho phép trùng lặp, thiếu hoặc thừa block.
    - Bắn tiến độ (Progress & Heartbeats) đều đặn qua ProgressSink.
    """

    def __init__(
        self,
        provider: TranslationProvider,
        context_builder: Optional[NovelContextBuilder] = None,
        prompt_version: str = "novel-ja-vi-v1",
    ):
        self.provider = provider
        self.context_builder = context_builder or NovelContextBuilder()
        self.prompt_version = prompt_version

    async def translate_document(
        self,
        document_or_blocks: Union[CanonicalNovelDocument, List[TranslatableBlock]],
        glossary_entries: Optional[List[Dict[str, Any]]] = None,
        progress_sink: Optional[ProgressSink] = None,
        job_id: Optional[str] = None,
    ) -> NovelTranslationResult:
        """
        Dịch toàn bộ tài liệu Light Novel sang tiếng Việt.
        """
        # 1. Trích xuất TranslatableBlocks nếu đầu vào là CanonicalNovelDocument
        if isinstance(document_or_blocks, CanonicalNovelDocument):
            segmenter = NovelSegmenter()
            blocks = segmenter.segment_document(document_or_blocks)
        else:
            blocks = list(document_or_blocks)

        if not blocks:
            return NovelTranslationResult(
                blocks=[],
                total_blocks=0,
                total_batches=0,
                glossary_hits=0,
            )

        # 2. Khớp thuật ngữ qua Shadow String NFKC
        glossary_engine = NovelGlossaryEngine(glossary_entries)
        glossary_constraints_map = glossary_engine.match_blocks(blocks)
        total_glossary_hits = sum(len(v) for v in glossary_constraints_map.values())

        # 3. Gom cụm các batch theo token budget và sliding window context
        batches = self.context_builder.build_batches(blocks, glossary_constraints_map)
        total_batches = len(batches)
        translated_blocks_map: Dict[str, str] = {}

        # 4. Thực thi dịch từng batch
        for idx, batch in enumerate(batches):
            # Phát tiến độ TRANSLATING
            if progress_sink:
                pct = int((idx / max(1, total_batches)) * 100)
                await progress_sink.emit_progress(
                    stage="TRANSLATING",
                    progress_percentage=pct,
                    current_page=idx + 1,
                    total_pages=total_batches,
                )

            # Gọi provider dịch batch
            translated_items: List[TranslatedNovelBlockItem] = await self.provider.translate_novel_batch(
                batch, prompt_version=self.prompt_version
            )

            # Thu thập kết quả
            for item in translated_items:
                translated_blocks_map[item.anchor_block_id] = item.translated_text

        # Phát tiến độ 100% stage TRANSLATING
        if progress_sink:
            await progress_sink.emit_progress(
                stage="TRANSLATING",
                progress_percentage=100,
                current_page=total_batches,
                total_pages=total_batches,
            )

        # 5. Dựng lại danh sách TranslatedNovelBlock theo đúng thứ tự đọc ban đầu
        final_translated_blocks: List[TranslatedNovelBlock] = []
        for block in blocks:
            translated_text = translated_blocks_map.get(block.anchor_block_id, block.raw_text)
            final_translated_blocks.append(
                TranslatedNovelBlock(
                    anchor_block_id=block.anchor_block_id,
                    sort_order=block.sort_order,
                    block_type=block.block_type,
                    raw_text=block.raw_text,
                    translated_text=translated_text,
                    meta=dict(block.meta),
                )
            )

        return NovelTranslationResult(
            blocks=final_translated_blocks,
            total_blocks=len(final_translated_blocks),
            total_batches=total_batches,
            glossary_hits=total_glossary_hits,
        )

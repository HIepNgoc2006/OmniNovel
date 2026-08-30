import json
from pathlib import Path
from typing import Any, Dict, List, Optional
import httpx
import pytest

from app.novel.ast_parser import NovelAstParser
from app.novel.segmenter import TranslatableBlock
from app.novel.translator import NovelTranslationPipeline, NovelTranslationResult
from app.pipeline.progress_sink import ProgressSink
from app.translation.prompt_registry import get_prompt_template
from app.translation.providers.base import (
    AuthenticationError,
    RateLimitError,
    SchemaMismatchError,
    TranslationProvider,
    TranslatedNovelBlockItem,
    TranslatedSegmentItem,
)
from app.translation.providers.mock_provider import MockTranslationProvider
from app.translation.providers.openai_provider import OpenAICompatibleTranslationProvider


@pytest.mark.asyncio
async def test_novel_pipeline_with_mock_provider():
    html = """
    <html>
        <body>
            <h1>第1章 旅立ち</h1>
            <p>少年は魔王の城を見つめていた。</p>
            <p>「行くぞ、相棒」</p>
        </body>
    </html>
    """
    doc = NovelAstParser.parse_html(html)
    glossary = [
        {"source_term": "魔王の城", "target_term": "Lâu đài Ma Vương", "category": "location"}
    ]

    provider = MockTranslationProvider()
    pipeline = NovelTranslationPipeline(provider=provider)

    sink_events = []
    class CustomSink(ProgressSink):
        async def emit_progress(
            self,
            progress: int,
            stage: str,
            heartbeat: bool = False,
            message: str = "",
            sequence: Optional[int] = None,
            result_manifest: Optional[Dict[str, Any]] = None,
            segments: Optional[List[Dict[str, Any]]] = None,
            **kwargs,
        ):
            sink_events.append((stage, progress))

    result = await pipeline.translate_document(
        doc,
        glossary_entries=glossary,
        progress_sink=CustomSink(),
    )

    assert result.total_blocks == 3
    assert result.glossary_hits >= 1
    assert len(result.blocks) == 3

    # Heading
    assert result.blocks[0].anchor_block_id == "blk_0001_h1"
    # Paragraph with glossary applied
    assert "Lâu đài Ma Vương" in result.blocks[1].translated_text
    # Dialogue
    assert "blk_0003_dlg" in result.blocks[2].anchor_block_id
    assert len(sink_events) >= 2
    assert sink_events[-1][0] == "TRANSLATING"
    assert sink_events[-1][1] == 100


def test_novel_prompt_template_registered():
    prompt_v1 = get_prompt_template("novel-ja-vi-v1")
    assert "Biên dịch viên Light Novel" in prompt_v1
    assert "translate_blocks" in prompt_v1
    assert "anchorBlockId" in prompt_v1
    assert "DATA BOUNDARY & INJECTION DEFENSE" in prompt_v1

    prompt_v2 = get_prompt_template("novel-ja-vi-v2")
    assert "PROTECTED INLINE ANCHORS" in prompt_v2
    assert "⟦S:0001⟧" in prompt_v2
    assert "⟦R:0001⟧" in prompt_v2
    assert "SOV -> SVO" in prompt_v2



@pytest.mark.asyncio
async def test_novel_provider_rejects_duplicate_input_keys():
    provider = MockTranslationProvider()
    blocks = [
        TranslatableBlock("blk_0001_p", 1, "PARAGRAPH", "Text 1"),
        TranslatableBlock("blk_0001_p", 2, "PARAGRAPH", "Text 2 (Duplicate ID)"),
    ]
    pipeline = NovelTranslationPipeline(provider=provider)

    with pytest.raises(SchemaMismatchError, match="DUPLICATE_NOVEL_INPUT_KEY"):
        await pipeline.translate_document(blocks)


@pytest.mark.asyncio
async def test_novel_provider_rejects_duplicate_output_keys():
    class DuplicateKeyProvider(TranslationProvider):
        async def translate_batch(self, batch: Any, prompt_version: str = "manga-ja-vi-v1") -> List[TranslatedSegmentItem]:
            return []

        async def translate_novel_batch(self, batch: Any, prompt_version: str = "novel-ja-vi-v1") -> List[TranslatedNovelBlockItem]:
            results = [
                TranslatedNovelBlockItem("blk_0001_p", "Dịch 1"),
                TranslatedNovelBlockItem("blk_0001_p", "Dịch trùng lặp"),
            ]
            self._validate_novel_output_keys(batch.translate_blocks, results)
            return results

    blocks = [
        TranslatableBlock("blk_0001_p", 1, "PARAGRAPH", "Text 1"),
        TranslatableBlock("blk_0002_p", 2, "PARAGRAPH", "Text 2"),
    ]
    pipeline = NovelTranslationPipeline(provider=DuplicateKeyProvider())

    with pytest.raises(SchemaMismatchError, match="DUPLICATE_NOVEL_OUTPUT_KEY"):
        await pipeline.translate_document(blocks)


@pytest.mark.asyncio
async def test_novel_provider_rejects_cardinality_mismatch():
    class CardinalityMismatchProvider(TranslationProvider):
        async def translate_batch(self, batch: Any, prompt_version: str = "manga-ja-vi-v1") -> List[TranslatedSegmentItem]:
            return []

        async def translate_novel_batch(self, batch: Any, prompt_version: str = "novel-ja-vi-v1") -> List[TranslatedNovelBlockItem]:
            results = [
                TranslatedNovelBlockItem("blk_0001_p", "Dịch 1"),
            ]
            self._validate_novel_output_keys(batch.translate_blocks, results)
            return results

    blocks = [
        TranslatableBlock("blk_0001_p", 1, "PARAGRAPH", "Text 1"),
        TranslatableBlock("blk_0002_p", 2, "PARAGRAPH", "Text 2"),
    ]
    pipeline = NovelTranslationPipeline(provider=CardinalityMismatchProvider())

    with pytest.raises(SchemaMismatchError, match="CARDINALITY_MISMATCH"):
        await pipeline.translate_document(blocks)


@pytest.mark.asyncio
async def test_novel_provider_rejects_missing_or_hallucinated_keys():
    class MissingKeyProvider(TranslationProvider):
        async def translate_batch(self, batch: Any, prompt_version: str = "manga-ja-vi-v1") -> List[TranslatedSegmentItem]:
            return []

        async def translate_novel_batch(self, batch: Any, prompt_version: str = "novel-ja-vi-v1") -> List[TranslatedNovelBlockItem]:
            results = [
                TranslatedNovelBlockItem("blk_0001_p", "Dịch 1"),
                TranslatedNovelBlockItem("blk_9999_hallucinated", "Dịch ảo giác"),
            ]
            self._validate_novel_output_keys(batch.translate_blocks, results)
            return results

    blocks = [
        TranslatableBlock("blk_0001_p", 1, "PARAGRAPH", "Text 1"),
        TranslatableBlock("blk_0002_p", 2, "PARAGRAPH", "Text 2"),
    ]
    pipeline = NovelTranslationPipeline(provider=MissingKeyProvider())

    with pytest.raises(SchemaMismatchError, match="SCHEMA_NOVEL_KEY_MISMATCH"):
        await pipeline.translate_document(blocks)



@pytest.mark.asyncio
async def test_openai_compatible_novel_translation_mocked():
    fake_response = {
        "choices": [
            {
                "message": {
                    "content": json.dumps(
                        {
                            "translations": [
                                {"anchorBlockId": "blk_0001_p", "translatedText": "Dịch chuẩn 1"},
                                {"anchorBlockId": "blk_0002_dlg", "translatedText": "Dịch chuẩn 2"},
                            ]
                        }
                    )
                }
            }
        ]
    }

    async def mock_handler(request: httpx.Request):
        return httpx.Response(200, json=fake_response)

    transport = httpx.MockTransport(mock_handler)
    async with httpx.AsyncClient(transport=transport) as client:
        provider = OpenAICompatibleTranslationProvider(
            api_key="sk-test",
            base_url="https://api.openai.com/v1",
            model_name="gpt-4o",
            client=client,
        )

        blocks = [
            TranslatableBlock("blk_0001_p", 1, "PARAGRAPH", "Text 1"),
            TranslatableBlock("blk_0002_dlg", 2, "DIALOGUE", "Text 2"),
        ]
        pipeline = NovelTranslationPipeline(provider=provider)
        res = await pipeline.translate_document(blocks)

        assert res.total_blocks == 2
        assert res.blocks[0].translated_text == "Dịch chuẩn 1"
        assert res.blocks[1].translated_text == "Dịch chuẩn 2"

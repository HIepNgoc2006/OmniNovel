"""
Tests for NovelMaterializer Engine (#158).
Verifies:
1. Zero LLM / Zero NovelSegmenter runtime invariant.
2. Target language preservation (<html lang="en">).
3. Strict SHA-256 and sourceStructureFingerprint verification.
4. Cross-snapshot parity verification (anchors, cardinality, blockType).
5. Fail-closed asset mapping resolution (NOVEL_ASSET_MAPPING_UNAVAILABLE).
6. Fail-closed structural QA validation.
7. Upload to canonical outputStorageKey and fenced completion callback.
"""

import hashlib
import json
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi import HTTPException

from app.models.manifests import (
    NovelBlockType,
    NovelStructureSnapshotModel,
)
from app.models.materialize import (
    MaterializationSnapshotV1,
    MaterializeNovelRequest,
)
from app.novel.ast_parser import (
    CanonicalNovelDocument,
    DividerBlockNode,
    HeadingBlockNode,
    IllustrationBlockNode,
    ParagraphBlockNode,
    RubyNode,
    StrongNode,
    TextNode,
)
from app.novel.inline_anchors import InlineAnchorCodec, InlineAnchorMap
from app.novel.segmenter import NovelSegmenter
from app.novel.structure_snapshot import (
    create_structure_snapshot,
    extract_source_structure_fingerprint,
)
from app.pipeline.novel_materializer import NovelMaterializer

VALID_JOB_ID = "11111111-1111-4111-8111-111111111111"
VALID_SEG_1_ID = "22222222-2222-4222-8222-222222222222"
VALID_SEG_2_ID = "33333333-3333-4333-8333-333333333333"


def _build_test_document() -> CanonicalNovelDocument:
    return CanonicalNovelDocument(
        format="EPUB",
        title="第1章 旅立ち",
        language="ja",
        metadata={},
        blocks=[
            HeadingBlockNode(
                level=1,
                children=[
                    TextNode("第1章 "),
                    StrongNode(children=[TextNode("旅立ち")]),
                ],
            ),
            ParagraphBlockNode(
                children=[
                    TextNode("夜空を見上げると、"),
                    RubyNode(base_text="星屑", ruby_text="ほしくず"),
                    TextNode("が輝いていた。"),
                ],
            ),
            IllustrationBlockNode(
                src="images/chapter1_cover.jpg",
                alt="Chapter 1 Illustration",
            ),
            DividerBlockNode(),
        ],
    )


def _build_test_fixtures(target_language: str = "vi"):
    source_doc = _build_test_document()
    segmenter = NovelSegmenter()
    blocks, anchor_maps = segmenter.segment_document_with_inline_anchors(source_doc)
    source_fp = extract_source_structure_fingerprint(source_doc)

    struct_snapshot = create_structure_snapshot(
        source_doc=source_doc,
        blocks=blocks,
        anchor_maps=anchor_maps,
        segmenter_version=segmenter.version,
        source_structure_fingerprint=source_fp,
    )
    raw_struct_bytes = struct_snapshot.model_dump_json(by_alias=True).encode("utf-8")
    struct_sha256 = hashlib.sha256(raw_struct_bytes).hexdigest()

    if target_language == "en":
        h1_trans = "Chapter 1 ⟦S:0001⟧Departure⟦/S:0001⟧"
        p_trans = "Looking up at the night sky, ⟦R:0001⟧stardust⟦/R:0001⟧ shone brightly."
        title = "Chapter 1 Departure"
    else:
        h1_trans = "Chương 1 ⟦S:0001⟧Khởi hành⟦/S:0001⟧"
        p_trans = "Ngước nhìn bầu trời đêm, ⟦R:0001⟧bụi sao⟦/R:0001⟧ lấp lánh."
        title = "Chương 1 Khởi hành"

    mat_snapshot_dict = {
        "version": 1,
        "jobId": VALID_JOB_ID,
        "targetRevision": 2,
        "mediaFormat": "NOVEL",
        "segments": [
            {
                "id": VALID_SEG_1_ID,
                "version": 1,
                "pageNumber": None,
                "bboxX": None,
                "bboxY": None,
                "bboxW": None,
                "bboxH": None,
                "anchorBlockId": blocks[0].anchor_block_id,
                "sortOrder": 1,
                "rawText": blocks[0].raw_text,
                "translatedText": h1_trans,
                "blockType": "HEADING",
            },
            {
                "id": VALID_SEG_2_ID,
                "version": 1,
                "pageNumber": None,
                "bboxX": None,
                "bboxY": None,
                "bboxW": None,
                "bboxH": None,
                "anchorBlockId": blocks[1].anchor_block_id,
                "sortOrder": 2,
                "rawText": blocks[1].raw_text,
                "translatedText": p_trans,
                "blockType": "NARRATION",
            },
        ],
    }
    raw_mat_bytes = json.dumps(mat_snapshot_dict, ensure_ascii=False).encode("utf-8")
    mat_sha256 = hashlib.sha256(raw_mat_bytes).hexdigest()

    request_data = {
        "jobId": VALID_JOB_ID,
        "targetRevision": 2,
        "targetLanguage": target_language,
        "materializationSnapshotUrl": "https://storage.local/snapshots/mat.json",
        "materializationSnapshotSha256": mat_sha256,
        "structureSnapshotUrl": "https://storage.local/snapshots/struct.json",
        "structureSnapshotSha256": struct_sha256,
        "sourceStructureFingerprint": source_fp,
        "outputUploadUrl": "https://storage.local/materializations/content.html",
        "outputStorageKey": f"ai/jobs/{VALID_JOB_ID}/materializations/rev-2/content.html",
        "title": title,
        "assetMappings": [
            {
                "sourceHref": "/images/chapter1_cover.jpg",
                "storageKey": f"ai/jobs/{VALID_JOB_ID}/assets/chapter1_cover.jpg",
            }
        ],
    }
    request = MaterializeNovelRequest.model_validate(request_data)

    return {
        "request": request,
        "raw_struct_bytes": raw_struct_bytes,
        "raw_mat_bytes": raw_mat_bytes,
        "struct_snapshot": struct_snapshot,
        "mat_snapshot_dict": mat_snapshot_dict,
        "source_fp": source_fp,
    }


@pytest.mark.asyncio
async def test_materialize_novel_success_happy_path():
    fixtures = _build_test_fixtures(target_language="vi")
    req = fixtures["request"]

    async def mock_download(url: str) -> bytes:
        if "mat.json" in url:
            return fixtures["raw_mat_bytes"]
        if "struct.json" in url:
            return fixtures["raw_struct_bytes"]
        raise ValueError(f"Unknown download URL: {url}")

    uploaded_html_bytes: Optional[bytes] = None
    uploaded_headers: Optional[dict] = None
    callback_payload: Optional[dict] = None

    class MockAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass

        async def put(self, url, content=None, headers=None):
            nonlocal uploaded_html_bytes, uploaded_headers
            uploaded_html_bytes = content
            uploaded_headers = headers
            resp = MagicMock()
            resp.status_code = 200
            return resp

        async def post(self, url, json=None, headers=None):
            nonlocal callback_payload
            callback_payload = json
            resp = MagicMock()
            resp.is_success = True
            resp.status_code = 200
            return resp

    materializer = NovelMaterializer()

    with patch("app.pipeline.novel_materializer.safe_download_bytes", side_effect=mock_download), \
         patch("app.pipeline.novel_materializer.validate_download_url"), \
         patch("httpx.AsyncClient", return_value=MockAsyncClient()):

        result = await materializer.materialize_novel(req)

    # 1. Output HTML validation
    assert result["htmlKey"] == req.output_storage_key
    assert result["segmentCount"] == 2
    assert result["charCount"] > 0
    assert uploaded_html_bytes is not None
    assert uploaded_headers == {"Content-Type": "text/html; charset=utf-8"}

    html_str = uploaded_html_bytes.decode("utf-8")
    assert '<html lang="vi">' in html_str
    assert "Chương 1 <strong>Khởi hành</strong>" in html_str
    assert "<ruby><rb>bụi sao</rb><rt>ほしくず</rt></ruby>" in html_str
    assert f'src="ai/jobs/{VALID_JOB_ID}/assets/chapter1_cover.jpg"' in html_str
    assert "<hr />" in html_str

    # 2. Completion callback validation
    assert callback_payload is not None
    assert callback_payload["targetRevision"] == 2
    assert callback_payload["mediaFormat"] == "NOVEL"
    res = callback_payload["result"]
    assert res["version"] == 1
    assert res["mediaFormat"] == "NOVEL"
    assert res["htmlKey"] == req.output_storage_key
    assert res["htmlFileSizeBytes"] == len(uploaded_html_bytes)
    assert res["segmentCount"] == 2
    assert res["qa"]["passed"] is True
    assert res["qa"]["score"] == 1.0
    assert res["qa"]["issues"] == []


@pytest.mark.asyncio
async def test_materialize_novel_preserves_target_language_en():
    fixtures = _build_test_fixtures(target_language="en")
    req = fixtures["request"]

    async def mock_download(url: str) -> bytes:
        if "mat.json" in url:
            return fixtures["raw_mat_bytes"]
        if "struct.json" in url:
            return fixtures["raw_struct_bytes"]
        raise ValueError(f"Unknown download URL: {url}")

    uploaded_html_bytes: Optional[bytes] = None

    class MockAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass

        async def put(self, url, content=None, headers=None):
            nonlocal uploaded_html_bytes
            uploaded_html_bytes = content
            resp = MagicMock()
            resp.status_code = 200
            return resp

        async def post(self, url, json=None, headers=None):
            resp = MagicMock()
            resp.is_success = True
            resp.status_code = 200
            return resp

    materializer = NovelMaterializer()

    with patch("app.pipeline.novel_materializer.safe_download_bytes", side_effect=mock_download), \
         patch("app.pipeline.novel_materializer.validate_download_url"), \
         patch("httpx.AsyncClient", return_value=MockAsyncClient()):

        await materializer.materialize_novel(req)

    assert uploaded_html_bytes is not None
    html_str = uploaded_html_bytes.decode("utf-8")
    assert '<html lang="en">' in html_str
    assert "Chapter 1 <strong>Departure</strong>" in html_str


@pytest.mark.asyncio
async def test_novel_materializer_never_instantiates_segmenter(monkeypatch):
    """
    P0 Invariant: Novel materialization must NEVER instantiate NovelSegmenter.
    """
    fixtures = _build_test_fixtures(target_language="vi")
    req = fixtures["request"]

    def fail_segmenter(*args, **kwargs):
        raise AssertionError("Novel materialization must never instantiate current segmenter")

    monkeypatch.setattr(NovelSegmenter, "__init__", fail_segmenter)

    async def mock_download(url: str) -> bytes:
        if "mat.json" in url:
            return fixtures["raw_mat_bytes"]
        if "struct.json" in url:
            return fixtures["raw_struct_bytes"]
        raise ValueError(f"Unknown download URL: {url}")

    class MockAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass

        async def put(self, url, content=None, headers=None):
            resp = MagicMock()
            resp.status_code = 200
            return resp

        async def post(self, url, json=None, headers=None):
            resp = MagicMock()
            resp.is_success = True
            resp.status_code = 200
            return resp

    materializer = NovelMaterializer()

    with patch("app.pipeline.novel_materializer.safe_download_bytes", side_effect=mock_download), \
         patch("app.pipeline.novel_materializer.validate_download_url"), \
         patch("httpx.AsyncClient", return_value=MockAsyncClient()):

        result = await materializer.materialize_novel(req)
        assert result["htmlKey"] == req.output_storage_key


@pytest.mark.asyncio
async def test_rejects_materialization_snapshot_hash_mismatch():
    fixtures = _build_test_fixtures()
    req = fixtures["request"]

    async def mock_download(url: str) -> bytes:
        if "mat.json" in url:
            return b'{"corrupted": true}'
        return fixtures["raw_struct_bytes"]

    materializer = NovelMaterializer()
    with patch("app.pipeline.novel_materializer.safe_download_bytes", side_effect=mock_download):
        with pytest.raises(HTTPException) as exc:
            await materializer.materialize_novel(req)
        assert exc.value.status_code == 400
        assert "MATERIALIZATION_SNAPSHOT_HASH_MISMATCH" in exc.value.detail


@pytest.mark.asyncio
async def test_rejects_structure_snapshot_hash_mismatch():
    fixtures = _build_test_fixtures()
    req = fixtures["request"]

    async def mock_download(url: str) -> bytes:
        if "mat.json" in url:
            return fixtures["raw_mat_bytes"]
        return b'{"corrupted": true}'

    materializer = NovelMaterializer()
    with patch("app.pipeline.novel_materializer.safe_download_bytes", side_effect=mock_download):
        with pytest.raises(HTTPException) as exc:
            await materializer.materialize_novel(req)
        assert exc.value.status_code == 400
        assert "STRUCTURE_SNAPSHOT_HASH_MISMATCH" in exc.value.detail


@pytest.mark.asyncio
async def test_rejects_source_structure_fingerprint_mismatch():
    fixtures = _build_test_fixtures()
    req_dict = fixtures["request"].model_dump(by_alias=True)
    # Tamper with fingerprint
    req_dict["sourceStructureFingerprint"] = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    req = MaterializeNovelRequest.model_validate(req_dict)

    async def mock_download(url: str) -> bytes:
        if "mat.json" in url:
            return fixtures["raw_mat_bytes"]
        return fixtures["raw_struct_bytes"]

    materializer = NovelMaterializer()
    with patch("app.pipeline.novel_materializer.safe_download_bytes", side_effect=mock_download):
        with pytest.raises(HTTPException) as exc:
            await materializer.materialize_novel(req)
        assert exc.value.status_code == 400
        assert "SOURCE_STRUCTURE_FINGERPRINT_MISMATCH" in exc.value.detail


@pytest.mark.asyncio
async def test_rejects_cross_snapshot_anchor_mismatch():
    fixtures = _build_test_fixtures()
    # Modify anchor in materialization snapshot
    mat_dict = fixtures["mat_snapshot_dict"]
    mat_dict["segments"][0]["anchorBlockId"] = "blk_9999_wrong"
    raw_mat = json.dumps(mat_dict).encode("utf-8")
    mat_sha = hashlib.sha256(raw_mat).hexdigest()

    req_dict = fixtures["request"].model_dump(by_alias=True)
    req_dict["materializationSnapshotSha256"] = mat_sha
    req = MaterializeNovelRequest.model_validate(req_dict)

    async def mock_download(url: str) -> bytes:
        if "mat.json" in url:
            return raw_mat
        return fixtures["raw_struct_bytes"]

    materializer = NovelMaterializer()
    with patch("app.pipeline.novel_materializer.safe_download_bytes", side_effect=mock_download):
        with pytest.raises(HTTPException) as exc:
            await materializer.materialize_novel(req)
        assert exc.value.status_code == 400
        assert "CROSS_SNAPSHOT_ANCHOR_MISMATCH" in exc.value.detail


@pytest.mark.asyncio
async def test_fail_closed_on_unresolved_asset_mapping():
    """
    P0 #5: When snapshot has an image source that cannot be resolved -> fail closed with NOVEL_ASSET_MAPPING_UNAVAILABLE
    """
    fixtures = _build_test_fixtures()
    req_dict = fixtures["request"].model_dump(by_alias=True)
    # Empty asset mappings while document contains chapter1_cover.jpg
    req_dict["assetMappings"] = []
    req = MaterializeNovelRequest.model_validate(req_dict)

    async def mock_download(url: str) -> bytes:
        if "mat.json" in url:
            return fixtures["raw_mat_bytes"]
        return fixtures["raw_struct_bytes"]

    materializer = NovelMaterializer()
    with patch("app.pipeline.novel_materializer.safe_download_bytes", side_effect=mock_download):
        with pytest.raises(HTTPException) as exc:
            await materializer.materialize_novel(req)
        assert exc.value.status_code == 400
        assert "NOVEL_ASSET_MAPPING_UNAVAILABLE" in exc.value.detail


@pytest.mark.asyncio
async def test_fail_closed_if_structural_qa_fails():
    """
    When structural QA fails (e.g. invalid score or broken invariants), materialize_novel must fail closed.
    """
    fixtures = _build_test_fixtures()
    req = fixtures["request"]

    async def mock_download(url: str) -> bytes:
        if "mat.json" in url:
            return fixtures["raw_mat_bytes"]
        return fixtures["raw_struct_bytes"]

    mock_qa = MagicMock()
    mock_qa_result = MagicMock()
    mock_qa_result.passed = False
    mock_qa_result.score = 0.5
    mock_qa_result.issues = [MagicMock(rule_id="RULE_TEST", message="Test failure")]
    mock_qa.evaluate.return_value = mock_qa_result

    materializer = NovelMaterializer(qa_evaluator=mock_qa)
    with patch("app.pipeline.novel_materializer.safe_download_bytes", side_effect=mock_download):
        with pytest.raises(HTTPException) as exc:
            await materializer.materialize_novel(req)
        assert exc.value.status_code == 400
        assert "QA_EVALUATION_FAILED" in exc.value.detail


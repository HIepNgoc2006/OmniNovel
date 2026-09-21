"""
Novel Materializer Engine (#158).
Rebuild reviewed Novel segments into structurally verified HTML without LLMs or NovelSegmenter.
"""

import hashlib
import logging
from typing import Any, Dict, List, Optional
import httpx
from fastapi import HTTPException, status

from app.core.config import settings
from app.core.ssrf_safe_downloader import safe_download_bytes, validate_download_url
from app.models.manifests import (
    NovelResultQaIssueModel,
    NovelResultQaModel,
    NovelStructureSnapshotModel,
    normalize_novel_asset_href,
)
from app.models.materialize import (
    MaterializationSnapshotV1,
    MaterializeNovelRequest,
)
from app.novel.ast_parser import (
    CanonicalNovelDocument,
    HeadingBlockNode,
    IllustrationBlockNode,
    InlineImageNode,
    NovelBlockNode,
    NovelInlineNode,
    ParagraphBlockNode,
    BlockquoteBlockNode,
)
from app.novel.qa_evaluator import NovelStructuralQAEvaluator
from app.novel.rebuilder import NovelDocumentRebuilder
from app.novel.serializer import NovelDocumentSerializer
from app.novel.structure_snapshot import (
    extract_source_structure_fingerprint,
    snapshot_dict_to_document,
)

logger = logging.getLogger(__name__)


class NovelMaterializer:
    """
    Engine tái cấu trúc Novel từ immutable structure snapshot và reviewed segments (#158):
    - Zero LLM / Zero NovelSegmenter instantiation
    - Thẩm định toàn vẹn SHA-256 và sourceStructureFingerprint
    - Thẩm định tính đồng nhất cross-snapshot (anchors, count, blockType)
    - Giải mã protected tags với strict mode
    - Đánh giá Structural QA Invariants
    - Ánh xạ asset href canonical fail-closed
    - Xuất bản HTML chuẩn an toàn UTF-8
    - Bắn callback hoàn tất về Core API
    """

    def __init__(
        self,
        qa_evaluator: Optional[NovelStructuralQAEvaluator] = None,
        rebuilder: Optional[NovelDocumentRebuilder] = None,
    ):
        self.qa_evaluator = qa_evaluator or NovelStructuralQAEvaluator()
        self.rebuilder = rebuilder or NovelDocumentRebuilder(fallback_to_raw_on_missing=False)

    async def materialize_novel(self, request: MaterializeNovelRequest) -> Dict[str, Any]:
        """
        Thực hiện toàn bộ quy trình materialize Novel:
        1. Tải & verify SHA-256 của Materialization Snapshot và Structure Snapshot
        2. Thẩm định Snapshot Invariants & Cross-Snapshot Parity
        3. Khôi phục source document và verify cryptographic structural fingerprint
        4. Rebuild translated document độc lập hoàn toàn (không dùng NovelSegmenter)
        5. Thẩm định chất lượng qua NovelStructuralQAEvaluator
        6. Ánh xạ assets canonical fail-closed
        7. Serialize ra HTML5 an toàn UTF-8
        8. Upload HTML lên MinIO qua HTTP PUT
        9. Bắn completion callback về Core API
        """
        logger.info(
            f"[NovelMaterializer] Bắt đầu materialize job {request.job_id} rev {request.target_revision}"
        )

        # 1. Tải cả 2 snapshots qua SSRF-safe downloader
        raw_mat = await safe_download_bytes(request.materialization_snapshot_url)
        raw_struct = await safe_download_bytes(request.structure_snapshot_url)

        # 2. Verify Content-Addressed SHA-256 trên downloaded bytes trước khi parse
        actual_mat_sha = hashlib.sha256(raw_mat).hexdigest()
        if actual_mat_sha != request.materialization_snapshot_sha256:
            logger.error(
                f"[NovelMaterializer] Materialization snapshot SHA-256 mismatch: "
                f"expected {request.materialization_snapshot_sha256}, actual {actual_mat_sha}"
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"MATERIALIZATION_SNAPSHOT_HASH_MISMATCH: expected {request.materialization_snapshot_sha256}, got {actual_mat_sha}",
            )

        actual_struct_sha = hashlib.sha256(raw_struct).hexdigest()
        if actual_struct_sha != request.structure_snapshot_sha256:
            logger.error(
                f"[NovelMaterializer] Structure snapshot SHA-256 mismatch: "
                f"expected {request.structure_snapshot_sha256}, actual {actual_struct_sha}"
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"STRUCTURE_SNAPSHOT_HASH_MISMATCH: expected {request.structure_snapshot_sha256}, got {actual_struct_sha}",
            )

        # 3. Parse và validate Pydantic models
        try:
            mat_snapshot = MaterializationSnapshotV1.model_validate_json(raw_mat)
        except Exception as e:
            logger.error(f"[NovelMaterializer] Lỗi parse MaterializationSnapshotV1: {e}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"INVALID_MATERIALIZATION_SNAPSHOT_PAYLOAD: {str(e)}",
            )

        try:
            struct_snapshot = NovelStructureSnapshotModel.model_validate_json(raw_struct)
        except Exception as e:
            logger.error(f"[NovelMaterializer] Lỗi parse NovelStructureSnapshotModel: {e}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"INVALID_STRUCTURE_SNAPSHOT_PAYLOAD: {str(e)}",
            )

        # 4. Thẩm định Snapshot Metadata Invariants
        if (
            mat_snapshot.jobId != request.job_id
            or mat_snapshot.targetRevision != request.target_revision
            or mat_snapshot.mediaFormat != "NOVEL"
        ):
            logger.error(
                f"[NovelMaterializer] Materialization snapshot invariants mismatch cho job {request.job_id}"
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="MATERIALIZATION_SNAPSHOT_INVARIANT_MISMATCH: snapshot metadata does not match request",
            )

        # 5. Khôi phục source document và xác thực cryptographic structural fingerprint
        source_doc = snapshot_dict_to_document(struct_snapshot.document.model_dump(by_alias=True))
        computed_fp = extract_source_structure_fingerprint(source_doc)

        if computed_fp != request.source_structure_fingerprint:
            logger.error(
                f"[NovelMaterializer] Fingerprint mismatch: "
                f"computed '{computed_fp}' != request '{request.source_structure_fingerprint}'"
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"SOURCE_STRUCTURE_FINGERPRINT_MISMATCH: computed '{computed_fp}' does not match request '{request.source_structure_fingerprint}'",
            )

        if computed_fp != struct_snapshot.sourceStructureFingerprint:
            logger.error(
                f"[NovelMaterializer] Fingerprint mismatch: "
                f"computed '{computed_fp}' != snapshot '{struct_snapshot.sourceStructureFingerprint}'"
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"SNAPSHOT_STRUCTURE_FINGERPRINT_MISMATCH: computed '{computed_fp}' does not match snapshot '{struct_snapshot.sourceStructureFingerprint}'",
            )

        # 6. Cross-snapshot parity verification (Exact set equality, cardinality, blockType)
        struct_anchor_ids = [s.anchorBlockId for s in struct_snapshot.segments]
        mat_anchor_ids = [s.anchorBlockId for s in mat_snapshot.segments]

        if set(struct_anchor_ids) != set(mat_anchor_ids):
            missing_in_mat = set(struct_anchor_ids) - set(mat_anchor_ids)
            extra_in_mat = set(mat_anchor_ids) - set(struct_anchor_ids)
            logger.error(
                f"[NovelMaterializer] Cross-snapshot anchor mismatch. "
                f"Missing in materialization: {missing_in_mat}, Extra in materialization: {extra_in_mat}"
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"CROSS_SNAPSHOT_ANCHOR_MISMATCH: missing={missing_in_mat}, extra={extra_in_mat}",
            )

        if len(struct_snapshot.segments) != len(mat_snapshot.segments):
            logger.error(
                f"[NovelMaterializer] Cross-snapshot cardinality mismatch: "
                f"{len(struct_snapshot.segments)} != {len(mat_snapshot.segments)}"
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"CROSS_SNAPSHOT_CARDINALITY_MISMATCH: struct={len(struct_snapshot.segments)} != mat={len(mat_snapshot.segments)}",
            )

        struct_type_by_anchor = {
            s.anchorBlockId: (s.blockType.value if hasattr(s.blockType, "value") else str(s.blockType))
            for s in struct_snapshot.segments
        }
        for seg in mat_snapshot.segments:
            seg_type = seg.blockType.value if hasattr(seg.blockType, "value") else str(seg.blockType)
            expected_type = struct_type_by_anchor.get(seg.anchorBlockId)
            if seg_type != expected_type:
                logger.error(
                    f"[NovelMaterializer] Block type mismatch for {seg.anchorBlockId}: "
                    f"expected {expected_type}, got {seg_type}"
                )
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"CROSS_SNAPSHOT_BLOCK_TYPE_MISMATCH for anchor '{seg.anchorBlockId}': expected '{expected_type}', got '{seg_type}'",
                )

        # 7. Tái cấu trúc document qua NovelDocumentRebuilder (độc lập 100% với NovelSegmenter)
        translated_blocks_map = {
            seg.anchorBlockId: seg.translatedText for seg in mat_snapshot.segments
        }

        try:
            translated_doc: CanonicalNovelDocument = self.rebuilder.rebuild_from_snapshot(
                snapshot=struct_snapshot,
                translated_blocks=translated_blocks_map,
                translated_title=request.title,
                target_language=request.target_language,
            )
        except Exception as e:
            logger.error(f"[NovelMaterializer] Rebuild from snapshot thất bại: {e}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"REBUILD_FROM_SNAPSHOT_FAILED: {str(e)}",
            )

        # 8. Thẩm định chất lượng cấu trúc AST qua NovelStructuralQAEvaluator
        qa_result = self.qa_evaluator.evaluate(source_doc, translated_doc)
        logger.info(
            f"[NovelMaterializer] QA Evaluation: score={qa_result.score}, "
            f"passed={qa_result.passed}, issues={len(qa_result.issues)}"
        )

        if not qa_result.passed:
            logger.error(
                f"[NovelMaterializer] QA evaluation failed for job {request.job_id}: "
                f"{[(i.rule_id, i.message) for i in qa_result.issues]}"
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"QA_EVALUATION_FAILED: score={qa_result.score}, issues={len(qa_result.issues)}",
            )

        # 9. Ánh xạ assets canonical & kiểm tra fail-closed (P0 #5)
        asset_map: Dict[str, str] = {}
        for m in request.asset_mappings:
            norm_href = normalize_novel_asset_href(m.source_href)
            asset_map[norm_href] = m.storage_key
            asset_map[m.source_href] = m.storage_key

        # Quét mọi hình ảnh trong translated_doc để đảm bảo có mapping
        self._validate_all_assets_present(translated_doc, asset_map)

        # 10. Serialize sang HTML5 chuẩn an toàn UTF-8
        serialized_html = NovelDocumentSerializer.serialize_to_html(
            translated_doc,
            include_html_wrapper=True,
            asset_map=asset_map,
        )
        html_bytes = serialized_html.encode("utf-8")

        # 11. Upload HTML lên MinIO qua HTTP PUT
        validate_download_url(request.output_upload_url)
        transport_limits = httpx.Timeout(connect=5.0, read=30.0, write=30.0, pool=5.0)

        async with httpx.AsyncClient(timeout=transport_limits, follow_redirects=False) as http_client:
            upload_resp = await http_client.put(
                request.output_upload_url,
                content=html_bytes,
                headers={"Content-Type": "text/html; charset=utf-8"},
            )
            if upload_resp.status_code not in (200, 204):
                logger.error(
                    f"[NovelMaterializer] Upload HTML thất bại với HTTP {upload_resp.status_code}"
                )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"Upload output HTML artifact thất bại: HTTP {upload_resp.status_code}",
                )

            # 12. Gửi Completion Callback về Core API
            qa_payload = NovelResultQaModel(
                passed=qa_result.passed,
                score=qa_result.score,
                fingerprintMatch=qa_result.fingerprint_match,
                issuesCount=len(qa_result.issues),
                issues=[
                    NovelResultQaIssueModel(
                        severity=i.severity.value,
                        ruleId=i.rule_id,
                        message=i.message,
                    )
                    for i in qa_result.issues
                ],
            )

            segment_count = len(mat_snapshot.segments)
            char_count = sum(len(s.translatedText) for s in mat_snapshot.segments)

            callback_url = (
                f"{settings.CORE_API_INTERNAL_URL}"
                f"/internal/v1/ai/jobs/{request.job_id}/materializations/complete"
            )
            callback_payload = {
                "targetRevision": request.target_revision,
                "mediaFormat": "NOVEL",
                "result": {
                    "version": 1,
                    "mediaFormat": "NOVEL",
                    "htmlKey": request.output_storage_key,
                    "htmlFileSizeBytes": len(html_bytes),
                    "segmentCount": segment_count,
                    "charCount": char_count,
                    "qa": qa_payload.model_dump(by_alias=True),
                },
            }

            cb_resp = await http_client.post(
                callback_url,
                json=callback_payload,
                headers={
                    "Content-Type": "application/json",
                    "X-Internal-Service-Key": settings.AI_WORKER_SECRET,
                },
            )
            if not cb_resp.is_success:
                logger.error(
                    f"[NovelMaterializer] Callback Core API thất bại với HTTP {cb_resp.status_code}: {cb_resp.text}"
                )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"Callback Core API thất bại với HTTP {cb_resp.status_code}: {cb_resp.text}",
                )

        logger.info(
            f"[NovelMaterializer] Materialization Novel hoàn tất thành công cho job {request.job_id} rev {request.target_revision}"
        )

        return {
            "htmlKey": request.output_storage_key,
            "htmlFileSizeBytes": len(html_bytes),
            "segmentCount": segment_count,
            "charCount": char_count,
        }

    def _validate_all_assets_present(
        self, doc: CanonicalNovelDocument, asset_map: Dict[str, str]
    ) -> None:
        """
        Quét duyệt toàn bộ cây AST để đảm bảo mọi ảnh đều có thể giải quyết được mapping (P0 #5).
        Nếu không giải quyết được -> raise NOVEL_ASSET_MAPPING_UNAVAILABLE.
        """
        for block in doc.blocks:
            self._check_block_assets(block, asset_map)

    def _check_block_assets(
        self, block: NovelBlockNode, asset_map: Dict[str, str]
    ) -> None:
        if isinstance(block, IllustrationBlockNode):
            norm = normalize_novel_asset_href(block.src)
            if norm not in asset_map and block.src not in asset_map:
                logger.error(
                    f"[NovelMaterializer] Không tìm thấy mapping cho illustration asset '{block.src}'"
                )
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"NOVEL_ASSET_MAPPING_UNAVAILABLE: Illustration image asset '{block.src}' could not be resolved from assetMappings",
                )
        elif isinstance(block, (HeadingBlockNode, ParagraphBlockNode)):
            for child in block.children:
                self._check_inline_assets(child, asset_map)
        elif isinstance(block, BlockquoteBlockNode):
            for child_block in block.children:
                self._check_block_assets(child_block, asset_map)

    def _check_inline_assets(
        self, node: NovelInlineNode, asset_map: Dict[str, str]
    ) -> None:
        if isinstance(node, InlineImageNode):
            norm = normalize_novel_asset_href(node.src)
            if norm not in asset_map and node.src not in asset_map:
                logger.error(
                    f"[NovelMaterializer] Không tìm thấy mapping cho inline image asset '{node.src}'"
                )
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"NOVEL_ASSET_MAPPING_UNAVAILABLE: Inline image asset '{node.src}' could not be resolved from assetMappings",
                )
        elif hasattr(node, "children"):
            for sub in getattr(node, "children", []):
                self._check_inline_assets(sub, asset_map)

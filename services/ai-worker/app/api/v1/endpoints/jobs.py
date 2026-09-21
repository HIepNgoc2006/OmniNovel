import os
import uuid
from typing import Optional, Dict, Any, List, Union
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
import httpx
from app.core.security import verify_internal_key
from app.core.config import settings
from app.models.manifests import (
    MangaCleanBasePageModel,
    MangaResultManifestV1,
    MangaResultPageModel,
    MangaReviewSourceManifestV1,
    MangaReviewSourcePageModel,
    NovelResultManifestV1,
    NovelResultQaModel,
    NovelBlockType,
    TranslationInputManifestV1,
)
from app.models.materialize import MaterializeMangaRequest
from app.pipeline.manga_re_renderer import MangaReRenderer

router = APIRouter()

# 1x1 Lossless Valid WebP image bytes with valid RIFF/WEBP/VP8L magic headers
VALID_MOCK_WEBP_BYTES = bytes([
    0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00,
    0x00, 0x07, 0x00, 0x00, 0x00, 0x00,
])

class ProcessJobRequest(BaseModel):
    jobId: str
    attemptNumber: int
    outputPrefix: Optional[str] = None
    sourceDownloadUrl: Optional[str] = None
    sourceLang: Optional[str] = "ja"
    targetLang: Optional[str] = "vi"
    inputManifest: Optional[TranslationInputManifestV1] = None

class HealthResponse(BaseModel):
    status: str
    service: str

@router.get("/health", response_model=HealthResponse)
async def health_check():
    return HealthResponse(status="healthy", service="omninovel-ai-worker")

async def request_output_upload_urls(
    job_id: str,
    attempt_number: int,
    filenames_or_specs: List[Union[str, Dict[str, str]]],
) -> List[Dict[str, Any]]:
    """
    Giai đoạn 2 của Two-Step Upload: Xin Core API cấp Presigned PUT URLs cho các file output (Manga & Novel).
    Fail-fast: Ném HTTPException(502) nếu Core API trả lỗi hoặc không cấp được URLs.
    """
    url = f"{settings.CORE_API_INTERNAL_URL}/internal/v1/ai/jobs/{job_id}/output-uploads"
    normalized_files = []
    for item in filenames_or_specs:
        if isinstance(item, dict):
            normalized_files.append({
                "filename": item["filename"],
                "contentType": item.get("contentType", "application/octet-stream"),
            })
        else:
            normalized_files.append({
                "filename": str(item),
                "contentType": "image/webp",
            })

    payload = {
        "attemptNumber": attempt_number,
        "files": normalized_files,
    }
    headers = {
        "Content-Type": "application/json",
        "X-Internal-Service-Key": settings.AI_WORKER_SECRET,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code in (200, 201):
                data = resp.json()
                files = data.get("files", [])
                if not files:
                    raise HTTPException(status_code=502, detail="Core API returned empty files list")
                return files
            else:
                raise HTTPException(
                    status_code=502,
                    detail=f"Core API request output uploads failed with status {resp.status_code}: {resp.text}"
                )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to connect to Core API for output upload URLs: {e}")

async def request_clean_base_upload_urls(
    job_id: str,
    attempt_number: int,
    pages: List[int],
) -> List[Dict[str, Any]]:
    """
    Xin Core API cấp Presigned PUT URLs cho các file Manga clean bases (#162).
    Path: /internal/v1/ai/jobs/{job_id}/clean-base-uploads
    Payload: {"attemptNumber": attempt_number, "pages": pages}
    Fail-fast: Ném HTTPException(502) nếu Core API trả lỗi hoặc không cấp được URLs.
    """
    url = f"{settings.CORE_API_INTERNAL_URL}/internal/v1/ai/jobs/{job_id}/clean-base-uploads"
    payload = {
        "attemptNumber": attempt_number,
        "pages": pages,
    }
    headers = {
        "Content-Type": "application/json",
        "X-Internal-Service-Key": settings.AI_WORKER_SECRET,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code in (200, 201):
                data = resp.json()
                clean_bases = data.get("cleanBases", [])
                if not clean_bases:
                    raise HTTPException(status_code=502, detail="Core API returned empty cleanBases list")
                return clean_bases
            else:
                raise HTTPException(
                    status_code=502,
                    detail=f"Core API request clean base uploads failed with status {resp.status_code}: {resp.text}"
                )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to connect to Core API for clean base upload URLs: {e}")

async def request_source_review_upload_urls(
    job_id: str,
    attempt_number: int,
    pages: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Xin Core API cấp Presigned PUT URLs cho Manga source review previews (#159).
    Path: /internal/v1/ai/jobs/{job_id}/source-review-slots
    Payload: {"attemptNumber": attempt_number, "pages": pages}
    Fail-fast: Ném HTTPException(502) nếu Core API trả lỗi hoặc không cấp được URLs.
    """
    url = f"{settings.CORE_API_INTERNAL_URL}/internal/v1/ai/jobs/{job_id}/source-review-slots"
    payload = {
        "attemptNumber": attempt_number,
        "pages": pages,
    }
    headers = {
        "Content-Type": "application/json",
        "X-Internal-Service-Key": settings.AI_WORKER_SECRET,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code in (200, 201):
                data = resp.json()
                source_pages = data.get("sourcePages", [])
                if not source_pages:
                    raise HTTPException(status_code=502, detail="Core API returned empty sourcePages list")
                return source_pages
            else:
                raise HTTPException(
                    status_code=502,
                    detail=f"Core API request source review upload slots failed with status {resp.status_code}: {resp.text}"
                )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to connect to Core API for source review upload URLs: {e}")

async def request_structure_snapshot_upload_url(
    job_id: str,
    attempt_number: int,
    sha256: str,
) -> Dict[str, Any]:
    """
    Xin Core API cấp Presigned PUT URL cho Novel structure snapshot (#163).
    Path: /internal/v1/ai/jobs/{job_id}/structure-snapshot-upload
    Payload: {"attemptNumber": attempt_number, "sha256": sha256}
    Fail-fast: Ném HTTPException(502) nếu Core API trả lỗi hoặc không cấp được URL.
    """
    url = f"{settings.CORE_API_INTERNAL_URL}/internal/v1/ai/jobs/{job_id}/structure-snapshot-upload"
    payload = {
        "attemptNumber": attempt_number,
        "sha256": sha256,
    }
    headers = {
        "Content-Type": "application/json",
        "X-Internal-Service-Key": settings.AI_WORKER_SECRET,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code in (200, 201):
                data = resp.json()
                if not data.get("uploadUrl") or not data.get("storageKey"):
                    raise HTTPException(
                        status_code=502,
                        detail="Core API returned incomplete structure snapshot upload slot",
                    )
                return data
            else:
                raise HTTPException(
                    status_code=502,
                    detail=f"Core API request structure snapshot upload failed with status {resp.status_code}: {resp.text}",
                )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to connect to Core API for structure snapshot upload URL: {e}",
        )

async def upload_file_to_presigned_url(
    upload_url: str,
    data: bytes,
    content_type: str = "image/webp",
    extra_headers: Optional[Dict[str, str]] = None,
) -> None:
    """
    Upload buffer ảnh hoặc JSON lên MinIO qua Presigned PUT URL.
    Fail-fast: Ném HTTPException(502) nếu upload thất bại.
    """
    headers = {"Content-Type": content_type}
    if extra_headers:
        headers.update(extra_headers)
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.put(upload_url, content=data, headers=headers)
            if resp.status_code not in (200, 201):
                raise HTTPException(
                    status_code=502,
                    detail=f"MinIO presigned PUT failed with status {resp.status_code}: {resp.text}"
                )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to PUT file to MinIO presigned URL: {e}")

async def send_callback_event(
    job_id: str,
    attempt_number: int,
    sequence: int,
    stage: str,
    progress: int,
    result_manifest: Optional[Union[MangaResultManifestV1, NovelResultManifestV1]] = None,
    segments: Optional[List[Dict[str, Any]]] = None,
) -> None:
    """
    Gửi Fenced Callback event lên Core API.
    Fail-fast: Ném HTTPException(502) nếu Core API từ chối hoặc trả non-2xx.
    """
    callback_url = f"{settings.CORE_API_INTERNAL_URL}/internal/v1/ai/jobs/{job_id}/events"
    manifest_payload = (
        result_manifest.model_dump(mode="json", exclude_none=True, by_alias=True)
        if result_manifest is not None
        else None
    )
    payload = {
        "eventId": str(uuid.uuid4()),
        "attemptNumber": attempt_number,
        "sequence": sequence,
        "stage": stage,
        "progress": progress,
        "heartbeat": True,
        "resultManifest": manifest_payload,
        "segments": segments if segments is not None else [],
    }
    headers = {
        "Content-Type": "application/json",
        "X-Internal-Service-Key": settings.AI_WORKER_SECRET,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(callback_url, json=payload, headers=headers)
            if resp.status_code not in (200, 201):
                raise HTTPException(
                    status_code=502,
                    detail=f"Core API callback event for stage {stage} (seq {sequence}) failed with status {resp.status_code}: {resp.text}"
                )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to send callback event to Core API: {e}")

@router.post("/process-manga", dependencies=[Depends(verify_internal_key)])
async def process_manga_job(req: ProcessJobRequest):
    """
    Pipeline cho Manga Translation (Fail-Fast Production Engine):
    - Khóa ranh giới: AI_WORKER_TEST_MODE chỉ hợp lệ khi ENV=test.
    - Ở production: Bắt buộc sourceDownloadUrl, tuyệt đối không chạy fallback mock.
    - Ở test environment (ENV=test): Cho phép mock fallback khi sourceDownloadUrl=None phục vụ unit testing endpoint.
    """
    is_test_env = (settings.ENV == "test") or (os.environ.get("ENV") == "test")
    is_test_mode = settings.AI_WORKER_TEST_MODE or (os.environ.get("AI_WORKER_TEST_MODE") == "true")

    # Invariant P0: Chặn test mode rò rỉ ra production
    if is_test_mode and not is_test_env:
        raise HTTPException(
            status_code=500,
            detail="AI_WORKER_TEST_MODE is strictly forbidden outside ENV=test",
        )

    job_id = req.jobId
    attempt_num = req.attemptNumber

    # Invariant P0: Production bắt buộc phải có sourceDownloadUrl
    if not req.sourceDownloadUrl:
        if not is_test_env:
            raise HTTPException(
                status_code=400,
                detail="sourceDownloadUrl is required in production environment",
            )
    else:
        # Thực thi FullMangaPipeline thật
        from app.pipeline.attempt_coordinator import AttemptProgressCoordinator
        from app.pipeline.full_manga_pipeline import FullMangaPipeline
        from app.pipeline.progress_sink import CoreCallbackProgressSink
        from app.translation.manga_translator import MangaTranslationPipeline
        from app.translation.providers.mock_provider import MockTranslationProvider

        sink = CoreCallbackProgressSink(job_id=job_id, attempt_number=attempt_num)
        coordinator = AttemptProgressCoordinator(sink=sink)

        if is_test_mode and is_test_env:
            trans_pipe = MangaTranslationPipeline(provider=MockTranslationProvider())
        else:
            trans_pipe = MangaTranslationPipeline()

        pipeline = FullMangaPipeline(
            coordinator=coordinator,
            translation_pipeline=trans_pipe,
            upload_urls_requester=request_output_upload_urls,
            clean_base_urls_requester=request_clean_base_upload_urls,
            source_review_urls_requester=request_source_review_upload_urls,
            uploader_func=upload_file_to_presigned_url,
        )

        try:
            return await pipeline.execute(
                job_id=job_id,
                attempt_number=attempt_num,
                source_download_url=req.sourceDownloadUrl,
                input_manifest=req.inputManifest,
            )
        except Exception as e:
            # Dừng coordinator và ném 502 Fail-Fast
            await coordinator.stop()
            raise HTTPException(
                status_code=502,
                detail=f"Full Manga Pipeline execution failed: {str(e)}"
            ) from e

    # Fallback cho mock isolation trong ENV=test (legacy endpoint tests)
    uploaded_files = await request_output_upload_urls(job_id, attempt_num, ["page-001.webp"])
    clean_base_slots = await request_clean_base_upload_urls(job_id, attempt_num, [1])
    source_review_slots = await request_source_review_upload_urls(
        job_id, attempt_num, [{"pageNumber": 1, "mimeType": "image/webp"}]
    )
    manifest_pages = []
    clean_bases_manifest = []
    source_reviews_manifest = []

    for idx, f in enumerate(uploaded_files, start=1):
        await upload_file_to_presigned_url(f["uploadUrl"], VALID_MOCK_WEBP_BYTES, "image/webp")
        manifest_pages.append(
            MangaResultPageModel(
                page=idx,
                storageKey=f["storageKey"],
                previewKey=f["storageKey"],
                width=1200,
                height=1800,
                fileSizeBytes=len(VALID_MOCK_WEBP_BYTES),
            )
        )

    for cb in clean_base_slots:
        await upload_file_to_presigned_url(cb["uploadUrl"], VALID_MOCK_WEBP_BYTES, "image/webp")
        clean_bases_manifest.append(
            MangaCleanBasePageModel(
                page=cb["page"],
                cleanBaseKey=cb["storageKey"],
            )
        )

    for s in source_review_slots:
        await upload_file_to_presigned_url(s["uploadUrl"], VALID_MOCK_WEBP_BYTES, "image/webp")
        source_reviews_manifest.append(
            MangaReviewSourcePageModel(
                page=s["pageNumber"],
                storageKey=s["storageKey"],
                width=1200,
                height=1800,
            )
        )

    stages = [
        ("PREPROCESSING", 10),
        ("OCR", 30),
        ("TRANSLATING", 50),
        ("INPAINTING", 70),
        ("TYPESETTING", 85),
        ("QUALITY_CHECK", 95),
    ]

    seq = 1
    for stage_name, prog in stages:
        await send_callback_event(job_id, attempt_num, seq, stage_name, prog, segments=[])
        seq += 1

    result_manifest = MangaResultManifestV1(
        version=1,
        mediaFormat="COMIC",
        pages=manifest_pages,
        cleanBases=clean_bases_manifest,
        sourceReview=MangaReviewSourceManifestV1(
            version=1,
            pages=source_reviews_manifest,
        ),
    )
    segments = [
        {
            "pageNumber": 1,
            "sortOrder": 1,
            "bboxX": 150,
            "bboxY": 200,
            "bboxW": 300,
            "bboxH": 120,
            "rawText": "オレは海賊王になる男だ！",
            "translatedText": "Tôi là người sẽ trở thành Vua Hải Tặc!",
            "confidence": 0.98,
        },
    ]

    await send_callback_event(
        job_id,
        attempt_num,
        seq,
        "READY_FOR_REVIEW",
        100,
        result_manifest=result_manifest,
        segments=segments,
    )

    return {
        "success": True,
        "jobId": job_id,
        "attemptNumber": attempt_num,
        "status": "READY_FOR_REVIEW",
        "pagesProcessed": len(manifest_pages),
    }

@router.post("/process-novel", dependencies=[Depends(verify_internal_key)])
async def process_novel_job(req: ProcessJobRequest):
    """
    Pipeline cho Light Novel Translation (Full Novel Orchestrator):
    - PREPROCESSING -> TRANSLATING -> QUALITY_CHECK -> READY_FOR_REVIEW
    - Khóa ranh giới: AI_WORKER_TEST_MODE chỉ hợp lệ khi ENV=test.
    - Ở production: Bắt buộc sourceDownloadUrl, tuyệt đối không chạy fallback mock.
    - Sử dụng phiên bản prompt chuẩn: novel-ja-vi-v2
    """
    is_test_env = (settings.ENV == "test") or (os.environ.get("ENV") == "test")
    is_test_mode = settings.AI_WORKER_TEST_MODE or (os.environ.get("AI_WORKER_TEST_MODE") == "true")

    if is_test_mode and not is_test_env:
        raise HTTPException(
            status_code=500,
            detail="AI_WORKER_TEST_MODE is strictly forbidden outside ENV=test",
        )

    job_id = req.jobId
    attempt_num = req.attemptNumber

    if not req.sourceDownloadUrl:
        if not is_test_env:
            raise HTTPException(
                status_code=400,
                detail="sourceDownloadUrl is required in production environment",
            )
    else:
        # Thực thi FullNovelPipeline thật
        from app.novel.full_novel_pipeline import FullNovelPipeline
        from app.pipeline.attempt_coordinator import AttemptProgressCoordinator
        from app.pipeline.progress_sink import CoreCallbackProgressSink
        from app.translation.providers.mock_provider import MockTranslationProvider
        from app.translation.providers.openai_provider import OpenAICompatibleTranslationProvider

        sink = CoreCallbackProgressSink(job_id=job_id, attempt_number=attempt_num)
        coordinator = AttemptProgressCoordinator(sink=sink)

        if is_test_mode and is_test_env:
            provider = MockTranslationProvider()
        else:
            provider = OpenAICompatibleTranslationProvider()

        pipeline = FullNovelPipeline(
            coordinator=coordinator,
            translation_provider=provider,
            request_upload_urls_func=request_output_upload_urls,
            upload_file_func=upload_file_to_presigned_url,
            request_structure_snapshot_upload_func=request_structure_snapshot_upload_url,
            prompt_version="novel-ja-vi-v2",
        )

        try:
            glossary_entries = (
                [
                    {
                        "sourceTerm": x.sourceTerm,
                        "targetTerm": x.targetTerm,
                        "category": x.category,
                    }
                    for x in req.inputManifest.glossarySnapshot
                ]
                if req.inputManifest and req.inputManifest.glossarySnapshot
                else []
            )
            return await pipeline.execute(
                job_id=job_id,
                attempt_number=attempt_num,
                source_download_url=req.sourceDownloadUrl,
                input_manifest=req.inputManifest,
                glossary_entries=glossary_entries,
            )
        except Exception as e:
            await coordinator.stop()
            raise HTTPException(
                status_code=502,
                detail=f"Full Novel Pipeline execution failed: {str(e)}"
            ) from e

    # Fallback cho mock isolation trong ENV=test (legacy endpoint tests)
    stages = [
        ("PREPROCESSING", 15),
        ("TRANSLATING", 50),
        ("QUALITY_CHECK", 90),
    ]

    seq = 1
    for stage_name, prog in stages:
        await send_callback_event(job_id, attempt_num, seq, stage_name, prog)
        seq += 1

    trans_text = "Ngày hôm đó, nhân loại đã nhớ lại. Nỗi sợ hãi khi bị thống trị bởi chúng."
    segments = [
        {
            "sortOrder": 1,
            "anchorBlockId": "blk_0001_p",
            "blockType": NovelBlockType.NARRATION,
            "rawText": "その日、人類は思い出した。ヤツらに支配されていた恐怖を。",
            "translatedText": trans_text,
            "confidence": 0.99,
        }
    ]

    result_manifest = NovelResultManifestV1(
        version=1,
        mediaFormat="NOVEL",
        htmlKey=f"chapters/{job_id}/novel_translated.html",
        segmentCount=len(segments),
        charCount=len(trans_text),
        htmlFileSizeBytes=20480,
        qa=NovelResultQaModel(
            passed=True,
            score=1.0,
            fingerprintMatch=True,
            issuesCount=0,
        ),
    )

    await send_callback_event(
        job_id,
        attempt_num,
        seq,
        "READY_FOR_REVIEW",
        100,
        result_manifest=result_manifest,
        segments=segments,
    )

    return {
        "success": True,
        "jobId": job_id,
        "attemptNumber": attempt_num,
        "status": "READY_FOR_REVIEW",
        "segmentsCount": len(segments),
    }


def get_manga_re_renderer() -> MangaReRenderer:
    return MangaReRenderer()


@router.post(
    "/materialize-manga",
    dependencies=[Depends(verify_internal_key)],
    status_code=status.HTTP_200_OK,
)
async def materialize_manga(
    request: MaterializeMangaRequest,
    renderer: MangaReRenderer = Depends(get_manga_re_renderer),
):
    await renderer.re_render_manga(request)
    return {
        "status": "COMPLETED",
        "jobId": request.job_id,
        "targetRevision": request.target_revision,
    }



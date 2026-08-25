import uuid
from typing import Optional, Dict, Any, List
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
import httpx
from app.core.security import verify_internal_key
from app.core.config import settings

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
    outputPrefix: str
    sourceDownloadUrl: Optional[str] = None
    sourceLang: Optional[str] = "ja"
    targetLang: Optional[str] = "vi"

class HealthResponse(BaseModel):
    status: str
    service: str

@router.get("/health", response_model=HealthResponse)
async def health_check():
    return HealthResponse(status="healthy", service="omninovel-ai-worker")

async def request_output_upload_urls(job_id: str, attempt_number: int, filenames: List[str]) -> List[Dict[str, Any]]:
    """
    Giai đoạn 2 của Two-Step Upload: Xin Core API cấp Presigned PUT URLs cho các trang đã phân tích
    """
    url = f"{settings.CORE_API_INTERNAL_URL}/internal/v1/ai/jobs/{job_id}/output-uploads"
    payload = {
        "attemptNumber": attempt_number,
        "files": [{"filename": fn, "contentType": "image/webp"} for fn in filenames],
    }
    headers = {
        "Content-Type": "application/json",
        "X-Internal-Service-Key": settings.AI_WORKER_SECRET,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                return data.get("files", [])
    except Exception as e:
        print(f"[AI-Worker Error] Failed to request output upload URLs from Core API: {e}")
    return []

async def upload_file_to_presigned_url(upload_url: str, data: bytes, content_type: str = "image/webp") -> bool:
    """
    Upload buffer ảnh thật lên MinIO qua Presigned PUT URL
    """
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.put(upload_url, content=data, headers={"Content-Type": content_type})
            return resp.status_code == 200
    except Exception as e:
        print(f"[AI-Worker Error] Failed to PUT file to MinIO presigned URL: {e}")
        return False

async def send_callback_event(
    job_id: str,
    attempt_number: int,
    sequence: int,
    stage: str,
    progress: int,
    result_manifest: Optional[Dict[str, Any]] = None,
    segments: Optional[List[Dict[str, Any]]] = None,
) -> bool:
    callback_url = f"{settings.CORE_API_INTERNAL_URL}/internal/v1/ai/jobs/{job_id}/events"
    payload = {
        "eventId": str(uuid.uuid4()),
        "attemptNumber": attempt_number,
        "sequence": sequence,
        "stage": stage,
        "progress": progress,
        "heartbeat": True,
        "resultManifest": result_manifest,
        "segments": segments or [],
    }
    headers = {
        "Content-Type": "application/json",
        "X-Internal-Service-Key": settings.AI_WORKER_SECRET,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(callback_url, json=payload, headers=headers)
            return resp.status_code == 200
    except Exception as e:
        print(f"[AI-Worker Callback Error] Failed to send event to Core API: {e}")
        return False

@router.post("/process-manga", dependencies=[Depends(verify_internal_key)])
async def process_manga_job(req: ProcessJobRequest):
    """
    Pipeline cho Manga Translation:
    1. Xin Presigned PUT URL qua two-step protocol
    2. Upload WebP buffer thật lên MinIO
    3. Gửi chuỗi callback hợp lệ: PREPROCESSING -> OCR -> TRANSLATING -> INPAINTING -> TYPESETTING -> QUALITY_CHECK -> READY_FOR_REVIEW
    """
    job_id = req.jobId
    attempt_num = req.attemptNumber

    # 1. Xin Presigned PUT URL từ Core API cho trang đầu tiên
    uploaded_files = await request_output_upload_urls(job_id, attempt_num, ["page-001.webp"])
    manifest_pages = []

    if uploaded_files:
        for idx, f in enumerate(uploaded_files, start=1):
            put_success = await upload_file_to_presigned_url(f["uploadUrl"], VALID_MOCK_WEBP_BYTES, "image/webp")
            if put_success:
                manifest_pages.append({
                    "page": idx,
                    "storageKey": f["storageKey"],
                    "previewKey": f["storageKey"],
                    "width": 1200,
                    "height": 1800,
                    "fileSize": len(VALID_MOCK_WEBP_BYTES),
                })

    # Nếu không kết nối được Core API để xin Presigned URL (chế độ mock độc lập)
    if not manifest_pages:
        manifest_pages.append({
            "page": 1,
            "storageKey": f"ai/jobs/{job_id}/attempt-{attempt_num}/page-001.webp",
            "previewKey": f"ai/jobs/{job_id}/attempt-{attempt_num}/page-001.webp",
            "width": 1200,
            "height": 1800,
            "fileSize": 154200,
        })

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
        await send_callback_event(job_id, attempt_num, seq, stage_name, prog)
        seq += 1

    # Stage cuối cùng: READY_FOR_REVIEW với result_manifest và segments
    result_manifest = {
        "pages": manifest_pages,
    }
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
        {
            "pageNumber": 1,
            "sortOrder": 2,
            "bboxX": 500,
            "bboxY": 600,
            "bboxW": 250,
            "bboxH": 90,
            "rawText": "行くぞ、野郎ども！",
            "translatedText": "Đi thôi, các anh em!",
            "confidence": 0.96,
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
    Pipeline cho Light Novel Translation:
    PREPROCESSING -> TRANSLATING -> QUALITY_CHECK -> READY_FOR_REVIEW
    """
    job_id = req.jobId
    attempt_num = req.attemptNumber

    stages = [
        ("PREPROCESSING", 15),
        ("TRANSLATING", 50),
        ("QUALITY_CHECK", 90),
    ]

    seq = 1
    for stage_name, prog in stages:
        await send_callback_event(job_id, attempt_num, seq, stage_name, prog)
        seq += 1

    segments = [
        {
            "sortOrder": 1,
            "anchorBlockId": "p-1",
            "rawText": "その日、人類は思い出した。ヤツらに支配されていた恐怖を。",
            "translatedText": "Ngày hôm đó, nhân loại đã nhớ lại. Nỗi sợ hãi khi bị thống trị bởi chúng.",
            "confidence": 0.99,
        }
    ]

    await send_callback_event(
        job_id,
        attempt_num,
        seq,
        "READY_FOR_REVIEW",
        100,
        result_manifest={"pages": []},
        segments=segments,
    )

    return {
        "success": True,
        "jobId": job_id,
        "attemptNumber": attempt_num,
        "status": "READY_FOR_REVIEW",
        "segmentsCount": len(segments),
    }

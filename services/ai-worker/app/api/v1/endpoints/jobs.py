import uuid
from typing import Optional, Dict, Any, List
from fastapi import APIRouter, Depends
from pydantic import BaseModel
import httpx
from app.core.security import verify_internal_key
from app.core.config import settings

router = APIRouter()

class ProcessJobRequest(BaseModel):
    jobId: str
    attemptNumber: int
    outputPrefix: str
    sourceLang: Optional[str] = "ja"
    targetLang: Optional[str] = "vi"

class HealthResponse(BaseModel):
    status: str
    service: str

@router.get("/health", response_model=HealthResponse)
async def health_check():
    return HealthResponse(status="healthy", service="omninovel-ai-worker")

async def send_callback_event(
    job_id: str,
    attempt_number: int,
    sequence: int,
    stage: str,
    progress: int,
    result_manifest: Optional[Dict[str, Any]] = None,
    segments: Optional[List[Dict[str, Any]]] = None,
):
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
    Mock pipeline cho Vertical Slice 1:
    Phát sinh chuỗi callback hợp lệ từ PREPROCESSING -> OCR -> TRANSLATING -> INPAINTING -> TYPESETTING -> QUALITY_CHECK -> READY_FOR_REVIEW
    kèm result_manifest và mock segments.
    """
    job_id = req.jobId
    attempt_num = req.attemptNumber
    output_prefix = req.outputPrefix

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
        "pages": [
            {
                "page": 1,
                "previewKey": f"{output_prefix}page-001.webp",
                "width": 1200,
                "height": 1800,
                "fileSize": 154200,
            }
        ],
        "previewUrls": [
            f"http://localhost:9000/manga-media/{output_prefix}page-001.webp"
        ],
    }
    segments = [
        {
            "pageNumber": 1,
            "sortOrder": 1,
            "bboxX": 100,
            "bboxY": 200,
            "bboxW": 300,
            "bboxH": 150,
            "rawText": "こんにちは、世界！",
            "translatedText": "Xin chào thế giới!",
            "confidence": 0.98,
        }
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
        "jobId": job_id,
        "attemptNumber": attempt_num,
        "status": "COMPLETED",
        "message": "Manga processing simulated successfully.",
    }

@router.post("/process-novel", dependencies=[Depends(verify_internal_key)])
async def process_novel_job(req: ProcessJobRequest):
    job_id = req.jobId
    attempt_num = req.attemptNumber

    await send_callback_event(job_id, attempt_num, 1, "TRANSLATING", 50)
    await send_callback_event(job_id, attempt_num, 2, "READY_FOR_REVIEW", 100)
    return {"jobId": job_id, "status": "COMPLETED"}

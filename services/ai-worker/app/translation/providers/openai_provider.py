import json
from typing import List, Optional
import httpx

from app.translation.context_builder import ContextBatch
from app.translation.prompt_registry import get_prompt_template
from app.translation.providers.base import (
    AuthenticationError,
    RateLimitError,
    SchemaMismatchError,
    TranslationProvider,
    TranslationProviderError,
    TranslatedSegmentItem,
)


class OpenAICompatibleTranslationProvider(TranslationProvider):
    """
    Adapter kết nối các API tương thích OpenAI / LiteLLM / Cloud LLM:
    - Structured JSON Mode (response_format={"type": "json_object"}).
    - Fail-Fast: Ném ngay Typed Exceptions khi gặp lỗi 429/500/timeout, KHÔNG retry nội bộ.
    - Phân định ranh giới Prompt Injection: Đưa rawText vào trường JSON dữ liệu độc lập.
    - Xác thực nghiêm ngặt 1:1 segmentKey output.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = "https://api.openai.com/v1",
        model_name: str = "gpt-4o-mini",
        client: Optional[httpx.AsyncClient] = None,
        timeout_seconds: float = 30.0,
    ):
        self.api_key = api_key or ""
        self.base_url = (base_url or "https://api.openai.com/v1").rstrip("/")
        self.model_name = model_name
        self._client = client
        self.timeout_seconds = timeout_seconds

    async def translate_batch(
        self, batch: ContextBatch, prompt_version: str = "manga-ja-vi-v1"
    ) -> List[TranslatedSegmentItem]:
        system_prompt = get_prompt_template(prompt_version)

        # Đóng gói dữ liệu an toàn trong payload JSON cấu trúc
        user_payload = {
            "items": [
                {
                    "segmentKey": item.segment_key,
                    "rawText": item.raw_text,
                    "context": item.surrounding_context,
                    "glossary_constraints": [
                        {
                            "source_term": c.source_term,
                            "target_term": c.target_term,
                            "category": c.category,
                        }
                        for c in item.glossary_constraints
                    ],
                }
                for item in batch.items
            ]
        }

        request_body = {
            "model": self.model_name,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.3,
        }

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }

        endpoint = f"{self.base_url}/chat/completions"

        # Thực thi call mạng (Fail-fast: không retry lặp lại trong code)
        try:
            if self._client is not None:
                response = await self._client.post(
                    endpoint, json=request_body, headers=headers, timeout=self.timeout_seconds
                )
            else:
                async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                    response = await client.post(
                        endpoint, json=request_body, headers=headers
                    )
        except httpx.TimeoutException as e:
            raise TranslationProviderError(f"LLM request timed out after {self.timeout_seconds}s: {str(e)}") from e
        except Exception as e:
            raise TranslationProviderError(f"LLM network transport error: {str(e)}") from e

        # Xử lý các mã lỗi HTTP Fail-fast
        if response.status_code in (401, 403):
            raise AuthenticationError(
                f"LLM Authentication failed (HTTP {response.status_code}): {response.text}"
            )
        elif response.status_code == 429:
            retry_after_hdr = response.headers.get("retry-after")
            retry_after = int(retry_after_hdr) if retry_after_hdr and retry_after_hdr.isdigit() else None
            raise RateLimitError(
                f"LLM Rate limit exceeded (HTTP 429): {response.text}", retry_after=retry_after
            )
        elif response.status_code >= 400:
            raise TranslationProviderError(
                f"LLM Provider returned HTTP {response.status_code}: {response.text}"
            )

        # Parse JSON và kiểm tra schema
        try:
            res_json = response.json()
            content_raw = res_json["choices"][0]["message"]["content"]
            parsed_content = json.loads(content_raw)
        except Exception as e:
            raise SchemaMismatchError(f"Failed to parse LLM JSON response: {str(e)}") from e

        raw_translations = parsed_content.get("translations")
        if not isinstance(raw_translations, list):
            raise SchemaMismatchError(
                f"LLM response missing 'translations' array: {parsed_content}"
            )

        results: List[TranslatedSegmentItem] = []
        for t in raw_translations:
            if not isinstance(t, dict) or "segmentKey" not in t or "translatedText" not in t:
                raise SchemaMismatchError(f"Invalid translation item schema: {t}")
            results.append(
                TranslatedSegmentItem(
                    segment_key=str(t["segmentKey"]),
                    translated_text=str(t["translatedText"]),
                )
            )

        # Xác thực 1:1 segmentKey
        self._validate_output_keys(batch.items, results)
        return results

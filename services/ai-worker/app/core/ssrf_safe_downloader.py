import ipaddress
import urllib.parse
from pathlib import Path
from typing import Optional, Set
import httpx
from app.core.config import settings

FORBIDDEN_METADATA_HOSTS = {
    "169.254.169.254",
    "metadata.google.internal",
    "100.100.100.200",
}


def _get_allowed_hosts() -> Set[str]:
    """Tập hợp hostname/domain được phép tải file (MinIO, S3, Core API)."""
    allowed = {"localhost", "127.0.0.1", "minio", "host.docker.internal"}
    if settings.MINIO_ENDPOINT:
        parsed = urllib.parse.urlparse(
            f"http://{settings.MINIO_ENDPOINT}" if "://" not in settings.MINIO_ENDPOINT else settings.MINIO_ENDPOINT
        )
        if parsed.hostname:
            allowed.add(parsed.hostname.lower())
    return allowed


def validate_download_url(url: str) -> urllib.parse.ParseResult:
    """
    Thẩm định an toàn ranh giới SSRF cho URL download nguồn:
    - Bắt buộc giao thức http hoặc https.
    - Chặn IP metadata cloud (169.254.169.254).
    - Hostname phải nằm trong danh sách Object Storage cho phép.
    """
    if not url or not isinstance(url, str):
        raise ValueError("SSRF_BLOCKED: URL tải nguồn không hợp lệ hoặc rỗng.")

    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"SSRF_BLOCKED: Giao thức '{parsed.scheme}' không được hỗ trợ. Chỉ cho phép http/https.")

    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise ValueError("SSRF_BLOCKED: URL thiếu hostname.")

    if hostname in FORBIDDEN_METADATA_HOSTS:
        raise ValueError(f"SSRF_BLOCKED: Hostname nhạy cảm '{hostname}' bị cấm tuyệt đối.")

    try:
        ip_obj = ipaddress.ip_address(hostname)
        if ip_obj.is_link_local or ip_obj.is_multicast:
            raise ValueError(f"SSRF_BLOCKED: Địa chỉ IP nội bộ '{hostname}' bị cấm.")
    except ValueError:
        pass  # Không phải IP thuần (domain name)

    allowed_hosts = _get_allowed_hosts()
    if hostname not in allowed_hosts:
        raise ValueError(
            f"SSRF_BLOCKED: Hostname '{hostname}' không nằm trong danh sách Object Storage được cấp phép: {allowed_hosts}"
        )

    return parsed


async def safe_download_archive(
    url: str,
    target_path: Path,
    max_bytes: int = settings.MAX_ARCHIVE_DOWNLOAD_BYTES,
    client: Optional[httpx.AsyncClient] = None,
) -> Path:
    """
    Tải file an toàn qua luồng stream có giới hạn dung lượng cứng và timeout chặt chẽ:
    - Thẩm định URL trước khi gửi request.
    - Chặn redirect tự động không kiểm soát (follow_redirects=False).
    - Cắt luồng tải ngay lập tức nếu vượt quá max_bytes (100MB).
    """
    validate_download_url(url)
    target_path.parent.mkdir(parents=True, exist_ok=True)

    bytes_downloaded = 0

    async def _do_download(http_client: httpx.AsyncClient):
        nonlocal bytes_downloaded
        async with http_client.stream(
            "GET", url, headers={"User-Agent": "OmniNovel-AI-Worker/1.0"}
        ) as response:
            if response.status_code not in (200, 206):
                raise ValueError(f"Tải source package thất bại với HTTP {response.status_code}: {response.reason_phrase}")

            # Kiểm tra Content-Length header nếu có
            content_len = response.headers.get("content-length")
            if content_len and content_len.isdigit() and int(content_len) > max_bytes:
                raise ValueError(f"Dung lượng Content-Length ({content_len} bytes) vượt quá giới hạn ({max_bytes} bytes)")

            with open(target_path, "wb") as f:
                async for chunk in response.aiter_bytes(chunk_size=65536):
                    bytes_downloaded += len(chunk)
                    if bytes_downloaded > max_bytes:
                        raise ValueError(f"Dung lượng tải ({bytes_downloaded} bytes) vượt quá giới hạn ({max_bytes} bytes)")
                    f.write(chunk)

    if client is not None:
        await _do_download(client)
    else:
        # Timeout kết nối 5s, đọc 20s, không tự follow redirect để chống SSRF qua redirect
        transport_limits = httpx.Timeout(connect=5.0, read=20.0, write=5.0, pool=5.0)
        async with httpx.AsyncClient(timeout=transport_limits, follow_redirects=False) as http_client:
            await _do_download(http_client)

    return target_path

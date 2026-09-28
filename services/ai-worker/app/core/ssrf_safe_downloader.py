import ipaddress
import urllib.parse
from pathlib import Path
from typing import Optional, Set, Tuple
import httpx
from app.core.config import settings

FORBIDDEN_METADATA_HOSTS = {
    "169.254.169.254",
    "metadata.google.internal",
    "100.100.100.200",
}


class SSRFBlockedError(ValueError):
    """Lỗi ném ra khi URL vi phạm chính sách SSRF."""
    pass


def _get_allowed_origins() -> Set[Tuple[str, str, int]]:
    """
    Trả về tập hợp các origin (scheme, hostname, port) được phép tải file Object Storage.
    - Nếu provider == 'r2': CHỈ cho phép origin từ settings.S3_ENDPOINT.
    - Nếu provider == 'minio': CHỈ cho phép origin từ settings.MINIO_ENDPOINT.
    - Ở production: Tuyệt đối KHÔNG bổ sung local aliases.
    - Ở test/development: Bổ sung các local aliases chỉ khi provider == 'minio'.
    """
    origins: Set[Tuple[str, str, int]] = set()
    provider = (settings.STORAGE_PROVIDER or "minio").lower()

    if provider == "r2":
        if settings.S3_ENDPOINT:
            raw_s3 = settings.S3_ENDPOINT.strip().lower()
            if "://" not in raw_s3:
                raw_s3 = f"https://{raw_s3}"
            parsed_s3 = urllib.parse.urlparse(raw_s3)
            s3_scheme = (parsed_s3.scheme or "https").lower()
            s3_host = (parsed_s3.hostname or "").lower()
            s3_port = parsed_s3.port or (443 if s3_scheme == "https" else 80)
            if s3_host:
                origins.add((s3_scheme, s3_host, s3_port))
    else:
        # MinIO Origin
        raw_endpoint = (settings.MINIO_ENDPOINT or "localhost").lower()
        if "://" in raw_endpoint:
            parsed_minio = urllib.parse.urlparse(raw_endpoint)
            minio_host = parsed_minio.hostname or "localhost"
            minio_port = parsed_minio.port or settings.MINIO_PORT or 9000
        elif ":" in raw_endpoint:
            parts = raw_endpoint.split(":")
            minio_host = parts[0]
            try:
                minio_port = int(parts[1])
            except ValueError:
                minio_port = settings.MINIO_PORT or 9000
        else:
            minio_host = raw_endpoint
            minio_port = settings.MINIO_PORT or 9000

        minio_scheme = "https" if settings.MINIO_USE_SSL else "http"
        origins.add((minio_scheme, minio_host, minio_port))

        # Chỉ thêm local aliases khi ở môi trường test hoặc development VÀ provider là minio
        if settings.ENV != "production":
            origins.update({
                ("http", "localhost", minio_port),
                ("http", "127.0.0.1", minio_port),
                ("http", "minio", minio_port),
                ("http", "host.docker.internal", minio_port),
            })

    return origins


def validate_download_url(url: str) -> urllib.parse.ParseResult:
    """
    Thẩm định an toàn ranh giới SSRF cho URL download nguồn:
    - Bắt buộc giao thức http hoặc https.
    - Chặn IP metadata cloud (169.254.169.254) và mọi dải link-local / multicast.
    - Thẩm định exact origin: Khóa chặt theo (scheme, hostname, port) của Object Storage được cấu hình.
    - Hỗ trợ virtual-hosted style của Cloudflare R2 (<bucket>.<account_id>.r2.cloudflarestorage.com).
    """
    if not url or not isinstance(url, str):
        raise SSRFBlockedError("SSRF_BLOCKED: URL tải nguồn không hợp lệ hoặc rỗng.")

    try:
        parsed = urllib.parse.urlparse(url)
    except Exception as e:
        raise SSRFBlockedError(f"SSRF_BLOCKED: Không thể parse URL: {e}") from e

    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise SSRFBlockedError(f"SSRF_BLOCKED: Giao thức '{scheme}' không được hỗ trợ. Chỉ cho phép http/https.")

    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise SSRFBlockedError("SSRF_BLOCKED: URL thiếu hostname.")

    # 1. Chặn blacklist metadata cloud domains/IPs
    if hostname in FORBIDDEN_METADATA_HOSTS:
        raise SSRFBlockedError(f"SSRF_BLOCKED: Hostname nhạy cảm '{hostname}' bị cấm tuyệt đối.")

    # 2. Kiểm tra IP address và chặn link-local / multicast mà không nuốt nhầm exception
    is_ip = False
    try:
        ip_obj = ipaddress.ip_address(hostname)
        is_ip = True
    except (ValueError, AttributeError):
        is_ip = False

    if is_ip:
        if ip_obj.is_link_local or ip_obj.is_multicast:
            raise SSRFBlockedError(f"SSRF_BLOCKED: Địa chỉ IP link-local/multicast '{hostname}' bị cấm tuyệt đối.")

    # 3. Xác định port hiệu dụng (mặc định 80 cho http, 443 cho https nếu không chỉ định)
    effective_port = parsed.port
    if effective_port is None:
        effective_port = 443 if scheme == "https" else 80

    # 4. Thẩm định exact origin (scheme, hostname, port)
    allowed_origins = _get_allowed_origins()
    current_origin = (scheme, hostname, effective_port)

    if current_origin in allowed_origins:
        return parsed

    # 5. Hỗ trợ Cloudflare R2 / S3 Virtual-Hosted style:
    # URL có dạng: https://<bucket>.<account_id>.r2.cloudflarestorage.com/...
    provider = (settings.STORAGE_PROVIDER or "minio").lower()
    if provider == "r2" and settings.S3_ENDPOINT:
        raw_s3 = settings.S3_ENDPOINT.strip().lower()
        if "://" not in raw_s3:
            raw_s3 = f"https://{raw_s3}"
        parsed_s3 = urllib.parse.urlparse(raw_s3)
        s3_scheme = (parsed_s3.scheme or "https").lower()
        s3_host = (parsed_s3.hostname or "").lower()
        s3_port = parsed_s3.port or (443 if s3_scheme == "https" else 80)

        if scheme == s3_scheme and effective_port == s3_port and s3_host:
            suffix = f".{s3_host}"
            if hostname.endswith(suffix):
                prefix = hostname[:-len(suffix)]
                if prefix and "." not in prefix:  # 1 level subdomain for bucket
                    return parsed

    # Nếu không khớp exact origin, kiểm tra match hostname và port
    allowed_hosts = {o[1] for o in allowed_origins}
    if hostname in allowed_hosts:
        allowed_ports = {o[2] for o in allowed_origins if o[1] == hostname}
        raise SSRFBlockedError(
            f"SSRF_BLOCKED: Port {effective_port} trên host '{hostname}' không được phép. Các port được phép: {allowed_ports}"
        )
    raise SSRFBlockedError(
        f"SSRF_BLOCKED: Origin '{scheme}://{hostname}:{effective_port}' không nằm trong danh sách Object Storage được cấp phép."
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


async def safe_download_bytes(
    url: str,
    max_bytes: int = 50 * 1024 * 1024,  # 50MB bound
    client: Optional[httpx.AsyncClient] = None,
) -> bytes:
    """
    Tải raw bytes an toàn qua streaming chống SSRF:
    - Thẩm định URL trước khi gửi request (validate_download_url).
    - Chặn redirect tự động (follow_redirects=False).
    - Kiểm tra Content-Length header nếu có.
    - Cắt luồng tải ngay lập tức nếu vượt quá max_bytes.
    """
    validate_download_url(url)

    downloaded_chunks = []
    bytes_downloaded = 0

    async def _do_download(http_client: httpx.AsyncClient):
        nonlocal bytes_downloaded
        async with http_client.stream(
            "GET", url, headers={"User-Agent": "OmniNovel-AI-Worker/1.0"}
        ) as response:
            if response.status_code not in (200, 206):
                raise ValueError(
                    f"Tải byte thất bại với HTTP {response.status_code}: {response.reason_phrase}"
                )

            content_len = response.headers.get("content-length")
            if content_len and content_len.isdigit() and int(content_len) > max_bytes:
                raise ValueError(
                    f"Dung lượng Content-Length ({content_len} bytes) vượt quá giới hạn ({max_bytes} bytes)"
                )

            async for chunk in response.aiter_bytes(chunk_size=65536):
                bytes_downloaded += len(chunk)
                if bytes_downloaded > max_bytes:
                    raise ValueError(
                        f"Dung lượng tải ({bytes_downloaded} bytes) vượt quá giới hạn ({max_bytes} bytes)"
                    )
                downloaded_chunks.append(chunk)

    if client is not None:
        await _do_download(client)
    else:
        transport_limits = httpx.Timeout(connect=5.0, read=20.0, write=5.0, pool=5.0)
        async with httpx.AsyncClient(timeout=transport_limits, follow_redirects=False) as http_client:
            await _do_download(http_client)

    return b"".join(downloaded_chunks)

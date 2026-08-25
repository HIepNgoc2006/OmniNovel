from pathlib import Path
import httpx
import pytest

from app.core.ssrf_safe_downloader import (
    safe_download_archive,
    validate_download_url,
)


def test_ssrf_blocks_forbidden_metadata_and_external_hosts():
    # 1. Cloud metadata IP
    with pytest.raises(ValueError, match="SSRF_BLOCKED"):
        validate_download_url("http://169.254.169.254/latest/meta-data")

    # 2. Hostname độc hại không thuộc allowlist
    with pytest.raises(ValueError, match="SSRF_BLOCKED"):
        validate_download_url("http://evil-site.com/exploit.zip")

    # 3. Giao thức không phải http/https
    with pytest.raises(ValueError, match="SSRF_BLOCKED"):
        validate_download_url("file:///etc/passwd")


def test_ssrf_allows_minio_and_localhost():
    # Cho phép localhost / 127.0.0.1 / minio
    url1 = "http://localhost:9000/raw-manga/chapter.zip"
    parsed1 = validate_download_url(url1)
    assert parsed1.hostname == "localhost"

    url2 = "http://127.0.0.1:9000/raw-manga/chapter.zip"
    parsed2 = validate_download_url(url2)
    assert parsed2.hostname == "127.0.0.1"


@pytest.mark.asyncio
async def test_safe_download_archive_with_mock_client(tmp_path: Path):
    target = tmp_path / "downloaded.zip"
    dummy_bytes = b"PK\x03\x04" + b"x" * 100

    def mock_transport(req: httpx.Request):
        return httpx.Response(200, content=dummy_bytes)

    client = httpx.AsyncClient(transport=httpx.MockTransport(mock_transport))
    res_path = await safe_download_archive(
        url="http://localhost:9000/raw-manga/chapter.zip",
        target_path=target,
        max_bytes=1024,
        client=client,
    )

    assert res_path.exists()
    assert res_path.read_bytes() == dummy_bytes


@pytest.mark.asyncio
async def test_safe_download_archive_exceeds_size_limit(tmp_path: Path):
    target = tmp_path / "oversized.zip"
    large_bytes = b"PK\x03\x04" + b"x" * 2000

    def mock_transport(req: httpx.Request):
        return httpx.Response(200, content=large_bytes)

    client = httpx.AsyncClient(transport=httpx.MockTransport(mock_transport))
    with pytest.raises(ValueError, match="vượt quá giới hạn"):
        await safe_download_archive(
            url="http://localhost:9000/raw-manga/chapter.zip",
            target_path=target,
            max_bytes=500,  # Max 500 bytes
            client=client,
        )

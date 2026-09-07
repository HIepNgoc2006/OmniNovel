from pathlib import Path
import httpx
import pytest

from app.core.ssrf_safe_downloader import (
    SSRFBlockedError,
    safe_download_archive,
    safe_download_bytes,
    validate_download_url,
)


def test_ssrf_blocks_forbidden_metadata_and_external_hosts():
    # 1. Cloud metadata IP
    with pytest.raises(SSRFBlockedError, match="SSRF_BLOCKED"):
        validate_download_url("http://169.254.169.254/latest/meta-data")

    # 2. Hostname độc hại không thuộc allowlist
    with pytest.raises(SSRFBlockedError, match="SSRF_BLOCKED"):
        validate_download_url("http://evil-site.com/exploit.zip")

    # 3. Giao thức không phải http/https
    with pytest.raises(SSRFBlockedError, match="SSRF_BLOCKED"):
        validate_download_url("file:///etc/passwd")


def test_ssrf_blocks_link_local_and_multicast_ips():
    # 1. Link-local IP khác metadata IP
    with pytest.raises(SSRFBlockedError, match="SSRF_BLOCKED.*link-local"):
        validate_download_url("http://169.254.10.20:9000/exploit.zip")

    # 2. Multicast IP
    with pytest.raises(SSRFBlockedError, match="SSRF_BLOCKED.*link-local/multicast"):
        validate_download_url("http://224.0.0.1:9000/exploit.zip")


def test_ssrf_blocks_wrong_port(monkeypatch):
    monkeypatch.setattr("app.core.ssrf_safe_downloader.settings.ENV", "test")

    # Hostname hợp lệ (localhost) nhưng port không được phép (8080, 8000)
    with pytest.raises(SSRFBlockedError, match="Port 8080 trên host 'localhost' không được phép"):
        validate_download_url("http://localhost:8080/exploit.zip")

    with pytest.raises(SSRFBlockedError, match="Port 3000 trên host '127.0.0.1' không được phép"):
        validate_download_url("http://127.0.0.1:3000/exploit.zip")


def test_ssrf_allows_minio_exact_origin_in_test_env(monkeypatch):
    monkeypatch.setattr("app.core.ssrf_safe_downloader.settings.ENV", "test")

    # Đúng scheme http, host localhost / 127.0.0.1 / minio, port 9000
    url1 = "http://localhost:9000/raw-manga/chapter.zip"
    parsed1 = validate_download_url(url1)
    assert parsed1.hostname == "localhost"
    assert parsed1.port == 9000

    url2 = "http://127.0.0.1:9000/raw-manga/chapter.zip"
    parsed2 = validate_download_url(url2)
    assert parsed2.hostname == "127.0.0.1"
    assert parsed2.port == 9000


def test_ssrf_production_strictly_restricts_to_configured_origin(monkeypatch):
    monkeypatch.setattr("app.core.ssrf_safe_downloader.settings.ENV", "production")
    monkeypatch.setattr("app.core.ssrf_safe_downloader.settings.MINIO_ENDPOINT", "s3.storage.production.internal")
    monkeypatch.setattr("app.core.ssrf_safe_downloader.settings.MINIO_PORT", 9000)
    monkeypatch.setattr("app.core.ssrf_safe_downloader.settings.MINIO_USE_SSL", False)

    # Khớp chính xác configured origin
    valid_url = "http://s3.storage.production.internal:9000/raw-manga/chapter.zip"
    parsed = validate_download_url(valid_url)
    assert parsed.hostname == "s3.storage.production.internal"
    assert parsed.port == 9000

    # Chặn 127.0.0.1 và localhost ở production khi không được cấu hình
    with pytest.raises(SSRFBlockedError, match="SSRF_BLOCKED: Origin .* không nằm trong danh sách Object Storage"):
        validate_download_url("http://127.0.0.1:9000/raw-manga/chapter.zip")


@pytest.mark.asyncio
async def test_safe_download_archive_with_mock_client(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.core.ssrf_safe_downloader.settings.ENV", "test")
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
async def test_safe_download_archive_exceeds_size_limit(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.core.ssrf_safe_downloader.settings.ENV", "test")
    target = tmp_path / "oversized.zip"
    large_bytes = b"PK\x03\x04" + b"x" * 2000

    def mock_transport(req: httpx.Request):
        return httpx.Response(200, content=large_bytes)

    client = httpx.AsyncClient(transport=httpx.MockTransport(mock_transport))
    with pytest.raises(ValueError, match="vượt quá giới hạn"):
        await safe_download_archive(
            url="http://localhost:9000/raw-manga/chapter.zip",
            target_path=target,
            max_bytes=500,
            client=client,
        )


@pytest.mark.asyncio
async def test_safe_download_bytes_success(monkeypatch):
    monkeypatch.setattr("app.core.ssrf_safe_downloader.settings.ENV", "test")
    dummy_bytes = b'{"version": 1, "test": "data"}'

    def mock_transport(req: httpx.Request):
        return httpx.Response(200, content=dummy_bytes)

    client = httpx.AsyncClient(transport=httpx.MockTransport(mock_transport))
    res = await safe_download_bytes(
        url="http://localhost:9000/snapshots/test.json",
        max_bytes=1024,
        client=client,
    )
    assert res == dummy_bytes


@pytest.mark.asyncio
async def test_safe_download_bytes_exceeds_limit(monkeypatch):
    monkeypatch.setattr("app.core.ssrf_safe_downloader.settings.ENV", "test")
    large_bytes = b"x" * 2000

    def mock_transport(req: httpx.Request):
        return httpx.Response(200, content=large_bytes)

    client = httpx.AsyncClient(transport=httpx.MockTransport(mock_transport))
    with pytest.raises(ValueError, match="vượt quá giới hạn"):
        await safe_download_bytes(
            url="http://localhost:9000/snapshots/large.json",
            max_bytes=500,
            client=client,
        )


@pytest.mark.asyncio
async def test_safe_download_bytes_blocks_ssrf():
    with pytest.raises(SSRFBlockedError, match="SSRF_BLOCKED"):
        await safe_download_bytes(
            url="http://169.254.169.254/latest/meta-data",
        )


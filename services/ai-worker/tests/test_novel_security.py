import io
import zipfile
from pathlib import Path
import pytest

from app.novel.security import (
    ExcessiveArchiveEntriesError,
    ExcessiveArchiveSizeError,
    ExternalResourceForbiddenError,
    MalformedEpubError,
    MultiChapterPackageError,
    PathTraversalError,
    SafeNovelPackageExtractor,
    SymlinkDetectedError,
    ZipBombError,
    safe_parse_xml_file,
    sanitize_and_resolve_archive_path,
)


# ============================================================================
# Path Traversal & Malicious Entry Names Tests
# ============================================================================

def test_sanitize_and_resolve_valid_path(tmp_path: Path):
    target_dir = tmp_path / "sandbox"
    target_dir.mkdir()

    resolved = sanitize_and_resolve_archive_path("OEBPS/chapter01.xhtml", target_dir)
    assert resolved.is_relative_to(target_dir)
    assert resolved.name == "chapter01.xhtml"


@pytest.mark.parametrize(
    "malicious_name",
    [
        "../evil.txt",
        "..\\evil.txt",
        "a/../../b/evil.txt",
        "/etc/passwd",
        "/root/.ssh/id_rsa",
        "C:/Windows/System32/cmd.exe",
        "C:\\Windows\\System32\\cmd.exe",
        "\\\\server\\share\\evil.txt",
        "//server/share/evil.txt",
        "sub/%2e%2e/evil.txt",
        "sub/%2f/evil.txt",
        "evil\x00file.txt",
    ],
)
def test_sanitize_and_resolve_rejects_adversarial_paths(tmp_path: Path, malicious_name: str):
    target_dir = tmp_path / "sandbox"
    target_dir.mkdir()

    with pytest.raises(PathTraversalError):
        sanitize_and_resolve_archive_path(malicious_name, target_dir)


def test_extractor_rejects_symlinks(tmp_path: Path):
    zip_path = tmp_path / "symlink.zip"
    out_dir = tmp_path / "extracted"

    with zipfile.ZipFile(zip_path, "w") as zf:
        # Tạo ZipInfo có external_attr chứa S_IFLNK (0o120000)
        zi = zipfile.ZipInfo("symlink_entry.txt")
        zi.external_attr = 0o120777 << 16  # Symlink mode
        zf.writestr(zi, "target_file.txt")

    with pytest.raises(SymlinkDetectedError, match="symbolic link"):
        SafeNovelPackageExtractor.extract_single_chapter_archive(zip_path, out_dir)


# ============================================================================
# Zip Bomb & Aggregate Limits Tests
# ============================================================================

def test_extractor_rejects_excessive_entry_count(tmp_path: Path):
    zip_path = tmp_path / "many_files.zip"
    out_dir = tmp_path / "extracted"

    with zipfile.ZipFile(zip_path, "w") as zf:
        for i in range(505):
            zf.writestr(f"file_{i:04d}.txt", "hello")

    with pytest.raises(ExcessiveArchiveEntriesError, match="vượt quá giới hạn tối đa"):
        SafeNovelPackageExtractor.extract_single_chapter_archive(zip_path, out_dir)


def test_extractor_rejects_high_compression_ratio(tmp_path: Path):
    zip_path = tmp_path / "bomb.zip"
    out_dir = tmp_path / "extracted"

    # Tạo 2MB zeroes nén cực cao (ratio > 100:1)
    huge_data = b"0" * (2 * 1024 * 1024)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("huge_zeroes.txt", huge_data)

    with pytest.raises(ZipBombError, match="Tỷ lệ nén"):
        SafeNovelPackageExtractor.extract_single_chapter_archive(zip_path, out_dir)


# ============================================================================
# EPUB Structure & Scope Tests
# ============================================================================

def _create_valid_single_chapter_epub(target_path: Path, html_content: str = "<p>こんにちは</p>"):
    with zipfile.ZipFile(target_path, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?>
            <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                <rootfiles>
                    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
                </rootfiles>
            </container>""",
        )
        zf.writestr(
            "OEBPS/content.opf",
            """<?xml version="1.0"?>
            <package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="pub-id">
                <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                    <dc:title>Chapter 1: Khởi đầu</dc:title>
                    <dc:language>ja</dc:language>
                </metadata>
                <manifest>
                    <item id="chapter1" href="chapter01.xhtml" media-type="application/xhtml+xml"/>
                    <item id="ill1" href="images/ill_01.png" media-type="image/png"/>
                </manifest>
                <spine>
                    <itemref idref="chapter1"/>
                </spine>
            </package>""",
        )
        zf.writestr("OEBPS/chapter01.xhtml", f"<html><body>{html_content}</body></html>")
        zf.writestr("OEBPS/images/ill_01.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)


def test_epub_valid_single_chapter_extraction(tmp_path: Path):
    epub_path = tmp_path / "valid.epub"
    out_dir = tmp_path / "extracted"

    _create_valid_single_chapter_epub(epub_path, "<h1>第1章</h1><p>これはテストです。</p>")

    result = SafeNovelPackageExtractor.extract_and_validate_epub(epub_path, out_dir)
    assert result.title == "Chapter 1: Khởi đầu"
    assert result.language == "ja"
    assert result.content_html_path.exists()
    assert "images/ill_01.png" in result.image_assets


def test_epub_missing_container_xml_raises_error(tmp_path: Path):
    epub_path = tmp_path / "missing_container.epub"
    out_dir = tmp_path / "extracted"

    with zipfile.ZipFile(epub_path, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr("OEBPS/chapter01.xhtml", "<html><body><p>Hello</p></body></html>")

    with pytest.raises(MalformedEpubError, match="META-INF/container.xml"):
        SafeNovelPackageExtractor.extract_and_validate_epub(epub_path, out_dir)


def test_epub_rejects_multi_chapter_package(tmp_path: Path):
    epub_path = tmp_path / "multi_chapter.epub"
    out_dir = tmp_path / "extracted"

    with zipfile.ZipFile(epub_path, "w") as zf:
        zf.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?>
            <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                <rootfiles>
                    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
                </rootfiles>
            </container>""",
        )
        zf.writestr(
            "OEBPS/content.opf",
            """<?xml version="1.0"?>
            <package version="3.0" xmlns="http://www.idpf.org/2007/opf">
                <manifest>
                    <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
                    <item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
                </manifest>
                <spine>
                    <itemref idref="c1"/>
                    <itemref idref="c2"/>
                </spine>
            </package>""",
        )
        zf.writestr("OEBPS/chap1.xhtml", "<html><body>Chapter 1</body></html>")
        zf.writestr("OEBPS/chap2.xhtml", "<html><body>Chapter 2</body></html>")

    with pytest.raises(MultiChapterPackageError, match="Single-Chapter Package"):
        SafeNovelPackageExtractor.extract_and_validate_epub(epub_path, out_dir)


@pytest.mark.parametrize(
    "external_snippet",
    [
        '<img src="https://evil.com/track.png" />',
        '<link rel="stylesheet" href="http://cdn.attacker.com/style.css" />',
        '<script src="//malicious-cdn.com/evil.js"></script>',
        '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>',
    ],
)
def test_epub_rejects_external_resources_fail_closed(tmp_path: Path, external_snippet: str):
    epub_path = tmp_path / "external_res.epub"
    out_dir = tmp_path / "extracted"

    _create_valid_single_chapter_epub(epub_path, f"<p>Text</p>{external_snippet}")

    with pytest.raises(ExternalResourceForbiddenError, match="tài nguyên từ xa bị cấm"):
        SafeNovelPackageExtractor.extract_and_validate_epub(epub_path, out_dir)


# ============================================================================
# Checkpoint 3A Security Audit Hardening Tests
# ============================================================================

@pytest.mark.parametrize(
    "mode_val, mode_name",
    [
        (0o010777, "FIFO / named pipe"),
        (0o020777, "Character device"),
        (0o060777, "Block device"),
        (0o140777, "Socket"),
        (0o120777, "Symbolic link"),
    ],
)
def test_extractor_rejects_non_regular_file_types(tmp_path: Path, mode_val: int, mode_name: str):
    zip_path = tmp_path / f"non_regular_{mode_val}.zip"
    out_dir = tmp_path / "extracted"

    with zipfile.ZipFile(zip_path, "w") as zf:
        zi = zipfile.ZipInfo("special_entry.bin")
        zi.external_attr = mode_val << 16
        zf.writestr(zi, "payload")

    with pytest.raises(SymlinkDetectedError):
        SafeNovelPackageExtractor.extract_single_chapter_archive(zip_path, out_dir)


def test_extractor_rejects_cross_platform_path_collision(tmp_path: Path):
    """
    Xác thực kiểm tra va chạm tên file sau canonicalization hoạt động nhất quán cross-platform
    (Ví dụ 'OEBPS/Chap01.xhtml' vs 'oebps/chap01.xhtml' phải bị từ chối 100% trên cả Linux, Windows, macOS).
    """
    zip_path = tmp_path / "case_collision.zip"
    out_dir = tmp_path / "extracted"

    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("OEBPS/chapter01.xhtml", "<p>File 1</p>")
        zf.writestr("oebps/CHAPTER01.xhtml", "<p>File 2</p>")

    with pytest.raises(PathTraversalError, match="duplicate destination collision"):
        SafeNovelPackageExtractor.extract_single_chapter_archive(zip_path, out_dir)


def test_epub_rejects_xxe_dtd_entity_expansion(tmp_path: Path):
    """
    Xác thực bộ parser XML fail-closed trước các payload tấn công XXE / Entity Expansion / Billion Laughs.
    """
    epub_path = tmp_path / "xxe_payload.epub"
    out_dir = tmp_path / "extracted"

    malicious_container = """<?xml version="1.0"?>
    <!DOCTYPE container [
        <!ENTITY % xxe SYSTEM "file:///etc/passwd">
        %xxe;
    ]>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles>
            <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
        </rootfiles>
    </container>"""

    with zipfile.ZipFile(epub_path, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr("META-INF/container.xml", malicious_container)
        zf.writestr("OEBPS/content.opf", "<package><manifest/><spine/></package>")

    with pytest.raises(MalformedEpubError, match="nguy cơ XXE"):
        SafeNovelPackageExtractor.extract_and_validate_epub(epub_path, out_dir)


def test_epub_zero_network_io_even_with_adversarial_uris(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """
    Chứng minh bằng cách chặn toàn bộ network primitive (socket, urllib, httpx):
    Quá trình thẩm định EPUB và quét external resources hoàn toàn không tạo bất kỳ kết nối mạng nào ra ngoài.
    """
    import socket
    import urllib.request

    def forbidden_network(*args, **kwargs):
        raise RuntimeError("NETWORK I/O ATTEMPTED! Security invariant breached.")

    monkeypatch.setattr(socket, "socket", forbidden_network)
    monkeypatch.setattr(urllib.request, "urlopen", forbidden_network)

    epub_path = tmp_path / "zero_io.epub"
    out_dir = tmp_path / "extracted"

    # EPUB chứa link ngoài
    _create_valid_single_chapter_epub(epub_path, '<p>Text</p><img src="http://169.254.169.254/latest/meta-data/" />')

    # Phải fail-closed với ExternalResourceForbiddenError mà KHÔNG gọi network
    with pytest.raises(ExternalResourceForbiddenError):
        SafeNovelPackageExtractor.extract_and_validate_epub(epub_path, out_dir)


@pytest.mark.parametrize(
    "reserved_entry",
    [
        "CON",
        "con.txt",
        "AUX.xhtml",
        "NUL",
        "prn.png",
        "COM1.dat",
        "LPT9.html",
        "sub/CON/file.txt",
    ],
)
def test_sanitize_path_rejects_windows_reserved_names(tmp_path: Path, reserved_entry: str):
    with pytest.raises(PathTraversalError, match="Windows reserved device name"):
        sanitize_and_resolve_archive_path(reserved_entry, tmp_path)


@pytest.mark.parametrize(
    "trailing_entry",
    [
        "chapter1. ",
        "chapter1.",
        "folder. /file.txt",
        "folder./file.txt",
        " leading_space/file.txt",
    ],
)
def test_sanitize_path_rejects_trailing_dot_and_spaces(tmp_path: Path, trailing_entry: str):
    with pytest.raises(PathTraversalError, match="(trailing dot/space|leading space)"):
        sanitize_and_resolve_archive_path(trailing_entry, tmp_path)


def test_safe_parse_xml_rejects_utf16_xxe_payload(tmp_path: Path):
    """
    Xác thực bộ parser XML phát hiện và từ chối XXE/DTD payload được mã hóa dưới dạng UTF-16-LE / UTF-16-BE.
    """
    xml_utf16le = tmp_path / "xxe_utf16le.xml"
    content = '<?xml version="1.0" encoding="utf-16"?><!DOCTYPE test [<!ENTITY xxe "evil">]><test>&xxe;</test>'
    xml_utf16le.write_bytes(content.encode("utf-16-le"))

    with pytest.raises(MalformedEpubError, match="nguy cơ XXE"):
        safe_parse_xml_file(xml_utf16le)

    xml_utf16be = tmp_path / "xxe_utf16be.xml"
    xml_utf16be.write_bytes(content.encode("utf-16-be"))

    with pytest.raises(MalformedEpubError, match="nguy cơ XXE"):
        safe_parse_xml_file(xml_utf16be)


def test_safe_parse_xml_parses_clean_utf16_xml(tmp_path: Path):
    """
    Xác thực XML UTF-16 hợp lệ không chứa DTD vẫn được parse chính xác.
    """
    xml_clean = tmp_path / "clean_utf16.xml"
    content = '<?xml version="1.0" encoding="utf-16"?><root><title>第1章</title></root>'
    xml_clean.write_bytes(content.encode("utf-16-le"))

    tree = safe_parse_xml_file(xml_clean)
    assert tree.find("title").text == "第1章"


def test_extractor_rejects_unicode_casefold_collision(tmp_path: Path):
    """
    Xác thực kiểm tra va chạm Unicode canonical equivalence + casefold
    (ví dụ: 'café.xhtml' [NFC: c-a-f-\u00e9] vs 'cafe\u0301.xhtml' [NFD: c-a-f-e-\u0301]
    hoặc 'Σ.xhtml' vs 'σ.xhtml').
    """
    zip_path = tmp_path / "unicode_collision.zip"
    out_dir = tmp_path / "extracted"

    # café in NFC vs NFD
    nfc_name = "OEBPS/caf\u00e9.xhtml"
    nfd_name = "oebps/cafe\u0301.xhtml"

    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr(nfc_name, "<p>File NFC</p>")
        zf.writestr(nfd_name, "<p>File NFD</p>")

    with pytest.raises(PathTraversalError, match="duplicate destination collision"):
        SafeNovelPackageExtractor.extract_single_chapter_archive(zip_path, out_dir)



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

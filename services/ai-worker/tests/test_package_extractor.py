import io
import zipfile
from pathlib import Path
from PIL import Image
import pytest

from app.core.package_extractor import extract_chapter_package


def _create_sample_image_bytes(width: int = 800, height: int = 1200, color=(255, 255, 255)) -> bytes:
    img = Image.new("RGB", (width, height), color=color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def test_extract_valid_chapter_package(tmp_path: Path):
    zip_path = tmp_path / "chapter.zip"
    out_dir = tmp_path / "out"

    # Tạo ZIP với 3 trang có thứ tự tự nhiên (p2, p10, p1)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("page_2.jpg", _create_sample_image_bytes(800, 1200))
        zf.writestr("page_10.jpg", _create_sample_image_bytes(800, 1200))
        zf.writestr("page_1.jpg", _create_sample_image_bytes(800, 1200))

    pages = extract_chapter_package(zip_path, out_dir)

    assert len(pages) == 3
    # Xác minh natural sort: page_1 -> page_2 -> page_10
    assert pages[0].page_number == 1
    assert pages[0].original_filename == "page_1.jpg"
    assert pages[0].width == 800
    assert pages[0].height == 1200

    assert pages[1].page_number == 2
    assert pages[1].original_filename == "page_2.jpg"

    assert pages[2].page_number == 3
    assert pages[2].original_filename == "page_10.jpg"


def test_extract_rejects_invalid_magic_header(tmp_path: Path):
    bad_zip = tmp_path / "fake.zip"
    bad_zip.write_bytes(b"NOT_A_ZIP_HEADER_1234567890")
    out_dir = tmp_path / "out"

    with pytest.raises(ValueError, match="Invalid ZIP magic header"):
        extract_chapter_package(bad_zip, out_dir)


def test_extract_rejects_path_traversal(tmp_path: Path):
    zip_path = tmp_path / "traversal.zip"
    out_dir = tmp_path / "out"

    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("../escape.jpg", _create_sample_image_bytes())

    with pytest.raises(ValueError, match="Path traversal detected"):
        extract_chapter_package(zip_path, out_dir)


def test_extract_rejects_absolute_path(tmp_path: Path):
    zip_path = tmp_path / "abs.zip"
    out_dir = tmp_path / "out"

    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("/root/escape.jpg", _create_sample_image_bytes())

    with pytest.raises(ValueError, match="Path traversal detected"):
        extract_chapter_package(zip_path, out_dir)


def test_extract_rejects_drive_letter_path(tmp_path: Path):
    zip_path = tmp_path / "drive.zip"
    out_dir = tmp_path / "out"

    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("C:escape.jpg", _create_sample_image_bytes())

    with pytest.raises(ValueError, match="Path traversal detected"):
        extract_chapter_package(zip_path, out_dir)


def test_extract_rejects_duplicate_filenames(tmp_path: Path):
    zip_path = tmp_path / "dup.zip"
    out_dir = tmp_path / "out"

    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("PAGE_1.jpg", _create_sample_image_bytes())
        zf.writestr("page_1.jpg", _create_sample_image_bytes())

    with pytest.raises(ValueError, match="Duplicate filename detected"):
        extract_chapter_package(zip_path, out_dir)


def test_extract_rejects_zero_images(tmp_path: Path):
    zip_path = tmp_path / "empty.zip"
    out_dir = tmp_path / "out"

    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("readme.txt", b"Hello world")

    with pytest.raises(ValueError, match="No valid image pages found"):
        extract_chapter_package(zip_path, out_dir)


def test_extract_rejects_oversized_image_dimensions(tmp_path: Path):
    out_dir = tmp_path / "out"

    # Case 1: 4097 x 100 -> vượt quá trục ngang
    zip1 = tmp_path / "wide.zip"
    with zipfile.ZipFile(zip1, "w") as zf:
        zf.writestr("page1.jpg", _create_sample_image_bytes(4097, 100))
    with pytest.raises(ValueError, match="exceed max axis limit"):
        extract_chapter_package(zip1, out_dir / "1")

    # Case 2: 100 x 4097 -> vượt quá trục dọc
    zip2 = tmp_path / "tall.zip"
    with zipfile.ZipFile(zip2, "w") as zf:
        zf.writestr("page1.jpg", _create_sample_image_bytes(100, 4097))
    with pytest.raises(ValueError, match="exceed max axis limit"):
        extract_chapter_package(zip2, out_dir / "2")

    # Case 3: 8192 x 1024 -> vượt quá trục dù tổng pixel < 16MP
    zip3 = tmp_path / "banner.zip"
    with zipfile.ZipFile(zip3, "w") as zf:
        zf.writestr("page1.jpg", _create_sample_image_bytes(8192, 1024))
    with pytest.raises(ValueError, match="exceed max axis limit"):
        extract_chapter_package(zip3, out_dir / "3")

    # Case 4: 5000 x 5000 -> vượt cả trục lẫn tổng pixel
    zip4 = tmp_path / "giant.zip"
    with zipfile.ZipFile(zip4, "w") as zf:
        zf.writestr("page1.jpg", _create_sample_image_bytes(5000, 5000))
    with pytest.raises(ValueError, match="exceed max axis limit"):
        extract_chapter_package(zip4, out_dir / "4")


def test_extract_accepts_max_allowed_dimensions(tmp_path: Path):
    zip_path = tmp_path / "max_ok.zip"
    out_dir = tmp_path / "out_max"

    # Đúng 4096 x 4096 -> hợp lệ
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("page1.jpg", _create_sample_image_bytes(4096, 4096))

    pages = extract_chapter_package(zip_path, out_dir)
    assert len(pages) == 1
    assert pages[0].width == 4096
    assert pages[0].height == 4096

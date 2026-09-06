import os
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import List
from PIL import Image

from app.core.config import settings

# Đặt mức Decompression Bomb Protection của PIL theo SSoT
Image.MAX_IMAGE_PIXELS = settings.MAX_IMAGE_PIXELS

ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".avif"}
ZIP_MAGIC_HEADERS = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")


@dataclass(frozen=True)
class ExtractedPageRef:
    page_number: int  # 1-indexed
    original_filename: str
    file_path: Path
    width: int
    height: int
    mime_type: str


def _natural_sort_key(text: str):
    """Natural sorting key (e.g., page1, page2, page10 thay vì page1, page10, page2)."""
    return [int(c) if c.isdigit() else c.lower() for c in re.split(r"(\d+)", text)]


def extract_chapter_package(zip_path: Path, output_dir: Path) -> List[ExtractedPageRef]:
    """
    Giải nén và thẩm định an toàn source chapter ZIP package theo đúng SSoT Invariants:
    - Magic header check
    - Zip bomb & ratio limits (100MB / 100:1 ratio / max 500 entries)
    - Path traversal protection (no .., no absolute, no backslash)
    - Duplicate filename detection & Symlink rejection
    - Image dimension validation (max 4096*4096 px)
    - Natural sort order & 1-indexed page numbering
    """
    if not zip_path.exists():
        raise FileNotFoundError(f"Source archive not found at {zip_path}")

    archive_size = zip_path.stat().st_size
    if archive_size > settings.MAX_ARCHIVE_DOWNLOAD_BYTES:
        raise ValueError(
            f"Archive size ({archive_size} bytes) exceeds limit ({settings.MAX_ARCHIVE_DOWNLOAD_BYTES} bytes)"
        )

    # 1. Kiểm tra Magic Header
    with open(zip_path, "rb") as f:
        header = f.read(4)
        if not any(header.startswith(magic) for magic in ZIP_MAGIC_HEADERS):
            raise ValueError(f"Invalid ZIP magic header: {header!r}")

    # 2. Phân tích cấu trúc ZIP an toàn
    output_dir.mkdir(parents=True, exist_ok=True)
    resolved_output_dir = output_dir.resolve()

    with zipfile.ZipFile(zip_path, "r") as zf:
        infolist = zf.infolist()

        if len(infolist) > settings.MAX_ZIP_ENTRIES:
            raise ValueError(
                f"ZIP entries count ({len(infolist)}) exceeds maximum allowed ({settings.MAX_ZIP_ENTRIES})"
            )

        total_uncompressed = 0
        seen_names = set()
        image_entries: List[zipfile.ZipInfo] = []

        for info in infolist:
            # Chặn encrypted entries
            if info.flag_bits & 0x1:
                raise ValueError("Encrypted ZIP archives are not supported")

            # Chặn Symlinks (UNIX mode check)
            mode = (info.external_attr >> 16) & 0o170000
            if mode == 0o120000:
                raise ValueError(f"Symlinks are forbidden in archive: {info.filename}")

            # Path traversal check
            raw_name = info.filename
            if (
                raw_name.startswith("/")
                or raw_name.startswith("\\")
                or ".." in raw_name
                or "\\" in raw_name
                or (len(raw_name) >= 2 and raw_name[1] == ":")
            ):
                raise ValueError(f"Path traversal detected in archive entry: {raw_name}")

            norm_name = raw_name.lower().replace("/", os.sep)
            if norm_name in seen_names:
                raise ValueError(f"Duplicate filename detected in archive: {raw_name}")
            seen_names.add(norm_name)

            # Bỏ qua thư mục và macOS artifacts
            if info.is_dir() or raw_name.startswith("__MACOSX/") or Path(raw_name).name.startswith("._"):
                continue

            # Zip bomb checks
            total_uncompressed += info.file_size
            if total_uncompressed > settings.MAX_UNCOMPRESSED_ARCHIVE_BYTES:
                raise ValueError(
                    f"Total uncompressed size ({total_uncompressed} bytes) exceeds limit ({settings.MAX_UNCOMPRESSED_ARCHIVE_BYTES} bytes)"
                )

            entry_ratio = (
                info.file_size / max(1, info.compress_size)
                if info.compress_size > 0
                else info.file_size
            )
            if entry_ratio > settings.COMPRESSION_RATIO_LIMIT:
                raise ValueError(
                    f"Entry compression ratio ({entry_ratio:.1f}:1) exceeds limit ({settings.COMPRESSION_RATIO_LIMIT:.1f}:1)"
                )

            ext = Path(raw_name).suffix.lower()
            if ext in ALLOWED_IMAGE_EXTENSIONS:
                image_entries.append(info)

        # Tổng compression ratio check
        overall_ratio = total_uncompressed / max(1, archive_size)
        if overall_ratio > settings.COMPRESSION_RATIO_LIMIT:
            raise ValueError(
                f"Overall compression ratio ({overall_ratio:.1f}:1) exceeds limit ({settings.COMPRESSION_RATIO_LIMIT:.1f}:1)"
            )

        if not image_entries:
            raise ValueError("No valid image pages found in archive")

        if len(image_entries) > settings.MAX_MANGA_PAGES:
            raise ValueError(
                f"Image pages count ({len(image_entries)}) exceeds maximum allowed ({settings.MAX_MANGA_PAGES})"
            )

        # Natural sort theo filename
        image_entries.sort(key=lambda x: _natural_sort_key(Path(x.filename).name))

        extracted_pages: List[ExtractedPageRef] = []

        for idx, info in enumerate(image_entries, start=1):
            target_path = (resolved_output_dir / f"page_{idx:04d}{Path(info.filename).suffix.lower()}").resolve()
            if not str(target_path).startswith(str(resolved_output_dir)):
                raise ValueError(f"Extracted path escapes destination directory: {target_path}")

            # Giải nén stream
            with zf.open(info) as src, open(target_path, "wb") as dst:
                bytes_written = 0
                while True:
                    chunk = src.read(65536)
                    if not chunk:
                        break
                    dst.write(chunk)
                    bytes_written += len(chunk)
                    if bytes_written > settings.MAX_UNCOMPRESSED_ARCHIVE_BYTES:
                        raise ValueError("File extraction exceeded uncompressed byte budget")

            FORMAT_TO_MIME = {
                "JPEG": "image/jpeg",
                "JPG": "image/jpeg",
                "PNG": "image/png",
                "WEBP": "image/webp",
                "AVIF": "image/avif",
            }

            # Validate ảnh qua PIL
            try:
                with Image.open(target_path) as img:
                    actual_format = (img.format or "").upper()
                    if actual_format not in FORMAT_TO_MIME:
                        raise ValueError(f"Unsupported image format '{actual_format}' in archive")
                    mime_type = FORMAT_TO_MIME[actual_format]

                    width, height = img.size
                    if width > settings.MAX_IMAGE_AXIS_DIMENSION or height > settings.MAX_IMAGE_AXIS_DIMENSION:
                        raise ValueError(
                            f"Image dimensions {width}x{height} exceed max axis limit ({settings.MAX_IMAGE_AXIS_DIMENSION}px)"
                        )
                    if width * height > settings.MAX_IMAGE_PIXELS:
                        raise ValueError(
                            f"Image dimensions {width}x{height} exceed max pixel limit ({settings.MAX_IMAGE_PIXELS})"
                        )
                    if width <= 0 or height <= 0:
                        raise ValueError(f"Invalid image dimensions: {width}x{height}")
            except Exception as e:
                raise ValueError(f"Corrupt or invalid image file {info.filename}: {str(e)}") from e

            extracted_pages.append(
                ExtractedPageRef(
                    page_number=idx,
                    original_filename=Path(info.filename).name,
                    file_path=target_path,
                    width=width,
                    height=height,
                    mime_type=mime_type,
                )
            )

        return extracted_pages

import io
import os
import posixpath
import re
import stat
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set


class NovelSecurityError(ValueError):
    """Lỗi bảo mật chung trong quá trình xử lý tài liệu tiểu thuyết."""
    pass


class PathTraversalError(NovelSecurityError):
    """Lỗi khi phát hiện đường dẫn chứa path traversal hoặc nằm ngoài sandbox."""
    pass


class ZipBombError(NovelSecurityError):
    """Lỗi khi tỷ lệ nén hoặc kích thước giải nén vượt quá giới hạn an toàn."""
    pass


class SymlinkDetectedError(NovelSecurityError):
    """Lỗi khi archive chứa symbolic link hoặc non-regular file."""
    pass


class MalformedEpubError(NovelSecurityError):
    """Lỗi khi cấu trúc EPUB không hợp lệ (thiếu container.xml hoặc OPF)."""
    pass


class MultiChapterPackageError(NovelSecurityError):
    """Lỗi khi gói EPUB vượt quá phạm vi đơn chương (Single-chapter EPUB scope)."""
    pass


class ExternalResourceForbiddenError(NovelSecurityError):
    """Lỗi khi phát hiện tài liệu chứa liên kết tới tài nguyên bên ngoài Internet."""
    pass


class ExcessiveArchiveEntriesError(NovelSecurityError):
    """Lỗi khi số lượng file trong archive vượt quá giới hạn cho phép."""
    pass


class ExcessiveArchiveSizeError(NovelSecurityError):
    """Lỗi khi dung lượng giải nén tổng thể vượt quá giới hạn."""
    pass


# Giới hạn an toàn (Security Thresholds)
MAX_ARCHIVE_ENTRIES = 500
MAX_UNCOMPRESSED_TEXT_BYTES = 50 * 1024 * 1024   # 50 MB
MAX_UNCOMPRESSED_TOTAL_BYTES = 100 * 1024 * 1024  # 100 MB
MAX_COMPRESSION_RATIO = 100.0                     # 100:1 ratio limit
CHUNK_SIZE = 64 * 1024                            # 64 KB streaming buffer

TEXT_EXTENSIONS = {".html", ".xhtml", ".htm", ".xml", ".opf", ".ncx", ".txt", ".md", ".json"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}

EXTERNAL_URL_PATTERN = re.compile(
    r"""(?i)(https?://|ftp://|//[a-z0-9]|data:text/html)""",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ExtractedNovelPackage:
    root_dir: Path
    all_files: List[Path]
    text_files: List[Path]
    image_files: List[Path]
    total_uncompressed_bytes: int


@dataclass(frozen=True)
class ExtractedEpubChapter:
    content_html_path: Path
    title: Optional[str]
    language: Optional[str]
    image_assets: Dict[str, Path] = field(default_factory=dict)
    total_uncompressed_bytes: int = 0


def sanitize_and_resolve_archive_path(entry_name: str, target_dir: Path) -> Path:
    """
    Thẩm định nghiêm ngặt tên file trong archive:
    - Chặn null bytes (\x00), URL-encoded traversal (%2e%2e), dấu hai chấm (C:), UNC (\\\\), leading slashes.
    - Chuẩn hóa đường dẫn và kiểm tra tính trực thuộc tuyệt đối bên trong target_dir.
    """
    if not entry_name or "\x00" in entry_name:
        raise PathTraversalError("Phát hiện tên file rỗng hoặc chứa ký tự null byte.")

    # Chặn URL-encoded traversal
    if "%2e" in entry_name.lower() or "%2f" in entry_name.lower() or "%5c" in entry_name.lower():
        raise PathTraversalError(f"Phát hiện URL-encoded traversal pattern trong tên file: '{entry_name}'")

    # Chặn Windows drive letters (vd: C:, D:) và UNC paths (vd: \\server\share)
    if re.match(r"^[a-zA-Z]:", entry_name) or entry_name.startswith("\\\\") or entry_name.startswith("//"):
        raise PathTraversalError(f"Phát hiện absolute drive / UNC path bất hợp pháp: '{entry_name}'")

    # Chuẩn hóa về forward slash
    normalized_name = entry_name.replace("\\", "/")

    # Chặn leading slash
    if normalized_name.startswith("/"):
        raise PathTraversalError(f"Phát hiện absolute path bất hợp pháp: '{entry_name}'")

    # Phân tích từng path segment
    parts = normalized_name.split("/")
    for part in parts:
        if part in ("..", "."):
            raise PathTraversalError(f"Phát hiện relative traversal segment '{part}' trong: '{entry_name}'")

    clean_rel_path = posixpath.normpath(normalized_name)
    if clean_rel_path == "." or clean_rel_path.startswith("../"):
        raise PathTraversalError(f"Phát hiện traversal sau chuẩn hóa: '{entry_name}'")

    target_dir_abs = target_dir.resolve()
    dest_path = (target_dir_abs / clean_rel_path).resolve()

    try:
        dest_path.relative_to(target_dir_abs)
    except ValueError as e:
        raise PathTraversalError(f"Đích đến nằm ngoài thư mục sandbox an toàn: '{entry_name}'") from e

    return dest_path


class SafeNovelPackageExtractor:
    """
    Trích xuất và thẩm định an toàn các gói tài liệu tiểu thuyết (.zip / .epub / single-chapter package).
    Bảo đảm:
    1. Chặn Path Traversal, Symlinks, Non-regular files.
    2. Chặn Zip Bomb (Aggregate metadata & In-flight stream byte counter).
    3. Thẩm định Single-chapter EPUB scope.
    4. Fail-closed khi phát hiện External Resources (không dereference mạng).
    5. Hoàn toàn không thực hiện bất kỳ network I/O nào.
    """

    @classmethod
    def extract_single_chapter_archive(
        cls,
        archive_path: Path,
        output_dir: Path,
    ) -> ExtractedNovelPackage:
        if not archive_path.exists() or not archive_path.is_file():
            raise NovelSecurityError(f"File archive không tồn tại tại {archive_path}")

        output_dir.mkdir(parents=True, exist_ok=True)
        target_dir_abs = output_dir.resolve()

        try:
            zf = zipfile.ZipFile(archive_path, "r")
        except zipfile.BadZipFile as e:
            raise NovelSecurityError(f"File archive bị hỏng hoặc không đúng định dạng ZIP: {e}") from e

        with zf:
            infolist = zf.infolist()

            # 1. Kiểm tra số lượng entries
            if len(infolist) > MAX_ARCHIVE_ENTRIES:
                raise ExcessiveArchiveEntriesError(
                    f"Số lượng file trong archive ({len(infolist)}) vượt quá giới hạn tối đa ({MAX_ARCHIVE_ENTRIES})."
                )

            # 2. Kiểm tra aggregate metadata trước khi giải nén
            meta_total_uncompressed = sum(info.file_size for info in infolist)
            meta_total_compressed = sum(info.compress_size for info in infolist)

            if meta_total_uncompressed > MAX_UNCOMPRESSED_TOTAL_BYTES:
                raise ExcessiveArchiveSizeError(
                    f"Tổng dung lượng giải nén khai báo ({meta_total_uncompressed} bytes) vượt quá {MAX_UNCOMPRESSED_TOTAL_BYTES} bytes."
                )

            if meta_total_compressed > 0:
                ratio = meta_total_uncompressed / meta_total_compressed
                if ratio > MAX_COMPRESSION_RATIO:
                    raise ZipBombError(
                        f"Tỷ lệ nén khai báo ({ratio:.1f}:1) vượt quá giới hạn an toàn ({MAX_COMPRESSION_RATIO}:1)."
                    )

            # 3. Duyệt và giải nén có streaming byte counter chống forged header metadata
            extracted_files: List[Path] = []
            text_files: List[Path] = []
            image_files: List[Path] = []

            seen_destinations: Set[Path] = set()
            actual_total_bytes = 0
            actual_text_bytes = 0

            for info in infolist:
                # Bỏ qua thư mục rỗng trong ZIP
                if info.is_dir() or info.filename.endswith("/"):
                    continue

                # Kiểm tra symlink / hardlink qua external_attr
                # Trong Unix, mode 0o120000 là symlink (S_IFLNK)
                mode = info.external_attr >> 16
                if mode != 0 and stat.S_ISLNK(mode):
                    raise SymlinkDetectedError(f"Phát hiện symbolic link trong archive: '{info.filename}'")

                dest_file = sanitize_and_resolve_archive_path(info.filename, target_dir_abs)

                # Chống va chạm duplicate normalized paths
                if dest_file in seen_destinations:
                    raise PathTraversalError(f"Phát hiện duplicate destination collision cho '{info.filename}'")
                seen_destinations.add(dest_file)

                # Tạo thư mục cha an toàn
                dest_file.parent.mkdir(parents=True, exist_ok=True)

                # Streaming write với byte counter
                ext = dest_file.suffix.lower()
                is_text = ext in TEXT_EXTENSIONS
                entry_bytes_read = 0

                with zf.open(info, "r") as src, open(dest_file, "wb") as dst:
                    while True:
                        chunk = src.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        chunk_len = len(chunk)
                        dst.write(chunk)
                        entry_bytes_read += chunk_len
                        actual_total_bytes += chunk_len
                        if is_text:
                            actual_text_bytes += chunk_len

                        # In-flight threshold enforcement
                        if actual_total_bytes > MAX_UNCOMPRESSED_TOTAL_BYTES:
                            raise ExcessiveArchiveSizeError(
                                f"Dung lượng giải nén thực tế vượt quá giới hạn {MAX_UNCOMPRESSED_TOTAL_BYTES} bytes."
                            )
                        if actual_text_bytes > MAX_UNCOMPRESSED_TEXT_BYTES:
                            raise ExcessiveArchiveSizeError(
                                f"Dung lượng văn bản giải nén thực tế vượt quá giới hạn {MAX_UNCOMPRESSED_TEXT_BYTES} bytes."
                            )

                # Kiểm tra in-flight decompression ratio trên từng file
                if info.compress_size > 0:
                    entry_ratio = entry_bytes_read / info.compress_size
                    if entry_ratio > MAX_COMPRESSION_RATIO and entry_bytes_read > 1024 * 1024:
                        raise ZipBombError(
                            f"File '{info.filename}' có tỷ lệ nén thực tế ({entry_ratio:.1f}:1) vượt quá giới hạn."
                        )

                extracted_files.append(dest_file)
                if is_text:
                    text_files.append(dest_file)
                elif ext in IMAGE_EXTENSIONS:
                    image_files.append(dest_file)

        return ExtractedNovelPackage(
            root_dir=target_dir_abs,
            all_files=extracted_files,
            text_files=text_files,
            image_files=image_files,
            total_uncompressed_bytes=actual_total_bytes,
        )

    @classmethod
    def extract_and_validate_epub(
        cls,
        epub_path: Path,
        output_dir: Path,
    ) -> ExtractedEpubChapter:
        """
        Trích xuất và thẩm định chặt chẽ file EPUB:
        - Đảm bảo tuân thủ cấu trúc chuẩn META-INF/container.xml và OPF package.
        - Enforce phạm vi Đơn Chương (Single-Chapter Scope): Spine chỉ được chứa đúng 1 item tài liệu nội dung.
        - Quét toàn diện chống External Resources (Fail-Closed nếu chứa link http/https ngoài internet).
        """
        package = cls.extract_single_chapter_archive(epub_path, output_dir)

        # 1. Tìm và parse container.xml
        container_path = package.root_dir / "META-INF" / "container.xml"
        if not container_path.exists():
            raise MalformedEpubError("EPUB không hợp lệ: thiếu file 'META-INF/container.xml'.")

        try:
            container_tree = ET.parse(container_path)
            rootfile_el = container_tree.find(".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile")
            if rootfile_el is None or "full-path" not in rootfile_el.attrib:
                rootfile_el = container_tree.find(".//rootfile")
            if rootfile_el is None or "full-path" not in rootfile_el.attrib:
                raise MalformedEpubError("EPUB container.xml không chứa thẻ rootfile hợp lệ.")
            opf_rel_path = rootfile_el.attrib["full-path"]
        except Exception as e:
            raise MalformedEpubError(f"Không thể parse container.xml của EPUB: {e}") from e

        opf_path = (package.root_dir / opf_rel_path).resolve()
        if not opf_path.exists():
            raise MalformedEpubError(f"Không tìm thấy file OPF tại đường dẫn khai báo: '{opf_rel_path}'")

        # 2. Parse OPF file (Manifest, Spine, Metadata)
        try:
            opf_tree = ET.parse(opf_path)
            opf_root = opf_tree.getroot()
        except Exception as e:
            raise MalformedEpubError(f"Không thể parse file OPF '{opf_path}': {e}") from e

        # Extract title & language
        title = None
        language = None
        for el in opf_root.iter():
            tag = el.tag.lower()
            if tag.endswith("title") and el.text:
                title = el.text.strip()
            elif tag.endswith("language") and el.text:
                language = el.text.strip()

        # Parse Manifest items
        manifest_items: Dict[str, str] = {}
        for item in opf_root.iter():
            if item.tag.lower().endswith("item"):
                item_id = item.attrib.get("id")
                href = item.attrib.get("href")
                if item_id and href:
                    manifest_items[item_id] = href

        # Parse Spine itemrefs
        spine_itemrefs: List[str] = []
        for itemref in opf_root.iter():
            if itemref.tag.lower().endswith("itemref"):
                idref = itemref.attrib.get("idref")
                if idref:
                    spine_itemrefs.append(idref)

        if not spine_itemrefs:
            raise MalformedEpubError("EPUB spine không chứa bất kỳ itemref nào.")

        # Lọc các spine items là tài liệu nội dung (XHTML / HTML)
        opf_dir = opf_path.parent
        content_docs: List[Path] = []

        for idref in spine_itemrefs:
            href = manifest_items.get(idref)
            if not href:
                continue
            doc_path = (opf_dir / href).resolve()
            if doc_path.exists() and doc_path.suffix.lower() in (".xhtml", ".html", ".htm", ".xml"):
                content_docs.append(doc_path)

        if not content_docs:
            raise MalformedEpubError("Không tìm thấy file nội dung XHTML/HTML nào trong EPUB spine.")

        # INVARIANT: Single-Chapter EPUB Scope
        if len(content_docs) > 1:
            raise MultiChapterPackageError(
                f"EPUB chứa {len(content_docs)} chương/tài liệu trong spine. "
                "Scope của Vertical Slice 3 yêu cầu Single-Chapter Package (1 Chapter = 1 Job)."
            )

        content_html = content_docs[0]

        # 3. Quét toàn diện External Resource Reference trong nội dung HTML (Fail-Closed)
        html_content = content_html.read_text(encoding="utf-8", errors="replace")
        cls._validate_no_external_resources(html_content, content_html.name)

        # 4. Map ảnh minh họa nội bộ
        image_assets: Dict[str, Path] = {}
        for item_id, href in manifest_items.items():
            ext = Path(href).suffix.lower()
            if ext in IMAGE_EXTENSIONS:
                img_path = (opf_dir / href).resolve()
                if img_path.exists() and img_path.is_relative_to(package.root_dir):
                    image_assets[href] = img_path

        return ExtractedEpubChapter(
            content_html_path=content_html,
            title=title,
            language=language,
            image_assets=image_assets,
            total_uncompressed_bytes=package.total_uncompressed_bytes,
        )

    @staticmethod
    def _validate_no_external_resources(content: str, filename: str) -> None:
        """
        Kiểm tra và fail-closed nếu tài liệu tham chiếu tới tài nguyên từ xa trên Internet.
        """
        matches = EXTERNAL_URL_PATTERN.findall(content)
        if matches:
            raise ExternalResourceForbiddenError(
                f"Tài liệu '{filename}' chứa liên kết tài nguyên từ xa bị cấm ({matches[:3]}). "
                "Tất cả tài nguyên của chương phải là local assets trong package."
            )

from pathlib import Path
from typing import Dict
from PIL import ImageFont

_DEFAULT_FONT_PATH = Path(__file__).parent / "fonts" / "manga_default.ttf"


class FontManager:
    """
    Quản lý và nạp TrueType font bất biến, deterministic 100%:
    - Luôn nạp font pinned manga_default.ttf đi kèm repo.
    - Fail-fast ngay nếu thiếu font file, tuyệt đối không dùng OS fallback không kiểm soát.
    - Caching font instances theo kích cỡ font_size.
    """

    def __init__(self, font_path: Path = _DEFAULT_FONT_PATH):
        self.font_path = Path(font_path)
        if not self.font_path.exists():
            raise RuntimeError(
                f"PRODUCTION_FONT_NOT_FOUND: Không tìm thấy pinned TrueType font tại {self.font_path}. "
                "Production yêu cầu font cố định để đảm bảo render deterministic."
            )
        self._cache: Dict[int, ImageFont.FreeTypeFont] = {}

    def get_font(self, size: int) -> ImageFont.FreeTypeFont:
        """Lấy FreeTypeFont instance tương ứng với kích thước size."""
        if size not in self._cache:
            self._cache[size] = ImageFont.truetype(str(self.font_path), size=size)
        return self._cache[size]

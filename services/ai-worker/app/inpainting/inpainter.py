import cv2
import numpy as np


class MangaInpainter:
    """
    Engine Inpainting xóa chữ thoại Manga:
    - Thuật toán OpenCV Telea Fast Inpainting.
    - Pixel Invariance: Pixel ở các vùng mask == 0 được bảo toàn tuyệt đối 100%.
    """

    def inpaint(
        self,
        image_bgr: np.ndarray,
        mask: np.ndarray,
        inpaint_radius: int = 3,
    ) -> np.ndarray:
        """
        Thực thi inpaint trên image_bgr bằng mask nhị phân (255: vùng cần xóa).
        """
        if mask is None or np.count_nonzero(mask) == 0:
            return image_bgr.copy()

        if image_bgr.shape[:2] != mask.shape[:2]:
            raise ValueError(
                f"Kích thước ảnh {image_bgr.shape[:2]} và mask {mask.shape[:2]} không khớp."
            )

        inpainted = cv2.inpaint(
            image_bgr,
            mask,
            inpaintRadius=inpaint_radius,
            flags=cv2.INPAINT_TELEA,
        )

        # Invariant: Khôi phục chính xác 100% pixel gốc ở vùng mask == 0
        unmodified_mask = (mask == 0)
        inpainted[unmodified_mask] = image_bgr[unmodified_mask]

        return inpainted

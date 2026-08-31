import { apiClient } from './client';
import { ChapterDetailResponse } from '@omninovel/shared';

export interface PresignedMediaUrlResponse {
  assetId: string;
  downloadUrl: string;
  expiresInSeconds: number;
}

/**
 * Lấy thông tin chi tiết chương truyện phục vụ trình đọc (Reader)
 * Hỗ trợ chuyển đổi phiên bản bản dịch qua tham số versionId
 */
export async function getChapterDetailApi(
  chapterId: string,
  versionId?: string,
): Promise<ChapterDetailResponse> {
  const url = versionId
    ? `/chapters/${chapterId}?versionId=${encodeURIComponent(versionId)}`
    : `/chapters/${chapterId}`;

  const response = await apiClient.get<ChapterDetailResponse>(url);
  return response.data;
}

/**
 * Lấy Presigned GET URL mới cho media asset khi token URL cũ (900s) hết hạn
 */
export async function getMediaPresignedUrlApi(
  assetId: string,
): Promise<PresignedMediaUrlResponse> {
  const response = await apiClient.get<PresignedMediaUrlResponse>(`/storage/media-url/${assetId}`);
  return response.data;
}

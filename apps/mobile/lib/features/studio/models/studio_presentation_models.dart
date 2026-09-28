import 'studio_models.dart';

class MangaPreviewPair {
  final int pageNumber;
  final ReviewAssetDto? sourceAsset;
  final ReviewAssetDto? resultAsset;

  const MangaPreviewPair({
    required this.pageNumber,
    this.sourceAsset,
    this.resultAsset,
  });

  bool get hasBoth => sourceAsset != null && resultAsset != null;
  bool get hasSource => sourceAsset != null;
  bool get hasResult => resultAsset != null;

  /// Helper factory to pair source and result assets from TranslationJobPreviewsResponse
  static List<MangaPreviewPair> fromPreviewsResponse(TranslationJobPreviewsResponse response) {
    final Map<int, ReviewAssetDto> sourceByPage = {};
    for (final asset in response.sourceAssets) {
      sourceByPage[asset.pageNumber] = asset;
    }

    final Map<int, ReviewAssetDto> resultByPage = {};
    for (final asset in response.resultAssets) {
      resultByPage[asset.pageNumber] = asset;
    }

    final allPages = <int>{...sourceByPage.keys, ...resultByPage.keys}.toList()..sort();

    return allPages.map((page) {
      return MangaPreviewPair(
        pageNumber: page,
        sourceAsset: sourceByPage[page],
        resultAsset: resultByPage[page],
      );
    }).toList();
  }
}

import 'package:flutter/material.dart';
import '../../models/studio_models.dart';
import '../../models/studio_presentation_models.dart';
import '../../repositories/studio_repository.dart';

enum PreviewMode { source, result }

class MangaPreviewComparisonView extends StatefulWidget {
  final StudioRepository repository;
  final String jobId;
  final int? initialPageCount;

  const MangaPreviewComparisonView({
    super.key,
    required this.repository,
    required this.jobId,
    this.initialPageCount,
  });

  @override
  State<MangaPreviewComparisonView> createState() => _MangaPreviewComparisonViewState();
}

class _MangaPreviewComparisonViewState extends State<MangaPreviewComparisonView> {
  late Future<TranslationJobPreviewsResponse> _previewsFuture;
  int _currentPageIndex = 0;
  PreviewMode _previewMode = PreviewMode.result;

  @override
  void initState() {
    super.initState();
    _loadPreviews();
  }

  void _loadPreviews() {
    _previewsFuture = widget.repository.getPreviews(widget.jobId);
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return FutureBuilder<TranslationJobPreviewsResponse>(
      future: _previewsFuture,
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }

        if (snapshot.hasError) {
          return Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.error_outline, size: 48, color: colorScheme.error),
                const SizedBox(height: 12),
                Text(
                  'Không thể tải ảnh xem trước:\n${snapshot.error}',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: colorScheme.error),
                ),
                const SizedBox(height: 12),
                ElevatedButton.icon(
                  onPressed: () => setState(_loadPreviews),
                  icon: const Icon(Icons.refresh),
                  label: const Text('Thử lại'),
                ),
              ],
            ),
          );
        }

        final previews = snapshot.data;
        if (previews == null) {
          return const Center(child: Text('Không có dữ liệu ảnh xem trước.'));
        }

        final pairs = MangaPreviewPair.fromPreviewsResponse(previews);
        if (pairs.isEmpty) {
          return const Center(child: Text('Không tìm thấy trang ảnh xem trước nào.'));
        }

        if (_currentPageIndex >= pairs.length) {
          _currentPageIndex = 0;
        }

        final currentPair = pairs[_currentPageIndex];
        final currentAsset = _previewMode == PreviewMode.result
            ? (currentPair.resultAsset ?? currentPair.sourceAsset)
            : (currentPair.sourceAsset ?? currentPair.resultAsset);

        return Column(
          children: [
            // Toolbar điều khiển: Toggle Mode & Page Counter
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              color: colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  // Nút gạt chế độ Trước / Sau
                  SegmentedButton<PreviewMode>(
                    segments: const [
                      ButtonSegment(
                        value: PreviewMode.source,
                        label: Text('Bản gốc'),
                        icon: Icon(Icons.image_outlined, size: 16),
                      ),
                      ButtonSegment(
                        value: PreviewMode.result,
                        label: Text('Dịch AI'),
                        icon: Icon(Icons.auto_awesome, size: 16),
                      ),
                    ],
                    selected: {_previewMode},
                    onSelectionChanged: (set) {
                      setState(() {
                        _previewMode = set.first;
                      });
                    },
                  ),

                  // Chỉ số trang
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    decoration: BoxDecoration(
                      color: colorScheme.surface,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: colorScheme.outlineVariant),
                    ),
                    child: Text(
                      'Trang ${currentPair.pageNumber} / ${pairs.length}',
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                    ),
                  ),
                ],
              ),
            ),

            // Khu vực hiển thị ảnh có Zoom & Pan (InteractiveViewer)
            Expanded(
              child: Container(
                color: Colors.black,
                width: double.infinity,
                child: currentAsset != null && currentAsset.url.isNotEmpty
                    ? InteractiveViewer(
                        minScale: 0.8,
                        maxScale: 4.0,
                        child: Center(
                          child: Image.network(
                            currentAsset.url,
                            fit: BoxFit.contain,
                            loadingBuilder: (context, child, progress) {
                              if (progress == null) return child;
                              return Center(
                                child: CircularProgressIndicator(
                                  value: progress.expectedTotalBytes != null
                                      ? progress.cumulativeBytesLoaded /
                                          progress.expectedTotalBytes!
                                      : null,
                                ),
                              );
                            },
                            errorBuilder: (context, error, stackTrace) {
                              return Center(
                                child: Column(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  children: [
                                    Icon(Icons.broken_image, size: 48, color: colorScheme.error),
                                    const SizedBox(height: 8),
                                    Text(
                                      'Không thể tải ảnh trang ${currentPair.pageNumber}',
                                      style: TextStyle(color: colorScheme.error),
                                    ),
                                  ],
                                ),
                              );
                            },
                          ),
                        ),
                      )
                    : const Center(
                        child: Text(
                          'Trang này chưa có ảnh xem trước.',
                          style: TextStyle(color: Colors.white70),
                        ),
                      ),
              ),
            ),

            // Thanh lật trang đáy
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              color: colorScheme.surface,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  IconButton.filledTonal(
                    onPressed: _currentPageIndex > 0
                        ? () => setState(() => _currentPageIndex--)
                        : null,
                    icon: const Icon(Icons.arrow_back),
                    tooltip: 'Trang trước',
                  ),
                  Text(
                    'Vuốt hoặc dùng nút để chuyển trang',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: colorScheme.onSurfaceVariant,
                        ),
                  ),
                  IconButton.filledTonal(
                    onPressed: _currentPageIndex < pairs.length - 1
                        ? () => setState(() => _currentPageIndex++)
                        : null,
                    icon: const Icon(Icons.arrow_forward),
                    tooltip: 'Trang kế tiếp',
                  ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}

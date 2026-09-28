import 'package:flutter/material.dart';
import '../../models/studio_models.dart';
import '../../repositories/studio_repository.dart';

class NovelSegmentComparisonView extends StatefulWidget {
  final StudioRepository repository;
  final String jobId;

  const NovelSegmentComparisonView({
    super.key,
    required this.repository,
    required this.jobId,
  });

  @override
  State<NovelSegmentComparisonView> createState() => _NovelSegmentComparisonViewState();
}

class _NovelSegmentComparisonViewState extends State<NovelSegmentComparisonView> {
  int _currentPage = 1;
  static const int _limit = 30;
  late Future<TranslationJobSegmentsResponse> _segmentsFuture;

  @override
  void initState() {
    super.initState();
    _loadSegments();
  }

  void _loadSegments() {
    _segmentsFuture = widget.repository.getSegments(
      widget.jobId,
      page: _currentPage,
      limit: _limit,
    );
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return FutureBuilder<TranslationJobSegmentsResponse>(
      future: _segmentsFuture,
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
                  'Không thể tải phân đoạn đối chiếu:\n${snapshot.error}',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: colorScheme.error),
                ),
                const SizedBox(height: 12),
                ElevatedButton.icon(
                  onPressed: () => setState(_loadSegments),
                  icon: const Icon(Icons.refresh),
                  label: const Text('Thử lại'),
                ),
              ],
            ),
          );
        }

        final segmentsData = snapshot.data;
        if (segmentsData == null || segmentsData.data.isEmpty) {
          return const Center(child: Text('Không tìm thấy phân đoạn văn bản nào.'));
        }

        return Column(
          children: [
            // Thanh tiêu đề tóm tắt phân đoạn
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              color: colorScheme.surfaceContainerHighest.withValues(alpha: 0.4),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'Tổng cộng: ${segmentsData.total} đoạn',
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                          fontWeight: FontWeight.bold,
                        ),
                  ),
                  Text(
                    'Trang $_currentPage / ${segmentsData.totalPages}',
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: colorScheme.onSurfaceVariant,
                        ),
                  ),
                ],
              ),
            ),

            // Danh sách phân đoạn song ngữ
            Expanded(
              child: ListView.separated(
                padding: const EdgeInsets.all(16),
                itemCount: segmentsData.data.length,
                separatorBuilder: (context, index) => const Divider(height: 24),
                itemBuilder: (context, index) {
                  final seg = segmentsData.data[index];
                  return _buildSegmentCard(context, seg, index);
                },
              ),
            ),

            // Pagination Controls
            if (segmentsData.totalPages > 1)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                decoration: BoxDecoration(
                  color: colorScheme.surface,
                  border: Border(top: BorderSide(color: colorScheme.outlineVariant)),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    TextButton.icon(
                      onPressed: _currentPage > 1
                          ? () {
                              setState(() {
                                _currentPage--;
                                _loadSegments();
                              });
                            }
                          : null,
                      icon: const Icon(Icons.chevron_left),
                      label: const Text('Trang trước'),
                    ),
                    Text(
                      'Trang $_currentPage / ${segmentsData.totalPages}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    TextButton.icon(
                      onPressed: _currentPage < segmentsData.totalPages
                          ? () {
                              setState(() {
                                _currentPage++;
                                _loadSegments();
                              });
                            }
                          : null,
                      icon: const Icon(Icons.chevron_right),
                      label: const Text('Trang sau'),
                    ),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }

  Widget _buildSegmentCard(BuildContext context, TranslationSegmentDto seg, int index) {
    final colorScheme = Theme.of(context).colorScheme;

    return Card(
      elevation: 0,
      color: colorScheme.surfaceContainerHighest.withValues(alpha: 0.3),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: colorScheme.outlineVariant.withValues(alpha: 0.5)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header đoạn: Thứ tự, anchorBlockId và Verified badge
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: colorScheme.primaryContainer,
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        '#${seg.sortOrder}',
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.bold,
                          color: colorScheme.onPrimaryContainer,
                        ),
                      ),
                    ),
                    if (seg.anchorBlockId != null) ...[
                      const SizedBox(width: 6),
                      Text(
                        seg.anchorBlockId!,
                        style: TextStyle(fontSize: 11, color: colorScheme.outline),
                      ),
                    ],
                  ],
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: seg.isHumanVerified
                        ? Colors.green.withValues(alpha: 0.15)
                        : Colors.amber.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Row(
                    children: [
                      Icon(
                        seg.isHumanVerified ? Icons.verified : Icons.smart_toy_outlined,
                        size: 12,
                        color: seg.isHumanVerified ? Colors.green : Colors.amber.shade800,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        seg.isHumanVerified ? 'Đã xác nhận' : 'AI dịch thô',
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: seg.isHumanVerified ? Colors.green : Colors.amber.shade800,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),

            // Văn bản gốc (rawText)
            Text(
              'Bản gốc:',
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.bold,
                color: colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              seg.rawText,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    fontStyle: FontStyle.italic,
                    color: colorScheme.onSurfaceVariant,
                  ),
            ),
            const SizedBox(height: 8),

            // Bản dịch AI (translatedText)
            Text(
              'Bản dịch tiếng Việt:',
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.bold,
                color: colorScheme.primary,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              seg.translatedText ?? '(Chưa có bản dịch)',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w500,
                  ),
            ),
          ],
        ),
      ),
    );
  }
}

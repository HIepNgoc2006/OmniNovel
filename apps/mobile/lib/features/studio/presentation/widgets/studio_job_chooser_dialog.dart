import 'package:flutter/material.dart';
import '../../models/studio_models.dart';

class StudioJobChooserDialog extends StatelessWidget {
  final String chapterNumber;
  final List<TranslationJobSummaryDto> jobs;
  final ValueChanged<TranslationJobSummaryDto> onJobSelected;

  const StudioJobChooserDialog({
    super.key,
    required this.chapterNumber,
    required this.jobs,
    required this.onJobSelected,
  });

  static Future<TranslationJobSummaryDto?> show(
    BuildContext context, {
    required String chapterNumber,
    required List<TranslationJobSummaryDto> jobs,
  }) {
    return showModalBottomSheet<TranslationJobSummaryDto>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) {
        return StudioJobChooserDialog(
          chapterNumber: chapterNumber,
          jobs: jobs,
          onJobSelected: (job) => Navigator.of(context).pop(job),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Handle bar
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: colorScheme.outlineVariant,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 16),

            Text(
              'Chọn bản dịch AI cần duyệt',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
            ),
            const SizedBox(height: 4),
            Text(
              'Chương $chapterNumber có ${jobs.length} bản dịch AI đã hoàn thành. Vui lòng chọn bản dịch bạn muốn xem trước & phê duyệt:',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: colorScheme.onSurfaceVariant,
                  ),
            ),
            const SizedBox(height: 16),

            Flexible(
              child: ListView.separated(
                shrinkWrap: true,
                itemCount: jobs.length,
                separatorBuilder: (context, index) => const SizedBox(height: 10),
                itemBuilder: (context, index) {
                  final job = jobs[index];
                  final lang = job.targetLanguage?.toUpperCase() ?? 'VI';
                  final model = job.modelName ?? 'AI Model';

                  return Card(
                    elevation: 0,
                    color: colorScheme.surfaceContainerHighest.withValues(alpha: 0.35),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                      side: BorderSide(color: colorScheme.outlineVariant.withValues(alpha: 0.6)),
                    ),
                    child: ListTile(
                      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                      leading: CircleAvatar(
                        backgroundColor: colorScheme.primaryContainer,
                        child: Icon(Icons.auto_awesome, color: colorScheme.primary, size: 20),
                      ),
                      title: Text(
                        'Bản dịch tiếng $lang ($model)',
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                      ),
                      subtitle: Text(
                        job.completedAt != null
                            ? 'Hoàn tất lúc: ${_formatDate(job.completedAt!)}'
                            : 'Trạng thái: Sẵn sàng duyệt',
                        style: TextStyle(fontSize: 12, color: colorScheme.onSurfaceVariant),
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => onJobSelected(job),
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _formatDate(DateTime dt) {
    return '${dt.day.toString().padLeft(2, '0')}/${dt.month.toString().padLeft(2, '0')}/${dt.year} ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }
}

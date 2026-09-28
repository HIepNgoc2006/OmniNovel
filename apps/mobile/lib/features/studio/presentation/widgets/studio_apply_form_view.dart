import 'package:flutter/material.dart';
import '../../models/studio_models.dart';
import '../controllers/studio_approval_controller.dart';

class StudioApplyFormView extends StatelessWidget {
  final StudioApprovalController controller;
  final VoidCallback? onApplySuccess;

  const StudioApplyFormView({
    super.key,
    required this.controller,
    this.onApplySuccess,
  });

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final colorScheme = Theme.of(context).colorScheme;
        final detail = controller.jobDetail;
        final summary = detail.reviewSummary;

        return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 1. Tóm tắt thông tin bản dịch
          Text(
            'Thông tin bản dịch AI',
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: colorScheme.surfaceContainerHighest.withValues(alpha: 0.4),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: colorScheme.outlineVariant),
            ),
            child: Column(
              children: [
                _buildInfoRow('Tác phẩm:', detail.context.story.title),
                const SizedBox(height: 8),
                _buildInfoRow('Chương:', 'Chương ${detail.context.chapter.chapterNumber} ${detail.context.chapter.title ?? ''}'),
                const SizedBox(height: 8),
                _buildInfoRow('Ngôn ngữ:', '${detail.context.project.sourceLanguage.toUpperCase()} ➔ ${detail.context.project.targetLanguage.toUpperCase()}'),
                const SizedBox(height: 8),
                _buildInfoRow('Mô hình AI:', detail.job.modelName),
                const Divider(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceAround,
                  children: [
                    _buildStatBadge(
                      context,
                      'Tiến độ',
                      '${detail.job.progressPercentage}%',
                      Colors.blue,
                    ),
                    _buildStatBadge(
                      context,
                      'Đoạn dịch',
                      '${summary.verifiedCount}/${summary.segmentCount}',
                      Colors.green,
                    ),
                    if (summary.pageCount != null)
                      _buildStatBadge(
                        context,
                        'Số trang',
                        '${summary.pageCount}',
                        Colors.purple,
                      ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),

          // 2. Gate 2: Server-Authoritative Permission Check
          if (!detail.permissions.canApply) ...[
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Colors.red.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Colors.red.withValues(alpha: 0.3)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.gpp_bad_outlined, color: Colors.red, size: 24),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'Bạn không có quyền áp dụng bản dịch cho tác phẩm này (${detail.permissions.applyBlockReason ?? "INSUFFICIENT_ROLE"}). Chỉ OWNER/EDITOR mới có thể phê duyệt.',
                      style: const TextStyle(color: Colors.red, fontSize: 13),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),
          ],

          // 3. Gate 4: Canonical Freshness Gate Warning
          if (!controller.isFresh) ...[
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Colors.amber.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Colors.amber.withValues(alpha: 0.4)),
              ),
              child: Row(
                children: [
                  Icon(Icons.warning_amber_rounded, color: Colors.amber.shade900, size: 24),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'Bản dịch đang được cập nhật/materialize lại trên máy chủ (Review rev: ${detail.job.reviewRevision} != Mat rev: ${detail.job.materializedRevision}). Vui lòng làm mới sau ít phút.',
                      style: TextStyle(color: Colors.amber.shade900, fontSize: 13),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),
          ],

          // 4. Gate 5: Explicit Mode Selection
          Text(
            'Chọn chế độ xuất bản',
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
          ),
          const SizedBox(height: 8),
          Text(
            'Vui lòng chọn phương thức xuất bản phù hợp trước khi xác nhận:',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colorScheme.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 12),

          // Option A: OVERWRITE_ACTIVE_VERSION
          _buildModeCard(
            context: context,
            mode: ApplyTranslationMode.overwriteActiveVersion,
            title: 'Ghi đè phiên bản chính (Recommended)',
            subtitle: 'Thay thế bản dịch hiện tại thành bản dịch chính thức mới. Độc giả sẽ đọc ngay phiên bản này.',
            icon: Icons.published_with_changes,
          ),
          const SizedBox(height: 10),

          // Option B: CREATE_ALTERNATE_VERSION
          _buildModeCard(
            context: context,
            mode: ApplyTranslationMode.createAlternateVersion,
            title: 'Tạo phiên bản song song (Alternate Version)',
            subtitle: 'Lưu bản dịch AI dưới dạng phiên bản phụ, giữ nguyên phiên bản chính hiện tại.',
            icon: Icons.alt_route,
          ),
          const SizedBox(height: 24),

          // 5. State feedback banners
          if (controller.status == StudioApprovalStatus.submissionOutcomeUnknown) ...[
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Colors.orange.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Colors.orange.withValues(alpha: 0.5)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.sync_problem, color: Colors.orange, size: 24),
                      const SizedBox(width: 8),
                      Text(
                        'Kết nối mạng gián đoạn',
                        style: TextStyle(color: Colors.orange.shade900, fontWeight: FontWeight.bold),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    controller.errorMessage ??
                        'Yêu cầu xuất bản có thể đã được máy chủ tiếp nhận. Vui lòng bấm nút bên dưới để đối soát kết quả.',
                    style: TextStyle(color: Colors.orange.shade900, fontSize: 13),
                  ),
                  const SizedBox(height: 10),
                  ElevatedButton.icon(
                    onPressed: controller.reconcile,
                    icon: const Icon(Icons.refresh),
                    label: const Text('Đối soát trạng thái ngay'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.orange.shade800,
                      foregroundColor: Colors.white,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
          ],

          if (controller.status == StudioApprovalStatus.committedReconciliationRequired) ...[
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Colors.amber.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Colors.amber.shade700),
              ),
              child: Row(
                children: [
                  Icon(Icons.report_problem, color: Colors.amber.shade900, size: 24),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      controller.errorMessage ?? 'Phát hiện sai lệch tính nhất quán phiên bản.',
                      style: TextStyle(color: Colors.amber.shade900, fontSize: 13),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
          ],

          if (controller.status == StudioApprovalStatus.succeeded) ...[
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.green.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Colors.green.withValues(alpha: 0.5)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.check_circle, color: Colors.green, size: 32),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Xuất bản thành công!',
                          style: TextStyle(
                            color: Colors.green,
                            fontWeight: FontWeight.bold,
                            fontSize: 16,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'Bản dịch mới đã được áp dụng làm phiên bản chính thức (v${controller.applyResponse?.versionNumber ?? 2}).',
                          style: const TextStyle(fontSize: 13),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
          ],

          if (controller.status == StudioApprovalStatus.failed &&
              controller.status != StudioApprovalStatus.submissionOutcomeUnknown) ...[
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Colors.red.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Colors.red.withValues(alpha: 0.3)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.error, color: Colors.red, size: 24),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      controller.errorMessage ?? 'Đã xảy ra lỗi trong quá trình phê duyệt.',
                      style: const TextStyle(color: Colors.red, fontSize: 13),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
          ],

          // 6. Action Button CTA
          SizedBox(
            width: double.infinity,
            height: 52,
            child: ElevatedButton(
              onPressed: controller.isApplyEnabled
                  ? () async {
                      await controller.submitApply();
                      if (controller.status == StudioApprovalStatus.succeeded) {
                        onApplySuccess?.call();
                      }
                    }
                  : null,
              style: ElevatedButton.styleFrom(
                backgroundColor: colorScheme.primary,
                foregroundColor: colorScheme.onPrimary,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              child: (controller.status == StudioApprovalStatus.submitting ||
                      controller.status == StudioApprovalStatus.reconciling)
                  ? const Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                        ),
                        SizedBox(width: 12),
                        Text('Đang xử lý xuất bản...'),
                      ],
                    )
                  : Text(
                      controller.selectedMode == null
                          ? 'Vui lòng chọn chế độ xuất bản'
                          : 'Xác nhận & Xuất bản',
                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold),
                    ),
            ),
          ),
        ],
      ),
    );
      },
    );
  }

  Widget _buildModeCard({
    required BuildContext context,
    required ApplyTranslationMode mode,
    required String title,
    required String subtitle,
    required IconData icon,
  }) {
    final colorScheme = Theme.of(context).colorScheme;
    final isSelected = controller.selectedMode == mode;

    return InkWell(
      onTap: controller.canSelectMode ? () => controller.selectMode(mode) : null,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: isSelected
              ? colorScheme.primaryContainer.withValues(alpha: 0.3)
              : colorScheme.surfaceContainerHighest.withValues(alpha: 0.2),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: isSelected ? colorScheme.primary : colorScheme.outlineVariant,
            width: isSelected ? 2 : 1,
          ),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Icon(
                isSelected ? Icons.radio_button_checked : Icons.radio_button_off,
                color: isSelected ? colorScheme.primary : colorScheme.outline,
                size: 22,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(icon, size: 18, color: isSelected ? colorScheme.primary : colorScheme.onSurface),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          title,
                          style: TextStyle(
                            fontWeight: FontWeight.bold,
                            color: isSelected ? colorScheme.primary : colorScheme.onSurface,
                            fontSize: 14,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    subtitle,
                    style: TextStyle(
                      color: colorScheme.onSurfaceVariant,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildInfoRow(String label, String value) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(label, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            value,
            textAlign: TextAlign.end,
            style: const TextStyle(fontSize: 13),
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }

  Widget _buildStatBadge(BuildContext context, String label, String value, Color color) {
    return Column(
      children: [
        Text(label, style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.outline)),
        const SizedBox(height: 2),
        Text(
          value,
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.bold,
            color: color,
          ),
        ),
      ],
    );
  }
}

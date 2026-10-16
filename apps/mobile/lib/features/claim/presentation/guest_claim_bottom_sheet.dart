import 'package:flutter/material.dart';
import '../../../core/claim/guest_claim_coordinator.dart';
import '../../../core/claim/models/guest_claim_models.dart';

class GuestClaimBottomSheet extends StatefulWidget {
  final GuestClaimCoordinator coordinator;
  final String userId;

  const GuestClaimBottomSheet({
    super.key,
    required this.coordinator,
    required this.userId,
  });

  @override
  State<GuestClaimBottomSheet> createState() => _GuestClaimBottomSheetState();
}

class _GuestClaimBottomSheetState extends State<GuestClaimBottomSheet> {
  final Map<String, ConflictResolution> _conflictDecisions = {};

  @override
  void initState() {
    super.initState();
    final conflicts = widget.coordinator.previewData?.conflicts ?? [];
    for (final conflict in conflicts) {
      _conflictDecisions[conflict.storyId] = ConflictResolution.keepCloud;
    }
  }

  void _onConfirm() {
    if (widget.coordinator.isCommitting) return;
    widget.coordinator.confirmClaim(widget.userId, _conflictDecisions);
  }

  void _onSkip() {
    if (widget.coordinator.isCommitting) return;
    widget.coordinator.skipClaim(widget.userId);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.coordinator,
      builder: (context, _) {
        final coordinator = widget.coordinator;
        final preview = coordinator.previewData;
        final isCommitting = coordinator.isCommitting;
        final error = coordinator.error;

        return PopScope(
          canPop: !isCommitting,
          child: Container(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surface,
              borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withOpacity(0.3),
                  blurRadius: 16,
                  offset: const Offset(0, -4),
                ),
              ],
            ),
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Handle bar
                  Center(
                    child: Container(
                      width: 40,
                      height: 4,
                      decoration: BoxDecoration(
                        color: Colors.grey.withOpacity(0.3),
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),

                  // Header
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: Theme.of(context).colorScheme.primary.withOpacity(0.12),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Icon(
                          Icons.cloud_sync_rounded,
                          color: Theme.of(context).colorScheme.primary,
                          size: 28,
                        ),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Đồng bộ dữ liệu khách',
                              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                                    fontWeight: FontWeight.bold,
                                  ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              'Chuyển truyện đã lưu và tiến độ đọc vào tài khoản của bạn',
                              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                    color: Colors.grey,
                                  ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),

                  // Metrics summary card
                  if (preview != null)
                    Container(
                      padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 12),
                      decoration: BoxDecoration(
                        color: Theme.of(context).colorScheme.surfaceVariant.withOpacity(0.4),
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(
                          color: Theme.of(context).dividerColor.withOpacity(0.1),
                        ),
                      ),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceAround,
                        children: [
                          _buildMetricItem(
                            context,
                            icon: Icons.bookmark_added_rounded,
                            count: preview.bookmarksToImport,
                            label: 'Đánh dấu',
                          ),
                          _buildDivider(),
                          _buildMetricItem(
                            context,
                            icon: Icons.history_rounded,
                            count: preview.historyToImport,
                            label: 'Lịch sử đọc',
                          ),
                          _buildDivider(),
                          _buildMetricItem(
                            context,
                            icon: Icons.auto_stories_rounded,
                            count: preview.progressToImport,
                            label: 'Tiến độ đọc',
                          ),
                        ],
                      ),
                    ),
                  const SizedBox(height: 20),

                  // Conflicts section
                  if (preview != null && preview.conflicts.isNotEmpty) ...[
                    Text(
                      'Xung đột tiến độ đọc (${preview.conflicts.length})',
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.bold,
                            color: Colors.amber,
                          ),
                    ),
                    const SizedBox(height: 8),
                    ...preview.conflicts.map((conflict) {
                      final selected = _conflictDecisions[conflict.storyId] ?? ConflictResolution.keepCloud;
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: Material(
                          color: Theme.of(context).colorScheme.surfaceVariant.withOpacity(0.2),
                          borderRadius: BorderRadius.circular(12),
                          child: Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(
                                color: Colors.amber.withOpacity(0.3),
                              ),
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  conflict.storyId,
                                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                                        fontWeight: FontWeight.bold,
                                      ),
                                ),
                                const SizedBox(height: 8),
                                RadioListTile<ConflictResolution>(
                                  key: Key('conflict_radio_keep_cloud_${conflict.storyId}'),
                                  contentPadding: EdgeInsets.zero,
                                  dense: true,
                                  title: Text(
                                    'Giữ bản tài khoản (${conflict.cloudProgress.progressPercentage.toStringAsFixed(0)}%)',
                                    style: const TextStyle(fontSize: 13),
                                  ),
                                  value: ConflictResolution.keepCloud,
                                  groupValue: selected,
                                  onChanged: isCommitting
                                      ? null
                                      : (val) {
                                          if (val != null) {
                                            setState(() {
                                              _conflictDecisions[conflict.storyId] = val;
                                            });
                                          }
                                        },
                                ),
                                RadioListTile<ConflictResolution>(
                                  key: Key('conflict_radio_use_guest_${conflict.storyId}'),
                                  contentPadding: EdgeInsets.zero,
                                  dense: true,
                                  title: Text(
                                    'Ghi đè bằng bản thiết bị (${conflict.guestProgress.progressPercentage.toStringAsFixed(0)}%)',
                                    style: const TextStyle(fontSize: 13),
                                  ),
                                  value: ConflictResolution.useGuest,
                                  groupValue: selected,
                                  onChanged: isCommitting
                                      ? null
                                      : (val) {
                                          if (val != null) {
                                            setState(() {
                                              _conflictDecisions[conflict.storyId] = val;
                                            });
                                          }
                                        },
                                ),
                              ],
                            ),
                          ),
                        ),
                      );
                    }),

                    const SizedBox(height: 12),
                  ],

                  // Error banner
                  if (error != null) ...[
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Colors.red.withOpacity(0.12),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: Colors.red.withOpacity(0.4)),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.error_outline_rounded, color: Colors.red, size: 22),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              error,
                              style: const TextStyle(color: Colors.red, fontSize: 13),
                            ),
                          ),
                          TextButton(
                            key: const Key('retry_claim_button'),
                            onPressed: isCommitting ? null : _onConfirm,
                            child: const Text('Thử lại'),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                  ],

                  // Actions
                  ElevatedButton(
                    key: const Key('confirm_claim_button'),
                    onPressed: isCommitting ? null : _onConfirm,
                    style: ElevatedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: isCommitting
                        ? const SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text(
                            'Chuyển giao dữ liệu',
                            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
                          ),
                  ),
                  const SizedBox(height: 8),

                  TextButton(
                    key: const Key('skip_claim_button'),
                    onPressed: isCommitting ? null : _onSkip,
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                    ),
                    child: Text(
                      'Bỏ qua',
                      style: TextStyle(
                        color: isCommitting ? Colors.grey : Colors.grey[400],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildMetricItem(
    BuildContext context, {
    required IconData icon,
    required int count,
    required String label,
  }) {
    return Column(
      children: [
        Icon(icon, size: 22, color: Theme.of(context).colorScheme.primary),
        const SizedBox(height: 4),
        Text(
          '$count',
          style: Theme.of(context).textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.bold,
              ),
        ),
        Text(
          label,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Colors.grey,
                fontSize: 11,
              ),
        ),
      ],
    );
  }

  Widget _buildDivider() {
    return Container(
      width: 1,
      height: 36,
      color: Colors.grey.withOpacity(0.2),
    );
  }
}

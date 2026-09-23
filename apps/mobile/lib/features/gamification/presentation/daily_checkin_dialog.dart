import 'dart:async';
import 'package:flutter/material.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/theme/theme_tokens.dart';
import '../models/gamification_models.dart';
import '../repositories/gamification_repository.dart';

/// Hộp thoại Điểm Danh Hàng Ngày (Daily Check-in Streak)
/// Tích hợp Monotonic Stopwatch Countdown chống lệch đồng hồ thiết bị (Clock-skew resistant)
class DailyCheckinDialog extends StatefulWidget {
  final GamificationRepository repository;
  final UserProgression progression;
  final VoidCallback? onCheckinSuccess;

  const DailyCheckinDialog({
    super.key,
    required this.repository,
    required this.progression,
    this.onCheckinSuccess,
  });

  static Future<void> show(
    BuildContext context, {
    required GamificationRepository repository,
    required UserProgression progression,
    VoidCallback? onCheckinSuccess,
  }) {
    return showDialog(
      context: context,
      barrierDismissible: true,
      builder: (context) => DailyCheckinDialog(
        repository: repository,
        progression: progression,
        onCheckinSuccess: onCheckinSuccess,
      ),
    );
  }

  @override
  State<DailyCheckinDialog> createState() => _DailyCheckinDialogState();
}

class _DailyCheckinDialogState extends State<DailyCheckinDialog> {
  late bool _hasCheckedInToday;
  late int _currentStreak;
  late int _initialSecondsRemaining;
  Stopwatch? _countdownStopwatch;
  Timer? _tickerTimer;
  bool _isSubmitting = false;
  String? _successMessage;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _hasCheckedInToday = widget.progression.hasCheckedInToday;
    _currentStreak = widget.progression.currentStreak;
    _initialSecondsRemaining = widget.progression.secondsUntilNextCheckin;

    if (_hasCheckedInToday && _initialSecondsRemaining > 0) {
      _startMonotonicCountdown();
    }
  }

  void _startMonotonicCountdown() {
    _countdownStopwatch?.stop();
    _countdownStopwatch = Stopwatch()..start();
    _tickerTimer?.cancel();
    _tickerTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) {
        final elapsed = _countdownStopwatch?.elapsed.inSeconds ?? 0;
        if (elapsed >= _initialSecondsRemaining) {
          _tickerTimer?.cancel();
          setState(() {});
        } else {
          setState(() {});
        }
      }
    });
  }

  int get _currentRemainingSeconds {
    if (_countdownStopwatch == null) return _initialSecondsRemaining;
    final remaining = _initialSecondsRemaining - _countdownStopwatch!.elapsed.inSeconds;
    return remaining > 0 ? remaining : 0;
  }

  String _formatDuration(int totalSeconds) {
    final hours = (totalSeconds ~/ 3600).toString().padLeft(2, '0');
    final minutes = ((totalSeconds % 3600) ~/ 60).toString().padLeft(2, '0');
    final seconds = (totalSeconds % 60).toString().padLeft(2, '0');
    return '$hours:$minutes:$seconds';
  }

  Future<void> _handleCheckin() async {
    if (_isSubmitting || _hasCheckedInToday) return;

    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });

    try {
      final res = await widget.repository.checkIn();
      if (mounted) {
        setState(() {
          _hasCheckedInToday = true;
          _currentStreak = res.newStreak;
          _successMessage = res.message;
          _isSubmitting = false;
        });

        // Lấy lại tiến trình để kích hoạt countdown canonical
        final updatedProg = await widget.repository.getProgression();
        if (mounted) {
          _initialSecondsRemaining = updatedProg.secondsUntilNextCheckin;
          _startMonotonicCountdown();
        }

        widget.onCheckinSuccess?.call();
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _errorMessage = e.toString().replaceAll('Exception: ', '');
          _isSubmitting = false;
        });
      }
    }
  }

  @override
  void dispose() {
    _countdownStopwatch?.stop();
    _tickerTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final primary = context.primaryColor;

    return Dialog(
      backgroundColor: AppColors.darkSurface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(20),
        side: const BorderSide(color: AppColors.darkBorder),
      ),
      child: Padding(
        padding: const EdgeInsets.all(20.0),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Header
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: primary.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(Icons.calendar_month, color: primary, size: 24),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Điểm danh nhận quà',
                        style: TextStyle(
                          color: AppColors.textPrimary,
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      Text(
                        'Chuỗi hiện tại: $_currentStreak ngày',
                        style: TextStyle(
                          color: primary,
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.close, color: AppColors.textMuted),
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ],
            ),
            const SizedBox(height: 16),

            // 7 Days Grid
            _buildDaysStreakGrid(primary),
            const SizedBox(height: 16),

            // Messages
            if (_successMessage != null) ...[
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color: AppColors.success.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.success.withValues(alpha: 0.3)),
                ),
                child: Text(
                  _successMessage!,
                  style: const TextStyle(color: AppColors.success, fontSize: 13),
                  textAlign: TextAlign.center,
                ),
              ),
              const SizedBox(height: 12),
            ],

            if (_errorMessage != null) ...[
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color: AppColors.error.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.error.withValues(alpha: 0.3)),
                ),
                child: Text(
                  _errorMessage!,
                  style: const TextStyle(color: AppColors.error, fontSize: 13),
                  textAlign: TextAlign.center,
                ),
              ),
              const SizedBox(height: 12),
            ],

            // Action Button / Countdown
            if (_hasCheckedInToday) ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 14),
                decoration: BoxDecoration(
                  color: AppColors.darkSurfaceElevated,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.darkBorder),
                ),
                child: Column(
                  children: [
                    const Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.check_circle, color: AppColors.success, size: 18),
                        SizedBox(width: 6),
                        Text(
                          'Đã điểm danh hôm nay',
                          style: TextStyle(
                            color: AppColors.success,
                            fontWeight: FontWeight.bold,
                            fontSize: 14,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'Lượt tiếp theo sau: ${_formatDuration(_currentRemainingSeconds)}',
                      style: const TextStyle(
                        color: AppColors.textSecondary,
                        fontSize: 12,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ],
                ),
              ),
            ] else ...[
              SizedBox(
                width: double.infinity,
                height: 48,
                child: ElevatedButton(
                  key: const Key('submit_checkin_button'),
                  onPressed: _isSubmitting ? null : _handleCheckin,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: primary,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: _isSubmitting
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : const Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.stars, color: Colors.white, size: 20),
                            SizedBox(width: 8),
                            Text(
                              'Điểm danh ngay (+10 EXP, +5 Xu)',
                              style: TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ],
                        ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildDaysStreakGrid(Color primary) {
    final streakIndex = (_currentStreak % 7);

    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: List.generate(7, (index) {
        final dayNumber = index + 1;
        final isCompleted = _hasCheckedInToday
            ? index < (_currentStreak == 0 ? 0 : ((_currentStreak - 1) % 7) + 1)
            : index < streakIndex;
        final isCurrent = !_hasCheckedInToday && index == streakIndex;
        final isDay7 = dayNumber == 7;

        return Expanded(
          child: Container(
            margin: const EdgeInsets.symmetric(horizontal: 2),
            padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 2),
            decoration: BoxDecoration(
              color: isCompleted
                  ? primary.withValues(alpha: 0.2)
                  : isCurrent
                      ? primary.withValues(alpha: 0.1)
                      : AppColors.darkSurfaceElevated,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: isCompleted || isCurrent
                    ? primary
                    : AppColors.darkBorder,
                width: isCurrent ? 1.5 : 1,
              ),
            ),
            child: Column(
              children: [
                Text(
                  'N$dayNumber',
                  style: TextStyle(
                    color: isCompleted || isCurrent ? primary : AppColors.textMuted,
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 4),
                Icon(
                  isCompleted
                      ? Icons.check
                      : isDay7
                          ? Icons.workspace_premium
                          : Icons.monetization_on,
                  color: isCompleted
                      ? AppColors.success
                      : isDay7
                          ? AppColors.gold
                          : AppColors.textSecondary,
                  size: 16,
                ),
                const SizedBox(height: 4),
                Text(
                  isDay7 ? '+20' : '+5',
                  style: TextStyle(
                    color: isCompleted ? AppColors.textPrimary : AppColors.textMuted,
                    fontSize: 10,
                  ),
                ),
              ],
            ),
          ),
        );
      }),
    );
  }
}

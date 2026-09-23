import 'package:flutter/material.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/theme/theme_tokens.dart';
import '../models/gamification_models.dart';
import '../repositories/gamification_repository.dart';

/// Thẻ Tiến Trình Cấp Độ MangaPass & Danh Sách Phần Thưởng Mốc Level
class MangaPassCard extends StatefulWidget {
  final UserProgression progression;
  final List<MilestoneRewardItem> rewards;
  final GamificationRepository repository;
  final VoidCallback? onRewardClaimed;

  const MangaPassCard({
    super.key,
    required this.progression,
    required this.rewards,
    required this.repository,
    this.onRewardClaimed,
  });

  @override
  State<MangaPassCard> createState() => _MangaPassCardState();
}

class _MangaPassCardState extends State<MangaPassCard> {
  final Set<int> _claimingMilestones = {};
  String? _errorMessage;

  Future<void> _claimReward(int milestoneLevel) async {
    if (_claimingMilestones.contains(milestoneLevel)) return;

    setState(() {
      _claimingMilestones.add(milestoneLevel);
      _errorMessage = null;
    });

    try {
      await widget.repository.claimLevelReward(milestoneLevel);
      if (mounted) {
        widget.onRewardClaimed?.call();
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _errorMessage = e.toString().replaceAll('Exception: ', '');
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          _claimingMilestones.remove(milestoneLevel);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final primary = context.primaryColor;
    final prog = widget.progression;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.darkSurface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.darkBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header: Cấp độ, Huy hiệu & Danh hiệu
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: primary.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: primary.withValues(alpha: 0.3)),
                ),
                child: Text(
                  'Cấp ${prog.level}',
                  style: TextStyle(
                    color: primary,
                    fontWeight: FontWeight.bold,
                    fontSize: 13,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  prog.rankTitle,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontWeight: FontWeight.bold,
                    fontSize: 15,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.bolt, color: AppColors.gold, size: 16),
                  const SizedBox(width: 2),
                  Text(
                    '${prog.totalExp} EXP',
                    style: const TextStyle(
                      color: AppColors.gold,
                      fontWeight: FontWeight.w600,
                      fontSize: 13,
                    ),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 12),

          // Thanh tiến trình EXP
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: LinearProgressIndicator(
              value: prog.progressPercent / 100.0,
              minHeight: 8,
              backgroundColor: AppColors.darkSurfaceElevated,
              valueColor: AlwaysStoppedAnimation<Color>(primary),
            ),
          ),
          const SizedBox(height: 6),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Tiến trình cấp: ${prog.currentLevelExp}/${prog.nextLevelExp} EXP',
                style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
              ),
              Text(
                '${prog.progressPercent}%',
                style: TextStyle(color: primary, fontSize: 11, fontWeight: FontWeight.bold),
              ),
            ],
          ),
          const SizedBox(height: 16),

          if (_errorMessage != null) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              margin: const EdgeInsets.only(bottom: 12),
              decoration: BoxDecoration(
                color: AppColors.error.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppColors.error.withValues(alpha: 0.3)),
              ),
              child: Text(
                _errorMessage!,
                style: const TextStyle(color: AppColors.error, fontSize: 12),
              ),
            ),
          ],

          // Tiêu đề Milestone Rewards
          const Text(
            'Phần thưởng mốc cấp độ (MangaPass)',
            style: TextStyle(
              color: AppColors.textPrimary,
              fontWeight: FontWeight.w600,
              fontSize: 13,
            ),
          ),
          const SizedBox(height: 10),

          // Danh sách cuộn ngang
          if (widget.rewards.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8.0),
              child: Text(
                'Chưa có phần thưởng mốc nào được cấu hình.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 12),
              ),
            )
          else
            SizedBox(
              height: 115,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: widget.rewards.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (context, index) {
                  final reward = widget.rewards[index];
                  final isClaiming = _claimingMilestones.contains(reward.milestoneLevel);

                  return Container(
                    width: 110,
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: reward.isClaimed
                          ? AppColors.darkSurfaceElevated.withValues(alpha: 0.5)
                          : reward.canClaim
                              ? primary.withValues(alpha: 0.1)
                              : AppColors.darkSurfaceElevated,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: reward.canClaim ? primary : AppColors.darkBorder,
                        width: reward.canClaim ? 1.5 : 1,
                      ),
                    ),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.flag, size: 14, color: primary),
                            const SizedBox(width: 4),
                            Text(
                              'Cấp ${reward.milestoneLevel}',
                              style: TextStyle(
                                color: primary,
                                fontWeight: FontWeight.bold,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(Icons.monetization_on, color: AppColors.gold, size: 14),
                            const SizedBox(width: 2),
                            Text(
                              '+${reward.rewardCoins}',
                              style: const TextStyle(
                                color: AppColors.textPrimary,
                                fontWeight: FontWeight.bold,
                                fontSize: 13,
                              ),
                            ),
                          ],
                        ),
                        SizedBox(
                          width: double.infinity,
                          height: 28,
                          child: ElevatedButton(
                            key: Key('claim_reward_btn_${reward.milestoneLevel}'),
                            onPressed: (reward.canClaim && !isClaiming)
                                ? () => _claimReward(reward.milestoneLevel)
                                : null,
                            style: ElevatedButton.styleFrom(
                              padding: EdgeInsets.zero,
                              backgroundColor: reward.isClaimed
                                  ? AppColors.darkBorder
                                  : primary,
                              foregroundColor: Colors.white,
                              disabledBackgroundColor: AppColors.darkBorder.withValues(alpha: 0.5),
                              disabledForegroundColor: AppColors.textMuted,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(6),
                              ),
                            ),
                            child: isClaiming
                                ? const SizedBox(
                                    width: 12,
                                    height: 12,
                                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                                  )
                                : Text(
                                    reward.isClaimed
                                        ? 'Đã nhận'
                                        : reward.canClaim
                                            ? 'Nhận'
                                            : 'Cần Lvl ${reward.milestoneLevel}',
                                    style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold),
                                  ),
                          ),
                        ),
                      ],
                    ),
                  );
                },
              ),
            ),
        ],
      ),
    );
  }
}

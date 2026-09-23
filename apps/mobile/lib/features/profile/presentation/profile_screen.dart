import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/auth/auth_service.dart';
import '../../auth/models/auth_models.dart';
import '../../../core/theme/theme_controller.dart';
import '../../../core/theme/theme_tokens.dart';
import '../../gamification/models/gamification_models.dart';
import '../../gamification/presentation/daily_checkin_dialog.dart';
import '../../gamification/presentation/mangapass_card.dart';
import '../../gamification/repositories/gamification_repository.dart';

/// Màn hình Hồ Sơ Cá Nhân & Quản Lý Gamification (Phase 5C.5)
class ProfileScreen extends StatefulWidget {
  final AuthService authService;
  final GamificationRepository gamificationRepository;

  const ProfileScreen({
    super.key,
    required this.authService,
    required this.gamificationRepository,
  });

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  UserProgression? _progression;
  List<MilestoneRewardItem> _rewards = [];
  List<RankThemeItem> _themes = [];
  bool _isLoading = true;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _loadProfileData();
  }

  Future<void> _loadProfileData({bool forceRefresh = false}) async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final results = await Future.wait([
        widget.gamificationRepository.getProgression(forceRefresh: forceRefresh),
        widget.gamificationRepository.getLevelRewards(forceRefresh: forceRefresh),
        widget.gamificationRepository.getThemes(forceRefresh: forceRefresh),
      ]);

      if (mounted) {
        setState(() {
          _progression = results[0] as UserProgression;
          _rewards = results[1] as List<MilestoneRewardItem>;
          _themes = results[2] as List<RankThemeItem>;
          _isLoading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _errorMessage = e.toString().replaceAll('Exception: ', '');
          _isLoading = false;
        });
      }
    }
  }

  Future<void> _handleThemeSwitch(String themeId, ThemeController themeController) async {
    if (themeController.currentThemeId == themeId) return;

    try {
      await themeController.setRankTheme(
        themeId,
        onSyncToServer: () => widget.gamificationRepository.changeRankTheme(themeId),
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Đã đổi sang chủ đề $themeId thành công!'),
            backgroundColor: AppColors.success,
            duration: const Duration(seconds: 1),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Không thể đổi chủ đề: ${e.toString()}'),
            backgroundColor: AppColors.error,
          ),
        );
      }
    }
  }

  void _showTransactionsSheet() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.darkSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) => _RewardTransactionsSheet(
        repository: widget.gamificationRepository,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final user = widget.authService.state.user;
    final primary = context.primaryColor;
    final themeController = Provider.of<ThemeController>(context);

    return Scaffold(
      backgroundColor: AppColors.oledBlack,
      appBar: AppBar(
        backgroundColor: AppColors.oledBlack,
        elevation: 0,
        title: const Text(
          'Hồ sơ cá nhân',
          style: TextStyle(
            color: AppColors.textPrimary,
            fontWeight: FontWeight.bold,
            fontSize: 18,
          ),
        ),
      ),
      body: _isLoading && _progression == null
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: () => _loadProfileData(forceRefresh: true),
              color: primary,
              backgroundColor: AppColors.darkSurfaceElevated,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_errorMessage != null) ...[
                    Container(
                      padding: const EdgeInsets.all(12),
                      margin: const EdgeInsets.only(bottom: 16),
                      decoration: BoxDecoration(
                        color: AppColors.error.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: AppColors.error.withValues(alpha: 0.3)),
                      ),
                      child: Text(
                        _errorMessage!,
                        style: const TextStyle(color: AppColors.error, fontSize: 13),
                      ),
                    ),
                  ],

                  // 1. User Info Header
                  _buildUserHeader(user, primary),
                  const SizedBox(height: 16),

                  // 2. OmniCoin Wallet Card
                  _buildWalletCard(primary),
                  const SizedBox(height: 16),

                  // 3. Daily Check-in Card
                  _buildCheckinCard(primary),
                  const SizedBox(height: 16),

                  // 4. MangaPass Progression Card
                  if (_progression != null) ...[
                    MangaPassCard(
                      progression: _progression!,
                      rewards: _rewards,
                      repository: widget.gamificationRepository,
                      onRewardClaimed: () => _loadProfileData(forceRefresh: true),
                    ),
                    const SizedBox(height: 16),
                  ],

                  // 5. Dynamic Rank Theme Selector
                  _buildThemeSelector(themeController),
                  const SizedBox(height: 16),

                  // 6. Settings (OLED Mode)
                  _buildSettingsSection(themeController),
                  const SizedBox(height: 24),

                  // 7. Logout Button
                  SizedBox(
                    width: double.infinity,
                    height: 48,
                    child: OutlinedButton.icon(
                      onPressed: () async {
                        widget.gamificationRepository.clearCache();
                        await widget.authService.logout();
                      },
                      icon: const Icon(Icons.logout, color: AppColors.error, size: 20),
                      label: const Text(
                        'Đăng xuất',
                        style: TextStyle(
                          color: AppColors.error,
                          fontWeight: FontWeight.bold,
                          fontSize: 15,
                        ),
                      ),
                      style: OutlinedButton.styleFrom(
                        side: const BorderSide(color: AppColors.error),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 32),
                ],
              ),
            ),
    );
  }

  Widget _buildUserHeader(User? user, Color primary) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.darkSurface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.darkBorder),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 30,
            backgroundColor: primary.withValues(alpha: 0.2),
            child: Icon(Icons.person, color: primary, size: 36),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  user?.username ?? 'Độc Giả',
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 17,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  user?.email ?? '',
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                        color: primary.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        'Cấp ${_progression?.level ?? 1}',
                        style: TextStyle(
                          color: primary,
                          fontSize: 11,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      _progression?.rankTitle ?? 'Độc Giả',
                      style: const TextStyle(
                        color: AppColors.textMuted,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildWalletCard(Color primary) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.darkSurface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.darkBorder),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppColors.gold.withValues(alpha: 0.15),
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.monetization_on, color: AppColors.gold, size: 24),
              ),
              const SizedBox(width: 12),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Ví OmniCoin',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 12),
                  ),
                  Text(
                    '${_progression?.omnicoinBalance ?? '0'} Xu',
                    style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ],
              ),
            ],
          ),
          TextButton.icon(
            key: const Key('wallet_history_button'),
            onPressed: _showTransactionsSheet,
            icon: Icon(Icons.history, color: primary, size: 18),
            label: Text(
              'Lịch sử',
              style: TextStyle(color: primary, fontWeight: FontWeight.w600, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildCheckinCard(Color primary) {
    final checkedIn = _progression?.hasCheckedInToday ?? false;

    return InkWell(
      onTap: () {
        if (_progression != null) {
          DailyCheckinDialog.show(
            context,
            repository: widget.gamificationRepository,
            progression: _progression!,
            onCheckinSuccess: () => _loadProfileData(forceRefresh: true),
          );
        }
      },
      borderRadius: BorderRadius.circular(16),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.darkSurface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.darkBorder),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: primary.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(Icons.calendar_today, color: primary, size: 22),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Điểm danh mỗi ngày',
                    style: TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 14,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    checkedIn
                        ? 'Đã điểm danh hôm nay (Chuỗi ${_progression?.currentStreak ?? 0} ngày)'
                        : 'Chưa điểm danh hôm nay. Nhận ngay +10 EXP, +5 Xu!',
                    style: TextStyle(
                      color: checkedIn ? AppColors.success : AppColors.gold,
                      fontSize: 11,
                    ),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: AppColors.textMuted),
          ],
        ),
      ),
    );
  }

  Widget _buildThemeSelector(ThemeController themeController) {
    final currentThemeId = themeController.currentThemeId;

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
          const Text(
            'Chủ đề cấp bậc độc giả',
            style: TextStyle(
              color: AppColors.textPrimary,
              fontWeight: FontWeight.bold,
              fontSize: 14,
            ),
          ),
          const SizedBox(height: 4),
          const Text(
            'Chọn phong cách danh xưng và màu sắc chủ đề cho toàn bộ ứng dụng:',
            style: TextStyle(color: AppColors.textMuted, fontSize: 11),
          ),
          const SizedBox(height: 12),

          GridView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 3,
              crossAxisSpacing: 8,
              mainAxisSpacing: 8,
              childAspectRatio: 1.15,
            ),
            itemCount: _themes.isEmpty ? 6 : _themes.length,
            itemBuilder: (context, index) {
              final themeId = _themes.isNotEmpty
                  ? _themes[index].id
                  : ['DEFAULT', 'TU_TIEN', 'GAME', 'DEMON_KING', 'MAGICIAN', 'SCI_FI'][index];
              final themeName = _themes.isNotEmpty
                  ? _themes[index].name
                  : ['Mặc Định', 'Tu Tiên', 'Game Thủ', 'Ma Vương', 'Pháp Sư', 'Khoa Huyễn'][index];
              final rankTitle = _themes.isNotEmpty ? _themes[index].currentRankTitle : 'Độc Giả';
              final color = RankThemePalette.getPrimary(themeId);
              final isSelected = currentThemeId.toUpperCase() == themeId.toUpperCase();

              return InkWell(
                key: Key('theme_card_$themeId'),
                onTap: () => _handleThemeSwitch(themeId, themeController),
                borderRadius: BorderRadius.circular(12),
                child: Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: isSelected
                        ? color.withValues(alpha: 0.15)
                        : AppColors.darkSurfaceElevated,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: isSelected ? color : AppColors.darkBorder,
                      width: isSelected ? 2 : 1,
                    ),
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      CircleAvatar(
                        radius: 12,
                        backgroundColor: color,
                        child: isSelected
                            ? const Icon(Icons.check, size: 14, color: Colors.white)
                            : null,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        themeName,
                        style: TextStyle(
                          color: isSelected ? color : AppColors.textPrimary,
                          fontWeight: FontWeight.bold,
                          fontSize: 11,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      Text(
                        rankTitle,
                        style: const TextStyle(
                          color: AppColors.textMuted,
                          fontSize: 9,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
        ],
      ),
    );
  }

  Widget _buildSettingsSection(ThemeController themeController) {
    return Material(
      color: AppColors.darkSurface,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.darkBorder),
        ),
        child: SwitchListTile(
          key: const Key('oled_mode_switch'),
          title: const Text(
            'Chế độ OLED Đen sâu',
            style: TextStyle(
              color: AppColors.textPrimary,
              fontWeight: FontWeight.w600,
              fontSize: 14,
            ),
          ),
          subtitle: const Text(
            'Tiết kiệm pin cho màn hình AMOLED',
            style: TextStyle(color: AppColors.textMuted, fontSize: 11),
          ),
          value: themeController.isOledMode,
          activeTrackColor: context.primaryColor,
          onChanged: (val) => themeController.setOledMode(val),
        ),
      ),
    );
  }
}

class _RewardTransactionsSheet extends StatefulWidget {
  final GamificationRepository repository;

  const _RewardTransactionsSheet({required this.repository});

  @override
  State<_RewardTransactionsSheet> createState() => _RewardTransactionsSheetState();
}

class _RewardTransactionsSheetState extends State<_RewardTransactionsSheet> {
  List<RewardTransactionItem> _transactions = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _fetchTransactions();
  }

  Future<void> _fetchTransactions() async {
    try {
      final res = await widget.repository.getTransactions(limit: 30);
      if (mounted) {
        setState(() {
          _transactions = res;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 450,
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'Lịch sử Sổ Cái Thưởng',
                style: TextStyle(
                  color: AppColors.textPrimary,
                  fontWeight: FontWeight.bold,
                  fontSize: 16,
                ),
              ),
              IconButton(
                icon: const Icon(Icons.close, color: AppColors.textMuted),
                onPressed: () => Navigator.of(context).pop(),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _transactions.isEmpty
                    ? const Center(
                        child: Text(
                          'Chưa có giao dịch nào.',
                          style: TextStyle(color: AppColors.textMuted),
                        ),
                      )
                    : ListView.separated(
                        itemCount: _transactions.length,
                        separatorBuilder: (_, __) => const Divider(
                          color: AppColors.darkBorder,
                          height: 1,
                        ),
                        itemBuilder: (context, index) {
                          final tx = _transactions[index];
                          final isExp = tx.rewardType == 'EXP';

                          return ListTile(
                            contentPadding: EdgeInsets.zero,
                            leading: CircleAvatar(
                              backgroundColor: isExp
                                  ? context.primaryColor.withValues(alpha: 0.15)
                                  : AppColors.gold.withValues(alpha: 0.15),
                              child: Icon(
                                isExp ? Icons.bolt : Icons.monetization_on,
                                color: isExp ? context.primaryColor : AppColors.gold,
                                size: 18,
                              ),
                            ),
                            title: Text(
                              tx.sourceType == 'CHECKIN'
                                  ? 'Điểm danh hàng ngày'
                                  : tx.sourceType == 'READ_CHAPTER'
                                      ? 'Đọc chương truyện'
                                      : tx.sourceType == 'LEVEL_REWARD'
                                          ? 'Thưởng mốc cấp độ'
                                          : tx.sourceType,
                              style: const TextStyle(
                                color: AppColors.textPrimary,
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            subtitle: Text(
                              '${tx.createdAt.day}/${tx.createdAt.month}/${tx.createdAt.year} ${tx.createdAt.hour}:${tx.createdAt.minute.toString().padLeft(2, '0')}',
                              style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
                            ),
                            trailing: Text(
                              '+${tx.amount} ${isExp ? 'EXP' : 'Xu'}',
                              style: TextStyle(
                                color: isExp ? context.primaryColor : AppColors.gold,
                                fontWeight: FontWeight.bold,
                                fontSize: 13,
                              ),
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

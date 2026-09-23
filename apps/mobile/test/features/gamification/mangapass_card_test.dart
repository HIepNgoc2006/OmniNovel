import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/gamification/models/gamification_models.dart';
import 'package:omninovel_mobile/features/gamification/presentation/mangapass_card.dart';
import 'package:omninovel_mobile/features/gamification/repositories/gamification_repository.dart';

class MockGamificationRepository extends Mock implements GamificationRepository {}

void main() {
  late MockGamificationRepository mockRepo;

  const baseProgression = UserProgression(
    userId: 'user-1',
    level: 5,
    totalExp: '400',
    currentLevelExp: 400,
    nextLevelExp: 1000,
    omnicoinBalance: '50',
    currentStreak: 1,
    maxStreak: 2,
    lastCheckinDate: '2026-09-24',
    hasCheckedInToday: true,
    rankTitle: 'Luyện Khí',
    activeThemeId: 'DEFAULT',
    activeThemeName: 'Mặc Định',
    progressPercent: 40,
    serverDateVN: '2026-09-24',
    serverNow: '2026-09-24T00:00:00.000Z',
    nextCheckinAt: '2026-09-24T17:00:00.000Z',
    secondsUntilNextCheckin: 3600,
  );

  final mockMilestones = [
    const MilestoneRewardItem(
      id: 'm1',
      milestoneLevel: 3,
      rewardCoins: 50,
      isClaimed: true,
      canClaim: false,
    ),
    const MilestoneRewardItem(
      id: 'm2',
      milestoneLevel: 5,
      rewardCoins: 100,
      isClaimed: false,
      canClaim: true,
    ),
    const MilestoneRewardItem(
      id: 'm3',
      milestoneLevel: 10,
      rewardCoins: 200,
      isClaimed: false,
      canClaim: false,
    ),
  ];

  setUp(() {
    mockRepo = MockGamificationRepository();
  });

  testWidgets('MangaPassCard renders progression and handles claim button tap',
      (WidgetTester tester) async {
    when(() => mockRepo.claimLevelReward(5)).thenAnswer((_) async => {});

    bool claimed = false;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: MangaPassCard(
              progression: baseProgression,
              rewards: mockMilestones,
              repository: mockRepo,
              onRewardClaimed: () => claimed = true,
            ),
          ),
        ),
      ),
    );

    // Verify MangaPass level & progress
    expect(find.text('Cấp 5'), findsWidgets);
    expect(find.textContaining('400/1000 EXP'), findsOneWidget);
    expect(find.text('40%'), findsOneWidget);

    // Check milestone statuses
    expect(find.text('Đã nhận'), findsOneWidget);
    expect(find.text('Cần Lvl 10'), findsOneWidget);

    final claimButton = find.byKey(const Key('claim_reward_btn_5'));
    expect(claimButton, findsOneWidget);
    expect(find.text('Nhận'), findsOneWidget);

    // Tap claim for milestone 5
    await tester.tap(claimButton);
    await tester.pumpAndSettle();

    verify(() => mockRepo.claimLevelReward(5)).called(1);
    expect(claimed, isTrue);
  });
}

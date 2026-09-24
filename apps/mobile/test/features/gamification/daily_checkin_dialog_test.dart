import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/gamification/models/gamification_models.dart';
import 'package:omninovel_mobile/features/gamification/presentation/daily_checkin_dialog.dart';
import 'package:omninovel_mobile/features/gamification/repositories/gamification_repository.dart';

class MockGamificationRepository extends Mock implements GamificationRepository {}

void main() {
  late MockGamificationRepository mockRepo;

  const baseProgression = UserProgression(
    userId: 'user-1',
    level: 3,
    totalExp: '200',
    currentLevelExp: 200,
    nextLevelExp: 500,
    omnicoinBalance: '100',
    currentStreak: 2,
    maxStreak: 5,
    lastCheckinDate: '2026-09-23',
    hasCheckedInToday: false,
    rankTitle: 'Luyện Khí',
    activeThemeId: 'DEFAULT',
    activeThemeName: 'Mặc Định',
    progressPercent: 40,
    serverDateVN: '2026-09-24',
    serverNow: '2026-09-24T00:00:00.000Z',
    nextCheckinAt: '2026-09-24T17:00:00.000Z',
    secondsUntilNextCheckin: 3661, // 1h 1m 1s
  );

  setUp(() {
    mockRepo = MockGamificationRepository();
    when(() => mockRepo.getProgression(
          userId: any(named: 'userId'),
          forceRefresh: any(named: 'forceRefresh'),
        )).thenAnswer((_) async => baseProgression);
  });

  Widget buildTestableWidget({required UserProgression progression}) {
    return MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => ElevatedButton(
            onPressed: () {
              showDialog<void>(
                context: context,
                builder: (_) => DailyCheckinDialog(
                  progression: progression,
                  repository: mockRepo,
                ),
              );
            },
            child: const Text('Open Dialog'),
          ),
        ),
      ),
    );
  }

  testWidgets('DailyCheckinDialog displays 7 days streak and allows checkin when not claimed',
      (WidgetTester tester) async {
    when(() => mockRepo.checkIn(
          userId: any(named: 'userId'),
          idempotencyKey: any(named: 'idempotencyKey'),
        )).thenAnswer(
      (_) async => const CheckinResult(
        alreadyCheckedIn: false,
        message: 'Điểm danh thành công!',
        coinsEarned: 10,
        expEarned: 50,
        newStreak: 3,
        maxStreak: 5,
        totalExp: '250',
        omnicoinBalance: '110',
        level: 3,
      ),
    );

    await tester.pumpWidget(buildTestableWidget(progression: baseProgression));
    await tester.tap(find.text('Open Dialog'));
    await tester.pumpAndSettle();

    // Check header and streak text
    expect(find.text('Điểm danh nhận quà'), findsOneWidget);
    expect(find.text('N1'), findsOneWidget);
    expect(find.text('N7'), findsOneWidget);

    // Checkin button is available
    final checkinButton = find.byKey(const Key('submit_checkin_button'));
    expect(checkinButton, findsOneWidget);
    expect(find.textContaining('Điểm danh ngay'), findsOneWidget);

    // Tap check-in
    await tester.tap(checkinButton);
    await tester.pumpAndSettle();

    verify(() => mockRepo.checkIn(
          userId: any(named: 'userId'),
          idempotencyKey: any(named: 'idempotencyKey'),
        )).called(1);
    expect(find.text('Đã điểm danh hôm nay'), findsOneWidget);
  });

  testWidgets('DailyCheckinDialog shows monotonic countdown ticker when already checked in',
      (WidgetTester tester) async {
    const checkedInProgression = UserProgression(
      userId: 'user-1',
      level: 3,
      totalExp: '250',
      currentLevelExp: 250,
      nextLevelExp: 500,
      omnicoinBalance: '110',
      currentStreak: 3,
      maxStreak: 5,
      lastCheckinDate: '2026-09-24',
      hasCheckedInToday: true,
      rankTitle: 'Luyện Khí',
      activeThemeId: 'DEFAULT',
      activeThemeName: 'Mặc Định',
      progressPercent: 50,
      serverDateVN: '2026-09-24',
      serverNow: '2026-09-24T00:00:00.000Z',
      nextCheckinAt: '2026-09-24T17:00:00.000Z',
      secondsUntilNextCheckin: 3661, // 01:01:01
    );

    await tester.pumpWidget(buildTestableWidget(progression: checkedInProgression));
    await tester.tap(find.text('Open Dialog'));
    await tester.pumpAndSettle();

    expect(find.text('Đã điểm danh hôm nay'), findsOneWidget);
    expect(find.textContaining('01:01:01'), findsOneWidget);
  });

  testWidgets('Gate 4B: DailyCheckinDialog automatically triggers rollover when countdown reaches 0',
      (WidgetTester tester) async {
    const expiringProgression = UserProgression(
      userId: 'user-1',
      level: 3,
      totalExp: '250',
      currentLevelExp: 250,
      nextLevelExp: 500,
      omnicoinBalance: '110',
      currentStreak: 3,
      maxStreak: 5,
      lastCheckinDate: '2026-09-24',
      hasCheckedInToday: true,
      rankTitle: 'Luyện Khí',
      activeThemeId: 'DEFAULT',
      activeThemeName: 'Mặc Định',
      progressPercent: 50,
      serverDateVN: '2026-09-24',
      serverNow: '2026-09-24T23:59:58.000Z',
      nextCheckinAt: '2026-09-25T00:00:00.000Z',
      secondsUntilNextCheckin: 1, // Chỉ còn 1 giây đến nửa đêm
    );

    const refreshedProgression = UserProgression(
      userId: 'user-1',
      level: 3,
      totalExp: '250',
      currentLevelExp: 250,
      nextLevelExp: 500,
      omnicoinBalance: '110',
      currentStreak: 3,
      maxStreak: 5,
      lastCheckinDate: '2026-09-24',
      hasCheckedInToday: false, // Đã sang ngày mới -> mở khóa!
      rankTitle: 'Luyện Khí',
      activeThemeId: 'DEFAULT',
      activeThemeName: 'Mặc Định',
      progressPercent: 50,
      serverDateVN: '2026-09-25',
      serverNow: '2026-09-25T00:00:00.000Z',
      nextCheckinAt: '2026-09-26T00:00:00.000Z',
      secondsUntilNextCheckin: 86400,
    );

    when(() => mockRepo.getProgression(
          forceRefresh: true,
        )).thenAnswer((_) async => refreshedProgression);

    when(() => mockRepo.checkIn(
          userId: any(named: 'userId'),
          idempotencyKey: any(named: 'idempotencyKey'),
        )).thenAnswer(
      (_) async => const CheckinResult(
        alreadyCheckedIn: false,
        message: 'Điểm danh ngày mới thành công!',
        coinsEarned: 10,
        expEarned: 50,
        newStreak: 4,
        maxStreak: 5,
        totalExp: '300',
        omnicoinBalance: '120',
        level: 3,
      ),
    );

    await tester.pumpWidget(buildTestableWidget(progression: expiringProgression));
    await tester.tap(find.text('Open Dialog'));
    await tester.pumpAndSettle();

    // Ban đầu: đã điểm danh hôm nay
    expect(find.text('Đã điểm danh hôm nay'), findsOneWidget);

    // Chờ 2 giây để countdown về 0 và trigger rollover
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();

    // Đã gọi getProgression(forceRefresh: true)
    verify(() => mockRepo.getProgression(
          forceRefresh: true,
        )).called(1);

    // Nút check-in đã mở khóa cho ngày mới!
    final checkinButton = find.byKey(const Key('submit_checkin_button'));
    expect(checkinButton, findsOneWidget);
    expect(find.textContaining('Điểm danh ngay'), findsOneWidget);

    // Nhấn điểm danh ngày mới
    await tester.tap(checkinButton);
    await tester.pumpAndSettle();

    verify(() => mockRepo.checkIn(
          userId: any(named: 'userId'),
          idempotencyKey: any(named: 'idempotencyKey'),
        )).called(1);
  });
}

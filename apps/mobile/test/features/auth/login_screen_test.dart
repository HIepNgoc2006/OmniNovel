import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/features/auth/presentation/login_screen.dart';

class MockAuthService extends Mock implements AuthService {}

void main() {
  group('LoginScreen Widget Tests', () {
    late MockAuthService mockAuthService;

    setUp(() {
      mockAuthService = MockAuthService();
      when(() => mockAuthService.state).thenReturn(AuthState.unauthenticated());
    });

    testWidgets('renders brand title, input fields, and submit button', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: LoginScreen(authService: mockAuthService),
        ),
      );

      expect(find.text('OmniNovel'), findsOneWidget);
      expect(find.byKey(const Key('login_identifier_field')), findsOneWidget);
      expect(find.byKey(const Key('login_password_field')), findsOneWidget);
      expect(find.byKey(const Key('login_submit_button')), findsOneWidget);
      expect(find.text('Đăng nhập'), findsOneWidget);
    });

    testWidgets('validates required fields on empty submit', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: LoginScreen(authService: mockAuthService),
        ),
      );

      // Nhấn Đăng nhập mà không nhập gì
      await tester.tap(find.byKey(const Key('login_submit_button')));
      await tester.pumpAndSettle();

      expect(find.text('Vui lòng nhập tên đăng nhập hoặc email'), findsOneWidget);
      expect(find.text('Vui lòng nhập mật khẩu'), findsOneWidget);
      verifyNever(() => mockAuthService.login(
            identifier: any(named: 'identifier'),
            password: any(named: 'password'),
          ));
    });

    testWidgets('submits credentials when valid and triggers authService.login', (tester) async {
      when(() => mockAuthService.login(
            identifier: 'testuser',
            password: 'ValidPassword123',
          )).thenAnswer((_) async {});

      await tester.pumpWidget(
        MaterialApp(
          home: LoginScreen(authService: mockAuthService),
        ),
      );

      await tester.enterText(
        find.byKey(const Key('login_identifier_field')),
        'testuser',
      );
      await tester.enterText(
        find.byKey(const Key('login_password_field')),
        'ValidPassword123',
      );

      await tester.tap(find.byKey(const Key('login_submit_button')));
      await tester.pump();

      verify(() => mockAuthService.login(
            identifier: 'testuser',
            password: 'ValidPassword123',
          )).called(1);
    });
  });
}

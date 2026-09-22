import 'package:flutter/material.dart';
import '../../../core/auth/auth_service.dart';
import '../../../core/api/api_client.dart';
import '../../../core/api/api_endpoints.dart';
import '../../../app/theme/app_colors.dart';

class HomeScreen extends StatefulWidget {
  final AuthService authService;
  final ApiClient apiClient;

  const HomeScreen({
    super.key,
    required this.authService,
    required this.apiClient,
  });

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  String? _authenticatedDataStatus;
  bool _isLoadingData = false;

  Future<void> _fetchMe() async {
    setState(() {
      _isLoadingData = true;
      _authenticatedDataStatus = null;
    });

    try {
      final response = await widget.apiClient.get<Map<String, dynamic>>(ApiEndpoints.me);
      if (mounted) {
        setState(() {
          _authenticatedDataStatus = 'Xác thực thành công! ID: ${response.data?['id']}, Role: ${response.data?['role']}';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _authenticatedDataStatus = 'Lỗi truy xuất: $e';
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          _isLoadingData = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = widget.authService.state.user;

    return Scaffold(
      appBar: AppBar(
        title: const Text('OmniNovel Mobile'),
        actions: [
          IconButton(
            key: const Key('home_logout_button'),
            icon: const Icon(Icons.logout),
            tooltip: 'Đăng xuất',
            onPressed: () => widget.authService.logout(),
          ),
        ],
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Welcome Card
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: AppColors.darkSurface,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: AppColors.darkBorder),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        CircleAvatar(
                          radius: 24,
                          backgroundColor: AppColors.primary.withValues(alpha: 0.2),
                          child: Text(
                            user?.username.isNotEmpty == true
                                ? user!.username[0].toUpperCase()
                                : 'U',
                            style: const TextStyle(
                              color: AppColors.primary,
                              fontWeight: FontWeight.bold,
                              fontSize: 20,
                            ),
                          ),
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                user?.username ?? 'Độc giả OmniNovel',
                                style: const TextStyle(
                                  fontSize: 18,
                                  fontWeight: FontWeight.bold,
                                  color: AppColors.textPrimary,
                                ),
                              ),
                              Text(
                                user?.email ?? '',
                                style: const TextStyle(
                                  fontSize: 13,
                                  color: AppColors.textSecondary,
                                ),
                              ),
                            ],
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                          decoration: BoxDecoration(
                            color: AppColors.primary.withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: AppColors.primary.withValues(alpha: 0.3)),
                          ),
                          child: Text(
                            user?.role ?? 'READER',
                            style: const TextStyle(
                              color: AppColors.primaryLight,
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 24),

              // Foundation Lifecycle Verification Panel
              Text(
                'Phase 5A Lifecycle Verification',
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(height: 8),
              const Text(
                'Kiểm tra vòng đời Authenticated GET và cơ chế Single-Flight JWT Refresh:',
                style: TextStyle(color: AppColors.textSecondary, fontSize: 13),
              ),
              const SizedBox(height: 16),

              ElevatedButton.icon(
                key: const Key('home_fetch_me_button'),
                icon: _isLoadingData
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Icon(Icons.security),
                label: const Text('Test Authenticated GET (/auth/me)'),
                onPressed: _isLoadingData ? null : _fetchMe,
              ),

              if (_authenticatedDataStatus != null) ...[
                const SizedBox(height: 16),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: AppColors.darkSurfaceElevated,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: AppColors.darkBorder),
                  ),
                  child: Text(
                    _authenticatedDataStatus!,
                    style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontFamily: 'monospace',
                      fontSize: 12,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

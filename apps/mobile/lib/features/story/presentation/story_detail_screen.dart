import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../reader/presentation/reading_progress_coordinator.dart';
import '../../reader/repositories/reading_progress_repository.dart';
import '../models/story_models.dart';
import '../repositories/story_repository.dart';

class StoryDetailScreen extends StatefulWidget {
  final String slug;
  final StoryRepository storyRepository;
  final ReadingProgressRepository readingProgressRepository;

  const StoryDetailScreen({
    super.key,
    required this.slug,
    required this.storyRepository,
    required this.readingProgressRepository,
  });

  @override
  State<StoryDetailScreen> createState() => _StoryDetailScreenState();
}

class _StoryDetailScreenState extends State<StoryDetailScreen> {
  late final ReadingProgressCoordinator _progressCoordinator;
  StoryDetail? _story;
  ResumePointer? _resumePointer;
  bool _isLoading = true;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _progressCoordinator = ReadingProgressCoordinator(
      repository: widget.readingProgressRepository,
    );
    _progressCoordinator.init();
    _loadStoryAndProgress();
  }

  @override
  void dispose() {
    _progressCoordinator.dispose();
    super.dispose();
  }

  Future<void> _loadStoryAndProgress() async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final story = await widget.storyRepository.getStoryBySlug(widget.slug);
      final pointer = await _progressCoordinator.resolveResumePointer(story.id);

      if (mounted) {
        setState(() {
          _story = story;
          _resumePointer = pointer;
          _isLoading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _errorMessage = e.toString();
          _isLoading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.oledBlack,
      appBar: AppBar(
        title: Text(_story?.title ?? 'Chi tiết truyện'),
        backgroundColor: AppColors.oledBlack,
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_isLoading) {
      return const Center(
        child: CircularProgressIndicator(color: AppColors.primary),
      );
    }

    if (_errorMessage != null || _story == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: AppColors.error, size: 48),
              const SizedBox(height: 16),
              Text(
                _errorMessage ?? 'Không thể tải thông tin truyện',
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.textPrimary),
              ),
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: _loadStoryAndProgress,
                child: const Text('Thử lại'),
              ),
            ],
          ),
        ),
      );
    }

    final story = _story!;
    final chapters = story.defaultChapters;

    return RefreshIndicator(
      onRefresh: _loadStoryAndProgress,
      color: AppColors.primary,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Header: Tiêu đề, Thể loại, Trạng thái
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 100,
                height: 140,
                decoration: BoxDecoration(
                  color: AppColors.darkSurface,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.darkBorder),
                ),
                alignment: Alignment.center,
                child: const Icon(Icons.auto_stories, color: AppColors.primary, size: 40),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      story.title,
                      style: const TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.bold,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: story.genres
                          .map(
                            (g) => Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                              decoration: BoxDecoration(
                                color: AppColors.primary.withValues(alpha: 0.15),
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(color: AppColors.primary.withValues(alpha: 0.3)),
                              ),
                              child: Text(
                                g.name,
                                style: const TextStyle(color: AppColors.primaryLight, fontSize: 11),
                              ),
                            ),
                          )
                          .toList(),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      '${chapters.length} chương • ${story.status}',
                      style: const TextStyle(color: AppColors.textSecondary, fontSize: 13),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 20),

          // Tóm tắt nội dung
          if (story.summary != null && story.summary!.isNotEmpty) ...[
            const Text(
              'Tóm tắt',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.textPrimary),
            ),
            const SizedBox(height: 6),
            Text(
              story.summary!,
              style: const TextStyle(color: AppColors.textSecondary, fontSize: 14, height: 1.4),
            ),
            const SizedBox(height: 20),
          ],

          // Nút Đọc tiếp / Đọc từ đầu (Resume Button)
          if (chapters.isNotEmpty) ...[
            if (_resumePointer != null) ...[
              ElevatedButton.icon(
                key: const Key('resume_reading_button'),
                onPressed: () {
                  final targetChapter = chapters.firstWhere(
                    (c) => c.id == _resumePointer!.chapterId,
                    orElse: () => chapters.first,
                  );
                  context.push(
                    '/reader/${targetChapter.id}?storyId=${story.id}&pageIndex=${_resumePointer!.flutterPageIndex}',
                  );
                },
                icon: const Icon(Icons.play_arrow),
                label: Text(
                  'Đọc tiếp (Trang ${_resumePointer!.serverPageIndex})',
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
              ),
              const SizedBox(height: 10),
            ],
            OutlinedButton.icon(
              key: const Key('read_from_start_button'),
              onPressed: () {
                context.push('/reader/${chapters.first.id}?storyId=${story.id}&pageIndex=0');
              },
              icon: const Icon(Icons.menu_book),
              label: const Text('Đọc từ đầu (Chương 1)'),
            ),
            const SizedBox(height: 24),
          ],

          // Danh sách các chương
          const Text(
            'Danh sách chương',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppColors.textPrimary),
          ),
          const SizedBox(height: 10),
          ListView.separated(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: chapters.length,
            separatorBuilder: (_, __) => const Divider(color: AppColors.darkBorder, height: 1),
            itemBuilder: (context, index) {
              final chapter = chapters[index];
              return ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                title: Text(
                  'Chương ${chapter.chapterNumber}: ${chapter.title ?? ""}'.trim(),
                  style: const TextStyle(color: AppColors.textPrimary, fontSize: 15),
                ),
                trailing: const Icon(Icons.chevron_right, color: AppColors.textMuted),
                onTap: () {
                  context.push('/reader/${chapter.id}?storyId=${story.id}&pageIndex=0');
                },
              );
            },
          ),
        ],
      ),
    );
  }
}

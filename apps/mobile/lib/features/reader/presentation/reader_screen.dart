import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../app/theme/app_colors.dart';
import '../repositories/chapter_repository.dart';
import '../repositories/media_repository.dart';
import '../repositories/reading_progress_repository.dart';
import 'reader_image_cache_coordinator.dart';
import 'reader_session_controller.dart';
import 'reading_progress_coordinator.dart';
import 'webtoon_reader_view.dart';

class ReaderScreen extends StatefulWidget {
  final String chapterId;
  final String storyId;
  final int initialPageIndex;
  final ChapterRepository chapterRepository;
  final MediaRepository mediaRepository;
  final ReadingProgressRepository readingProgressRepository;

  const ReaderScreen({
    super.key,
    required this.chapterId,
    required this.storyId,
    this.initialPageIndex = 0,
    required this.chapterRepository,
    required this.mediaRepository,
    required this.readingProgressRepository,
  });

  @override
  State<ReaderScreen> createState() => _ReaderScreenState();
}

class _ReaderScreenState extends State<ReaderScreen> {
  late final ReaderImageCacheCoordinator _imageCacheCoordinator;
  late final ReaderSessionController _sessionController;
  late final ReadingProgressCoordinator _progressCoordinator;
  bool _showOverlay = false;

  @override
  void initState() {
    super.initState();
    _imageCacheCoordinator = ReaderImageCacheCoordinator(
      mediaRepository: widget.mediaRepository,
    );
    _sessionController = ReaderSessionController(
      chapterRepository: widget.chapterRepository,
      imageCacheCoordinator: _imageCacheCoordinator,
    );
    _progressCoordinator = ReadingProgressCoordinator(
      repository: widget.readingProgressRepository,
    );
    _progressCoordinator.init();

    _sessionController.loadChapter(
      widget.chapterId,
      initialPageIndex: widget.initialPageIndex,
    );
  }

  @override
  void didUpdateWidget(covariant ReaderScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.chapterId != widget.chapterId) {
      _sessionController.loadChapter(
        widget.chapterId,
        initialPageIndex: widget.initialPageIndex,
      );
    }
  }

  @override
  void dispose() {
    _progressCoordinator.dispose();
    _sessionController.dispose();
    super.dispose();
  }

  void _toggleOverlay() {
    setState(() {
      _showOverlay = !_showOverlay;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.oledBlack,
      body: Stack(
        children: [
          // 1. Trình đọc Webtoon cuộn dọc chính
          GestureDetector(
            onTap: _toggleOverlay,
            behavior: HitTestBehavior.opaque,
            child: WebtoonReaderView(
              controller: _sessionController,
              imageCacheCoordinator: _imageCacheCoordinator,
              initialPageIndex: widget.initialPageIndex,
              onProgressChanged: (pageIndex, progressPercentage, scrollOffset) {
                _progressCoordinator.recordProgress(
                  storyId: widget.storyId,
                  chapterId: widget.chapterId,
                  chapterVersionId:
                      _sessionController.state.chapterDetail?.activeVersion?.id,
                  flutterPageIndex: pageIndex,
                  progressPercentage: progressPercentage,
                  scrollPosition: scrollOffset,
                );
              },
            ),
          ),

          // 2. Top Header Overlay (Tự ẩn/hiện)
          if (_showOverlay)
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: Container(
                color: AppColors.darkBackground.withValues(alpha: 0.95),
                padding: EdgeInsets.only(
                  top: MediaQuery.of(context).padding.top + 8,
                  bottom: 8,
                  left: 8,
                  right: 16,
                ),
                child: Row(
                  children: [
                    IconButton(
                      icon: const Icon(Icons.arrow_back, color: AppColors.textPrimary),
                      onPressed: () {
                        _progressCoordinator.flush();
                        context.pop();
                      },
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: ListenableBuilder(
                        listenable: _sessionController,
                        builder: (context, _) {
                          final detail = _sessionController.state.chapterDetail;
                          final title = detail != null
                              ? 'Chương ${detail.chapter.chapterNumber}${detail.chapter.title != null ? ": ${detail.chapter.title}" : ""}'
                              : 'Đang đọc...';
                          return Text(
                            title,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: AppColors.textPrimary,
                              fontWeight: FontWeight.bold,
                              fontSize: 16,
                            ),
                          );
                        },
                      ),
                    ),
                  ],
                ),
              ),
            ),

          // 3. Bottom Footer Overlay (Tiến độ % & điều hướng trang)
          if (_showOverlay)
            Positioned(
              bottom: 0,
              left: 0,
              right: 0,
              child: Container(
                color: AppColors.darkBackground.withValues(alpha: 0.95),
                padding: EdgeInsets.only(
                  left: 16,
                  right: 16,
                  top: 12,
                  bottom: MediaQuery.of(context).padding.bottom + 12,
                ),
                child: ListenableBuilder(
                  listenable: _sessionController,
                  builder: (context, _) {
                    final state = _sessionController.state;
                    final nav = state.chapterDetail?.navigation;

                    return Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        // Thông số tiến độ đọc
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              'Trang ${state.focusedPageIndex + 1} / ${state.totalPages}',
                              style: const TextStyle(color: AppColors.textSecondary, fontSize: 13),
                            ),
                            Text(
                              '${state.progressPercentage.toStringAsFixed(1)}%',
                              style: const TextStyle(
                                color: AppColors.primaryLight,
                                fontWeight: FontWeight.bold,
                                fontSize: 13,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),

                        // Nút chuyển chương Trước / Sau
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            TextButton.icon(
                              onPressed: nav?.previous != null
                                  ? () {
                                      _progressCoordinator.flush();
                                      context.pushReplacement(
                                        '/reader/${nav!.previous!.id}?storyId=${widget.storyId}&pageIndex=0',
                                      );
                                    }
                                  : null,
                              icon: const Icon(Icons.skip_previous, size: 20),
                              label: const Text('Chương trước'),
                            ),
                            TextButton.icon(
                              onPressed: nav?.next != null
                                  ? () {
                                      _progressCoordinator.flush();
                                      context.pushReplacement(
                                        '/reader/${nav!.next!.id}?storyId=${widget.storyId}&pageIndex=0',
                                      );
                                    }
                                  : null,
                              icon: const Icon(Icons.skip_next, size: 20),
                              label: const Text('Chương sau'),
                            ),
                          ],
                        ),
                      ],
                    );
                  },
                ),
              ),
            ),
        ],
      ),
    );
  }
}

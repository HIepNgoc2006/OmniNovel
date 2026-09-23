import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../app/theme/app_colors.dart';
import '../models/manga_reading_mode.dart';
import '../repositories/chapter_repository.dart';
import '../repositories/media_repository.dart';
import '../repositories/reading_progress_repository.dart';
import 'manga_paged_reader_view.dart';
import 'reader_image_cache_coordinator.dart';
import 'reader_session_controller.dart';
import 'reader_session_state.dart';
import 'reading_progress_coordinator.dart';
import 'webtoon_reader_view.dart';

class ReaderScreen extends StatefulWidget {
  final String chapterId;
  final String storyId;
  final int initialPageIndex;
  final MangaReadingMode initialMode;
  final ChapterRepository chapterRepository;
  final MediaRepository mediaRepository;
  final ReadingProgressRepository readingProgressRepository;

  const ReaderScreen({
    super.key,
    required this.chapterId,
    required this.storyId,
    this.initialPageIndex = 0,
    this.initialMode = MangaReadingMode.vertical,
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
  late MangaReadingMode _currentMode;
  PageController? _pageController;
  final GlobalKey<WebtoonReaderViewState> _webtoonKey = GlobalKey();
  bool _showOverlay = false;

  @override
  void initState() {
    super.initState();
    _currentMode = widget.initialMode;

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

    _sessionController.addListener(_onSessionStateChanged);

    _sessionController.loadChapter(
      widget.chapterId,
      initialPageIndex: widget.initialPageIndex,
    );
  }

  void _onSessionStateChanged() {
    if (_sessionController.state.status == ReaderStatus.ready) {
      _ensurePagedController();
    }
  }

  /// Khởi tạo an toàn PageController chỉ khi session đã sẵn sàng (tránh race condition khóa ở page 0)
  void _ensurePagedController() {
    if (_sessionController.state.status != ReaderStatus.ready) return;
    if (_currentMode == MangaReadingMode.vertical) return;

    final targetPage = _sessionController.state.focusedPageIndex;
    if (_pageController == null) {
      setState(() {
        _pageController = PageController(initialPage: targetPage);
      });
    }
  }

  @override
  void didUpdateWidget(covariant ReaderScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.chapterId != widget.chapterId) {
      final oldController = _pageController;
      _pageController = null;
      if (oldController != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          oldController.dispose();
        });
      }
      _sessionController.loadChapter(
        widget.chapterId,
        initialPageIndex: widget.initialPageIndex,
      );
    }
  }

  @override
  void dispose() {
    _sessionController.removeListener(_onSessionStateChanged);
    _progressCoordinator.dispose();
    _sessionController.dispose();
    _pageController?.dispose();
    super.dispose();
  }

  void _toggleOverlay() {
    setState(() {
      _showOverlay = !_showOverlay;
    });
  }

  /// Chuyển đổi chế độ đọc và giữ nguyên trang đang đọc hiện tại
  void _setReadingMode(MangaReadingMode newMode) {
    if (_currentMode == newMode) return;
    final activeIndex = _sessionController.state.focusedPageIndex;
    final oldPageController = _pageController;

    setState(() {
      _currentMode = newMode;
      if (newMode != MangaReadingMode.vertical) {
        _pageController = PageController(initialPage: activeIndex);
      } else {
        _pageController = null;
      }
    });

    if (oldPageController != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        oldPageController.dispose();
      });
    }
  }

  /// Điều hướng nhảy trang (dùng chung cho Slider trên cả 3 chế độ đọc)
  void _jumpToPage(int targetPage) {
    if (_currentMode == MangaReadingMode.vertical) {
      _webtoonKey.currentState?.jumpToPage(targetPage);
    } else {
      if (_pageController != null && _pageController!.hasClients) {
        _pageController!.jumpToPage(targetPage);
      }
    }
  }

  void _onProgressChanged(int pageIndex, double progressPercentage, double scrollOffset) {
    _progressCoordinator.recordProgress(
      storyId: widget.storyId,
      chapterId: widget.chapterId,
      chapterVersionId: _sessionController.state.chapterDetail?.activeVersion?.id,
      readingMode: _currentMode.canonicalReadingMode,
      flutterPageIndex: pageIndex,
      progressPercentage: progressPercentage,
      scrollPosition: scrollOffset,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.oledBlack,
      body: Stack(
        children: [
          // 1. Trình đọc tương ứng theo _currentMode (Không có outer GestureDetector bọc ngoài)
          if (_currentMode == MangaReadingMode.vertical)
            WebtoonReaderView(
              key: _webtoonKey,
              controller: _sessionController,
              imageCacheCoordinator: _imageCacheCoordinator,
              initialPageIndex: widget.initialPageIndex,
              onToggleHud: _toggleOverlay,
              onProgressChanged: _onProgressChanged,
            )
          else
            _buildPagedReaderView(),

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
                    // Menu chọn chế độ đọc
                    PopupMenuButton<MangaReadingMode>(
                      icon: const Icon(Icons.settings, color: AppColors.textPrimary),
                      tooltip: 'Chế độ đọc',
                      color: AppColors.darkSurfaceElevated,
                      onSelected: _setReadingMode,
                      itemBuilder: (context) => [
                        PopupMenuItem(
                          value: MangaReadingMode.rtl,
                          child: Row(
                            children: [
                              Icon(
                                Icons.auto_stories,
                                size: 18,
                                color: _currentMode == MangaReadingMode.rtl
                                    ? AppColors.primary
                                    : AppColors.textMuted,
                              ),
                              const SizedBox(width: 8),
                              Text(
                                MangaReadingMode.rtl.displayName,
                                style: TextStyle(
                                  color: _currentMode == MangaReadingMode.rtl
                                      ? AppColors.primaryLight
                                      : AppColors.textPrimary,
                                ),
                              ),
                            ],
                          ),
                        ),
                        PopupMenuItem(
                          value: MangaReadingMode.ltr,
                          child: Row(
                            children: [
                              Icon(
                                Icons.menu_book,
                                size: 18,
                                color: _currentMode == MangaReadingMode.ltr
                                    ? AppColors.primary
                                    : AppColors.textMuted,
                              ),
                              const SizedBox(width: 8),
                              Text(
                                MangaReadingMode.ltr.displayName,
                                style: TextStyle(
                                  color: _currentMode == MangaReadingMode.ltr
                                      ? AppColors.primaryLight
                                      : AppColors.textPrimary,
                                ),
                              ),
                            ],
                          ),
                        ),
                        PopupMenuItem(
                          value: MangaReadingMode.vertical,
                          child: Row(
                            children: [
                              Icon(
                                Icons.swap_vert,
                                size: 18,
                                color: _currentMode == MangaReadingMode.vertical
                                    ? AppColors.primary
                                    : AppColors.textMuted,
                              ),
                              const SizedBox(width: 8),
                              Text(
                                MangaReadingMode.vertical.displayName,
                                style: TextStyle(
                                  color: _currentMode == MangaReadingMode.vertical
                                      ? AppColors.primaryLight
                                      : AppColors.textPrimary,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),

          // 3. Bottom Footer Overlay (Slider điều hướng, % tiến độ, chuyển chương)
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
                  top: 8,
                  bottom: MediaQuery.of(context).padding.bottom + 8,
                ),
                child: ListenableBuilder(
                  listenable: _sessionController,
                  builder: (context, _) {
                    final state = _sessionController.state;
                    final nav = state.chapterDetail?.navigation;
                    final totalPages = state.totalPages;

                    return Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        // Slider điều hướng trang (nếu có từ 2 trang trở lên)
                        if (totalPages > 1)
                          SliderTheme(
                            data: SliderTheme.of(context).copyWith(
                              activeTrackColor: AppColors.primary,
                              inactiveTrackColor: AppColors.darkSurface,
                              thumbColor: AppColors.primaryLight,
                              overlayColor: AppColors.primary.withValues(alpha: 0.2),
                              trackHeight: 3,
                            ),
                            child: Slider(
                              value: state.focusedPageIndex
                                  .toDouble()
                                  .clamp(0.0, (totalPages - 1).toDouble()),
                              min: 0,
                              max: (totalPages - 1).toDouble(),
                              divisions: totalPages > 1 ? totalPages - 1 : 1,
                              onChanged: (val) {
                                _jumpToPage(val.round());
                              },
                            ),
                          ),

                        // Thông số tiến độ đọc & Badge chế độ
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              'Trang ${state.focusedPageIndex + 1} / $totalPages',
                              style: const TextStyle(color: AppColors.textSecondary, fontSize: 13),
                            ),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(
                                color: AppColors.darkSurface,
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: Text(
                                _currentMode.displayName,
                                style: const TextStyle(
                                  color: AppColors.primaryLight,
                                  fontSize: 11,
                                  fontWeight: FontWeight.w500,
                                ),
                              ),
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

                        // Nút chuyển chương Trước / Sau (Bảo toàn _currentMode qua query parameter)
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            TextButton.icon(
                              onPressed: nav?.previous != null
                                  ? () {
                                      _progressCoordinator.flush();
                                      context.pushReplacement(
                                        '/reader/${nav!.previous!.id}?storyId=${widget.storyId}&pageIndex=0&mode=${_currentMode.name}',
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
                                        '/reader/${nav!.next!.id}?storyId=${widget.storyId}&pageIndex=0&mode=${_currentMode.name}',
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

  Widget _buildPagedReaderView() {
    if (_sessionController.state.status != ReaderStatus.ready || _pageController == null) {
      return const Center(
        child: CircularProgressIndicator(color: AppColors.primary),
      );
    }

    return MangaPagedReaderView(
      sessionController: _sessionController,
      imageCacheCoordinator: _imageCacheCoordinator,
      pageController: _pageController!,
      mode: _currentMode,
      onToggleHud: _toggleOverlay,
      onProgressChanged: _onProgressChanged,
    );
  }
}

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/theme/theme_tokens.dart';
import '../../gamification/repositories/gamification_repository.dart';
import '../models/manga_reading_mode.dart';
import '../models/novel_block_models.dart';
import '../models/reader_models.dart';
import '../repositories/chapter_repository.dart';
import '../repositories/media_repository.dart';
import '../repositories/novel_content_repository.dart';
import '../repositories/reading_progress_repository.dart';
import 'manga_paged_reader_view.dart';
import 'novel_content_parser.dart';
import 'novel_reader_view.dart';
import 'novel_settings_controller.dart';
import 'novel_typography_sheet.dart';
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
  final String? initialAnchorBlockId;
  final double? initialScrollPosition;
  final double? initialProgressPercentage;
  final ChapterRepository chapterRepository;
  final MediaRepository mediaRepository;
  final ReadingProgressRepository readingProgressRepository;
  final GamificationRepository? gamificationRepository;
  final NovelContentRepository? novelContentRepository;
  final NovelSettingsController? novelSettingsController;

  const ReaderScreen({
    super.key,
    required this.chapterId,
    required this.storyId,
    this.initialPageIndex = 0,
    this.initialMode = MangaReadingMode.vertical,
    this.initialAnchorBlockId,
    this.initialScrollPosition,
    this.initialProgressPercentage,
    required this.chapterRepository,
    required this.mediaRepository,
    required this.readingProgressRepository,
    this.gamificationRepository,
    this.novelContentRepository,
    this.novelSettingsController,
  });

  @override
  State<ReaderScreen> createState() => _ReaderScreenState();
}

class _ReaderScreenState extends State<ReaderScreen> {
  late final ReaderImageCacheCoordinator _imageCacheCoordinator;
  late final ReaderSessionController _sessionController;
  late final ReadingProgressCoordinator _progressCoordinator;
  late final NovelSettingsController _novelSettingsController;
  late final NovelContentRepository _novelContentRepository;
  late MangaReadingMode _currentMode;
  PageController? _pageController;
  final GlobalKey<WebtoonReaderViewState> _webtoonKey = GlobalKey();
  bool _showOverlay = false;

  List<NovelBlockItem>? _novelBlocks;
  bool _loadingNovelContent = false;
  String? _novelContentError;

  bool get _isNovel =>
      _sessionController.state.chapterDetail?.story.mediaFormat == 'NOVEL';

  @override
  void initState() {
    super.initState();
    _currentMode = widget.initialMode;

    _novelSettingsController =
        widget.novelSettingsController ?? NovelSettingsController();
    _novelContentRepository = widget.novelContentRepository ??
        NovelContentRepository(mediaRepository: widget.mediaRepository);

    _imageCacheCoordinator = ReaderImageCacheCoordinator(
      mediaRepository: widget.mediaRepository,
    );
    _sessionController = ReaderSessionController(
      chapterRepository: widget.chapterRepository,
      imageCacheCoordinator: _imageCacheCoordinator,
    );
    _progressCoordinator = ReadingProgressCoordinator(
      repository: widget.readingProgressRepository,
      gamificationRepository: widget.gamificationRepository,
    );
    _progressCoordinator.init();
    _progressCoordinator.startSession(widget.storyId);

    _sessionController.addListener(_onSessionStateChanged);
    _novelSettingsController.addListener(_onNovelSettingsChanged);

    _sessionController.loadChapter(
      widget.chapterId,
      initialPageIndex: widget.initialPageIndex,
    );
  }

  void _onNovelSettingsChanged() {
    if (mounted) setState(() {});
  }

  void _onSessionStateChanged() {
    if (_sessionController.state.status == ReaderStatus.ready) {
      final currentChapter = _sessionController.state.chapterDetail;
      if (currentChapter != null) {
        _progressCoordinator.onChapterReady(currentChapter.chapter.id);
      }
      if (_isNovel) {
        _loadNovelIfNeeded();
      } else {
        _ensurePagedController();
      }
    }
  }

  Future<void> _loadNovelIfNeeded() async {
    if (_novelBlocks != null || _loadingNovelContent) return;

    final detail = _sessionController.state.chapterDetail;
    if (detail == null) return;

    final pages = detail.pages;
    final novelAsset = pages.firstWhere(
      (p) => p.assetType == 'NOVEL_HTML',
      orElse: () => pages.isNotEmpty
          ? pages.first
          : const ChapterPage(assetId: '', sortOrder: 0),
    );

    if (novelAsset.assetId.isEmpty) {
      setState(() {
        _novelContentError = 'Không tìm thấy tệp nội dung tiểu thuyết.';
      });
      return;
    }

    setState(() {
      _loadingNovelContent = true;
      _novelContentError = null;
    });

    try {
      final html = await _novelContentRepository.loadNovelHtml(novelAsset.assetId);
      final blocks = NovelContentParser.parseHtml(html);
      if (mounted) {
        setState(() {
          _novelBlocks = blocks;
          _loadingNovelContent = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _novelContentError = e.toString();
          _loadingNovelContent = false;
        });
      }
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
      _novelBlocks = null;
      _loadingNovelContent = false;
      _novelContentError = null;
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
    _novelSettingsController.removeListener(_onNovelSettingsChanged);
    if (widget.novelSettingsController == null) {
      _novelSettingsController.dispose();
    }
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
      backgroundColor: _isNovel
          ? _novelSettingsController.settings.theme.backgroundColor
          : AppColors.oledBlack,
      body: Stack(
        children: [
          // 1. Trình đọc tương ứng (Novel vs Webtoon vs Manga Paged)
          if (_isNovel)
            _buildNovelView()
          else if (_currentMode == MangaReadingMode.vertical)
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
                    // Menu chọn chế độ đọc cho Manga HOẶC Nút Typography cho Novel
                    if (_isNovel)
                      IconButton(
                        icon: const Icon(Icons.text_fields, color: AppColors.textPrimary),
                        tooltip: 'Tùy chỉnh giao diện đọc',
                        onPressed: () => NovelTypographySheet.show(
                          context,
                          controller: _novelSettingsController,
                        ),
                      )
                    else
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
                                      ? context.primaryColor
                                      : AppColors.textMuted,
                                ),
                                const SizedBox(width: 8),
                                Text(
                                  MangaReadingMode.rtl.displayName,
                                  style: TextStyle(
                                    color: _currentMode == MangaReadingMode.rtl
                                        ? context.primaryColor
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
                                      ? context.primaryColor
                                      : AppColors.textMuted,
                                ),
                                const SizedBox(width: 8),
                                Text(
                                  MangaReadingMode.ltr.displayName,
                                  style: TextStyle(
                                    color: _currentMode == MangaReadingMode.ltr
                                        ? context.primaryColor
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
                                      ? context.primaryColor
                                      : AppColors.textMuted,
                                ),
                                const SizedBox(width: 8),
                                Text(
                                  MangaReadingMode.vertical.displayName,
                                  style: TextStyle(
                                    color: _currentMode == MangaReadingMode.vertical
                                        ? context.primaryColor
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
                        // Slider điều hướng trang (chỉ cho Manga có từ 2 trang trở lên)
                        if (!_isNovel && totalPages > 1)
                          SliderTheme(
                            data: SliderTheme.of(context).copyWith(
                              activeTrackColor: context.primaryColor,
                              inactiveTrackColor: AppColors.darkSurface,
                              thumbColor: context.primaryColor,
                              overlayColor: context.primaryColor.withValues(alpha: 0.2),
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
                            if (!_isNovel)
                              Text(
                                'Trang ${state.focusedPageIndex + 1} / $totalPages',
                                style: const TextStyle(color: AppColors.textSecondary, fontSize: 13),
                              )
                            else
                              const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(
                                color: AppColors.darkSurface,
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: Text(
                                _isNovel ? 'Tiểu thuyết' : _currentMode.displayName,
                                style: TextStyle(
                                  color: context.primaryLightColor,
                                  fontSize: 11,
                                  fontWeight: FontWeight.w500,
                                ),
                              ),
                            ),
                            if (!_isNovel)
                              Text(
                                '${state.progressPercentage.toStringAsFixed(1)}%',
                                style: TextStyle(
                                  color: context.primaryLightColor,
                                  fontWeight: FontWeight.bold,
                                  fontSize: 13,
                                ),
                              )
                            else
                              const SizedBox(width: 8),
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
                                      final navUrl = _isNovel
                                          ? '/reader/${nav!.previous!.id}?storyId=${widget.storyId}'
                                          : '/reader/${nav!.previous!.id}?storyId=${widget.storyId}&pageIndex=0&mode=${_currentMode.name}';
                                      context.pushReplacement(navUrl);
                                    }
                                  : null,
                              icon: const Icon(Icons.skip_previous, size: 20),
                              label: const Text('Chương trước'),
                            ),
                            TextButton.icon(
                              onPressed: nav?.next != null
                                  ? () {
                                      _progressCoordinator.flush();
                                      final navUrl = _isNovel
                                          ? '/reader/${nav!.next!.id}?storyId=${widget.storyId}'
                                          : '/reader/${nav!.next!.id}?storyId=${widget.storyId}&pageIndex=0&mode=${_currentMode.name}';
                                      context.pushReplacement(navUrl);
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

  Widget _buildNovelView() {
    if (_sessionController.state.status == ReaderStatus.loading || _loadingNovelContent) {
      return Center(
        child: CircularProgressIndicator(
          color: _novelSettingsController.settings.theme.textColor,
        ),
      );
    }

    if (_novelContentError != null || _sessionController.state.status == ReaderStatus.error) {
      final errorMsg = _novelContentError ??
          _sessionController.state.errorMessage ??
          'Không thể tải nội dung tiểu thuyết';
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: Colors.redAccent, size: 48),
              const SizedBox(height: 16),
              Text(
                errorMsg,
                textAlign: TextAlign.center,
                style: TextStyle(color: _novelSettingsController.settings.theme.textColor),
              ),
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: () {
                  _sessionController.loadChapter(widget.chapterId);
                  _loadNovelIfNeeded();
                },
                child: const Text('Thử lại'),
              ),
            ],
          ),
        ),
      );
    }

    if (_novelBlocks == null || _novelBlocks!.isEmpty) {
      return Center(
        child: Text(
          'Chương này chưa có nội dung văn bản.',
          style: TextStyle(color: _novelSettingsController.settings.theme.textColor),
        ),
      );
    }

    return NovelReaderView(
      storyId: widget.storyId,
      chapterId: widget.chapterId,
      chapterVersionId: _sessionController.state.chapterDetail?.activeVersion?.id,
      blocks: _novelBlocks!,
      coordinator: _progressCoordinator,
      settingsController: _novelSettingsController,
      initialAnchorBlockId: widget.initialAnchorBlockId,
      initialScrollPosition: widget.initialScrollPosition,
      initialProgressPercentage: widget.initialProgressPercentage,
      onTap: _toggleOverlay,
    );
  }

  Widget _buildPagedReaderView() {
    if (_sessionController.state.status != ReaderStatus.ready || _pageController == null) {
      return Center(
        child: CircularProgressIndicator(color: context.primaryColor),
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

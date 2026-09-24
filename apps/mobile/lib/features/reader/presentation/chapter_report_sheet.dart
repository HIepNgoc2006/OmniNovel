import 'dart:async';
import 'package:flutter/material.dart';
import '../../../app/theme/app_colors.dart';
import '../models/chapter_report_models.dart';
import '../repositories/chapter_report_repository.dart';

class ChapterReportSheet extends StatefulWidget {
  final String chapterId;
  final String chapterVersionId;
  final String mediaFormat; // 'COMIC' or 'NOVEL'
  final int? initialPageNumber;
  final String? initialAnchorBlockId;
  final ChapterReportRepository? repository;

  const ChapterReportSheet({
    super.key,
    required this.chapterId,
    required this.chapterVersionId,
    required this.mediaFormat,
    this.initialPageNumber,
    this.initialAnchorBlockId,
    this.repository,
  });

  static Future<void> show(
    BuildContext context, {
    required String chapterId,
    required String chapterVersionId,
    required String mediaFormat,
    int? initialPageNumber,
    String? initialAnchorBlockId,
    ChapterReportRepository? repository,
  }) {
    return showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => ChapterReportSheet(
        chapterId: chapterId,
        chapterVersionId: chapterVersionId,
        mediaFormat: mediaFormat,
        initialPageNumber: initialPageNumber,
        initialAnchorBlockId: initialAnchorBlockId,
        repository: repository,
      ),
    );
  }

  @override
  State<ChapterReportSheet> createState() => _ChapterReportSheetState();
}

class _ChapterReportSheetState extends State<ChapterReportSheet> {
  final TextEditingController _descController = TextEditingController();
  ChapterReportErrorType _selectedErrorType = ChapterReportErrorType.imageCorrupt;
  bool _isWholeChapter = false;
  bool _isSubmitting = false;

  // Rate limiting countdown
  int _rateLimitSecondsRemaining = 0;
  Timer? _countdownTimer;

  bool get _isNovel => widget.mediaFormat == 'NOVEL';

  @override
  void initState() {
    super.initState();
    // Default error type phù hợp ngữ cảnh
    if (_isNovel) {
      _selectedErrorType = ChapterReportErrorType.typo;
    } else {
      _selectedErrorType = ChapterReportErrorType.imageCorrupt;
    }
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _descController.dispose();
    super.dispose();
  }

  void _startCountdown(int seconds) {
    _countdownTimer?.cancel();
    setState(() {
      _rateLimitSecondsRemaining = seconds;
    });
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() {
        if (_rateLimitSecondsRemaining > 1) {
          _rateLimitSecondsRemaining--;
        } else {
          _rateLimitSecondsRemaining = 0;
          timer.cancel();
        }
      });
    });
  }

  Future<void> _submitReport() async {
    if (_isSubmitting || _rateLimitSecondsRemaining > 0) return;

    if (widget.repository == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Hệ thống báo cáo tạm thời không khả dụng.'),
          backgroundColor: AppColors.error,
        ),
      );
      return;
    }

    setState(() {
      _isSubmitting = true;
    });

    try {
      final pageNum = _isWholeChapter
          ? null
          : (_isNovel ? null : widget.initialPageNumber);
      final anchorId = _isWholeChapter
          ? null
          : (_isNovel ? widget.initialAnchorBlockId : null);

      final payload = ChapterReportPayload(
        chapterVersionId: widget.chapterVersionId,
        errorType: _selectedErrorType,
        pageNumber: pageNum,
        anchorBlockId: anchorId,
        description: _descController.text.trim().isEmpty ? null : _descController.text.trim(),
      );

      final result = await widget.repository!.sendReport(
        chapterId: widget.chapterId,
        payload: payload,
      );

      if (!mounted) return;

      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(result.message.isNotEmpty ? result.message : 'Báo cáo lỗi đã được gửi thành công!'),
          backgroundColor: Colors.green,
        ),
      );
    } on ChapterReportRateLimitException catch (e) {
      if (!mounted) return;
      _startCountdown(e.retryAfter);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Gửi báo cáo quá nhanh. Vui lòng thử lại sau ${e.retryAfter} giây.'),
          backgroundColor: Colors.orange,
        ),
      );
    } on ChapterReportDuplicateException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.message),
          backgroundColor: AppColors.error,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Lỗi: ${e.toString()}'),
          backgroundColor: AppColors.error,
        ),
      );
    } finally {
      if (mounted) {
        setState(() {
          _isSubmitting = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.of(context).viewInsets.bottom;

    String locationLabel;
    if (_isWholeChapter) {
      locationLabel = 'Toàn bộ chương';
    } else if (_isNovel) {
      locationLabel = widget.initialAnchorBlockId != null
          ? 'Đoạn: ${widget.initialAnchorBlockId}'
          : 'Toàn bộ chương';
    } else {
      locationLabel = widget.initialPageNumber != null
          ? 'Trang ${widget.initialPageNumber}'
          : 'Toàn bộ chương';
    }

    return Material(
      color: AppColors.darkSurface,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          top: 16,
          bottom: bottomInset + 20,
        ),
        child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Header Handle
            Center(
              child: Container(
                width: 40,
                height: 4,
                margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(
                  color: Colors.white24,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),

            // Title & Close Button
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Row(
                  children: [
                    Icon(Icons.flag_outlined, color: AppColors.primary, size: 22),
                    SizedBox(width: 8),
                    Text(
                      'Báo lỗi chương truyện',
                      style: TextStyle(
                        color: AppColors.textPrimary,
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
                IconButton(
                  icon: const Icon(Icons.close, color: AppColors.textSecondary),
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ],
            ),
            const SizedBox(height: 12),

            // Location Badge & Whole chapter toggle
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: AppColors.darkBackground,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.white10),
              ),
              child: Row(
                children: [
                  const Icon(Icons.location_on_outlined, size: 16, color: AppColors.primary),
                  const SizedBox(width: 6),
                  Text(
                    'Vị trí báo lỗi: ',
                    style: TextStyle(fontSize: 13, color: Colors.grey[400]),
                  ),
                  Text(
                    locationLabel,
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.bold,
                      color: AppColors.textPrimary,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),

            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text(
                'Báo lỗi cho toàn bộ chương truyện',
                style: TextStyle(color: AppColors.textSecondary, fontSize: 13),
              ),
              value: _isWholeChapter,
              activeColor: AppColors.primary,
              onChanged: (val) {
                setState(() {
                  _isWholeChapter = val ?? false;
                });
              },
            ),
            const Divider(color: Colors.white10, height: 16),

            // Category Selection (Dropdown)
            const Text(
              'Loại sự cố gặp phải',
              style: TextStyle(
                color: AppColors.textPrimary,
                fontWeight: FontWeight.w600,
                fontSize: 14,
              ),
            ),
            const SizedBox(height: 8),

            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              decoration: BoxDecoration(
                color: AppColors.darkBackground,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.white12),
              ),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<ChapterReportErrorType>(
                  value: _selectedErrorType,
                  dropdownColor: AppColors.darkSurfaceElevated,
                  isExpanded: true,
                  items: ChapterReportErrorType.values.map((type) {
                    return DropdownMenuItem(
                      value: type,
                      child: Text(
                        type.label,
                        style: const TextStyle(color: AppColors.textPrimary, fontSize: 14),
                      ),
                    );
                  }).toList(),
                  onChanged: (val) {
                    if (val != null) {
                      setState(() {
                        _selectedErrorType = val;
                      });
                    }
                  },
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Description Text Field
            const Text(
              'Mô tả chi tiết (Tùy chọn)',
              style: TextStyle(
                color: AppColors.textPrimary,
                fontWeight: FontWeight.w600,
                fontSize: 14,
              ),
            ),
            const SizedBox(height: 8),

            TextField(
              controller: _descController,
              maxLines: 3,
              maxLength: 1000,
              style: const TextStyle(color: AppColors.textPrimary, fontSize: 14),
              decoration: InputDecoration(
                hintText: 'Mô tả rõ hơn về lỗi để ban quản trị khắc phục nhanh nhất...',
                hintStyle: TextStyle(color: Colors.grey[600], fontSize: 13),
                filled: true,
                fillColor: AppColors.darkBackground,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: Colors.white12),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: Colors.white12),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: AppColors.primary),
                ),
                counterStyle: const TextStyle(color: Colors.white30, fontSize: 11),
              ),
            ),
            const SizedBox(height: 16),

            // Submit Button with Rate Limit Countdown State
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: _rateLimitSecondsRemaining > 0
                    ? Colors.grey[700]
                    : AppColors.primary,
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8),
                ),
              ),
              onPressed: (_isSubmitting || _rateLimitSecondsRemaining > 0)
                  ? null
                  : _submitReport,
              child: _isSubmitting
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : Text(
                      _rateLimitSecondsRemaining > 0
                          ? 'Vui lòng chờ ${_rateLimitSecondsRemaining}s'
                          : 'Gửi báo cáo',
                      style: const TextStyle(
                        fontWeight: FontWeight.bold,
                        fontSize: 15,
                        color: Colors.white,
                      ),
                    ),
            ),
          ],
        ),
      ),
      ),
    );
  }
}

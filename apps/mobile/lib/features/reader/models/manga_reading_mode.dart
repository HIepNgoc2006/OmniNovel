/// Chế độ đọc Manga / Webtoon
enum MangaReadingMode {
  /// Chuẩn Manga Nhật Bản (Lật trang từ Phải sang Trái)
  rtl,

  /// Chuẩn Comic Tây phương (Lật trang từ Trái sang Phải)
  ltr,

  /// Chuẩn Webtoon (Cuộn dọc liên tục)
  vertical,
  ;

  /// Ánh xạ chuẩn mực theo enum ReadingMode của Backend Core API (@omninovel/shared)
  /// Backend chỉ chấp nhận: 'WEBTOON' | 'PAGED' | 'NOVEL'
  String get canonicalReadingMode {
    switch (this) {
      case MangaReadingMode.rtl:
      case MangaReadingMode.ltr:
        return 'PAGED';
      case MangaReadingMode.vertical:
        return 'WEBTOON';
    }
  }

  /// Tên hiển thị người dùng trên giao diện HUD
  String get displayName {
    switch (this) {
      case MangaReadingMode.rtl:
        return 'Manga (RTL)';
      case MangaReadingMode.ltr:
        return 'Comic (LTR)';
      case MangaReadingMode.vertical:
        return 'Cuộn Dọc';
    }
  }

  /// Helper chuyển đổi an toàn từ chuỗi (không phân biệt hoa thường)
  static MangaReadingMode fromName(String? name) {
    if (name == null) return MangaReadingMode.vertical;
    final lower = name.toLowerCase().trim();
    if (lower == 'rtl' || lower == 'manga_rtl') return MangaReadingMode.rtl;
    if (lower == 'ltr' || lower == 'manga_ltr') return MangaReadingMode.ltr;
    if (lower == 'vertical' || lower == 'webtoon') return MangaReadingMode.vertical;
    return MangaReadingMode.values.firstWhere(
      (e) => e.name.toLowerCase() == lower,
      orElse: () => MangaReadingMode.vertical,
    );
  }
}

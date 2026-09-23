import 'package:flutter/material.dart';
import '../models/novel_block_models.dart';
import 'novel_settings_controller.dart';

/// Modal Bottom Sheet điều khiển cấu hình hiển thị Novel (Aa)
class NovelTypographySheet extends StatelessWidget {
  final NovelSettingsController controller;

  const NovelTypographySheet({
    super.key,
    required this.controller,
  });

  static Future<void> show(
    BuildContext context, {
    required NovelSettingsController controller,
  }) {
    return showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (ctx) => NovelTypographySheet(controller: controller),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final settings = controller.settings;
        final theme = settings.theme;

        return Container(
          decoration: BoxDecoration(
            color: theme.cardBackgroundColor,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(20.0)),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.3),
                blurRadius: 16.0,
                offset: const Offset(0, -4),
              ),
            ],
          ),
          padding: const EdgeInsets.fromLTRB(20.0, 16.0, 20.0, 32.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Thanh kéo drag handle
              Center(
                child: Container(
                  width: 40.0,
                  height: 4.0,
                  decoration: BoxDecoration(
                    color: theme.dividerColor,
                    borderRadius: BorderRadius.circular(2.0),
                  ),
                ),
              ),
              const SizedBox(height: 16.0),

              // Tiêu đề Sheet
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'Tùy chỉnh giao diện đọc',
                    style: TextStyle(
                      fontSize: 18.0,
                      fontWeight: FontWeight.bold,
                      color: theme.textColor,
                    ),
                  ),
                  IconButton(
                    icon: Icon(Icons.close, color: theme.secondaryTextColor),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 16.0),

              // 1. Lựa chọn Chủ đề màu (Theme Swatches)
              Text(
                'Màu nền & Chủ đề',
                style: TextStyle(
                  fontSize: 14.0,
                  fontWeight: FontWeight.w600,
                  color: theme.secondaryTextColor,
                ),
              ),
              const SizedBox(height: 10.0),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: NovelReadingTheme.values.map((t) {
                  final isSelected = t == theme;
                  return GestureDetector(
                    onTap: () => controller.setTheme(t),
                    child: Container(
                      width: 72.0,
                      padding: const EdgeInsets.symmetric(vertical: 8.0),
                      decoration: BoxDecoration(
                        color: t.backgroundColor,
                        borderRadius: BorderRadius.circular(10.0),
                        border: Border.all(
                          color: isSelected ? Colors.blueAccent : t.dividerColor,
                          width: isSelected ? 2.5 : 1.0,
                        ),
                      ),
                      child: Column(
                        children: [
                          Text(
                            t.displayName,
                            style: TextStyle(
                              fontSize: 12.0,
                              fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                              color: t.textColor,
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                }).toList(),
              ),
              const SizedBox(height: 20.0),

              // 2. Kiểu phông chữ (Font Family)
              Text(
                'Phông chữ',
                style: TextStyle(
                  fontSize: 14.0,
                  fontWeight: FontWeight.w600,
                  color: theme.secondaryTextColor,
                ),
              ),
              const SizedBox(height: 10.0),
              Row(
                children: NovelFontFamily.values.map((family) {
                  final isSelected = family == settings.fontFamily;
                  return Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4.0),
                      child: ChoiceChip(
                        label: Center(
                          child: Text(
                            family.displayName,
                            style: TextStyle(
                              color: isSelected ? Colors.white : theme.textColor,
                              fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                            ),
                          ),
                        ),
                        selected: isSelected,
                        selectedColor: Colors.blueAccent,
                        backgroundColor: theme.backgroundColor,
                        onSelected: (_) => controller.setFontFamily(family),
                      ),
                    ),
                  );
                }).toList(),
              ),
              const SizedBox(height: 20.0),

              // 3. Cỡ chữ (Font Size Slider)
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'Cỡ chữ',
                    style: TextStyle(
                      fontSize: 14.0,
                      fontWeight: FontWeight.w600,
                      color: theme.secondaryTextColor,
                    ),
                  ),
                  Text(
                    '${settings.fontSize.toInt()} sp',
                    style: TextStyle(
                      fontSize: 14.0,
                      fontWeight: FontWeight.bold,
                      color: theme.textColor,
                    ),
                  ),
                ],
              ),
              Row(
                children: [
                  IconButton(
                    icon: Icon(Icons.text_decrease, color: theme.textColor),
                    onPressed: () => controller.setFontSize(settings.fontSize - 1.0),
                  ),
                  Expanded(
                    child: Slider(
                      value: settings.fontSize,
                      min: 14.0,
                      max: 28.0,
                      divisions: 14,
                      activeColor: Colors.blueAccent,
                      inactiveColor: theme.dividerColor,
                      onChanged: (val) => controller.setFontSize(val),
                    ),
                  ),
                  IconButton(
                    icon: Icon(Icons.text_increase, color: theme.textColor),
                    onPressed: () => controller.setFontSize(settings.fontSize + 1.0),
                  ),
                ],
              ),
              const SizedBox(height: 10.0),

              // 4. Giãn dòng (Line Height)
              Text(
                'Giãn dòng',
                style: TextStyle(
                  fontSize: 14.0,
                  fontWeight: FontWeight.w600,
                  color: theme.secondaryTextColor,
                ),
              ),
              const SizedBox(height: 10.0),
              Row(
                children: [1.3, 1.6, 1.9, 2.2].map((height) {
                  final isSelected = (settings.lineHeightMultiplier - height).abs() < 0.05;
                  return Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4.0),
                      child: ChoiceChip(
                        label: Center(
                          child: Text(
                            '${height}x',
                            style: TextStyle(
                              color: isSelected ? Colors.white : theme.textColor,
                              fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                            ),
                          ),
                        ),
                        selected: isSelected,
                        selectedColor: Colors.blueAccent,
                        backgroundColor: theme.backgroundColor,
                        onSelected: (_) => controller.setLineHeight(height),
                      ),
                    ),
                  );
                }).toList(),
              ),
            ],
          ),
        );
      },
    );
  }
}

import { Injectable } from '@nestjs/common';
import { SyncDomain, SyncOperation } from '../interfaces/sync.types';
import {
  ConflictResolutionResult,
  ConflictResolverContext,
  IConflictResolver,
} from './conflict-resolver.interface';

/**
 * Whitelist các thiết lập người dùng có phạm vi tài khoản (Account-Scoped Preferences)
 * được phép đồng bộ giữa các thiết bị.
 */
export const ACCOUNT_SCOPED_PREFERENCE_KEYS = new Set([
  'theme', // 'light' | 'dark' | 'system' | 'amoled'
  'reader_theme', // 'light' | 'sepia' | 'dark' | 'black'
  'font_family', // 'sans' | 'serif' | custom web font
  'font_size_scale', // numeric scaling ratio (0.8 .. 1.5)
  'reading_mode_preference', // 'WEBTOON' | 'PAGED' | 'NOVEL'
  'locale', // 'vi' | 'en' | 'ja'
  'reading_direction', // 'ltr' | 'rtl' | 'vertical'
  'auto_scroll_speed', // pixel per second
]);

/**
 * Danh sách đen các thiết lập thuộc phạm vi phần cứng / thiết bị cục bộ (Device-Scoped Preferences)
 * Tuyệt đối cấm đồng bộ qua Sync Hub nhằm bảo toàn tính cô lập thiết bị.
 */
export const DEVICE_SCOPED_PREFERENCE_KEYS = new Set([
  'device_id',
  'device_name',
  'screen_brightness',
  'offline_storage_path',
  'haptic_feedback_enabled',
  'device_volume',
  'push_token',
  'cache_limit_mb',
  'download_over_wifi_only',
  'keep_screen_on',
]);

@Injectable()
export class PreferenceConflictResolver implements IConflictResolver {
  readonly domain = SyncDomain.PREFERENCE;

  resolve(context: ConflictResolverContext): ConflictResolutionResult {
    const { mutation } = context;
    const payload = mutation.payload as Record<string, any>;
    const preferenceKey = (payload?.key ?? mutation.entityId ?? '').trim();

    // 1. Kiểm tra nếu là thiết lập phần cứng cục bộ (Device Preferences)
    if (DEVICE_SCOPED_PREFERENCE_KEYS.has(preferenceKey)) {
      return {
        status: 'REJECTED_STALE',
        reason: 'DEVICE_PREFERENCE_NOT_SYNCABLE',
        message: `Preference key '${preferenceKey}' is scoped to the physical device and must not be synchronized across accounts or devices`,
        metadata: {
          key: preferenceKey,
          scope: 'DEVICE',
        },
        assignedRevision: null,
      };
    }

    // 2. Kiểm tra nếu thuộc whitelist Account-Scoped hợp lệ
    if (!ACCOUNT_SCOPED_PREFERENCE_KEYS.has(preferenceKey)) {
      return {
        status: 'REJECTED_STALE',
        reason: 'PREFERENCE_KEY_NOT_SUPPORTED',
        message: `Preference key '${preferenceKey}' is not recognized as an account-scoped preference`,
        metadata: {
          key: preferenceKey,
          supportedKeys: Array.from(ACCOUNT_SCOPED_PREFERENCE_KEYS),
        },
        assignedRevision: null,
      };
    }

    if (mutation.operation === SyncOperation.DELETE) {
      return {
        status: 'APPLIED',
        assignedRevision: null,
        message: `Account preference '${preferenceKey}' reset to default`,
      };
    }

    return {
      status: 'APPLIED',
      assignedRevision: null,
      message: `Account preference '${preferenceKey}' accepted`,
    };
  }
}

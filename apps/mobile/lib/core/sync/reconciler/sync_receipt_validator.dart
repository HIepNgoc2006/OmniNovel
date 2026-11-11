import 'package:flutter/foundation.dart';
import '../errors/sync_storage_exceptions.dart';
import '../utils/revision_bigint.dart';
import 'mock_sync_transport.dart';

/// Bộ kiểm định tính toàn vẹn biên nhận (Receipt Integrity Validator)
/// cho phản hồi đẩy batch mutation từ Core API Sync Hub.
///
/// Tuân thủ nghiêm ngặt ADR-SYNC-07C-v2.2 và Unified Sync Protocol:
/// 1. Số lượng receipt phải khớp 100% với số lượng mutation trong batch gửi đi.
/// 2. `processedCount` phải khớp với số lượng mutations trong batch.
/// 3. Mọi `mutationId` trong receipt phải thuộc batch đã gửi, không được rỗng.
/// 4. Không được có bất kỳ `mutationId` nào bị trùng lặp trong phản hồi.
/// 5. Mọi mutation đã gửi phải có đúng một biên nhận tương ứng.
/// 6. `newServerRevision` bắt buộc là chuỗi thập phân canonical 64-bit BIGINT hợp lệ.
/// 7. Status bắt buộc thuộc danh mục chuẩn:
///    - Settled: `APPLIED`, `DEDUPLICATED`, `CONFLICT_MERGED`.
///    - Quarantined: `REJECTED_TOMBSTONE`, `REJECTED_STALE`, `DOMAIN_NOT_SUPPORTED`.
/// 8. CẤM tự động cách ly (quarantine) status không nhận diện: ném [ReceiptValidationException]
///    để fail-closed và rollback toàn bộ transaction, giữ nguyên pending queue cho retry.
/// 9. `assignedRevision` bắt buộc hợp lệ:
///    - `APPLIED` và `DEDUPLICATED`: bắt buộc non-null và là canonical decimal BIGINT.
///    - Các status khác: nếu có giá trị (non-null) thì phải là canonical decimal BIGINT.
@immutable
class SyncReceiptValidator {
  const SyncReceiptValidator._();

  static const Set<String> settledStatuses = <String>{
    'APPLIED',
    'DEDUPLICATED',
    'CONFLICT_MERGED',
  };

  static const Set<String> quarantinedStatuses = <String>{
    'REJECTED_TOMBSTONE',
    'REJECTED_STALE',
    'DOMAIN_NOT_SUPPORTED',
  };

  static void validate({
    required List<ClientMutationWire> sentMutations,
    required PushMutationsBatchResponseWire response,
  }) {
    if (!isValidRevisionString(response.newServerRevision)) {
      throw ReceiptValidationException(
        'INVALID_SERVER_REVISION: newServerRevision "${response.newServerRevision}" is not a valid 64-bit canonical decimal string.',
      );
    }

    if (response.results.length != sentMutations.length) {
      throw ReceiptValidationException(
        'RECEIPT_COUNT_MISMATCH: Sent ${sentMutations.length} mutations, but server returned ${response.results.length} receipts.',
      );
    }

    if (response.processedCount != sentMutations.length) {
      throw ReceiptValidationException(
        'PROCESSED_COUNT_MISMATCH: Sent ${sentMutations.length} mutations, but server processedCount is ${response.processedCount}.',
      );
    }

    final sentMap = <String, ClientMutationWire>{
      for (final m in sentMutations) m.mutationId: m,
    };
    final sentIds = sentMap.keys.toSet();
    final seenIds = <String>{};

    for (final item in response.results) {
      final mId = item.mutationId.trim();
      if (mId.isEmpty) {
        throw const ReceiptValidationException(
          'EMPTY_MUTATION_ID: Receipt contains an empty or whitespace mutationId.',
        );
      }

      if (!sentIds.contains(mId)) {
        throw ReceiptValidationException(
          'UNEXPECTED_MUTATION_ID: Receipt for mutationId "$mId" was not part of the sent batch.',
        );
      }

      if (!seenIds.add(mId)) {
        throw ReceiptValidationException(
          'DUPLICATE_RECEIPT: Duplicate receipt received for mutationId "$mId".',
        );
      }

      final sentMutation = sentMap[mId]!;
      final status = item.status.trim().toUpperCase();
      final isSettled = settledStatuses.contains(status);
      final isQuarantined = quarantinedStatuses.contains(status);

      if (!isSettled && !isQuarantined) {
        throw ReceiptValidationException(
          'UNRECOGNIZED_RECEIPT_STATUS: Status "$status" for mutationId "$mId" is not recognized by the protocol.',
        );
      }

      if (isValidRevisionString(sentMutation.baseServerRevision)) {
        final serverRevBigInt = parseRevisionBigInt(response.newServerRevision);
        final baseBigInt = parseRevisionBigInt(sentMutation.baseServerRevision);
        if (serverRevBigInt < baseBigInt) {
          throw ReceiptValidationException(
            'STALE_SERVER_REVISION: newServerRevision (${response.newServerRevision}) < baseServerRevision (${sentMutation.baseServerRevision}) for mutationId "$mId".',
          );
        }
      }

      if (status == 'APPLIED' || status == 'DEDUPLICATED') {
        if (item.assignedRevision == null ||
            !isValidRevisionString(item.assignedRevision)) {
          throw ReceiptValidationException(
            'INVALID_ASSIGNED_REVISION: Status "$status" for mutationId "$mId" requires a valid canonical decimal assignedRevision, got "${item.assignedRevision}".',
          );
        }

        if (isValidRevisionString(sentMutation.baseServerRevision)) {
          final assignedBigInt = parseRevisionBigInt(item.assignedRevision!);
          final baseBigInt = parseRevisionBigInt(sentMutation.baseServerRevision);
          if (assignedBigInt < baseBigInt) {
            throw ReceiptValidationException(
              'STALE_ASSIGNED_REVISION: Status "$status" for mutationId "$mId" has assignedRevision (${item.assignedRevision}) < baseServerRevision (${sentMutation.baseServerRevision}).',
            );
          }
        }
      } else if (item.assignedRevision != null &&
          !isValidRevisionString(item.assignedRevision)) {
        throw ReceiptValidationException(
          'INVALID_ASSIGNED_REVISION: Optional assignedRevision "${item.assignedRevision}" for mutationId "$mId" is not a valid canonical decimal string.',
        );
      }
    }

    if (seenIds.length != sentIds.length) {
      throw ReceiptValidationException(
        'MISSING_RECEIPTS: Expected receipts for ${sentIds.length} mutations, but only received ${seenIds.length}.',
      );
    }
  }

  static bool isSettled(String status) =>
      settledStatuses.contains(status.trim().toUpperCase());

  static bool isQuarantined(String status) =>
      quarantinedStatuses.contains(status.trim().toUpperCase());
}

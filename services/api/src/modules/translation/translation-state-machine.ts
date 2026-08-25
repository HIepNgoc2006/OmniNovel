import { BadRequestException } from '@nestjs/common';
import { TranslationJobStatus } from '@omninovel/shared';

/**
 * Các trạng thái active mà Worker được phép cập nhật định kỳ (progress / heartbeat).
 */
export const WORKER_REPORTABLE_ACTIVE_STATES: readonly TranslationJobStatus[] = [
  TranslationJobStatus.PREPROCESSING,
  TranslationJobStatus.OCR,
  TranslationJobStatus.TRANSLATING,
  TranslationJobStatus.INPAINTING,
  TranslationJobStatus.TYPESETTING,
  TranslationJobStatus.QUALITY_CHECK,
] as const;

/**
 * Trạng thái kết thúc của Worker pipeline (trước khi Editor/Owner Apply).
 */
export const WORKER_FINAL_STATE = TranslationJobStatus.READY_FOR_REVIEW;

/**
 * Tập hợp tất cả các trạng thái mà Worker được phép gửi lên Core API.
 */
export const WORKER_REPORTABLE_STATES: readonly TranslationJobStatus[] = [
  ...WORKER_REPORTABLE_ACTIVE_STATES,
  WORKER_FINAL_STATE,
] as const;

/**
 * Các trạng thái kết thúc hệ thống (Terminal States) - Bất biến, không nhận thêm event nào.
 */
export const SYSTEM_TERMINAL_STATES: readonly TranslationJobStatus[] = [
  TranslationJobStatus.APPLIED,
  TranslationJobStatus.CANCELED,
  TranslationJobStatus.FAILED,
  TranslationJobStatus.EXPIRED,
] as const;

/**
 * Ma trận các bước chuyển tiếp trạng thái hợp lệ trong luồng bình thường.
 */
export const FORWARD_TRANSITIONS: Record<
  TranslationJobStatus,
  readonly TranslationJobStatus[]
> = {
  [TranslationJobStatus.CREATED]: [
    TranslationJobStatus.VALIDATING,
    TranslationJobStatus.FAILED,
  ],
  [TranslationJobStatus.VALIDATING]: [
    TranslationJobStatus.QUEUED,
    TranslationJobStatus.FAILED,
  ],
  [TranslationJobStatus.QUEUED]: [
    TranslationJobStatus.PREPROCESSING,
    TranslationJobStatus.CANCELED,
    TranslationJobStatus.FAILED,
  ],
  [TranslationJobStatus.PREPROCESSING]: [
    TranslationJobStatus.OCR,
    TranslationJobStatus.TRANSLATING, // Novel skips OCR
    TranslationJobStatus.CANCELED,
    TranslationJobStatus.FAILED,
  ],
  [TranslationJobStatus.OCR]: [
    TranslationJobStatus.TRANSLATING,
    TranslationJobStatus.CANCELED,
    TranslationJobStatus.FAILED,
  ],
  [TranslationJobStatus.TRANSLATING]: [
    TranslationJobStatus.INPAINTING,
    TranslationJobStatus.QUALITY_CHECK, // Novel skips INPAINTING/TYPESETTING
    TranslationJobStatus.CANCELED,
    TranslationJobStatus.FAILED,
  ],
  [TranslationJobStatus.INPAINTING]: [
    TranslationJobStatus.TYPESETTING,
    TranslationJobStatus.CANCELED,
    TranslationJobStatus.FAILED,
  ],
  [TranslationJobStatus.TYPESETTING]: [
    TranslationJobStatus.QUALITY_CHECK,
    TranslationJobStatus.CANCELED,
    TranslationJobStatus.FAILED,
  ],
  [TranslationJobStatus.QUALITY_CHECK]: [
    TranslationJobStatus.READY_FOR_REVIEW,
    TranslationJobStatus.CANCELED,
    TranslationJobStatus.FAILED,
  ],
  [TranslationJobStatus.READY_FOR_REVIEW]: [
    TranslationJobStatus.APPLIED,
    TranslationJobStatus.CANCELED,
    TranslationJobStatus.EXPIRED,
  ],
  [TranslationJobStatus.APPLIED]: [],
  [TranslationJobStatus.CANCELED]: [],
  [TranslationJobStatus.FAILED]: [],
  [TranslationJobStatus.EXPIRED]: [],
};

/**
 * Kiểm tra xem stage gửi từ worker có nằm trong danh sách được phép hay không.
 */
export function assertWorkerReportableState(stage: TranslationJobStatus): void {
  if (!WORKER_REPORTABLE_STATES.includes(stage)) {
    throw new BadRequestException(
      `INVALID_WORKER_STAGE: Worker không được phép tự ý gửi trạng thái hệ thống: ${stage}. Trạng thái hợp lệ: ${WORKER_REPORTABLE_STATES.join(', ')}`,
    );
  }
}

/**
 * Kiểm tra tính hợp lệ khi chuyển trạng thái từ `current` sang `target`.
 * Hỗ trợ same-state event (heartbeat / progress updates) cho các active states.
 */
export function assertTransitionAllowed(
  current: TranslationJobStatus,
  target: TranslationJobStatus,
): void {
  // 1. Same-state update (Heartbeat / Progress report): Hợp lệ nếu stage đang active
  if (current === target && WORKER_REPORTABLE_ACTIVE_STATES.includes(target)) {
    return;
  }

  // 2. Kiểm tra Terminal
  if (SYSTEM_TERMINAL_STATES.includes(current)) {
    throw new BadRequestException(
      `INVALID_STATE_TRANSITION: Không thể chuyển trạng thái từ Terminal State ${current} sang ${target}.`,
    );
  }

  // 3. READY_FOR_REVIEW không thể chuyển ngược lại các bước worker
  if (current === TranslationJobStatus.READY_FOR_REVIEW && current === target) {
    return;
  }

  // 4. Forward transitions
  const allowedTargets = FORWARD_TRANSITIONS[current] || [];
  if (!allowedTargets.includes(target)) {
    throw new BadRequestException(
      `INVALID_STATE_TRANSITION: Chuyển đổi từ ${current} sang ${target} không hợp lệ. Các đích hợp lệ: [${allowedTargets.join(', ')}].`,
    );
  }
}

/**
 * System transition: Bắt đầu một retry attempt mới từ BullMQ processor.
 * Cho phép chuyển từ bất kỳ active state nào hoặc QUEUED/VALIDATING về PREPROCESSING.
 */
export function canBeginRetryAttempt(
  currentStatus: TranslationJobStatus,
  currentAttempt: number,
  newAttemptNumber: number,
  maxAttempts = 3,
): boolean {
  if (SYSTEM_TERMINAL_STATES.includes(currentStatus)) {
    return false;
  }
  if (newAttemptNumber <= currentAttempt || newAttemptNumber > maxAttempts) {
    return false;
  }
  return true;
}

import { TranslationJobStatus } from '../index';

export interface JobProgressWsEvent {
  jobId: string;
  status: TranslationJobStatus;
  progress: number;
  heartbeatAt?: string;
  timestamp: string;
}

export interface JobReadyWsEvent {
  jobId: string;
  status: TranslationJobStatus.READY_FOR_REVIEW;
  timestamp: string;
}

export interface JobFailedWsEvent {
  jobId: string;
  status: TranslationJobStatus.FAILED;
  timestamp: string;
}

export interface JobCanceledWsEvent {
  jobId: string;
  status: TranslationJobStatus.CANCELED;
  timestamp: string;
}

export interface TranslationWsServerEventMap {
  job_progress: JobProgressWsEvent;
  job_ready_for_review: JobReadyWsEvent;
  job_failed: JobFailedWsEvent;
  job_canceled: JobCanceledWsEvent;
}

export type TranslationWsEvent =
  | ({ event: 'job_progress' } & JobProgressWsEvent)
  | ({ event: 'job_ready_for_review' } & JobReadyWsEvent)
  | ({ event: 'job_failed' } & JobFailedWsEvent)
  | ({ event: 'job_canceled' } & JobCanceledWsEvent);

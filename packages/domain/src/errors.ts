import type { SyncedPlayback } from '@yuqu/contracts';

export class AppError extends Error {
  status: number;
  code: string;
  snapshot?: SyncedPlayback;
  retryAfter?: number;

  constructor(status: number, code: string, message: string, snapshot?: SyncedPlayback, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.snapshot = snapshot;
    this.retryAfter = retryAfter;
  }
}

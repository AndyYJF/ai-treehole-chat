export class SyncConflictError extends Error {
  readonly code = "SYNC_CONFLICT";

  constructor(message = "The record was changed by another device") {
    super(message);
    this.name = "SyncConflictError";
  }
}

export function isSyncConflictError(error: unknown): error is SyncConflictError {
  return error instanceof SyncConflictError;
}

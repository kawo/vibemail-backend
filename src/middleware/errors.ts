/** The closed error-code union from CONTRACT.md §3.3. */
export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'GMAIL_NOT_CONNECTED'
  | 'GMAIL_TOKEN_REVOKED'
  | 'VALIDATION_FAILED'
  | 'MESSAGE_NOT_FOUND'
  | 'GMAIL_RATE_LIMITED'
  | 'GMAIL_UPSTREAM_ERROR'
  | 'SYNC_FAILED'
  | 'METHOD_NOT_ALLOWED'
  | 'CONFIG_ERROR'
  | 'INTERNAL';

/** A failure that maps 1:1 onto the §3.3 error envelope. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

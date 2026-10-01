export type ErrorCode =
  | "VALIDATION_ERROR"
  | "DIMENSION_MISMATCH"
  | "NON_FINITE_VALUE"
  | "INVALID_DIRECTION"
  | "INVALID_REFERENCE_POINT"
  | "REFERENCE_POINT_DOMINATED"
  | "REFERENCE_POINT_INFEASIBLE_SIDE"
  | "UNSUPPORTED_DIMENSION"
  | "NOT_FOUND"
  | "DUPLICATE_BATCH"
  | "SCALE_MISMATCH"
  | "REFERENCE_POINT_MISMATCH"
  | "EMPTY_BATCH"
  | "IDEMPOTENCY_MISMATCH"
  | "INVALID_PAGINATION";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, details?: unknown, httpStatus = 400) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

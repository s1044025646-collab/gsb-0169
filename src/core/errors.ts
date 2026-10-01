export type ErrorCode =
  | "VALIDATION_ERROR"
  | "DIMENSION_MISMATCH"
  | "NON_FINITE_VALUE"
  | "BAD_REFERENCE_POINT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNSUPPORTED_DIMENSION"
  | "BATCH_MISMATCH"
  | "BAD_REQUEST";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case "VALIDATION_ERROR":
    case "DIMENSION_MISMATCH":
    case "NON_FINITE_VALUE":
    case "BAD_REFERENCE_POINT":
    case "BAD_REQUEST":
    case "UNSUPPORTED_DIMENSION":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "BATCH_MISMATCH":
      return 409;
  }
}

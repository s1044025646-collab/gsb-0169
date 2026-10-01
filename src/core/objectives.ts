import { AppError } from "./errors.js";
import type { Direction, ObjectiveSpec } from "./types.js";

export const MIN_DIMS = 2;
export const MAX_DIMS = 3;

export function validateObjectives(objectives: unknown): ObjectiveSpec[] {
  if (!Array.isArray(objectives)) {
    throw new AppError("VALIDATION_ERROR", "objectives must be an array");
  }
  if (objectives.length < MIN_DIMS || objectives.length > MAX_DIMS) {
    throw new AppError(
      "UNSUPPORTED_DIMENSION",
      `number of objectives must be between ${MIN_DIMS} and ${MAX_DIMS}, got ${objectives.length}`,
    );
  }
  return objectives.map((raw, index) => {
    const obj = raw as Partial<ObjectiveSpec> | null;
    if (!obj || typeof obj !== "object") {
      throw new AppError("VALIDATION_ERROR", `objective[${index}] must be an object`);
    }
    if (typeof obj.name !== "string" || obj.name.trim() === "") {
      throw new AppError("VALIDATION_ERROR", `objective[${index}].name must be a non-empty string`);
    }
    if (obj.direction !== "max" && obj.direction !== "min") {
      throw new AppError(
        "INVALID_DIRECTION",
        `objective[${index}].direction must be "max" or "min", got ${String(obj.direction)}`,
      );
    }
    if (typeof obj.unit !== "string" || obj.unit.trim() === "") {
      throw new AppError("VALIDATION_ERROR", `objective[${index}].unit must be a non-empty string`);
    }
    return { name: obj.name, direction: obj.direction as Direction, unit: obj.unit.trim() };
  });
}

export function assertFiniteVector(values: unknown, dims: number, label: string): number[] {
  if (!Array.isArray(values)) {
    throw new AppError("VALIDATION_ERROR", `${label} must be an array of numbers`);
  }
  if (values.length !== dims) {
    throw new AppError(
      "DIMENSION_MISMATCH",
      `${label} has ${values.length} dimensions, expected ${dims}`,
      { actual: values.length, expected: dims },
    );
  }
  return values.map((raw, index) => {
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) {
      throw new AppError(
        "NON_FINITE_VALUE",
        `${label}[${index}] is not a finite number: ${String(raw)}`,
        { index, value: String(raw) },
      );
    }
    return value;
  });
}

/**
 * Convert a raw value to the unified maximization frame.
 * max objectives are kept as-is, min objectives are sign-flipped.
 * The reference point must be converted with the SAME transform so the
 * resulting box edges remain comparable.
 */
export function toMaxFrame(value: number, direction: Direction): number {
  return direction === "max" ? value : -value;
}

export function normalizeVector(values: number[], objectives: ObjectiveSpec[]): number[] {
  return values.map((value, index) => toMaxFrame(value, objectives[index]!.direction));
}

/**
 * A normalized point only contributes to hypervolume if it strictly
 * dominates the reference point in EVERY axis (x_i > ref_i in max frame).
 * Equality on an axis yields a zero-width box and is accepted (zero area),
 * but any point on the wrong side is rejected explicitly instead of being
 * silently clamped.
 */
export function validateReferencePoint(refRaw: number[], objectives: ObjectiveSpec[]): number[] {
  const ref = assertFiniteVector(refRaw, objectives.length, "referencePoint");
  return normalizeVector(ref, objectives);
}

export function assertPointCanDominateRef(point: number[], ref: number[], candidateId: string): void {
  const wrong = point
    .map((value, index) => ({ index, value }))
    .filter((entry) => entry.value < ref[entry.index]!);
  if (wrong.length > 0) {
    throw new AppError(
      "REFERENCE_POINT_INFEASIBLE_SIDE",
      `candidate ${candidateId} lies on the wrong side of the reference point on objective(s) ${wrong
        .map((entry) => entry.index)
        .join(", ")}; reference point will not be moved`,
      { candidateId, axes: wrong.map((entry) => entry.index) },
    );
  }
}

import { AppError } from "./errors.js";
import type {
  Candidate,
  CandidateInput,
  NormalPoint,
  ObjectiveSpec,
  ProblemConfig,
} from "./types.js";

export function assertFiniteVector(vec: number[], dimension: number, what: string): void {
  if (!Array.isArray(vec) || vec.length !== dimension) {
    throw new AppError(
      "DIMENSION_MISMATCH",
      `${what} must have exactly ${dimension} values, got ${Array.isArray(vec) ? vec.length : "non-array"}`,
    );
  }
  for (const v of vec) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new AppError("NON_FINITE_VALUE", `${what} contains a non-finite value`, { value: v });
    }
  }
}

export function validateConfig(input: {
  dimension: unknown;
  objectives: unknown;
  referencePoint: unknown;
}): ProblemConfig {
  const dimension = input.dimension;
  if (typeof dimension !== "number" || (dimension !== 2 && dimension !== 3)) {
    throw new AppError("UNSUPPORTED_DIMENSION", "dimension must be 2 or 3", { dimension });
  }
  if (!Array.isArray(input.objectives) || input.objectives.length !== dimension) {
    throw new AppError(
      "VALIDATION_ERROR",
      `objectives must be an array of length ${dimension}`,
    );
  }
  const objectives: ObjectiveSpec[] = input.objectives.map((raw, index) => {
    if (raw === null || typeof raw !== "object") {
      throw new AppError("VALIDATION_ERROR", `objective[${index}] must be an object`);
    }
    const o = raw as Record<string, unknown>;
    if (typeof o.name !== "string" || o.name.trim() === "") {
      throw new AppError("VALIDATION_ERROR", `objective[${index}].name is required`);
    }
    if (o.direction !== "max" && o.direction !== "min") {
      throw new AppError("VALIDATION_ERROR", `objective[${index}].direction must be "max" or "min"`);
    }
    if (typeof o.unit !== "string" || o.unit.trim() === "") {
      throw new AppError("VALIDATION_ERROR", `objective[${index}].unit is required`);
    }
    if (typeof o.scale !== "number" || !Number.isFinite(o.scale) || o.scale <= 0) {
      throw new AppError("VALIDATION_ERROR", `objective[${index}].scale must be a positive finite number`);
    }
    return { index, name: o.name, direction: o.direction, unit: o.unit, scale: o.scale };
  });
  assertFiniteVector(input.referencePoint as number[], dimension, "referencePoint");
  return {
    id: "",
    dimension,
    objectives,
    referencePoint: [...(input.referencePoint as number[])],
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * Convert one raw value to the canonical maximization frame:
 * divide by the (positive) unit scale, then negate minimization objectives.
 */
export function normalizeValue(raw: number, spec: ObjectiveSpec): number {
  const canonical = raw / spec.scale;
  return spec.direction === "min" ? -canonical : canonical;
}

/** Convert a raw vector to the canonical maximization frame. */
export function normalizeVector(raw: number[], config: ProblemConfig): number[] {
  assertFiniteVector(raw, config.dimension, "values");
  return config.objectives.map((spec) => normalizeValue(raw[spec.index]!, spec));
}

/** Convert the configured reference point to canonical maximization frame. */
export function referenceInCanonicalFrame(config: ProblemConfig): number[] {
  return normalizeVector(config.referencePoint, config);
}

export function toNormalPoints(
  rows: Array<Pick<Candidate, "id" | "code" | "values" | "feasible">>,
  config: ProblemConfig,
): NormalPoint[] {
  return rows.map((row) => {
    assertFiniteVector(row.values, config.dimension, `candidate ${row.code} values`);
    return {
      candidateIds: [row.id],
      codes: [row.code],
      coords: normalizeVector(row.values, config),
      feasible: !!row.feasible,
    };
  });
}

export function makeInputPoint(input: CandidateInput, config: ProblemConfig, id: number): NormalPoint {
  assertFiniteVector(input.values, config.dimension, `candidate ${input.code} values`);
  return {
    candidateIds: [id],
    codes: [input.code],
    coords: normalizeVector(input.values, config),
    feasible: input.feasible !== false,
  };
}

/**
 * Merge points with identical normalized coordinates into one group while
 * preserving every originating candidate id/code. The union geometry is
 * therefore counted exactly once even when sources share coordinates.
 */
export function mergeDuplicateCoordinates(points: NormalPoint[]): NormalPoint[] {
  const byKey = new Map<string, NormalPoint>();
  for (const p of points) {
    const key = p.coords.map((c) => c.toString()).join("|");
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        candidateIds: [...p.candidateIds],
        codes: [...p.codes],
        coords: p.coords,
        feasible: p.feasible,
      });
    } else {
      existing.candidateIds.push(...p.candidateIds);
      existing.codes.push(...p.codes);
    }
  }
  return [...byKey.values()];
}

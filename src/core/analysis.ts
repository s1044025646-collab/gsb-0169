import { AppError } from "./errors.js";
import type {
  CandidateInput,
  ContributionResult,
  DominanceEvidence,
  LayerResult,
  NormalizedPoint,
  ObjectiveSpec,
  Scale,
} from "./types.js";
import {
  assertFiniteVector,
  normalizeVector,
  validateObjectives,
  validateReferencePoint,
} from "./objectives.js";
import { buildDominanceEvidence, dedupeByCoordinate, nonDominatedSort } from "./dominance.js";
import { contributions as computeContributions, hypervolume } from "./hypervolume.js";

export interface PreparedBatch {
  objectives: ObjectiveSpec[];
  referencePoint: number[];
  feasible: NormalizedPoint[];
  infeasible: NormalizedPoint[];
}

export function validateCandidates(input: unknown, objectives: ObjectiveSpec[]): CandidateInput[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AppError("VALIDATION_ERROR", "candidates must be a non-empty array");
  }
  const seen = new Set<string>();
  return input.map((raw, index) => {
    const candidate = raw as Partial<CandidateInput> | null;
    if (!candidate || typeof candidate !== "object") {
      throw new AppError("VALIDATION_ERROR", `candidates[${index}] must be an object`);
    }
    if (typeof candidate.candidateId !== "string" || candidate.candidateId.trim() === "") {
      throw new AppError("VALIDATION_ERROR", `candidates[${index}].candidateId must be a non-empty string`);
    }
    if (seen.has(candidate.candidateId)) {
      throw new AppError("VALIDATION_ERROR", `duplicate candidateId within import: ${candidate.candidateId}`);
    }
    seen.add(candidate.candidateId);
    const values = assertFiniteVector(candidate.values, objectives.length, `candidates[${index}].values`);
    const feasible = typeof candidate.feasible === "boolean" ? candidate.feasible : true;
    return { candidateId: candidate.candidateId, values, feasible };
  });
}

export function prepareBatch(
  objectivesInput: unknown,
  referencePointInput: unknown,
  candidatesInput: unknown,
): PreparedBatch {
  const objectives = validateObjectives(objectivesInput);
  const referencePoint = validateReferencePoint(
    assertFiniteVector(referencePointInput, objectives.length, "referencePoint"),
    objectives,
  );
  const candidates = validateCandidates(candidatesInput, objectives);

  const feasible: NormalizedPoint[] = [];
  const infeasible: NormalizedPoint[] = [];
  for (const candidate of candidates) {
    const normalized: NormalizedPoint = {
      candidateId: candidate.candidateId,
      x: normalizeVector(candidate.values, objectives),
      feasible: candidate.feasible,
      feasibleCount: candidate.feasible ? 1 : 0,
    };
    if (candidate.feasible) feasible.push(normalized);
    else infeasible.push(normalized);
  }
  return { objectives, referencePoint, feasible, infeasible };
}

export interface BatchAnalysis {
  layers: LayerResult[];
  evidence: DominanceEvidence[];
  contributions: ContributionResult[];
  hypervolume: number;
  uniqueFrontCoordinates: number;
  infeasible: string[];
}

export function analyzeBatch(prepared: PreparedBatch): BatchAnalysis {
  const { layers, rankByCandidate } = nonDominatedSort(prepared.feasible);
  const evidence = buildDominanceEvidence(prepared.feasible, rankByCandidate, prepared.infeasible);

  // Hypervolume uses the feasible FIRST FRONT only (the Pareto front).
  const firstFrontIds = new Set(layers[0]?.points ?? []);
  const frontPoints = prepared.feasible.filter((point) => firstFrontIds.has(point.candidateId));
  const { unique } = dedupeByCoordinate(frontPoints);
  const hv = hypervolume(unique, prepared.referencePoint);

  const contributionResults = computeContributions(frontPoints, prepared.referencePoint, rankByCandidate);

  return {
    layers,
    evidence,
    contributions: contributionResults.map((entry) => ({
      candidateId: entry.candidateId,
      contribution: entry.contribution,
      totalHypervolume: entry.total,
      hypervolumeWithout: entry.without,
      rank: entry.rank,
    })),
    hypervolume: hv,
    uniqueFrontCoordinates: unique.length,
    infeasible: prepared.infeasible.map((point) => point.candidateId).sort(),
  };
}

export function assertSameFrame(
  a: { objectives: ObjectiveSpec[]; referencePoint: number[]; scale?: Scale },
  b: { objectives: ObjectiveSpec[]; referencePoint: number[]; scale?: Scale },
): void {
  if (a.objectives.length !== b.objectives.length) {
    throw new AppError("SCALE_MISMATCH", "batches have different numbers of objectives");
  }
  for (let i = 0; i < a.objectives.length; i++) {
    if (a.objectives[i]!.direction !== b.objectives[i]!.direction) {
      throw new AppError("SCALE_MISMATCH", `objective ${i} direction differs between batches`);
    }
  }
  for (let i = 0; i < a.referencePoint.length; i++) {
    if (a.referencePoint[i] !== b.referencePoint[i]) {
      throw new AppError(
        "REFERENCE_POINT_MISMATCH",
        `frozen reference point differs on axis ${i}; refusing to compare on different baselines`,
        { axis: i, a: a.referencePoint[i], b: b.referencePoint[i] },
      );
    }
  }
  const factorsA = a.scale?.factors;
  const factorsB = b.scale?.factors;
  if (factorsA && factorsB) {
    for (let i = 0; i < factorsA.length; i++) {
      if (Math.abs(factorsA[i]! - factorsB[i]!) > 1e-12) {
        throw new AppError("SCALE_MISMATCH", `scale factor differs on axis ${i}; freeze a single scale`);
      }
    }
  }
}

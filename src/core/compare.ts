import { createHash } from "node:crypto";
import { nonDominatedSort, type DominanceEvidence } from "./dominance.js";
import { computeContributions, computeHypervolume } from "./hypervolume.js";
import { mergeDuplicateCoordinates, toNormalPoints } from "./normalize.js";
import type { Candidate, ProblemConfig } from "./types.js";
import { AppError } from "./errors.js";

export function configHash(config: ProblemConfig): string {
  const canonical = {
    dimension: config.dimension,
    objectives: config.objectives.map((o) => ({
      name: o.name,
      direction: o.direction,
      unit: o.unit,
      scale: o.scale,
    })),
    referencePoint: config.referencePoint,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

export function feasibleNormalPoints(candidates: Candidate[], config: ProblemConfig) {
  return mergeDuplicateCoordinates(
    toNormalPoints(
      candidates.map((c) => ({ id: c.id, code: c.code, values: c.values, feasible: c.feasible })),
      config,
    ),
  );
}

export interface BatchAnalysis {
  batchId: number;
  layers: Array<{ rank: number; points: Array<{ coords: number[]; codes: string[]; candidateIds: number[] }> }>;
  infeasible: Array<{ values: number[]; code: string; candidateId: number }>;
  evidence: Array<DominanceEvidence & { rank: number | null }>;
  hypervolume: { value: number; unitLabel: string };
}

export function analyzeBatch(candidates: Candidate[], config: ProblemConfig, batchId: number): BatchAnalysis {
  const all = toNormalPoints(
    candidates.map((c) => ({ id: c.id, code: c.code, values: c.values, feasible: c.feasible })),
    config,
  );
  const sorted = nonDominatedSort(all);
  const feasible = all.filter((p) => p.feasible);
  const hv = computeHypervolume(feasible, config);

  const rankByCode = new Map<string, number>();
  for (const layer of sorted.layers) {
    for (const p of layer.points) {
      for (const code of p.codes) rankByCode.set(code, layer.rank);
    }
  }

  return {
    batchId,
    layers: sorted.layers.map((layer) => ({
      rank: layer.rank,
      points: layer.points.map((p) => ({
        coords: p.coords,
        codes: p.codes,
        candidateIds: p.candidateIds,
      })),
    })),
    infeasible: sorted.infeasible.map((p) => ({
      candidateId: p.candidateIds[0]!,
      code: p.codes[0]!,
      values: candidates.find((c) => c.id === p.candidateIds[0])!.values,
    })),
    evidence: sorted.evidence.map((e) => ({ ...e, rank: rankByCode.get(e.code) ?? null })),
    hypervolume: { value: hv.hypervolume, unitLabel: hv.unitLabel },
  };
}

export interface ComparisonReport {
  problemId: string;
  configHash: string;
  frozenReferencePoint: number[];
  frozenObjectives: ProblemConfig["objectives"];
  unitLabel: string;
  batchA: { batchId: number; name: string; hypervolume: number; frontSize: number };
  batchB: { batchId: number; name: string; hypervolume: number; frontSize: number };
  /** HV(B) - HV(A) in the common dimensional units. No weighted score. */
  deltaHypervolume: number;
  indicator: "A_better" | "B_better" | "tie";
  note: string;
}

export function compareBatches(
  config: ProblemConfig,
  a: { batchId: number; name: string; candidates: Candidate[] },
  b: { batchId: number; name: string; candidates: Candidate[] },
): ComparisonReport {
  const hash = configHash(config);
  const analysisA = analyzeBatch(a.candidates, config, a.batchId);
  const analysisB = analyzeBatch(b.candidates, config, b.batchId);
  const hvA = analysisA.hypervolume.value;
  const hvB = analysisB.hypervolume.value;
  const eps = 1e-12;
  const delta = hvB - hvA;

  return {
    problemId: config.id,
    configHash: hash,
    frozenReferencePoint: config.referencePoint,
    frozenObjectives: config.objectives,
    unitLabel: analysisA.hypervolume.unitLabel,
    batchA: {
      batchId: a.batchId,
      name: a.name,
      hypervolume: hvA,
      frontSize: analysisA.layers[0]?.points.length ?? 0,
    },
    batchB: {
      batchId: b.batchId,
      name: b.name,
      hypervolume: hvB,
      frontSize: analysisB.layers[0]?.points.length ?? 0,
    },
    deltaHypervolume: delta,
    indicator: Math.abs(delta) <= eps ? "tie" : delta > 0 ? "B_better" : "A_better",
    note:
      "Hypervolume is dimensional (units: " +
      analysisA.hypervolume.unitLabel +
      "). Both batches share one frozen reference point and scale; no weighted-sum score is used.",
  };
}

/**
 * Assert two problem configs are identical before comparing. A changed
 * reference point, direction, or scale must produce a new report instead of
 * silently mixing incompatible hypervolumes.
 */
export function assertSameConfig(configA: ProblemConfig, configB: ProblemConfig): void {
  if (configHash(configA) !== configHash(configB)) {
    throw new AppError(
      "BATCH_MISMATCH",
      "frozen problem parameters differ; create a new report rather than comparing under different reference points/scales",
      { hashA: configHash(configA), hashB: configHash(configB) },
    );
  }
}

export { computeHypervolume, computeContributions, nonDominatedSort };

import type { NormalPoint } from "./types.js";

/**
 * Pareto dominance in the canonical maximization frame.
 * a dominates b when a is no worse on every objective and strictly better on
 * at least one. Equal-on-all-coordinates points are mutually non-dominating.
 */
export function dominates(a: readonly number[], b: readonly number[]): boolean {
  let strictlyBetter = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return false;
    if (a[i]! > b[i]!) strictlyBetter = true;
  }
  return strictlyBetter;
}

export function weaklyDominates(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return false;
  }
  return true;
}

/** True when the point contributes a positive-orthant box reaching the reference. */
export function dominatesReference(p: NormalPoint, referenceNormal: readonly number[]): boolean {
  for (let i = 0; i < p.coords.length; i++) {
    if (p.coords[i]! <= referenceNormal[i]!) return false;
  }
  return true;
}

export interface DominanceEvidence {
  code: string;
  candidateIds: number[];
  coords: number[];
  /** Codes of points that dominate this point. */
  dominatedBy: string[];
  /** Codes of points dominated by this point. */
  dominates: string[];
}

export interface SortWithEvidence {
  layers: Array<{ rank: number; points: NormalPoint[] }>;
  infeasible: NormalPoint[];
  evidence: DominanceEvidence[];
}

/**
 * Layer-by-layer non-dominated sorting (fast non-dominated sort).
 * Infeasible points are reported separately and never mixed into a feasible
 * front. Duplicate coordinates must already be merged: they do not dominate
 * each other and occupy the same layer.
 */
export function nonDominatedSort(allPoints: NormalPoint[]): SortWithEvidence {
  const feasible = allPoints.filter((p) => p.feasible);
  const infeasible = allPoints.filter((p) => !p.feasible);

  const evidence = feasible.map<DominanceEvidence>((p) => ({
    code: p.codes.join(","),
    candidateIds: [...p.candidateIds],
    coords: [...p.coords],
    dominatedBy: [],
    dominates: [],
  }));

  // dominationCount[p] = number of points dominating p
  const dominationCount = feasible.map(() => 0);
  // dominatedSet[p] = indices p dominates
  const dominatedSet: number[][] = feasible.map(() => []);

  for (let i = 0; i < feasible.length; i++) {
    for (let j = i + 1; j < feasible.length; j++) {
      const pi = feasible[i]!;
      const pj = feasible[j]!;
      if (dominates(pi.coords, pj.coords)) {
        dominatedSet[i]!.push(j);
        dominationCount[j]!++;
        evidence[i]!.dominates.push(pj.codes.join(","));
        evidence[j]!.dominatedBy.push(pi.codes.join(","));
      } else if (dominates(pj.coords, pi.coords)) {
        dominatedSet[j]!.push(i);
        dominationCount[i]!++;
        evidence[j]!.dominates.push(pi.codes.join(","));
        evidence[i]!.dominatedBy.push(pj.codes.join(","));
      }
    }
  }

  const layers: Array<{ rank: number; points: NormalPoint[] }> = [];
  let remaining = feasible.length;
  let currentFront = feasible
    .map((_, idx) => idx)
    .filter((idx) => dominationCount[idx] === 0);

  while (currentFront.length > 0) {
    const rank = layers.length + 1;
    layers.push({ rank, points: currentFront.map((idx) => feasible[idx]!) });
    remaining -= currentFront.length;
    const nextFront: number[] = [];
    for (const idx of currentFront) {
      for (const dominatedIdx of dominatedSet[idx]!) {
        dominationCount[dominatedIdx]!--;
        if (dominationCount[dominatedIdx] === 0) nextFront.push(dominatedIdx);
      }
    }
    currentFront = nextFront;
  }

  if (remaining !== 0) {
    throw new Error("internal error: non-dominated sort failed to assign all points");
  }

  return { layers, infeasible, evidence };
}

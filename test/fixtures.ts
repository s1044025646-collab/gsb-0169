import type { CandidateInput, ObjectiveSpec } from "../src/core/types.js";

export const objectives2DMinMax: ObjectiveSpec[] = [
  { name: "cost", direction: "min", unit: "USD" },
  { name: "performance", direction: "max", unit: "score" },
];

export const objectives3D: ObjectiveSpec[] = [
  { name: "mass", direction: "min", unit: "kg" },
  { name: "range", direction: "max", unit: "km" },
  { name: "comfort", direction: "max", unit: "score" },
];

/** Mutually non-dominating 2D points (after max-frame normalization). */
export function mutualNonDominated(): CandidateInput[] {
  // min cost, max performance. An anti-chain needs cost and performance to
  // increase together: cheaper options are slower, pricier options are
  // faster, so no point dominates another.
  return [
    { candidateId: "P1", values: [2, 3], feasible: true },
    { candidateId: "P2", values: [4, 6], feasible: true },
    { candidateId: "P3", values: [7, 9], feasible: true },
  ];
}

/** Chain dominance: C1 dominates C2 dominates C3. */
export function chainDomination(): CandidateInput[] {
  return [
    { candidateId: "C1", values: [1, 9], feasible: true },
    { candidateId: "C2", values: [3, 6], feasible: true },
    { candidateId: "C3", values: [6, 2], feasible: true },
  ];
}

/** Duplicate coordinates with distinct source ids. */
export function duplicatePoints(): CandidateInput[] {
  return [
    { candidateId: "D1", values: [2, 5], feasible: true },
    { candidateId: "D2", values: [2, 5], feasible: true },
    { candidateId: "D3", values: [4, 4], feasible: true },
  ];
}

/**
 * Zero-contribution point: Z is on the Pareto front but its box is fully
 * covered by the union of the other two boxes (2D), so exclusive HV is 0.
 * Reference at origin in max frame.
 */
export function zeroContribution2D(): CandidateInput[] {
  // A=(4,2), B=(2,4): union area = 8+8-4 = 12.
  // Z=(2,2) box of area 4 is fully inside the union -> adds 0.
  // Z is dominated, so this set is passed directly to the HV primitives
  // (not through front extraction) to test exclusive-contribution semantics.
  return [
    { candidateId: "A", values: [4, 2], feasible: true },
    { candidateId: "B", values: [2, 4], feasible: true },
    { candidateId: "Z", values: [2, 2], feasible: true },
  ];
}

/** Points sharing a single axis value (ties must not imply dominance). */
export function sameAxisValue(): CandidateInput[] {
  return [
    { candidateId: "T1", values: [3, 5], feasible: true },
    { candidateId: "T2", values: [3, 7], feasible: true },
    // cost is minimized: T3 ties T1 on performance but has lower cost.
    { candidateId: "T3", values: [1, 5], feasible: true },
  ];
}

export function withInfeasible(points: CandidateInput[]): CandidateInput[] {
  return [
    ...points,
    { candidateId: "BAD1", values: [0, 100], feasible: false },
    { candidateId: "BAD2", values: [5, 5], feasible: false },
  ];
}

/** A handful of 3D points for slice boundary tests. */
export function threeDPoints(): CandidateInput[] {
  return [
    { candidateId: "Q1", values: [1, 6, 5], feasible: true },
    { candidateId: "Q2", values: [2, 5, 6], feasible: true },
    { candidateId: "Q3", values: [3, 4, 4], feasible: true },
    { candidateId: "Q4", values: [2, 6, 6], feasible: true },
  ];
}

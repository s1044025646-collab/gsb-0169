import { describe, expect, it } from "vitest";
import { dominates, nonDominatedSort, dedupeByCoordinate } from "../src/core/dominance.js";
import {
  hypervolume,
  hypervolume2D,
  hypervolume3D,
  hypervolumeInclusionExclusion,
  contributions,
  scaledHypervolume,
} from "../src/core/hypervolume.js";
import { prepareBatch, analyzeBatch } from "../src/core/analysis.js";
import { AppError } from "../src/core/errors.js";
import type { NormalizedPoint, Scale } from "../src/core/types.js";
import {
  objectives2DMinMax,
  objectives3D,
  mutualNonDominated,
  chainDomination,
  duplicatePoints,
  zeroContribution2D,
  sameAxisValue,
  withInfeasible,
  threeDPoints,
} from "./fixtures.js";

function prepared2D(candidates: ReturnType<typeof mutualNonDominated>, referencePoint = [10, 0]) {
  return prepareBatch(objectives2DMinMax, referencePoint, candidates);
}

function np(id: string, x: number[]): NormalizedPoint {
  return { candidateId: id, x, feasible: true, feasibleCount: 1 };
}

describe("Pareto dominance", () => {
  it("handles mutual non-domination", () => {
    const prepared = prepared2D(mutualNonDominated());
    const { layers } = nonDominatedSort(prepared.feasible);
    expect(layers).toHaveLength(1);
    expect(layers[0]!.points).toEqual(["P1", "P2", "P3"]);
  });

  it("sorts a dominance chain into three ranks", () => {
    const prepared = prepared2D(chainDomination());
    const { layers, rankByCandidate } = nonDominatedSort(prepared.feasible);
    expect(layers.map((layer) => layer.points)).toEqual([["C1"], ["C2"], ["C3"]]);
    expect(rankByCandidate.get("C3")).toBe(2);
  });

  it("treats equal coordinates as equivalent, never dominating", () => {
    expect(dominates([2, 5], [2, 5])).toBe(false);
    const prepared = prepared2D(duplicatePoints());
    const { unique } = dedupeByCoordinate(prepared.feasible);
    expect(unique.map((point) => point.candidateId).sort()).toEqual(["D1", "D3"]);
  });

  it("does not infer dominance from a single tied axis", () => {
    const prepared = prepared2D(sameAxisValue());
    const evidence = analyzeBatch(prepared).evidence;
    const t1 = evidence.find((entry) => entry.candidateId === "T1")!;
    // T1 (cost=3,perf=5) is dominated by T2 (3,7) and T3 (5,5 in raw min/max)
    expect(t1.dominatedBy.sort()).toEqual(["T2", "T3"]);
    const t2 = evidence.find((entry) => entry.candidateId === "T2")!;
    expect(t2.dominatedBy).toEqual([]);
  });

  it("keeps infeasible points out of every feasible front", () => {
    const prepared = prepared2D(withInfeasible(mutualNonDominated()));
    const analysis = analyzeBatch(prepared);
    expect(analysis.infeasible).toEqual(["BAD1", "BAD2"]);
    const allFrontIds = analysis.layers.flatMap((layer) => layer.points);
    expect(allFrontIds).not.toContain("BAD1");
    expect(allFrontIds).not.toContain("BAD2");
  });
});

describe("2D hypervolume union vs inclusion-exclusion", () => {
  const ref = [0, 0];

  it("matches inclusion-exclusion on overlapping boxes", () => {
    const points = [np("A", [4, 2]), np("B", [2, 4]), np("Z", [2, 2])];
    expect(hypervolume2D(points, ref)).toBeCloseTo(12, 10);
    expect(hypervolume2D(points, ref)).toBeCloseTo(hypervolumeInclusionExclusion(points, ref), 10);
  });

  it("gives the zero-contribution interior point an exclusive contribution of 0", () => {
    const points = zeroContribution2D().map((candidate) => np(candidate.candidateId, candidate.values));
    const { rankByCandidate } = nonDominatedSort(points);
    const result = contributions(points, ref, rankByCandidate);
    const z = result.find((entry) => entry.candidateId === "Z")!;
    expect(z.contribution).toBeCloseTo(0, 10);
    for (const entry of result) expect(entry.contribution).toBeGreaterThanOrEqual(0);
  });

  it("counts a duplicate coordinate only once in the union", () => {
    const points = [np("D1", [2, 5]), np("D2", [2, 5]), np("D3", [4, 4])];
    const { unique } = dedupeByCoordinate(points);
    expect(hypervolume2D(unique, ref)).toBeCloseTo(hypervolumeInclusionExclusion(unique, ref), 10);
    // duplicated point removes nothing individually
    const { rankByCandidate } = nonDominatedSort(points);
    const result = contributions(points, ref, rankByCandidate);
    expect(result.find((entry) => entry.candidateId === "D1")!.contribution).toBe(0);
    expect(result.find((entry) => entry.candidateId === "D2")!.contribution).toBe(0);
  });

  it("adding a dominated point leaves the union unchanged", () => {
    const front = [np("A", [5, 5]), np("B", [3, 8])];
    const withWorse = [...front, np("W", [4, 4])];
    expect(hypervolume(withWorse, ref)).toBeCloseTo(hypervolume(front, ref), 10);
  });

  it("is invariant to input reordering", () => {
    const points = [np("A", [4, 2]), np("B", [2, 4]), np("Z", [2, 2])];
    const a = hypervolume2D(points, ref);
    const b = hypervolume2D([points[2]!, points[0]!, points[1]!], ref);
    expect(a).toBeCloseTo(b, 12);
  });

  it("scales by the product of per-axis scale factors", () => {
    const points = [np("A", [2, 3])];
    const raw = hypervolume2D(points, ref);
    const scale: Scale = { factors: [1000, 1], units: ["g", "score"] };
    expect(scaledHypervolume(raw, scale)).toBeCloseTo(raw * 1000, 10);
  });
});

describe("3D slice hypervolume", () => {
  // Pure max-frame coordinates with the reference at the origin, so the
  // slice / inclusion-exclusion cross-check stays sign-error free.
  const ref = [0, 0, 0];

  it("matches inclusion-exclusion for a handful of points", () => {
    const points = [
      np("Q1", [1, 6, 5]),
      np("Q2", [2, 5, 6]),
      np("Q3", [3, 4, 4]),
      np("Q4", [2, 6, 6]),
    ];
    const sliced = hypervolume3D(points, ref);
    const brute = hypervolumeInclusionExclusion(points, ref);
    expect(sliced).toBeCloseTo(brute, 8);
  });

  it("matches inclusion-exclusion at exact slice boundaries (shared x0)", () => {
    const points = [
      np("Q2", [2, 5, 6]),
      np("Q4", [2, 6, 6]),
      np("Q1", [1, 6, 5]),
      np("Q0", [3, 3, 3]),
    ];
    expect(hypervolume3D(points, ref)).toBeCloseTo(hypervolumeInclusionExclusion(points, ref), 8);
  });

  it("computes a single box volume directly", () => {
    // ref [0,0,0], point (2,3,4) -> volume 24
    expect(hypervolume3D([np("S", [2, 3, 4])], ref)).toBeCloseTo(24, 10);
  });

  it("integrates 3D through the analysis pipeline with mixed directions", () => {
    const prepared = prepareBatch(objectives3D, [10, 0, 0], threeDPoints());
    const analysis = analyzeBatch(prepared);
    expect(Number.isFinite(analysis.hypervolume)).toBe(true);
    expect(analysis.hypervolume).toBeGreaterThan(0);
  });
});

describe("reference point validation", () => {
  it("rejects points on the wrong side without moving the reference point", () => {
    // cost is minimized: normalized cost = -raw. ref cost 1 -> normalized -1.
    // candidate cost 20 -> normalized -20 < -1, wrong side.
    const prepared = prepareBatch(objectives2DMinMax, [1, 0], [
      { candidateId: "X", values: [20, 0.5], feasible: true },
    ]);
    const { layers } = nonDominatedSort(prepared.feasible);
    expect(() => hypervolume(prepared.feasible, prepared.referencePoint)).toThrow(AppError);
    expect(layers[0]!.points).toEqual(["X"]);
  });

  it("rejects non-finite values and dimension mismatches explicitly", () => {
    expect(() => prepareBatch(objectives2DMinMax, [0, 0], [{ candidateId: "N", values: [1, Number.NaN], feasible: true }])).toThrowError(
      /not a finite number/,
    );
    expect(() => prepareBatch(objectives2DMinMax, [0, 0, 0], mutualNonDominated())).toThrowError(/dimensions/);
  });

  it("rejects objective counts outside 2..3", () => {
    expect(() => prepareBatch([], [0], [{ candidateId: "N", values: [0], feasible: true }])).toThrow(AppError);
  });
});



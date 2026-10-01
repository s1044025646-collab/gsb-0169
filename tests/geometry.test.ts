import { test } from "node:test";
import assert from "node:assert/strict";
import { dominates, nonDominatedSort } from "../src/core/dominance.js";
import {
  computeContributions,
  computeHypervolume,
  hypervolume3D,
  unionArea2D,
  validateAgainstReference,
} from "../src/core/hypervolume.js";
import { mergeDuplicateCoordinates, normalizeVector } from "../src/core/normalize.js";
import { AppError } from "../src/core/errors.js";
import type { NormalPoint, ProblemConfig } from "../src/core/types.js";
import { baseProblem, cleanup, createProblem, makeRepo, tempDbPath } from "./helpers.js";

function pt(code: string, coords: number[], feasible = true): NormalPoint {
  return { candidateIds: [coords[0]! * 1000 + coords[1]!], codes: [code], coords, feasible };
}

test("dominance: strict in at least one axis, weak in all others", () => {
  assert.equal(dominates([2, 2], [1, 1]), true);
  assert.equal(dominates([2, 1], [1, 1]), true);
  assert.equal(dominates([1, 1], [1, 1]), false);
  assert.equal(dominates([2, 0], [1, 1]), false);
});

test("2D union area: overlapping rectangles are not double counted", () => {
  // inclusion-exclusion: 3*4 + 4*3 - overlap 3*3 = 12 + 12 - 9 = 15
  const points = [
    [3, 4],
    [4, 3],
  ];
  assert.ok(Math.abs(unionArea2D(points, [0, 0]) - 15) < 1e-9);

  // sweep: x=3 strip [2,3]: only (3,1) active height 1 -> 1
  //        x=2 strip [1,2]: (3,1),(2,2) active maxY 2 -> 2
  //        x=1 strip [0,1]: all active maxY 3 -> 3 ; total 6
  const three = [
    [2, 2],
    [3, 1],
    [1, 3],
  ];
  assert.ok(Math.abs(unionArea2D(three, [0, 0]) - 6) < 1e-9);
});

test("2D: adding a dominated point does not change hypervolume", () => {
  const base = [
    [2, 4],
    [4, 2],
  ];
  const before = unionArea2D(base, [0, 0]);
  const after = unionArea2D([...base, [3, 1.5]], [0, 0]);
  assert.ok(Math.abs(after - before) < 1e-12);
});

test("2D: hypervolume is invariant to input ordering", () => {
  const points = [
    [1, 5],
    [5, 1],
    [3, 3],
  ];
  const a = unionArea2D(points, [0, 0]);
  const b = unionArea2D([...points].reverse(), [0, 0]);
  assert.ok(Math.abs(a - b) < 1e-12);
});

test("3D slice union: hand-verified overlapping boxes", () => {
  // Slab z in [0,1]: both boxes active, 2D union = 4+3-2 = 5
  // Slab z in [1,2]: only (2,2,2) active, area 4 ; total 9
  const hv = hypervolume3D(
    [
      [2, 2, 2],
      [3, 1, 1],
    ],
    [0, 0, 0],
  );
  assert.ok(Math.abs(hv - 9) < 1e-9);
});

test("3D slice boundaries: box tops at equal z share the slab", () => {
  const hv = hypervolume3D(
    [
      [1, 1, 4],
      [2, 2, 4],
    ],
    [0, 0, 0],
  );
  // one slab of thickness 4, xy union area 4 -> 16
  assert.ok(Math.abs(hv - 16) < 1e-9);
});

test("reference point in the wrong direction is rejected, never moved", () => {
  const points = [pt("s1", [1, 1])];
  assert.throws(
    () => validateAgainstReference(points, [5, 5]),
    (err: unknown) => err instanceof AppError && err.code === "BAD_REFERENCE_POINT",
  );
  // equality on an axis is not strict domination -> reject
  assert.throws(
    () => validateAgainstReference([pt("s1", [1, 1])], [1, 0]),
    (err: unknown) => err instanceof AppError && err.code === "BAD_REFERENCE_POINT",
  );
});

test("minimization objectives are flipped into the maximization frame", () => {
  const config: ProblemConfig = {
    ...(baseProblem({ referencePoint: [0, 10] }) as Omit<ProblemConfig, "objectives" | "createdAt" | "updatedAt">),
    objectives: [
      { index: 0, name: "gain", direction: "max", unit: "a", scale: 1 },
      { index: 1, name: "cost", direction: "min", unit: "b", scale: 1 },
    ],
    createdAt: "",
    updatedAt: "",
  };
  const n = normalizeVector([9, 3], config);
  assert.deepEqual(n, [9, -3]);
  const hv = computeHypervolume(
    [{ candidateIds: [1], codes: ["x"], coords: n, feasible: true }],
    config,
  );
  // box: 9 * (-3 - (-10)) = 63
  assert.ok(Math.abs(hv.hypervolume - 63) < 1e-9);
});

test("non-dominated sort: mutual non-domination, chain, shared axis", () => {
  const points = [
    pt("p1", [1, 3]),
    pt("p2", [2, 2]),
    pt("p3", [3, 1]),
    pt("p4", [1, 1]),
    pt("p5", [1, 2]),
  ];
  const { layers, evidence, infeasible } = nonDominatedSort([
    ...points,
    { candidateIds: [99], codes: ["bad"], coords: [9, 9], feasible: false },
  ]);
  assert.deepEqual(layers[0]!.points.map((p) => p.codes[0]).sort(), ["p1", "p2", "p3"]);
  assert.equal(layers.at(-1)!.points.map((p) => p.codes[0])[0], "p4");
  assert.deepEqual(infeasible.map((p) => p.codes[0]), ["bad"]);
  const evP4 = evidence.find((e) => e.code === "p4")!;
  assert.ok(evP4.dominatedBy.length >= 3);
  const evP5 = evidence.find((e) => e.code === "p5")!;
  assert.ok(evP5.dominatedBy.includes("p1"));
});

test("duplicate coordinates are merged for the union but keep both source codes", () => {
  const merged = mergeDuplicateCoordinates([pt("a", [2, 2]), pt("b", [2, 2])]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]!.codes, ["a", "b"]);
  const single = unionArea2D([[2, 2]], [0, 0]);
  const dup = unionArea2D(merged.map((m) => m.coords), [0, 0]);
  assert.equal(single, dup);
});

test("contributions are non-negative; covered points contribute zero", () => {
  const dbPath = tempDbPath();
  const { db, repo } = makeRepo(dbPath);
  const config = createProblem(repo, { referencePoint: [0, 0] });
  const batchId = repo.createBatch("p1", "b1", () => "t");
  repo.importCandidates(
    batchId,
    config,
    [
      { code: "a", values: [4, 1], feasible: true },
      { code: "b", values: [1, 4], feasible: true },
      { code: "c", values: [2, 1], feasible: true },
      { code: "d", values: [4, 1], feasible: true },
    ],
    () => "t",
  );
  const rows = repo.allCurrentCandidates(batchId).filter((r) => r.feasible);
  const points = mergeDuplicateCoordinates(
    rows.map((r) => ({ candidateIds: [r.id], codes: [r.code], coords: r.values, feasible: true })),
  );
  const { full, contributions } = computeContributions(points, config);
  assert.ok(full > 0);
  for (const c of contributions) assert.ok(c.contribution >= 0);
  const zero = contributions.find((c) => c.codes.includes("c"))!;
  assert.equal(zero.contribution, 0);
  const dup = contributions.find((c) => c.duplicate)!;
  assert.deepEqual(dup.codes, ["a", "d"]);
  db.close();
  cleanup([dbPath]);
});

test("unit rescaling: hypervolume scales by the product of positive axis ratios", () => {
  const points = [
    [3, 4],
    [4, 3],
  ];
  const base = unionArea2D(points, [0, 0]);
  const scaled = unionArea2D(
    points.map((p) => [p[0]! * 2, p[1]! * 5]),
    [0, 0],
  );
  assert.ok(Math.abs(scaled - base * 2 * 5) < 1e-9);
});

test("dimension mismatch and non-finite values raise explicit errors", () => {
  const dbPath = tempDbPath();
  const { db, repo } = makeRepo(dbPath);
  const config = createProblem(repo, { referencePoint: [0, 0] });
  const batchId = repo.createBatch("p1", "b", () => "t");
  assert.throws(
    () =>
      repo.importCandidates(
        batchId,
        config,
        [{ code: "x", values: [1, 2, 3], feasible: true }],
        () => "t",
      ),
    (e: unknown) => e instanceof AppError && e.code === "DIMENSION_MISMATCH",
  );
  assert.throws(
    () =>
      repo.importCandidates(
        batchId,
        config,
        [{ code: "y", values: [1, Number.NaN], feasible: true }],
        () => "t",
      ),
    (e: unknown) => e instanceof AppError && e.code === "NON_FINITE_VALUE",
  );
  db.close();
  cleanup([dbPath]);
});

test("3D contributions: removing an extending box loses exactly the exclusive volume", () => {
  const points: NormalPoint[] = [
    { candidateIds: [1], codes: ["big"], coords: [2, 2, 2], feasible: true },
    { candidateIds: [2], codes: ["arm"], coords: [3, 1, 1], feasible: true },
  ];
  const base = baseProblem({ dimension: 3, referencePoint: [0, 0, 0] });
  const config: ProblemConfig = {
    ...base,
    objectives: base.objectives.map((o, index) => ({ ...o, index })),
    createdAt: "",
    updatedAt: "",
  };
  const { full, contributions } = computeContributions(points, config);
  assert.ok(Math.abs(full - 9) < 1e-9);
  const arm = contributions.find((c) => c.codes[0] === "arm")!;
  assert.ok(Math.abs(arm.contribution - 1) < 1e-9);
  const big = contributions.find((c) => c.codes[0] === "big")!;
  assert.ok(Math.abs(big.contribution - (9 - 3)) < 1e-9);
});

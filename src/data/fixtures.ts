import type { CandidateInput, CreateProblemInput } from "./fixtureTypes.js";

/**
 * Fictional candidates used by the repeatable end-to-end demo.
 * Two objectives: maximize "score" and minimize "cost" (mixed directions).
 * Fixture classes covered across the fixture batches:
 *  - mutually non-dominated points
 *  - a chain of dominance
 *  - duplicate coordinates under distinct codes
 *  - a zero-contribution (dominated / covered) point
 *  - equal value on one axis
 *  - infeasible candidates kept out of the feasible front
 */

export const DEMO_PROBLEM: CreateProblemInput = {
  id: "demo-2d",
  dimension: 2,
  objectives: [
    { name: "score", direction: "max", unit: "pt", scale: 1 },
    { name: "cost", direction: "min", unit: "USD", scale: 1 },
  ],
  referencePoint: [0, 10],
};

export const BATCH_A: CandidateInput[] = [
  // mutually non-dominated (higher score costs more)
  { code: "A-01", values: [3, 3], feasible: true, source: "fixture" },
  { code: "A-02", values: [6, 6], feasible: true, source: "fixture" },
  { code: "A-03", values: [9, 8], feasible: true, source: "fixture" },
  // duplicate coordinates with a different code
  { code: "A-03-DUP", values: [9, 8], feasible: true, source: "fixture-duplicate" },
  // dominated on both objectives by A-02 -> zero contribution
  { code: "A-04", values: [5, 7], feasible: true, source: "fixture-dominated" },
  // equal single-axis value to A-01 (same score, different cost)
  { code: "A-05", values: [3, 1], feasible: true, source: "fixture-shared-axis" },
  // infeasible: never enters a feasible front
  { code: "A-X1", values: [12, 2], feasible: false, source: "fixture-infeasible" },
];

export const BATCH_B: CandidateInput[] = [
  // chain of dominance: B-01 < B-02 < B-03 in maximization frame
  { code: "B-01", values: [2, 9], feasible: true, source: "fixture-chain" },
  { code: "B-02", values: [4, 5], feasible: true, source: "fixture-chain" },
  { code: "B-03", values: [7, 3], feasible: true, source: "fixture-chain" },
  { code: "B-04", values: [10, 7], feasible: true, source: "fixture" },
  { code: "B-X1", values: [20, 1], feasible: false, source: "fixture-infeasible" },
];

export const DEMO_3D_PROBLEM: CreateProblemInput = {
  id: "demo-3d",
  dimension: 3,
  objectives: [
    { name: "throughput", direction: "max", unit: "qps", scale: 1 },
    { name: "latency", direction: "min", unit: "ms", scale: 1 },
    { name: "cost", direction: "min", unit: "USD", scale: 1 },
  ],
  referencePoint: [0, 100, 100],
};

export const BATCH_3D: CandidateInput[] = [
  { code: "C-01", values: [10, 50, 60], feasible: true },
  { code: "C-02", values: [20, 30, 80], feasible: true },
  { code: "C-03", values: [30, 60, 30], feasible: true },
  // dominated by C-03 in all maximization-frame objectives
  { code: "C-04", values: [20, 70, 40], feasible: true },
  { code: "C-X1", values: [99, 1, 1], feasible: false },
];

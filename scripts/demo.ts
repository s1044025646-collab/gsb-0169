/**
 * Repeatable end-to-end demonstration against an isolated project-local
 * database (tmp/demo.db). Exercises import, evidence, layers, contributions,
 * comparison, unit scaling and report export with zero randomness.
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { Repository } from "../src/db/repository.js";
import { scaledHypervolume } from "../src/core/hypervolume.js";

const dbPath = resolve("tmp/demo.db");
for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });

const db = openDatabase(dbPath);
const repo = new Repository(db, { now: () => "2026-09-30T12:00:00.000Z" });

const objectives = [
  { name: "unit_cost", direction: "min" as const, unit: "USD" },
  { name: "efficiency", direction: "max" as const, unit: "percent" },
];
const referencePoint = [120, 0];

const alpha = repo.importBatch({
  batchId: "design-alpha",
  idempotencyKey: "demo-alpha",
  objectives,
  referencePoint,
  candidates: [
    { candidateId: "A-01", values: [40, 70], feasible: true },
    { candidateId: "A-02", values: [60, 85], feasible: true },
    { candidateId: "A-03", values: [90, 95], feasible: true },
    { candidateId: "A-04", values: [70, 72], feasible: true },
    { candidateId: "A-05", values: [30, 120], feasible: false },
  ],
});

const beta = repo.importBatch({
  batchId: "design-beta",
  idempotencyKey: "demo-beta",
  objectives,
  referencePoint,
  candidates: [
    { candidateId: "B-01", values: [35, 75], feasible: true },
    { candidateId: "B-02", values: [55, 90], feasible: true },
    { candidateId: "B-03", values: [95, 99], feasible: true },
    { candidateId: "B-04", values: [20, 40], feasible: false },
  ],
});

console.log("alpha front ranks:", JSON.stringify(alpha.analysis.layers));
console.log("alpha infeasible:", JSON.stringify(alpha.analysis.infeasible));
console.log("alpha hypervolume (USD*percent):", alpha.analysis.hypervolume);

// Same physical units, costs expressed in cents instead of dollars (x100).
const centsScale = { factors: [100, 1], units: ["cents", "percent"] };
console.log("alpha hypervolume in cents*percent:", scaledHypervolume(alpha.analysis.hypervolume, centsScale));

const comparison = repo.compareBatches(alpha.batchId, beta.batchId);
const report = repo.createReport(comparison.id, "demo-default", {
  hvA: comparison.hvA,
  hvB: comparison.hvB,
  delta: comparison.delta,
  winner: comparison.winner,
  frozenReferencePoint: comparison.frozenReferencePoint,
  note: "hypervolume units = USD * percent; never reported as dimensionless",
});
console.log("comparison delta (B - A):", comparison.delta, "winner:", comparison.winner);
console.log("report id:", report.reportId);

// Idempotency: re-importing alpha with the same key creates nothing new.
const replay = repo.importBatch({
  batchId: "design-alpha",
  idempotencyKey: "demo-alpha",
  objectives,
  referencePoint,
  candidates: [
    { candidateId: "A-01", values: [40, 70], feasible: true },
    { candidateId: "A-02", values: [60, 85], feasible: true },
    { candidateId: "A-03", values: [90, 95], feasible: true },
    { candidateId: "A-04", values: [70, 72], feasible: true },
    { candidateId: "A-05", values: [30, 120], feasible: false },
  ],
});
console.log("replay created:", replay.created, "revision:", replay.revision);

db.close();
console.log("demo db at", dbPath);

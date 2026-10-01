import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { openDatabase } from "../src/db/database.js";
import { Repository } from "../src/db/repository.js";
import { AppError } from "../src/core/errors.js";
import { objectives2DMinMax, mutualNonDominated, chainDomination, withInfeasible } from "./fixtures.js";

const dbFiles: string[] = [];
const openHandles: Array<{ close(): void }> = [];

function tempRepo(label: string) {
  const path = `tmp/test-${label}-${Math.random().toString(36).slice(2)}.db`;
  dbFiles.push(path);
  const db = openDatabase(path);
  openHandles.push(db);
  const clock = (() => {
    let ticks = 0;
    return { now: () => `2026-01-01T00:00:${String(ticks++).padStart(2, "0")}.000Z` };
  })();
  return { repository: new Repository(db, clock), db, path };
}

afterEach(() => {
  for (const handle of openHandles.splice(0)) {
    try {
      handle.close();
    } catch {
      // already closed
    }
  }
  for (const path of dbFiles.splice(0)) {
    try {
      rmSync(path, { force: true });
      rmSync(path + "-wal", { force: true });
      rmSync(path + "-shm", { force: true });
    } catch {
      // ignore cleanup races
    }
  }
});

describe("repository import & revision", () => {
  it("imports a batch and records feasibility and layers", () => {
    const { repository } = tempRepo("import");
    const result = repository.importBatch({
      batchId: "b1",
      objectives: objectives2DMinMax,
      referencePoint: [10, 0],
      candidates: withInfeasible(mutualNonDominated()),
    });
    expect(result.created).toBe(true);
    expect(result.analysis.infeasible).toEqual(["BAD1", "BAD2"]);
    expect(result.analysis.layers[0]!.points).toEqual(["P1", "P2", "P3"]);
  });

  it("is idempotent on repeated submission with the same key", () => {
    const { repository, db } = tempRepo("idempotent");
    const first = repository.importBatch({
      idempotencyKey: "key-1",
      objectives: objectives2DMinMax,
      referencePoint: [10, 0],
      candidates: mutualNonDominated(),
    });
    const second = repository.importBatch({
      idempotencyKey: "key-1",
      objectives: objectives2DMinMax,
      referencePoint: [10, 0],
      candidates: mutualNonDominated(),
    });
    expect(second.created).toBe(false);
    expect(second.batchId).toBe(first.batchId);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM batches").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("rejects the same idempotency key reused with different payload", () => {
    const { repository } = tempRepo("idempotent-mismatch");
    repository.importBatch({
      idempotencyKey: "k",
      objectives: objectives2DMinMax,
      referencePoint: [10, 0],
      candidates: mutualNonDominated(),
    });
    expect(() =>
      repository.importBatch({
        idempotencyKey: "k",
        objectives: objectives2DMinMax,
        referencePoint: [10, 0],
        candidates: chainDomination(),
      }),
    ).toThrow(AppError);
  });
});

describe("transaction rollback", () => {
  it("leaves no partial batch when a candidate fails validation", () => {
    const { repository, db } = tempRepo("rollback");
    expect(() =>
      repository.importBatch({
        batchId: "broken",
        objectives: objectives2DMinMax,
        referencePoint: [10, 0],
        candidates: [
          { candidateId: "ok", values: [1, 1], feasible: true },
          { candidateId: "bad", values: [1, Number.POSITIVE_INFINITY], feasible: true },
        ],
      }),
    ).toThrow(/finite/);
    const batches = (db.prepare("SELECT COUNT(*) AS c FROM batches").get() as { c: number }).c;
    const candidates = (db.prepare("SELECT COUNT(*) AS c FROM candidates").get() as { c: number }).c;
    expect(batches).toBe(0);
    expect(candidates).toBe(0);
  });
});

describe("persistence across restart and frozen-frame comparison", () => {
  it("survives closing and reopening the database", () => {
    const { repository, db, path } = tempRepo("restart");
    repository.importBatch({
      batchId: "persist",
      objectives: objectives2DMinMax,
      referencePoint: [10, 0],
      candidates: mutualNonDominated(),
    });
    db.close();

    const reopened = openDatabase(path);
    const repo2 = new Repository(reopened);
    const batch = repo2.getBatch("persist");
    expect(batch.objectives).toHaveLength(2);
    const analysis = repo2.analyze("persist");
    expect(analysis.layers[0]!.points).toEqual(["P1", "P2", "P3"]);
    reopened.close();
  });

  it("compares two batches and rejects differing frozen reference points", () => {
    const { repository } = tempRepo("compare");
    const a = repository.importBatch({
      batchId: "a",
      objectives: objectives2DMinMax,
      referencePoint: [10, 0],
      candidates: mutualNonDominated(),
    });
    const b = repository.importBatch({
      batchId: "b",
      objectives: objectives2DMinMax,
      referencePoint: [10, 0],
      candidates: chainDomination(),
    });
    const comparison = repository.compareBatches(a.batchId, b.batchId);
    expect(Number.isFinite(comparison.delta)).toBe(true);

    repository.importBatch({
      batchId: "c",
      objectives: objectives2DMinMax,
      referencePoint: [9, 0],
      candidates: mutualNonDominated(),
    });
    expect(() => repository.compareBatches("a", "c")).toThrow(/reference point/i);
  });

  it("generates a new report record per parameter set and reuses identical ones", () => {
    const { repository } = tempRepo("report");
    const a = repository.importBatch({ batchId: "ra", objectives: objectives2DMinMax, referencePoint: [10, 0], candidates: mutualNonDominated() });
    const b = repository.importBatch({ batchId: "rb", objectives: objectives2DMinMax, referencePoint: [10, 0], candidates: chainDomination() });
    const comparison = repository.compareBatches(a.batchId, b.batchId);
    const first = repository.createReport(comparison.id, "scale:1", { delta: comparison.delta });
    const second = repository.createReport(comparison.id, "scale:1", { delta: comparison.delta });
    const other = repository.createReport(comparison.id, "scale:2", { delta: comparison.delta + 1 });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(other.created).toBe(true);
  });
});



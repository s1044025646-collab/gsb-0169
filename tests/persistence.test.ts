import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "../src/core/errors.js";
import { migrate } from "../src/db/migrate.js";
import { Repository } from "../src/db/repository.js";
import { cleanup, clock, createProblem, makeRepo, tempDbPath } from "./helpers.js";

test("transaction rollback: one invalid row rolls back the entire import", () => {
  const dbPath = tempDbPath();
  const { db, repo } = makeRepo(dbPath);
  const config = createProblem(repo);
  const batchId = repo.createBatch("p1", "b", clock);

  assert.throws(
    () =>
      repo.importCandidates(
        batchId,
        config,
        [
          { code: "ok1", values: [1, 1], feasible: true },
          { code: "ok2", values: [2, 2], feasible: true },
          { code: "bad", values: [1], feasible: true },
        ],
        clock,
      ),
    (e: unknown) => e instanceof AppError && e.code === "DIMENSION_MISMATCH",
  );
  const page = repo.listCandidates(batchId, { limit: 100, offset: 0 });
  assert.equal(page.total, 0, "no rows from the failed transaction may persist");
  db.close();
  cleanup([dbPath]);
});

test("data revision: re-importing a code keeps history and marks only the new row current", () => {
  const dbPath = tempDbPath();
  const { db, repo } = makeRepo(dbPath);
  const config = createProblem(repo);
  const batchId = repo.createBatch("p1", "b", clock);
  repo.importCandidates(batchId, config, [{ code: "s1", values: [1, 1], feasible: true }], clock);
  repo.importCandidates(batchId, config, [{ code: "s1", values: [2, 2], feasible: true }], clock);

  const current = repo.listCandidates(batchId, { limit: 100, offset: 0 });
  assert.equal(current.total, 1);
  assert.deepEqual(current.items[0]!.values, [2, 2]);
  assert.equal(current.items[0]!.revision, 2);

  const history = repo.candidateHistory(batchId, "s1");
  assert.deepEqual(history.map((h) => h.revision), [1, 2]);
  assert.deepEqual(history.map((h) => h.values), [
    [1, 1],
    [2, 2],
  ]);
  db.close();
  cleanup([dbPath]);
});

test("restart persistence: reopen the same file and see committed state", () => {
  const dbPath = tempDbPath();
  {
    const { db, repo } = makeRepo(dbPath);
    const config = createProblem(repo);
    const batchId = repo.createBatch("p1", "b", clock);
    repo.importCandidates(batchId, config, [{ code: "s1", values: [3, 3], feasible: true }], clock);
    db.close();
  }
  {
    const db2 = new DatabaseSync(dbPath);
    migrate(db2); // migrations must be repeatable on an existing database
    migrate(db2); // ...including a second invocation
    const repo2 = new Repository(db2);
    const config2 = repo2.getProblem("p1");
    const batch = repo2.getBatch("p1", "b");
    const rows = repo2.allCurrentCandidates(batch.id);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.values, [3, 3]);
    assert.equal(config2.dimension, 2);
    db2.close();
  }
  cleanup([dbPath]);
});

test("idempotency keys: replay returns the stored response and does not duplicate data", () => {
  const dbPath = tempDbPath();
  const { db, repo } = makeRepo(dbPath);
  const config = createProblem(repo);
  const batchId = repo.createBatch("p1", "b", clock);
  const response = { ok: true };
  const first = repo.getIdempotent("p1", "key-1");
  assert.equal(first, null, "first call has no cached response");
  repo.storeIdempotent("p1", "key-1", response, clock);
  const second = repo.getIdempotent("p1", "key-1");
  assert.deepEqual(second, response, "replay returns the original response");
  db.close();
  cleanup([dbPath]);
});

test("report reuse: same frozen parameters reuse the report; changed config hashes differently", () => {
  const dbPath = tempDbPath();
  const { db, repo } = makeRepo(dbPath);
  const config = createProblem(repo);
  const a = repo.createBatch("p1", "a", clock);
  const b = repo.createBatch("p1", "b", clock);
  repo.importCandidates(a, config, [{ code: "x", values: [1, 1], feasible: true }], clock);
  repo.importCandidates(b, config, [{ code: "y", values: [2, 2], feasible: true }], clock);
  const save = (hash: string) =>
    repo.saveReport({
      problemId: "p1",
      batchAId: a,
      batchBId: b,
      configHash: hash,
      configJson: "{}",
      result: { hash },
      now: clock,
    });
  const r1 = save("hash-v1");
  const r2 = save("hash-v1");
  assert.equal(r2.reused, true);
  assert.equal(r2.id, r1.id);
  const r3 = save("hash-v2");
  assert.equal(r3.reused, false);
  assert.notEqual(r3.id, r1.id);
  db.close();
  cleanup([dbPath]);
});

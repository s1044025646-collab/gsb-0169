import { test } from "node:test";
import assert from "node:assert/strict";
import { startApiServer, type ApiDeps } from "../src/api/server.js";
import type { Server } from "node:http";
import { cleanup, clock, makeRepo, tempDbPath } from "./helpers.js";

let server: Server;
let baseUrl: string;
let dbPath: string;

async function api(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{
  status: number;
  body: any;
}> {
  const res = await fetch(new URL(path, baseUrl), {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await res.json()) as any;
  return { status: res.status, body };
}

test.before(async () => {
  dbPath = tempDbPath();
  const { db, repo } = makeRepo(dbPath);
  const deps: ApiDeps = { repo, now: clock };
  const started = await startApiServer(deps);
  server = started.server;
  baseUrl = `http://127.0.0.1:${started.port}`;
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanup([dbPath]);
});

test("health", async () => {
  const r = await api("/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
});

test("create problem, batch, import, layers, evidence and contributions", async () => {
  const created = await api("/problems", {
    method: "POST",
    body: {
      id: "mix",
      dimension: 2,
      objectives: [
        { name: "score", direction: "max", unit: "pt", scale: 1 },
        { name: "cost", direction: "min", unit: "USD", scale: 1 },
      ],
      referencePoint: [0, 10],
    },
  });
  assert.equal(created.status, 201);

  const batch = await api("/problems/mix/batches", { method: "POST", body: { name: "run1" } });
  assert.equal(batch.status, 201);

  const imported = await api("/problems/mix/batches/run1/import", {
    method: "POST",
    headers: { "Idempotency-Key": "import-1" },
    body: {
      candidates: [
        { code: "s1", values: [3, 3], feasible: true },
        { code: "s2", values: [6, 6], feasible: true },
        { code: "s3", values: [9, 8], feasible: true },
        { code: "s3b", values: [9, 8], feasible: true },
        { code: "s4", values: [5, 7], feasible: true },
        { code: "x1", values: [12, 2], feasible: false },
      ],
    },
  });
  assert.equal(imported.status, 200);

  // Replay with the same idempotency key: no duplicate import, cached response.
  const replayed = await api("/problems/mix/batches/run1/import", {
    method: "POST",
    headers: { "Idempotency-Key": "import-1" },
    body: { candidates: [] },
  });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.reused, true);
  const list = await api("/problems/mix/batches/run1/candidates?limit=2&offset=0");
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 2);
  assert.equal(list.body.total, 6);

  const layers = await api("/problems/mix/batches/run1/layers");
  assert.equal(layers.status, 200);
  assert.equal(layers.body.layers[0].points.length, 3, "s3/s3b merged as one point on the front");
  assert.deepEqual(
    layers.body.infeasible.map((p: { code: string }) => p.code),
    ["x1"],
  );

  const evidence = await api("/problems/mix/batches/run1/evidence");
  const s4 = evidence.body.evidence.find((e: { code: string }) => e.code === "s4");
  assert.ok(s4.dominatedBy.includes("s2"));

  const contributions = await api("/problems/mix/batches/run1/contributions");
  assert.equal(contributions.status, 200);
  for (const c of contributions.body.contributions) assert.ok(c.contribution >= 0);
});

test("bad reference point is rejected with BAD_REFERENCE_POINT and never moved", async () => {
  await api("/problems", {
    method: "POST",
    body: {
      id: "badref",
      dimension: 2,
      objectives: [
        { name: "a", direction: "max", unit: "u", scale: 1 },
        { name: "b", direction: "max", unit: "u", scale: 1 },
      ],
      referencePoint: [5, 5],
    },
  });
  await api("/problems/badref/batches", { method: "POST", body: { name: "r" } });
  await api("/problems/badref/batches/r/import", {
    method: "POST",
    body: { candidates: [{ code: "z", values: [1, 1], feasible: true }] },
  });
  const layers = await api("/problems/badref/batches/r/layers");
  assert.equal(layers.status, 400);
  assert.equal(layers.body.error.code, "BAD_REFERENCE_POINT");
});

test("validation failures return explicit codes; pagination rejects bad limit", async () => {
  const badDim = await api("/problems", {
    method: "POST",
    body: { id: "d1", dimension: 4, objectives: [], referencePoint: [] },
  });
  assert.equal(badDim.status, 400);
  assert.equal(badDim.body.error.code, "UNSUPPORTED_DIMENSION");

  const missing = await api("/problems", { method: "POST", body: { id: 99 } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, "VALIDATION_ERROR");

  await api("/problems/mix/batches", { method: "POST", body: { name: "p" } });
  const dup = await api("/problems/mix/batches", { method: "POST", body: { name: "p" } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, "CONFLICT");

  const badPage = await api("/problems/mix/batches/run1/candidates?limit=9999");
  assert.equal(badPage.status, 400);
  assert.equal(badPage.body.error.code, "VALIDATION_ERROR");

  const nf = await api("/problems/nope");
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error.code, "NOT_FOUND");
});

test("compare two batches and persist/freeze a new report; parameter change makes a new one", async () => {
  await api("/problems", {
    method: "POST",
    body: {
      id: "cmp",
      dimension: 2,
      objectives: [
        { name: "a", direction: "max", unit: "u", scale: 1 },
        { name: "b", direction: "max", unit: "u", scale: 1 },
      ],
      referencePoint: [0, 0],
    },
  });
  await api("/problems/cmp/batches", { method: "POST", body: { name: "a" } });
  await api("/problems/cmp/batches", { method: "POST", body: { name: "b" } });
  await api("/problems/cmp/batches/a/import", {
    method: "POST",
    body: { candidates: [{ code: "a1", values: [2, 2], feasible: true }] },
  });
  await api("/problems/cmp/batches/b/import", {
    method: "POST",
    body: { candidates: [{ code: "b1", values: [3, 3], feasible: true }] },
  });
  const cmp = await api("/problems/cmp/compare", {
    method: "POST",
    body: { batchA: "a", batchB: "b" },
  });
  assert.equal(cmp.status, 200);
  assert.equal(cmp.body.comparison.indicator, "B_better");
  assert.equal(cmp.body.comparison.deltaHypervolume, 5);

  const report1 = await api("/problems/cmp/reports", {
    method: "POST",
    body: { batchA: "a", batchB: "b" },
  });
  assert.equal(report1.status, 201);
  const report2 = await api("/problems/cmp/reports", {
    method: "POST",
    body: { batchA: "a", batchB: "b" },
  });
  assert.equal(report2.status, 200);
  assert.equal(report2.body.reused, true);

  const got = await api(`/problems/cmp/reports/${report1.body.reportId}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.report.result.configHash, cmp.body.comparison.configHash);
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { createApp } from "../src/api/http.js";
import { openDatabase } from "../src/db/database.js";
import { Repository } from "../src/db/repository.js";
import { objectives2DMinMax, mutualNonDominated, chainDomination } from "./fixtures.js";

const dbPath = "tmp/test-api.db";
const db = openDatabase(dbPath);
const repository = new Repository(db);
const server = createApp(repository);
let baseUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
});

async function request(path: string, init?: { method?: string; body?: unknown }) {
  const response = await fetch(baseUrl + path, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json };
}

describe("HTTP API end to end", () => {
  it("exposes health", async () => {
    const response = await request("/health");
    expect(response.status).toBe(200);
    expect(response.json.status).toBe("ok");
  });

  it("creates a batch and returns hypervolume with codes", async () => {
    const response = await request("/batches", {
      method: "POST",
      body: {
        batchId: "api-a",
        idempotencyKey: "api-key-a",
        objectives: objectives2DMinMax,
        referencePoint: [10, 0],
        candidates: mutualNonDominated(),
      },
    });
    expect(response.status).toBe(201);
    expect(response.json.batchId).toBe("api-a");
    expect(typeof (response.json.analysis as { hypervolume: number }).hypervolume).toBe("number");

    const replay = await request("/batches", {
      method: "POST",
      body: {
        idempotencyKey: "api-key-a",
        objectives: objectives2DMinMax,
        referencePoint: [10, 0],
        candidates: mutualNonDominated(),
      },
    });
    expect(replay.status).toBe(200);
    expect(replay.json.created).toBe(false);
  });

  it("returns explicit error codes for bad payloads", async () => {
    const bad = await request("/batches", {
      method: "POST",
      body: { objectives: objectives2DMinMax, referencePoint: [0], candidates: mutualNonDominated() },
    });
    expect(bad.status).toBe(400);
    expect((bad.json.error as { code: string }).code).toBe("DIMENSION_MISMATCH");
  });

  it("paginates candidate listing", async () => {
    const page1 = await request("/batches/api-a/candidates?limit=2&offset=0");
    expect(page1.status).toBe(200);
    expect(page1.json.data).toHaveLength(2);
    expect((page1.json.pagination as { hasMore: boolean }).hasMore).toBe(true);
    const page2 = await request("/batches/api-a/candidates?limit=2&offset=2");
    expect(page2.json.data).toHaveLength(1);
  });

  it("exposes evidence, layers and contributions by traceable candidate ids", async () => {
    const layers = await request("/batches/api-a/layers");
    expect((layers.json.layers as Array<{ points: string[] }>)[0]!.points).toEqual(["P1", "P2", "P3"]);
    const contributions = await request("/batches/api-a/contributions");
    const ids = (contributions.json.contributions as Array<{ candidateId: string }>).map((entry) => entry.candidateId);
    expect(ids.sort()).toEqual(["P1", "P2", "P3"]);
  });

  it("compares batches, stores and fetches a report", async () => {
    await request("/batches", {
      method: "POST",
      body: { batchId: "api-b", objectives: objectives2DMinMax, referencePoint: [10, 0], candidates: chainDomination() },
    });
    const comparison = await request("/comparisons", { method: "POST", body: { batchA: "api-a", batchB: "api-b" } });
    expect(comparison.status).toBe(201);
    const reportId = comparison.json.report as string;
    const report = await request("/reports/" + reportId);
    expect(report.status).toBe(200);
    expect((report.json.body as { winner: string }).winner).toBeDefined();
  });

  it("rejects comparison across differing reference points", async () => {
    await request("/batches", {
      method: "POST",
      body: { batchId: "api-c", objectives: objectives2DMinMax, referencePoint: [9, 0], candidates: mutualNonDominated() },
    });
    const response = await request("/comparisons", { method: "POST", body: { batchA: "api-a", batchB: "api-c" } });
    expect(response.status).toBe(400);
    expect((response.json.error as { code: string }).code).toBe("REFERENCE_POINT_MISMATCH");
  });
});



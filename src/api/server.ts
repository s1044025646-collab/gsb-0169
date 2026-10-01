import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { AppError, httpStatusFor, type ErrorCode } from "../core/errors.js";
import type { Repository } from "../db/repository.js";
import { analyzeBatch, compareBatches, configHash } from "../core/compare.js";
import { computeContributions } from "../core/hypervolume.js";
import { toNormalPoints, mergeDuplicateCoordinates } from "../core/normalize.js";
import { referenceInCanonicalFrame } from "../core/normalize.js";

export interface ApiDeps {
  repo: Repository;
  now: () => string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

function sendError(res: ServerResponse, code: ErrorCode, message: string, details?: unknown): void {
  send(res, httpStatusFor(code), { error: { code, message, details: details ?? null } });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError("BAD_REQUEST", "request body is not valid JSON");
  }
}

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new AppError("VALIDATION_ERROR", `${what} must be a JSON object`);
  }
  return v as Record<string, unknown>;
}

function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new AppError("VALIDATION_ERROR", `'${key}' is required and must be a non-empty string`);
  }
  return v;
}

function parsePagination(url: URL): { limit: number; offset: number } {
  const limitRaw = url.searchParams.get("limit") ?? "50";
  const offsetRaw = url.searchParams.get("offset") ?? "0";
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new AppError("VALIDATION_ERROR", "limit must be an integer between 1 and 500");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new AppError("VALIDATION_ERROR", "offset must be a non-negative integer");
  }
  return { limit, offset };
}

/**
 * Routes (all under a problem id for clarity):
 *  GET    /health
 *  POST   /problems
 *  GET    /problems
 *  GET    /problems/:id
 *  POST   /problems/:id/batches
 *  GET    /problems/:id/batches
 *  POST   /problems/:id/batches/:batch/import     (Idempotency-Key supported)
 *  GET    /problems/:id/batches/:batch/candidates
 *  GET    /problems/:id/batches/:batch/evidence
 *  GET    /problems/:id/batches/:batch/layers
 *  GET    /problems/:id/batches/:batch/contributions
 *  POST   /problems/:id/compare
 *  POST   /problems/:id/reports
 *  GET    /problems/:id/reports
 *  GET    /problems/:id/reports/:rid
 */
export function createApiServer(deps: ApiDeps): Server {
  const { repo, now } = deps;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { status: "ok", time: now() });
      }

      if (parts[0] === "problems") {
        // POST /problems
        if (parts.length === 1 && method === "POST") {
          const body = asObject(await readJson(req), "body");
          const id = requireString(body, "id");
          const config = repo.createProblem(
            {
              id,
              dimension: body.dimension as number,
              objectives: body.objectives as never,
              referencePoint: body.referencePoint as number[],
            },
            now,
          );
          return send(res, 201, { problem: config });
        }
        if (parts.length === 1 && method === "GET") {
          return send(res, 200, { problems: repo.listProblems() });
        }

        const problemId = parts[1]!;
        const config = repo.getProblem(problemId);

        if (parts.length === 2 && method === "GET") {
          return send(res, 200, { problem: config, configHash: configHash(config) });
        }

        if (parts[2] === "batches") {
          if (parts.length === 3 && method === "POST") {
            const body = asObject(await readJson(req), "body");
            const name = requireString(body, "name");
            const id = repo.createBatch(problemId, name, now);
            return send(res, 201, { batch: { id, name } });
          }
          if (parts.length === 3 && method === "GET") {
            return send(res, 200, { batches: repo.listBatches(problemId) });
          }

          const batchRef = parts[3]!;
          const batch = repo.getBatch(problemId, batchRef);
          const sub = parts[4];

          if (sub === "import" && method === "POST") {
            const idemKey = req.headers["idempotency-key"];
            const key = typeof idemKey === "string" ? idemKey : undefined;
            if (key) {
              const cached = repo.getIdempotent(problemId, key);
              if (cached !== null) {
                return send(res, 200, { ...(cached as Record<string, unknown>), idempotent: true, reused: true });
              }
            }
            const body = asObject(await readJson(req), "body");
            const candidates = body.candidates;
            if (!Array.isArray(candidates)) {
              throw new AppError("VALIDATION_ERROR", "'candidates' must be an array");
            }
            const response = {
              batch: { id: batch.id, name: batch.name },
              result: repo.importCandidates(batch.id, config, candidates as never, now),
            };
            if (key) {
              repo.storeIdempotent(problemId, key, response, now);
              return send(res, 200, { ...response, idempotent: true, reused: false });
            }
            return send(res, 200, { ...response, idempotent: false });
          }

          if (sub === "candidates" && method === "GET") {
            const { limit, offset } = parsePagination(url);
            const feasibleParam = url.searchParams.get("feasible");
            let feasible: boolean | undefined;
            if (feasibleParam !== null) {
              if (feasibleParam !== "true" && feasibleParam !== "false") {
                throw new AppError("VALIDATION_ERROR", "feasible must be 'true' or 'false'");
              }
              feasible = feasibleParam === "true";
            }
            const page = repo.listCandidates(batch.id, { limit, offset, feasible });
            return send(res, 200, { ...page, batch: { id: batch.id, name: batch.name } });
          }

          const allCandidates = repo.allCurrentCandidates(batch.id);
          if (sub === "evidence" && method === "GET") {
            const analysis = analyzeBatch(allCandidates, config, batch.id);
            return send(res, 200, { batch: batch, evidence: analysis.evidence, infeasible: analysis.infeasible });
          }
          if (sub === "layers" && method === "GET") {
            const analysis = analyzeBatch(allCandidates, config, batch.id);
            return send(res, 200, {
              batch: batch,
              layers: analysis.layers,
              infeasible: analysis.infeasible,
              hypervolume: analysis.hypervolume,
            });
          }
          if (sub === "contributions" && method === "GET") {
            const points = mergeDuplicateCoordinates(
              toNormalPoints(
                allCandidates.filter((c) => c.feasible).map((c) => ({ id: c.id, code: c.code, values: c.values, feasible: true })),
                config,
              ),
            );
            const { full, contributions } = computeContributions(points, config);
            return send(res, 200, {
              batch: batch,
              fullHypervolume: full,
              unitLabel: config.objectives.map((o) => o.unit).join("*"),
              referenceCanonical: referenceInCanonicalFrame(config),
              contributions,
            });
          }
        }

        if (parts[2] === "compare" && method === "POST") {
          const body = asObject(await readJson(req), "body");
          const aName = requireString(body, "batchA");
          const bName = requireString(body, "batchB");
          const a = repo.getBatch(problemId, aName);
          const b = repo.getBatch(problemId, bName);
          const report = compareBatches(
            config,
            { batchId: a.id, name: a.name, candidates: repo.allCurrentCandidates(a.id) },
            { batchId: b.id, name: b.name, candidates: repo.allCurrentCandidates(b.id) },
          );
          return send(res, 200, { comparison: report });
        }

        if (parts[2] === "reports") {
          if (parts.length === 3 && method === "POST") {
            const body = asObject(await readJson(req), "body");
            const aName = requireString(body, "batchA");
            const bName = requireString(body, "batchB");
            const a = repo.getBatch(problemId, aName);
            const b = repo.getBatch(problemId, bName);
            const comparison = compareBatches(
              config,
              { batchId: a.id, name: a.name, candidates: repo.allCurrentCandidates(a.id) },
              { batchId: b.id, name: b.name, candidates: repo.allCurrentCandidates(b.id) },
            );
            const saved = repo.saveReport({
              problemId,
              batchAId: a.id,
              batchBId: b.id,
              configHash: comparison.configHash,
              configJson: JSON.stringify({
                referencePoint: config.referencePoint,
                objectives: config.objectives,
                dimension: config.dimension,
              }),
              result: comparison,
              now,
            });
            return send(res, saved.reused ? 200 : 201, { reportId: saved.id, reused: saved.reused, comparison });
          }
          if (parts.length === 3 && method === "GET") {
            const { limit, offset } = parsePagination(url);
            return send(res, 200, { reports: repo.listReports(problemId, limit, offset) });
          }
          if (parts.length === 4 && method === "GET") {
            const rid = Number(parts[3]);
            if (!Number.isInteger(rid)) throw new AppError("VALIDATION_ERROR", "report id must be an integer");
            return send(res, 200, { report: repo.getReport(problemId, rid) });
          }
        }
      }

      sendError(res, "NOT_FOUND", `no route for ${method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof AppError) {
        return sendError(res, err.code, err.message, err.details);
      }
      const message = err instanceof Error ? err.message : "unknown error";
      sendError(res, "BAD_REQUEST", message);
    }
  });

  return server;
}

export function startApiServer(deps: ApiDeps): Promise<{ server: Server; port: number }> {
  const server = createApiServer(deps);
  return new Promise((resolve) => {
    // Bind only to loopback; port 0 lets the OS assign a free local port.
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

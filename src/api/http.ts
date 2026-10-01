import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { AppError } from "../core/errors.js";
import { Repository } from "../db/repository.js";

export interface Pagination {
  limit: number;
  offset: number;
}

export function parsePagination(url: URL): Pagination {
  const limitRaw = Number(url.searchParams.get("limit") ?? "50");
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 200) {
    throw new AppError("INVALID_PAGINATION", "limit must be an integer between 1 and 200");
  }
  if (!Number.isInteger(offsetRaw) || offsetRaw < 0) {
    throw new AppError("INVALID_PAGINATION", "offset must be a non-negative integer");
  }
  return { limit: limitRaw, offset: offsetRaw };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  if (body === "") return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new AppError("VALIDATION_ERROR", "request body must be valid JSON");
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function pageEnvelope<T>(pathname: string, pagination: Pagination, result: { items: T[]; total: number }) {
  const nextOffset = pagination.offset + pagination.limit;
  return {
    data: result.items,
    pagination: {
      limit: pagination.limit,
      offset: pagination.offset,
      total: result.total,
      hasMore: nextOffset < result.total,
      next: nextOffset < result.total ? pathname + "?limit=" + pagination.limit + "&offset=" + nextOffset : null,
    },
  };
}

export function createApp(repository: Repository): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathParts = url.pathname.split("/").filter(Boolean);

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { status: "ok" });
      }

      if (req.method === "POST" && pathParts.length === 1 && pathParts[0] === "batches") {
        const body = (await readJson(req)) as Record<string, unknown>;
        const result = repository.importBatch({
          batchId: body.batchId as string | undefined,
          idempotencyKey: body.idempotencyKey as string | undefined,
          objectives: body.objectives,
          referencePoint: body.referencePoint,
          candidates: body.candidates,
          scale: body.scale as { factors: number[]; units: string[] } | undefined,
        });
        return send(res, result.created ? 201 : 200, result);
      }

      if (req.method === "GET" && pathParts.length === 1 && pathParts[0] === "batches") {
        const pagination = parsePagination(url);
        return send(res, 200, pageEnvelope("/batches", pagination, repository.listBatches(pagination.limit, pagination.offset)));
      }

      const batchId = pathParts[0] === "batches" ? (pathParts[1] ?? "") : "";

      if (req.method === "GET" && pathParts.length === 2 && batchId) {
        const batch = repository.getBatch(batchId);
        const analysis = repository.analyze(batchId);
        return send(res, 200, { batch, analysis });
      }

      if (req.method === "GET" && pathParts.length === 3 && pathParts[2] === "candidates") {
        const pagination = parsePagination(url);
        return send(
          res,
          200,
          pageEnvelope("/batches/" + batchId + "/candidates", pagination, repository.listCandidates(batchId, pagination.limit, pagination.offset)),
        );
      }

      if (req.method === "GET" && pathParts.length === 3 && pathParts[2] === "evidence") {
        return send(res, 200, { evidence: repository.analyze(batchId).evidence });
      }

      if (req.method === "GET" && pathParts.length === 3 && pathParts[2] === "layers") {
        const analysis = repository.analyze(batchId);
        return send(res, 200, { layers: analysis.layers, infeasible: analysis.infeasible });
      }

      if (req.method === "GET" && pathParts.length === 3 && pathParts[2] === "contributions") {
        const analysis = repository.analyze(batchId);
        return send(res, 200, {
          hypervolume: analysis.hypervolume,
          contributions: analysis.contributions,
          uniqueFrontCoordinates: analysis.uniqueFrontCoordinates,
        });
      }

      if (req.method === "POST" && pathParts.length === 1 && pathParts[0] === "comparisons") {
        const body = (await readJson(req)) as Record<string, unknown>;
        if (typeof body.batchA !== "string" || typeof body.batchB !== "string") {
          throw new AppError("VALIDATION_ERROR", "batchA and batchB are required string ids");
        }
        const result = repository.compareBatches(
          body.batchA,
          body.batchB,
          body.scale as { factors: number[]; units: string[] } | undefined,
        );
        const report = repository.createReport(result.id, "default", {
          comparison: result.id,
          frozenReferencePoint: result.frozenReferencePoint,
          frozenScale: result.frozenScale ?? null,
          hvA: result.hvA,
          hvB: result.hvB,
          delta: result.delta,
          winner: result.winner,
          note: result.scaleNote ?? "raw hypervolume carries the product of objective units; it is not dimensionless",
        });
        return send(res, 201, { comparison: result, report: report.reportId, reportCreated: report.created });
      }

      if (req.method === "GET" && pathParts.length === 2 && pathParts[0] === "reports") {
        return send(res, 200, repository.getReport(pathParts[1]!));
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: "no route for " + req.method + " " + url.pathname } });
    } catch (error) {
      if (error instanceof AppError) {
        return send(res, error.httpStatus, { error: { code: error.code, message: error.message, details: error.details } });
      }
      const message = error instanceof Error ? error.message : String(error);
      send(res, 500, { error: { code: "INTERNAL_ERROR", message } });
    }
  });
  return server;
}

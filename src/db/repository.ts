import { DatabaseSync } from "node:sqlite";
import { AppError } from "../core/errors.js";
import type {
  Candidate,
  CandidateInput,
  ProblemConfig,
} from "../core/types.js";
import { assertFiniteVector, validateConfig } from "../core/normalize.js";

export interface ProblemRow {
  id: string;
  dimension: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export function parseConfig(row: ProblemRow): ProblemConfig {
  const parsed = JSON.parse(row.config_json) as Omit<ProblemConfig, "id" | "createdAt" | "updatedAt"> &
    Partial<Pick<ProblemConfig, "id" | "createdAt" | "updatedAt">>;
  return {
    ...parsed,
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateProblemInput {
  id: string;
  dimension: number;
  objectives: Array<{ name: string; direction: "max" | "min"; unit: string; scale: number }>;
  referencePoint: number[];
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

function isUniqueError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE constraint failed");
}

export class Repository {
  constructor(readonly db: DatabaseSync) {}

  createProblem(input: CreateProblemInput, now: () => string): ProblemConfig {
    const validated = validateConfig(input);
    assertFiniteVector(input.referencePoint, input.dimension, "referencePoint");
    const ts = now();
    const config: ProblemConfig = {
      ...validated,
      id: input.id,
      createdAt: ts,
      updatedAt: ts,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO problems(id, dimension, config_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          config.id,
          config.dimension,
          JSON.stringify({
            dimension: config.dimension,
            objectives: config.objectives,
            referencePoint: config.referencePoint,
          }),
          ts,
          ts,
        );
    } catch (err) {
      if (isUniqueError(err)) {
        throw new AppError("CONFLICT", `problem '${input.id}' already exists`);
      }
      throw err;
    }
    return config;
  }

  getProblem(id: string): ProblemConfig {
    const row = this.db.prepare("SELECT * FROM problems WHERE id = ?").get(id) as
      | ProblemRow
      | undefined;
    if (!row) throw new AppError("NOT_FOUND", `problem '${id}' not found`);
    return parseConfig(row);
  }

  listProblems(): Array<{ id: string; dimension: number; createdAt: string }> {
    const rows = this.db
      .prepare("SELECT id, dimension, created_at FROM problems ORDER BY id")
      .all() as Array<{ id: string; dimension: number; created_at: string }>;
    return rows.map((r) => ({ id: r.id, dimension: r.dimension, createdAt: r.created_at }));
  }

  createBatch(problemId: string, name: string, now: () => string): number {
    this.getProblem(problemId);
    try {
      const result = this.db
        .prepare("INSERT INTO batches(problem_id, name, created_at) VALUES (?, ?, ?)")
        .run(problemId, name, now());
      return Number(result.lastInsertRowid);
    } catch (err) {
      if (isUniqueError(err)) {
        throw new AppError("CONFLICT", `batch '${name}' already exists for problem '${problemId}'`);
      }
      throw err;
    }
  }

  getBatch(problemId: string, nameOrId: string): { id: number; name: string } {
    const byId = Number(nameOrId);
    const row = Number.isInteger(byId)
      ? (this.db
          .prepare("SELECT id, name FROM batches WHERE problem_id = ? AND id = ?")
          .get(problemId, byId) as { id: number; name: string } | undefined)
      : undefined;
    const found =
      row ??
      (this.db
        .prepare("SELECT id, name FROM batches WHERE problem_id = ? AND name = ?")
        .get(problemId, nameOrId) as { id: number; name: string } | undefined);
    if (!found) throw new AppError("NOT_FOUND", `batch '${nameOrId}' not found`);
    return found;
  }

  listBatches(problemId: string): Array<{ id: number; name: string; createdAt: string }> {
    const rows = this.db
      .prepare("SELECT id, name, created_at FROM batches WHERE problem_id = ? ORDER BY id")
      .all(problemId) as Array<{ id: number; name: string; created_at: string }>;
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
  }

  /**
   * Insert (or revise) candidates inside a single transaction. A repeated code
   * creates a new revision row; the old row is marked non-current. The whole
   * import is atomic: any invalid row rolls back every prior insert.
   */
  importCandidates(
    batchId: number,
    config: ProblemConfig,
    candidates: CandidateInput[],
    now: () => string,
  ): { inserted: number; revised: number } {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new AppError("VALIDATION_ERROR", "candidates must be a non-empty array");
    }
    const seenCodes = new Set<string>();
    candidates.forEach((c, i) => {
      if (!c || typeof c.code !== "string" || c.code.trim() === "") {
        throw new AppError("VALIDATION_ERROR", `candidates[${i}].code is required`);
      }
      if (seenCodes.has(c.code)) {
        throw new AppError("VALIDATION_ERROR", `duplicate code '${c.code}' within one import`);
      }
      seenCodes.add(c.code);
      assertFiniteVector(c.values, config.dimension, `candidate '${c.code}' values`);
    });

    const insert = this.db.prepare(
      `INSERT INTO candidates(batch_id, code, values_json, feasible, source, revision, supersedes_id, is_current, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    const currentRow = this.db.prepare(
      "SELECT id, revision FROM candidates WHERE batch_id = ? AND code = ? AND is_current = 1",
    );
    const supersede = this.db.prepare("UPDATE candidates SET is_current = 0 WHERE id = ?");

    this.db.exec("BEGIN IMMEDIATE");
    let inserted = 0;
    let revised = 0;
    try {
      for (const c of candidates) {
        const prev = currentRow.get(batchId, c.code) as
          | { id: number; revision: number }
          | undefined;
        insert.run(
          batchId,
          c.code,
          JSON.stringify(c.values),
          c.feasible === false ? 0 : 1,
          c.source ?? null,
          prev ? prev.revision + 1 : 1,
          prev ? prev.id : null,
          now(),
        );
        if (prev) {
          supersede.run(prev.id);
          revised++;
        } else {
          inserted++;
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { inserted, revised };
  }

  /** Paginated read of current candidates for a batch. */
  listCandidates(
    batchId: number,
    opts: { limit: number; offset: number; feasible?: boolean },
  ): Page<Candidate> {
    const where = ["batch_id = ?", "is_current = 1"];
    const params: unknown[] = [batchId];
    if (opts.feasible !== undefined) {
      where.push("feasible = ?");
      params.push(opts.feasible ? 1 : 0);
    }
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM candidates WHERE ${where.join(" AND ")}`)
      .get(...(params as never[])) as { n: number };
    const rows = this.db
      .prepare(
        `SELECT * FROM candidates WHERE ${where.join(" AND ")}
         ORDER BY id LIMIT ? OFFSET ?`,
      )
      .all(...(params as never[]), opts.limit, opts.offset) as Array<{
      id: number;
      batch_id: number;
      code: string;
      values_json: string;
      feasible: number;
      source: string | null;
      revision: number;
      created_at: string;
    }>;
    return {
      items: rows.map((r) => ({
        id: r.id,
        batchId: r.batch_id,
        code: r.code,
        values: JSON.parse(r.values_json) as number[],
        feasible: r.feasible === 1,
        source: r.source ?? undefined,
        revision: r.revision,
        createdAt: r.created_at,
      })),
      total: totalRow.n,
      limit: opts.limit,
      offset: opts.offset,
    };
  }

  /** Full unpaginated current set, used by analytics (sorting / hypervolume). */
  allCurrentCandidates(batchId: number): Candidate[] {
    return this.listCandidates(batchId, { limit: Number.MAX_SAFE_INTEGER, offset: 0 }).items;
  }

  candidateHistory(batchId: number, code: string): Array<{ revision: number; values: number[]; feasible: boolean; createdAt: string }> {
    const rows = this.db
      .prepare(
        "SELECT revision, values_json, feasible, created_at FROM candidates WHERE batch_id = ? AND code = ? ORDER BY revision",
      )
      .all(batchId, code) as Array<{ revision: number; values_json: string; feasible: number; created_at: string }>;
    if (rows.length === 0) throw new AppError("NOT_FOUND", `candidate '${code}' not found`);
    return rows.map((r) => ({
      revision: r.revision,
      values: JSON.parse(r.values_json) as number[],
      feasible: r.feasible === 1,
      createdAt: r.created_at,
    }));
  }

  getIdempotent(problemId: string, key: string): unknown | null {
    const row = this.db
      .prepare("SELECT response_json FROM idempotency_keys WHERE problem_id = ? AND idempotency_key = ?")
      .get(problemId, key) as { response_json: string } | undefined;
    return row ? JSON.parse(row.response_json) : null;
  }

  storeIdempotent(problemId: string, key: string, response: unknown, now: () => string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO idempotency_keys(problem_id, idempotency_key, response_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(problemId, key, JSON.stringify(response), now());
  }

  saveReport(input: {
    problemId: string;
    batchAId: number;
    batchBId: number;
    configHash: string;
    configJson: string;
    result: unknown;
    now: () => string;
  }): { id: number; reused: boolean } {
    const existing = this.db
      .prepare(
        "SELECT id FROM reports WHERE problem_id = ? AND batch_a_id = ? AND batch_b_id = ? AND config_hash = ?",
      )
      .get(input.problemId, input.batchAId, input.batchBId, input.configHash) as
      | { id: number }
      | undefined;
    if (existing) return { id: existing.id, reused: true };
    const result = this.db
      .prepare(
        `INSERT INTO reports(problem_id, batch_a_id, batch_b_id, config_hash, config_json, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.problemId,
        input.batchAId,
        input.batchBId,
        input.configHash,
        input.configJson,
        JSON.stringify(input.result),
        input.now(),
      );
    return { id: Number(result.lastInsertRowid), reused: false };
  }

  listReports(problemId: string, limit: number, offset: number): Page<{ id: number; batchA: number; batchB: number; configHash: string; createdAt: string }> {
    const totalRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM reports WHERE problem_id = ?")
      .get(problemId) as { n: number };
    const rows = this.db
      .prepare(
        "SELECT id, batch_a_id, batch_b_id, config_hash, created_at FROM reports WHERE problem_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
      )
      .all(problemId, limit, offset) as Array<{
      id: number;
      batch_a_id: number;
      batch_b_id: number;
      config_hash: string;
      created_at: string;
    }>;
    return {
      items: rows.map((r) => ({
        id: r.id,
        batchA: r.batch_a_id,
        batchB: r.batch_b_id,
        configHash: r.config_hash,
        createdAt: r.created_at,
      })),
      total: totalRow.n,
      limit,
      offset,
    };
  }

  getReport(problemId: string, reportId: number): { configHash: string; config: unknown; result: unknown; createdAt: string } {
    const row = this.db
      .prepare("SELECT * FROM reports WHERE problem_id = ? AND id = ?")
      .get(problemId, reportId) as
      | { config_hash: string; config_json: string; result_json: string; created_at: string }
      | undefined;
    if (!row) throw new AppError("NOT_FOUND", `report ${reportId} not found`);
    return {
      configHash: row.config_hash,
      config: JSON.parse(row.config_json),
      result: JSON.parse(row.result_json),
      createdAt: row.created_at,
    };
  }
}

export function openRepository(dbPath: string): { db: DatabaseSync; repo: Repository } {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  const repo = new Repository(db);
  return { db, repo };
}


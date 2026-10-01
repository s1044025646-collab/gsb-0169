import type { Database as DBType } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { AppError } from "../core/errors.js";
import { analyzeBatch, assertSameFrame, prepareBatch, type BatchAnalysis } from "../core/analysis.js";
import { scaledHypervolume } from "../core/hypervolume.js";
import type { ObjectiveSpec, Scale } from "../core/types.js";

export interface StoredBatch {
  id: string;
  objectives: ObjectiveSpec[];
  referencePoint: number[];
  scale?: Scale;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImportResult {
  batchId: string;
  created: boolean;
  revision: number;
  analysis: BatchAnalysis;
}

export interface Clock {
  now(): string;
}

export const isoClock: Clock = { now: () => new Date().toISOString() };

export class Repository {
  constructor(
    private readonly db: DBType,
    private readonly clock: Clock = isoClock,
  ) {}

  /**
   * Idempotent import. A repeated submission carrying the same
   * idempotencyKey returns the SAME batch without mutating it. A reused key
   * with a different payload is rejected rather than silently overwritten.
   */
  importBatch(params: {
    batchId?: string;
    idempotencyKey?: string;
    objectives: unknown;
    referencePoint: unknown;
    candidates: unknown;
    scale?: { factors: number[]; units: string[] };
  }): ImportResult {
    if (params.idempotencyKey) {
      const existing = this.db
        .prepare("SELECT id FROM batches WHERE idempotency_key = ?")
        .get(params.idempotencyKey) as { id: string } | undefined;
      if (existing) {
        const stored = this.getBatch(existing.id);
        if (!this.payloadMatches(stored, params)) {
          throw new AppError(
            "IDEMPOTENCY_MISMATCH",
            `idempotency key ${params.idempotencyKey} was already used with different payload`,
          );
        }
        return { batchId: existing.id, created: false, revision: stored.revision, analysis: this.analyze(existing.id) };
      }
    }

    const prepared = prepareBatch(params.objectives, params.referencePoint, params.candidates);
    const batchId = params.batchId ?? randomUUID();
    if (this.db.prepare("SELECT id FROM batches WHERE id = ?").get(batchId)) {
      throw new AppError("DUPLICATE_BATCH", `batch id already exists: ${batchId}`, undefined, 409);
    }

    const now = this.clock.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO batches (id, objectives, reference_point, scale, revision, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          batchId,
          JSON.stringify(prepared.objectives),
          JSON.stringify(prepared.referencePoint),
          params.scale ? JSON.stringify(params.scale) : null,
          params.idempotencyKey ?? null,
          now,
          now,
        );
      const insertCandidate = this.db.prepare(
        `INSERT INTO candidates (batch_id, candidate_id, raw_values, normalized_values, feasible, revision)
         VALUES (?, ?, ?, ?, ?, 1)`,
      );
      for (const point of [...prepared.feasible, ...prepared.infeasible]) {
        const raw = (params.candidates as Array<{ candidateId: string; values: number[] }>).find(
          (candidate) => candidate.candidateId === point.candidateId,
        )!;
        insertCandidate.run(
          batchId,
          point.candidateId,
          JSON.stringify(raw.values),
          JSON.stringify(point.x),
          point.feasible ? 1 : 0,
        );
      }
      this.insertRevisionSnapshot(batchId, 1, prepared, now);
    });
    tx();

    return { batchId, created: true, revision: 1, analysis: this.analyze(batchId) };
  }

  private payloadMatches(
    batch: StoredBatch,
    params: { objectives: unknown; referencePoint: unknown; candidates: unknown },
  ): boolean {
    // Compare fully normalized, validated payloads so equivalent textual
    // submissions are recognized as repeats.
    const storedCandidates = this.db
      .prepare("SELECT candidate_id, raw_values, feasible FROM candidates WHERE batch_id = ?")
      .all(batch.id) as Array<{ candidate_id: string; raw_values: string; feasible: number }>;
    const storedCandidateInput = storedCandidates
      .map((row) => ({
        candidateId: row.candidate_id,
        values: JSON.parse(row.raw_values) as number[],
        feasible: row.feasible === 1,
      }))
      .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
    const incomingPrepared = prepareBatch(params.objectives, params.referencePoint, params.candidates);
    const incomingCandidateInput = (params.candidates as Array<{ candidateId: string; values: number[]; feasible: boolean }>)
      .map((candidate) => ({ candidateId: candidate.candidateId, values: candidate.values, feasible: candidate.feasible }))
      .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
    return (
      JSON.stringify(batch.objectives) === JSON.stringify(incomingPrepared.objectives) &&
      JSON.stringify(batch.referencePoint) === JSON.stringify(incomingPrepared.referencePoint) &&
      JSON.stringify(storedCandidateInput) === JSON.stringify(incomingCandidateInput)
    );
  }

  private insertRevisionSnapshot(
    batchId: string,
    revision: number,
    prepared: ReturnType<typeof prepareBatch>,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO batch_revisions (batch_id, revision, objectives, reference_point, scale, snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        batchId,
        revision,
        JSON.stringify(prepared.objectives),
        JSON.stringify(prepared.referencePoint),
        null,
        JSON.stringify({
          feasible: prepared.feasible.map((point) => [point.candidateId, point.x]),
          infeasible: prepared.infeasible.map((point) => [point.candidateId, point.x]),
        }),
        now,
      );
  }

  getBatch(batchId: string): StoredBatch {
    const row = this.db
      .prepare("SELECT * FROM batches WHERE id = ?")
      .get(batchId) as BatchRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", `batch not found: ${batchId}`, undefined, 404);
    return this.toStoredBatch(row);
  }

  listBatches(limit: number, offset: number): { items: StoredBatch[]; total: number } {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM batches").get() as { c: number }).c;
    const rows = this.db
      .prepare("SELECT * FROM batches ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?")
      .all(limit, offset) as BatchRow[];
    return { items: rows.map((row) => this.toStoredBatch(row)), total };
  }

  private toStoredBatch(row: BatchRow): StoredBatch {
    return {
      id: row.id,
      objectives: JSON.parse(row.objectives) as ObjectiveSpec[],
      referencePoint: JSON.parse(row.reference_point) as number[],
      scale: row.scale ? (JSON.parse(row.scale) as Scale) : undefined,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  loadPrepared(batchId: string) {
    const batch = this.getBatch(batchId);
    const rows = this.db
      .prepare("SELECT candidate_id, normalized_values, feasible FROM candidates WHERE batch_id = ?")
      .all(batchId) as CandidateRow[];
    const feasible = rows
      .filter((row) => row.feasible === 1)
      .map((row) => ({
        candidateId: row.candidate_id,
        x: JSON.parse(row.normalized_values) as number[],
        feasible: true,
        feasibleCount: 1,
      }));
    const infeasible = rows
      .filter((row) => row.feasible === 0)
      .map((row) => ({
        candidateId: row.candidate_id,
        x: JSON.parse(row.normalized_values) as number[],
        feasible: false,
        feasibleCount: 0,
      }));
    return { objectives: batch.objectives, referencePoint: batch.referencePoint, scale: batch.scale, feasible, infeasible };
  }

  analyze(batchId: string): BatchAnalysis {
    const prepared = this.loadPrepared(batchId);
    return analyzeBatch(prepared);
  }

  listCandidates(
    batchId: string,
    limit: number,
    offset: number,
  ): { items: CandidateRowDetail[]; total: number } {
    this.getBatch(batchId);
    const total = (
      this.db.prepare("SELECT COUNT(*) AS c FROM candidates WHERE batch_id = ?").get(batchId) as { c: number }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT candidate_id, raw_values, normalized_values, feasible, revision
         FROM candidates WHERE batch_id = ? ORDER BY candidate_id ASC LIMIT ? OFFSET ?`,
      )
      .all(batchId, limit, offset) as Array<CandidateRow & { raw_values: string; revision: number }>;
    const items: CandidateRowDetail[] = rows.map((row) => ({
      candidateId: row.candidate_id,
      rawValues: JSON.parse(row.raw_values),
      normalizedValues: JSON.parse(row.normalized_values),
      feasible: row.feasible === 1,
      revision: row.revision,
    }));
    return { items, total };
  }

  compareBatches(batchAId: string, batchBId: string, overrideScale?: Scale) {
    const a = this.loadPrepared(batchAId);
    const b = this.loadPrepared(batchBId);
    const scale = overrideScale ?? a.scale ?? b.scale;
    const frameA = { objectives: a.objectives, referencePoint: a.referencePoint, scale };
    const frameB = { objectives: b.objectives, referencePoint: b.referencePoint, scale };
    assertSameFrame(frameA, frameB);

    const analysisA = analyzeBatch(a);
    const analysisB = analyzeBatch(b);
    let hvA = analysisA.hypervolume;
    let hvB = analysisB.hypervolume;
    let scaleNote: string | undefined;
    if (scale) {
      hvA = scaledHypervolume(hvA, scale);
      hvB = scaledHypervolume(hvB, scale);
      scaleNote = `hypervolume scaled by factors [${scale.factors.join(", ")}]; units = [${scale.units.join(" * ")}]`;
    }
    const delta = hvB - hvA;
    const winner = delta > 1e-12 ? batchBId : delta < -1e-12 ? batchAId : "tie";

    const id = randomUUID();
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO comparisons (id, batch_a, batch_b, frozen_reference_point, frozen_scale, hv_a, hv_b, delta, winner, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        batchAId,
        batchBId,
        JSON.stringify(a.referencePoint),
        scale ? JSON.stringify(scale) : null,
        hvA,
        hvB,
        delta,
        winner,
        now,
      );
    return {
      id,
      batchA: batchAId,
      batchB: batchBId,
      frozenReferencePoint: a.referencePoint,
      frozenScale: scale,
      hvA,
      hvB,
      delta,
      winner,
      scaleNote,
      createdAt: now,
      contributionsA: analysisA.contributions,
      contributionsB: analysisB.contributions,
      evidenceA: analysisA.evidence,
      evidenceB: analysisB.evidence,
      layersA: analysisA.layers,
      layersB: analysisB.layers,
      infeasibleA: analysisA.infeasible,
      infeasibleB: analysisB.infeasible,
    };
  }

  createReport(comparisonId: string, paramsKey: string, body: unknown) {
    const comparison = this.db
      .prepare("SELECT * FROM comparisons WHERE id = ?")
      .get(comparisonId) as ComparisonRow | undefined;
    if (!comparison) throw new AppError("NOT_FOUND", `comparison not found: ${comparisonId}`, undefined, 404);
    const existing = this.db
      .prepare("SELECT id FROM reports WHERE comparison_id = ? AND parameter_hash = ?")
      .get(comparisonId, paramsKey) as { id: string } | undefined;
    if (existing) return { reportId: existing.id, created: false };
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO reports (id, comparison_id, parameter_hash, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, comparisonId, paramsKey, JSON.stringify(body), this.clock.now());
    return { reportId: id, created: true };
  }

  getReport(reportId: string) {
    const row = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId) as
      | { id: string; comparison_id: string; parameter_hash: string; body: string; created_at: string }
      | undefined;
    if (!row) throw new AppError("NOT_FOUND", `report not found: ${reportId}`, undefined, 404);
    return {
      id: row.id,
      comparisonId: row.comparison_id,
      parameterHash: row.parameter_hash,
      body: JSON.parse(row.body),
      createdAt: row.created_at,
    };
  }
}

interface BatchRow {
  id: string;
  objectives: string;
  reference_point: string;
  scale: string | null;
  revision: number;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

interface CandidateRow {
  candidate_id: string;
  normalized_values: string;
  feasible: number;
}

export interface CandidateRowDetail {
  candidateId: string;
  rawValues: number[];
  normalizedValues: number[];
  feasible: boolean;
  revision: number;
}

interface ComparisonRow {
  id: string;
  batch_a: string;
  batch_b: string;
}

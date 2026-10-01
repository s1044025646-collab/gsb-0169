/**
 * Core domain types for multi-objective non-dominated sorting and hypervolume.
 *
 * All numeric objectives must be finite numbers. Objective directions are
 * declared per objective ("max" or "min"); internally everything is converted
 * to a maximization frame before dominance or hypervolume work takes place.
 */

export type Direction = "max" | "min";

export interface ObjectiveSpec {
  /** 0-based index, used only for stable ordering. */
  index: number;
  /** Human readable objective name, e.g. "profit". */
  name: string;
  /** Optimization direction. */
  direction: Direction;
  /** Unit of the raw input values, e.g. "kg", "USD". */
  unit: string;
  /**
   * Positive linear scale relative to the canonical problem unit.
   * Raw values are divided by scale to reach canonical units. Unit changes
   * that are pure proportional rescaling change hypervolume by the product
   * of axis ratios; hypervolume is therefore dimensional, never "unitless".
   */
  scale: number;
}

export interface ProblemConfig {
  id: string;
  /** Number of objectives; only 2 or 3 are supported. */
  dimension: number;
  objectives: ObjectiveSpec[];
  /** Reference point in raw (input) units and directions. Frozen per compare. */
  referencePoint: number[];
  createdAt: string;
  updatedAt: string;
}

/** A candidate solution as supplied by the user (raw frame). */
export interface CandidateInput {
  code: string;
  values: number[];
  feasible: boolean;
  /** Optional free-form source annotation, retained for traceability. */
  source?: string;
}

/** Persisted candidate row. */
export interface Candidate extends CandidateInput {
  id: number;
  batchId: number;
  revision: number;
  createdAt: string;
}

/** Point in the normalized maximization frame, canonical units. */
export interface NormalPoint {
  /** All distinct candidate ids sharing these normalized coordinates. */
  candidateIds: number[];
  /** Original codes, kept parallel with candidateIds for traceability. */
  codes: string[];
  coords: number[];
  feasible: boolean;
}

export interface FrontLayer {
  /** 1-based Pareto rank. */
  rank: number;
  points: NormalPoint[];
}

export interface Contribution {
  candidateIds: number[];
  codes: string[];
  coords: number[];
  /** Hypervolume lost when this unique coordinate group is removed. */
  contribution: number;
  /** True when multiple candidate codes collapse to the same coordinates. */
  duplicate: boolean;
}

export interface SortResult {
  layers: FrontLayer[];
  infeasible: NormalPoint[];
}

export interface HypervolumeResult {
  /** Canonical hypervolume in the (dimensional) canonical unit product. */
  hypervolume: number;
  /** Canonical reference point actually used (maximization frame). */
  referenceNormal: number[];
  /** Dimensional label such as "kg*USD" so the value is never claimed unitless. */
  unitLabel: string;
  /** Unique feasible normalized points that dominate the reference point. */
  contributingPoints: Array<{ coords: number[]; codes: string[] }>;
}

import type { DominanceEvidence, LayerResult, NormalizedPoint } from "./types.js";

/**
 * Pareto dominance in the unified maximization frame.
 * a dominates b iff a >= b on every axis and strictly greater on at least one.
 * Equal coordinates never dominate each other (they are equivalent solutions).
 */
export function dominates(a: number[], b: number[]): boolean {
  let strictlyBetter = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return false;
    if (a[i]! > b[i]!) strictlyBetter = true;
  }
  return strictlyBetter;
}

export function coordinatesEqual(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Successive-front non-dominated sorting (explainable O(k n^2) layering).
 * Infeasible points are excluded entirely from the fronts and are reported
 * separately by callers.
 */
export function nonDominatedSort(feasiblePoints: NormalizedPoint[]): {
  layers: LayerResult[];
  rankByCandidate: Map<string, number>;
} {
  const points = feasiblePoints.map((point) => ({ ...point }));
  const rankByCandidate = new Map<string, number>();
  const layers: LayerResult[] = [];
  let remaining = new Set(points.map((point) => point.candidateId));
  const byId = new Map(points.map((point) => [point.candidateId, point]));
  let rank = 0;

  while (remaining.size > 0) {
    const front: string[] = [];
    for (const id of remaining) {
      const point = byId.get(id)!;
      let isDominated = false;
      for (const otherId of remaining) {
        if (otherId === id) continue;
        const other = byId.get(otherId)!;
        if (dominates(other.x, point.x)) {
          isDominated = true;
          break;
        }
      }
      if (!isDominated) front.push(id);
    }
    for (const id of front) {
      rankByCandidate.set(id, rank);
      remaining.delete(id);
    }
    layers.push({ rank, points: front.sort() });
    rank += 1;
  }

  return { layers, rankByCandidate };
}

export function buildDominanceEvidence(
  feasiblePoints: NormalizedPoint[],
  rankByCandidate: Map<string, number>,
  infeasiblePoints: NormalizedPoint[],
): DominanceEvidence[] {
  const evidence: DominanceEvidence[] = [];
  for (const point of feasiblePoints) {
    const dominatedBy: string[] = [];
    const dominatesList: string[] = [];
    for (const other of feasiblePoints) {
      if (other.candidateId === point.candidateId) continue;
      if (coordinatesEqual(other.x, point.x)) continue;
      if (dominates(other.x, point.x)) dominatedBy.push(other.candidateId);
      else if (dominates(point.x, other.x)) dominatesList.push(other.candidateId);
    }
    evidence.push({
      candidateId: point.candidateId,
      dominatedBy: dominatedBy.sort(),
      dominates: dominatesList.sort(),
      rank: rankByCandidate.get(point.candidateId) ?? null,
      feasible: true,
      normalized: point.x,
    });
  }
  for (const point of infeasiblePoints) {
    evidence.push({
      candidateId: point.candidateId,
      dominatedBy: [],
      dominates: [],
      rank: null,
      feasible: false,
      normalized: point.x,
    });
  }
  return evidence.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
}

/**
 * Deduplicate by normalized coordinate. Multiple candidate ids sharing the
 * exact same coordinates are preserved (allIds), but participate in the
 * union only once. Returns canonical points plus a coordinate->ids map.
 */
export function dedupeByCoordinate(points: NormalizedPoint[]): {
  unique: NormalizedPoint[];
  idsByCoordinateKey: Map<string, string[]>;
} {
  const keyOf = (x: number[]) => x.map((value) => value.toString()).join("|");
  const unique: NormalizedPoint[] = [];
  const idsByCoordinateKey = new Map<string, string[]>();
  const indexByKey = new Map<string, number>();
  for (const point of points) {
    const key = keyOf(point.x);
    const existing = idsByCoordinateKey.get(key);
    if (existing) {
      existing.push(point.candidateId);
      existing.sort();
    } else {
      idsByCoordinateKey.set(key, [point.candidateId]);
      indexByKey.set(key, unique.length);
      unique.push({ ...point, candidateId: point.candidateId });
    }
  }
  return { unique, idsByCoordinateKey };
}

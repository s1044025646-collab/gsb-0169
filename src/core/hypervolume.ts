import { AppError } from "./errors.js";
import { assertPointCanDominateRef } from "./objectives.js";
import { coordinatesEqual, dedupeByCoordinate } from "./dominance.js";
import type { NormalizedPoint, Scale } from "./types.js";

/**
 * Hypervolume in the unified maximization frame.
 *
 * Every point defines an axis-aligned box [ref_i, x_i]. The hypervolume is
 * the volume of the UNION of these boxes, never a sum of individual box
 * volumes (which would double count overlapping regions).
 *
 * Points must dominate the reference point on every axis (strictly to give
 * positive volume). A point on the wrong side is an error; the reference
 * point is never moved or clamped.
 */

function keepDominatedByRef(points: NormalizedPoint[], ref: number[]): NormalizedPoint[] {
  for (const point of points) assertPointCanDominateRef(point.x, ref, point.candidateId);
  // A box has zero extent on any axis where x_i == ref_i; such points add no
  // volume and can be dropped from the union without changing its value.
  return points.filter((point) => point.x.every((value, i) => value >= ref[i]!));
}

/**
 * 2D union area via sweep line + merged y-intervals.
 * Sort unique x edges; between consecutive edges, merge the active
 * y-intervals so overlap along y is counted exactly once.
 */
export function hypervolume2D(points: NormalizedPoint[], ref: number[]): number {
  const active = keepDominatedByRef(points, ref).filter(
    (point) => point.x[0]! > ref[0]! && point.x[1]! > ref[1]!,
  );
  if (active.length === 0) return 0;

  type Edge = { x: number; y0: number; y1: number; kind: 1 | -1 };
  const edges: Edge[] = [];
  for (const point of active) {
    edges.push({ x: ref[0]!, y0: ref[1]!, y1: point.x[1]!, kind: 1 });
    edges.push({ x: point.x[0]!, y0: ref[1]!, y1: point.x[1]!, kind: -1 });
  }
  edges.sort((a, b) => a.x - b.x || b.kind - a.kind);

  let area = 0;
  let prevX = edges[0]!.x;
  const intervals: Array<[number, number]> = [];
  for (const edge of edges) {
    const mergedY = unionLength(intervals);
    area += (edge.x - prevX) * mergedY;
    prevX = edge.x;
    if (edge.kind === 1) intervals.push([edge.y0, edge.y1]);
    else {
      const index = intervals.findIndex((segment) => segment[0] === edge.y0 && segment[1] === edge.y1);
      intervals.splice(index, 1);
    }
  }
  return area;
}

function unionLength(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let length = 0;
  let curStart = sorted[0]![0];
  let curEnd = sorted[0]![1];
  for (let i = 1; i < sorted.length; i++) {
    const [start, end] = sorted[i]!;
    if (start > curEnd) {
      length += curEnd - curStart;
      curStart = start;
      curEnd = end;
    } else {
      curEnd = Math.max(curEnd, end);
    }
  }
  length += curEnd - curStart;
  return length;
}

/**
 * 3D union volume via slicing on axis 0 and interval union on axes 1/2.
 *
 * Between consecutive distinct x0 coordinates, the cross-section of the
 * union is a set of rectangles in the (x1,x2) plane. We compute its area by
 * a second sweep on x1 merging x2 intervals (the same merged-interval union
 * primitive used in 2D), then multiply by the slab thickness. Overlaps are
 * therefore resolved on BOTH inner axes; volumes are never summed blindly.
 */
export function hypervolume3D(points: NormalizedPoint[], ref: number[]): number {
  const active = keepDominatedByRef(points, ref).filter(
    (point) => point.x[0]! > ref[0]! && point.x[1]! > ref[1]! && point.x[2]! > ref[2]!,
  );
  if (active.length === 0) return 0;

  const breakpoints = [...new Set(active.map((point) => point.x[0]!))].sort((a, b) => a - b);
  let volume = 0;
  let slabStart = ref[0]!;

  for (const x0End of breakpoints) {
    const thickness = x0End - slabStart;
    if (thickness > 0) {
      const covering = active.filter((point) => point.x[0]! >= x0End);
      volume += thickness * crossSectionArea(covering, ref);
    }
    slabStart = x0End;
  }
  return volume;
}

/** Union area of rectangles [ref1,x1] x [ref2,x2] via interval merging. */
function crossSectionArea(covering: NormalizedPoint[], ref: number[]): number {
  type YEdge = { y: number; kind: 1 | -1; z0: number; z1: number };
  const edges: YEdge[] = [];
  for (const point of covering) {
    edges.push({ y: ref[1]!, kind: 1, z0: ref[2]!, z1: point.x[2]! });
    edges.push({ y: point.x[1]!, kind: -1, z0: ref[2]!, z1: point.x[2]! });
  }
  edges.sort((a, b) => a.y - b.y || b.kind - a.kind);
  const intervals: Array<[number, number]> = [];
  let area = 0;
  let prevY = edges[0]!.y;
  for (const edge of edges) {
    area += (edge.y - prevY) * unionLength(intervals);
    prevY = edge.y;
    if (edge.kind === 1) intervals.push([edge.z0, edge.z1]);
    else {
      const index = intervals.findIndex((segment) => segment[0] === edge.z0 && segment[1] === edge.z1);
      intervals.splice(index, 1);
    }
  }
  return area;
}

export function hypervolume(points: NormalizedPoint[], ref: number[]): number {
  const dims = ref.length;
  if (dims === 2) return hypervolume2D(points, ref);
  if (dims === 3) return hypervolume3D(points, ref);
  throw new AppError("UNSUPPORTED_DIMENSION", `hypervolume supports 2 or 3 dimensions, got ${dims}`);
}

/**
 * Per-candidate exclusive contribution to the union:
 *   contribution(p) = HV(all) - HV(all without p).
 * Candidates sharing identical coordinates have zero INDIVIDUAL contribution
 * (removing one duplicate leaves the union unchanged); the group's joint
 * contribution is attributed only if the whole coordinate disappears.
 */
export function contributions(
  points: NormalizedPoint[],
  ref: number[],
  rankByCandidate: Map<string, number>,
): Array<{ candidateId: string; contribution: number; total: number; without: number; rank: number }> {
  const { unique, idsByCoordinateKey } = dedupeByCoordinate(points);
  const total = hypervolume(unique, ref);
  const keyOf = (x: number[]) => x.map((value) => value.toString()).join("|");

  const results: Array<{ candidateId: string; contribution: number; total: number; without: number; rank: number }> = [];
  for (const point of points) {
    const peers = idsByCoordinateKey.get(keyOf(point.x))!;
    let without: number;
    if (peers.length > 1) {
      // Duplicate coordinate: removing a single id changes nothing.
      without = total;
    } else {
      const rest = unique.filter((other) => !coordinatesEqual(other.x, point.x));
      without = hypervolume(rest, ref);
    }
    const contribution = total - without;
    if (contribution < -1e-12) {
      throw new AppError("VALIDATION_ERROR", `negative contribution computed for ${point.candidateId}`);
    }
    results.push({
      candidateId: point.candidateId,
      contribution: Math.max(0, contribution),
      total,
      without,
      rank: rankByCandidate.get(point.candidateId) ?? -1,
    });
  }
  return results.sort((a, b) => b.contribution - a.contribution || a.candidateId.localeCompare(b.candidateId));
}

/**
 * Independent brute-force reference via the inclusion-exclusion principle.
 * Only usable for a handful of points (up to ~10 in 2D, ~8 in 3D) because it
 * enumerates all 2^n box subsets. Used by tests to cross-check the sweep /
 * slice implementations.
 */
export function hypervolumeInclusionExclusion(points: NormalizedPoint[], ref: number[]): number {
  const active = keepDominatedByRef(points, ref).filter((point) =>
    point.x.every((value, i) => value > ref[i]!),
  );
  const dims = ref.length;
  let total = 0;
  const subsetCount = 1 << active.length;
  for (let mask = 1; mask < subsetCount; mask++) {
    const lower = [...ref];
    const upper = new Array(dims).fill(Number.POSITIVE_INFINITY);
    let bits = 0;
    for (let i = 0; i < active.length; i++) {
      if ((mask & (1 << i)) !== 0) {
        bits += 1;
        for (let d = 0; d < dims; d++) upper[d] = Math.min(upper[d], active[i]!.x[d]!);
      }
    }
    let intersectionVolume = 1;
    for (let d = 0; d < dims; d++) {
      const extent = upper[d]! - lower[d]!;
      if (extent <= 0) {
        intersectionVolume = 0;
        break;
      }
      intersectionVolume *= extent;
    }
    total += (bits % 2 === 1 ? 1 : -1) * intersectionVolume;
  }
  return total;
}

/**
 * Apply a linear unit scale. Hypervolume scales by the product of the
 * per-axis positive scale factors. The raw numeric hypervolume carries units
 * (product of objective units); it is NOT dimensionless.
 */
export function scaledHypervolume(value: number, scale: Scale): number {
  const product = scale.factors.reduce((acc, factor) => acc * factor, 1);
  if (!Number.isFinite(product) || product <= 0) {
    throw new AppError("VALIDATION_ERROR", "scale factors must all be finite positive numbers");
  }
  return value * product;
}

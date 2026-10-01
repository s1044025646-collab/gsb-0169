import { dominatesReference } from "./dominance.js";
import { AppError } from "./errors.js";
import type {
  Contribution,
  HypervolumeResult,
  NormalPoint,
  ObjectiveSpec,
  ProblemConfig,
} from "./types.js";
import { mergeDuplicateCoordinates, referenceInCanonicalFrame } from "./normalize.js";

export interface ValidatedSet {
  /** Unique feasible normalized coordinates that strictly dominate the ref. */
  points: NormalPoint[];
  reference: number[];
}

/**
 * Validate the frozen reference point against the feasible set.
 * The reference must be strictly dominated by at least one feasible point;
 * a reference pointing the wrong way (hypervolume empty on every axis, or no
 * point beyond it) is rejected — it is never silently moved.
 */
export function validateAgainstReference(
  feasiblePoints: NormalPoint[],
  referenceNormal: number[],
): ValidatedSet {
  const dim = referenceNormal.length;
  for (const rv of referenceNormal) {
    if (!Number.isFinite(rv)) {
      throw new AppError("NON_FINITE_VALUE", "reference point contains a non-finite value", {
        referenceNormal,
      });
    }
  }
  for (const p of feasiblePoints) {
    if (p.coords.length !== dim) {
      throw new AppError("DIMENSION_MISMATCH", "point/reference dimension mismatch", {
        got: p.coords.length,
        expected: dim,
      });
    }
    for (const v of p.coords) {
      if (!Number.isFinite(v)) {
        throw new AppError("NON_FINITE_VALUE", "non-finite normalized coordinate");
      }
    }
  }
  if (feasiblePoints.length === 0) {
    throw new AppError(
      "BAD_REFERENCE_POINT",
      "no feasible candidates exist; cannot validate a reference point",
    );
  }

  const inside = feasiblePoints.filter((p) => dominatesReference(p, referenceNormal));
  if (inside.length === 0) {
    // Give a precise, explainable reason per axis.
    const perAxis = referenceNormal.map((rv, axis) => {
      const best = Math.max(...feasiblePoints.map((p) => p.coords[axis]!));
      return { axis, reference: rv, bestFeasible: best, wrongDirection: best <= rv };
    });
    throw new AppError(
      "BAD_REFERENCE_POINT",
      "reference point is not strictly dominated by any feasible candidate (wrong direction); refusing to move it",
      { perAxis },
    );
  }
  return { points: mergeDuplicateCoordinates(inside), reference: [...referenceNormal] };
}

/**
 * Union area of axis-aligned rectangles [rx, x] x [ry, y] in 2D.
 *
 * Interval/sweep algorithm (no pairwise box volumes are summed, so overlaps
 * are never counted twice): sort the unique right edges x descending; between
 * two adjacent edges the active rectangles are constant, and their covered
 * height is simply the maximum active top edge minus ry.
 */
export function unionArea2D(
  points: ReadonlyArray<readonly number[]>,
  ref: readonly number[],
): number {
  const rx = ref[0]!;
  const ry = ref[1]!;
  // Only points strictly beyond the reference can contribute.
  const usable = points.filter((p) => p[0]! > rx && p[1]! > ry);
  if (usable.length === 0) return 0;

  const xs = [...new Set(usable.map((p) => p[0]!))].sort((a, b) => b - a);
  let area = 0;
  for (let i = 0; i < xs.length; i++) {
    const right = xs[i]!;
    const left = i + 1 < xs.length ? xs[i + 1]! : rx;
    let maxY = ry;
    for (const p of usable) {
      if (p[0]! >= right && p[1]! > maxY) maxY = p[1]!;
    }
    area += (right - left) * (maxY - ry);
  }
  return area;
}

/**
 * Exact 3D hypervolume via slice union.
 *
 * Sweep the z axis at every unique top face z_i (descending). In the slab
 * [z_{i+1}, z_i] (with z_{last+1} = rz) exactly the boxes whose top is at or
 * above z_i are active; the slab volume is its thickness times the 2D union
 * area of the active boxes in the x-y plane. Overlapping boxes are merged by
 * the interval union inside unionArea2D, never added independently.
 */
export function hypervolume3D(points: ReadonlyArray<readonly number[]>, ref: readonly number[]): number {
  const rz = ref[2]!;
  const usable = points.filter((p) => p[0]! > ref[0]! && p[1]! > ref[1]! && p[2]! > rz);
  if (usable.length === 0) return 0;

  const zs = [...new Set(usable.map((p) => p[2]!))].sort((a, b) => b - a);
  let volume = 0;
  for (let i = 0; i < zs.length; i++) {
    const top = zs[i]!;
    const bottom = i + 1 < zs.length ? zs[i + 1]! : rz;
    const active = usable.filter((p) => p[2]! >= top);
    volume += (top - bottom) * unionArea2D(active, ref);
  }
  return volume;
}

export function canonicalUnitLabel(objectives: ObjectiveSpec[]): string {
  return objectives.map((o) => (o.unit === "" ? "1" : o.unit)).join("*");
}

export function computeHypervolume(
  feasiblePoints: NormalPoint[],
  config: ProblemConfig,
): HypervolumeResult {
  const referenceNormal = referenceInCanonicalFrame(config);
  const { points } = validateAgainstReference(feasiblePoints, referenceNormal);
  let hypervolume: number;
  if (config.dimension === 2) {
    hypervolume = unionArea2D(points.map((p) => p.coords), referenceNormal);
  } else {
    hypervolume = hypervolume3D(points.map((p) => p.coords), referenceNormal);
  }
  return {
    hypervolume,
    referenceNormal,
    unitLabel: canonicalUnitLabel(config.objectives),
    contributingPoints: points.map((p) => ({ coords: [...p.coords], codes: [...p.codes] })),
  };
}

/**
 * Single-removal contribution of every unique coordinate group:
 * HV(full set) - HV(set without that group). Duplicate coordinates are merged
 * first, so a point whose box is fully covered by others has contribution 0,
 * and every reported group traces back to its original candidate codes.
 */
export function computeContributions(
  feasiblePoints: NormalPoint[],
  config: ProblemConfig,
): { full: number; contributions: Contribution[] } {
  const referenceNormal = referenceInCanonicalFrame(config);
  const { points } = validateAgainstReference(feasiblePoints, referenceNormal);
  const allCoords = points.map((p) => p.coords);
  const full =
    config.dimension === 2
      ? unionArea2D(allCoords, referenceNormal)
      : hypervolume3D(allCoords, referenceNormal);

  const contributions: Contribution[] = points.map((p) => {
    const rest = points
      .filter((q) => q !== p)
      .map((q) => q.coords);
    const hvWithout =
      config.dimension === 2
        ? unionArea2D(rest, referenceNormal)
        : hypervolume3D(rest, referenceNormal);
    const contribution = full - hvWithout;
    if (contribution < -1e-12) {
      throw new Error(`internal error: negative contribution for codes ${p.codes.join(",")}`);
    }
    return {
      candidateIds: [...p.candidateIds],
      codes: [...p.codes],
      coords: [...p.coords],
      contribution: Math.max(0, contribution),
      duplicate: p.codes.length > 1,
    };
  });

  contributions.sort((a, b) => b.contribution - a.contribution);
  return { full, contributions };
}

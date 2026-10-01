export type Direction = "max" | "min";

export interface ObjectiveSpec {
  name: string;
  direction: Direction;
  unit: string;
}

export interface CandidateInput {
  candidateId: string;
  values: number[];
  feasible: boolean;
}

export interface NormalizedPoint {
  candidateId: string;
  x: number[];
  feasible: boolean;
  feasibleCount: number;
}

export interface DominanceEvidence {
  candidateId: string;
  dominatedBy: string[];
  dominates: string[];
  rank: number | null;
  feasible: boolean;
  normalized: number[];
}

export interface LayerResult {
  rank: number;
  points: string[];
}

export interface ContributionResult {
  candidateId: string;
  contribution: number;
  totalHypervolume: number;
  hypervolumeWithout: number;
  rank: number;
}

export interface Scale {
  factors: number[];
  units: string[];
}

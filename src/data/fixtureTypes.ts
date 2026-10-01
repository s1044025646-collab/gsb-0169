import type { CandidateInput } from "../core/types.js";

export interface CreateProblemInput {
  id: string;
  dimension: number;
  objectives: Array<{ name: string; direction: "max" | "min"; unit: string; scale: number }>;
  referencePoint: number[];
}

export type { CandidateInput };

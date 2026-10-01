import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/migrate.js";
import { Repository } from "../src/db/repository.js";
import type { ProblemConfig } from "../src/core/types.js";

let counter = 0;

/** Temp files stay inside the project (../.tmp relative to E:\GSB\0169\A\tests). */
export function tempDbPath(): string {
  const dir = join(process.cwd(), ".tmp-test");
  mkdirSync(dir, { recursive: true });
  counter++;
  return join(dir, `test-${process.pid}-${counter}-${Date.now()}.sqlite`);
}

export function makeRepo(dbPath: string): { db: DatabaseSync; repo: Repository } {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return { db, repo: new Repository(db) };
}

export function cleanup(paths: string[]): void {
  for (const p of paths) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(p + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

export const FIXED_NOW = "2026-01-01T00:00:00.000Z";
export const clock = () => FIXED_NOW;

export function baseProblem(overrides: Partial<{
  id: string;
  dimension: 2 | 3;
  referencePoint: number[];
}> = {}): {
  id: string;
  dimension: 2 | 3;
  objectives: Array<{ name: string; direction: "max" | "min"; unit: string; scale: number }>;
  referencePoint: number[];
} {
  const dimension = overrides.dimension ?? 2;
  return {
    id: overrides.id ?? "p1",
    dimension,
    objectives: Array.from({ length: dimension }, (_, index) => ({
      index,
      name: `f${index + 1}`,
      direction: "max" as const,
      unit: `u${index + 1}`,
      scale: 1,
    })),
    referencePoint: overrides.referencePoint ?? (dimension === 2 ? [0, 0] : [0, 0, 0]),
  };
}

export function createProblem(
  repo: Repository,
  overrides: Parameters<typeof baseProblem>[0] = {},
): ProblemConfig {
  return repo.createProblem(baseProblem(overrides), clock);
}

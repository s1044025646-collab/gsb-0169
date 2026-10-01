import { DatabaseSync } from "node:sqlite";

/**
 * Idempotent migrations. Every statement uses IF NOT EXISTS / OR IGNORE so the
 * migration can run repeatedly against an existing database without error.
 */
export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     version INTEGER PRIMARY KEY,
     applied_at TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS problems (
     id TEXT PRIMARY KEY,
     dimension INTEGER NOT NULL,
     config_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS batches (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     problem_id TEXT NOT NULL REFERENCES problems(id),
     name TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE(problem_id, name)
   );`,
  `CREATE TABLE IF NOT EXISTS candidates (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     batch_id INTEGER NOT NULL REFERENCES batches(id),
     code TEXT NOT NULL,
     values_json TEXT NOT NULL,
     feasible INTEGER NOT NULL,
     source TEXT,
     revision INTEGER NOT NULL DEFAULT 1,
     supersedes_id INTEGER REFERENCES candidates(id),
     is_current INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     UNIQUE(batch_id, code, revision)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_batch ON candidates(batch_id);
   CREATE INDEX IF NOT EXISTS idx_candidates_current ON candidates(batch_id, is_current);`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
     problem_id TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     response_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY(problem_id, idempotency_key)
   );`,
  `CREATE TABLE IF NOT EXISTS reports (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     problem_id TEXT NOT NULL REFERENCES problems(id),
     batch_a_id INTEGER NOT NULL REFERENCES batches(id),
     batch_b_id INTEGER NOT NULL REFERENCES batches(id),
     config_hash TEXT NOT NULL,
     config_json TEXT NOT NULL,
     result_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE(problem_id, batch_a_id, batch_b_id, config_hash)
   );`,
];

export function migrate(db: DatabaseSync, now: () => string = () => new Date().toISOString()): void {
  db.exec(MIGRATIONS[0]!);
  const appliedRow = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
    | { v: number | null }
    | undefined;
  const applied = appliedRow?.v ?? 0;
  for (let version = 1; version < MIGRATIONS.length; version++) {
    if (version <= applied) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[version]!);
      db.prepare("INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        version,
        now(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

import Database from "better-sqlite3";
import type { Database as DBType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let migrationCounter = 0;

export function openDatabase(path: string): DBType {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/**
 * Idempotent migrations. Every statement is guarded by IF NOT EXISTS /
 * user_version checks so running migrations repeatedly is safe.
 */
export function migrate(db: DBType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      objectives TEXT NOT NULL,
      reference_point TEXT NOT NULL,
      scale TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL,
      raw_values TEXT NOT NULL,
      normalized_values TEXT NOT NULL,
      feasible INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE(batch_id, candidate_id)
    );

    CREATE TABLE IF NOT EXISTS batch_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      objectives TEXT NOT NULL,
      reference_point TEXT NOT NULL,
      scale TEXT,
      snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(batch_id, revision)
    );

    CREATE TABLE IF NOT EXISTS comparisons (
      id TEXT PRIMARY KEY,
      batch_a TEXT NOT NULL REFERENCES batches(id),
      batch_b TEXT NOT NULL REFERENCES batches(id),
      frozen_reference_point TEXT NOT NULL,
      frozen_scale TEXT,
      hv_a REAL NOT NULL,
      hv_b REAL NOT NULL,
      delta REAL NOT NULL,
      winner TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      comparison_id TEXT NOT NULL REFERENCES comparisons(id),
      parameter_hash TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(comparison_id, parameter_hash)
    );
  `);

 const current = db.pragma("user_version", { simple: true }) as number;
  void migrationCounter;
  if (current < 1) db.pragma("user_version = 1");
}

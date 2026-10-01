import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./db/migrate.js";
import { openRepository } from "./db/repository.js";
import { startApiServer } from "./api/server.js";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = resolve(PROJECT_ROOT, "data");
export const DB_PATH = process.env.MOHV_DB ?? resolve(DATA_DIR, "mohv.sqlite");
export const PORT_FILE = resolve(DATA_DIR, "server.port");

async function main(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const { db, repo } = openRepository(DB_PATH);
  migrate(db);
  const { server, port } = await startApiServer({ repo, now: () => new Date().toISOString() });
  writeFileSync(PORT_FILE, String(port), "utf-8");
  const stop = (): void => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`mohv API listening on http://127.0.0.1:${port} (db: ${DB_PATH})`);
  console.log(`port file: ${PORT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

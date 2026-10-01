import { createApp } from "./http.js";
import { openDatabase } from "../db/database.js";
import { Repository } from "../db/repository.js";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * Server binds ONLY to loopback. Port 0 lets the OS assign a free port
 * automatically; the chosen base URL is written into tmp/ inside the project
 * so local tooling can discover it without scanning.
 */
function main(): void {
  const dbPath = process.env.MO_DB_PATH ?? resolve("data/app.db");
  const db = openDatabase(dbPath);
  const repository = new Repository(db);
  const server = createApp(repository);

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to acquire listening address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    mkdirSync("tmp", { recursive: true });
    writeFileSync(resolve("tmp/server.json"), JSON.stringify({ baseUrl, pid: process.pid, dbPath }, null, 2));
    console.log(`[mo-ns-hv] listening on ${baseUrl} (loopback only), pid=${process.pid}, db=${dbPath}`);
  });

  const shutdown = () => {
    console.log("[mo-ns-hv] shutting down");
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();

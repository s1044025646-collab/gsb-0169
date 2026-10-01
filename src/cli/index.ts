#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../db/database.js";
import { Repository } from "../db/repository.js";
import { AppError } from "../core/errors.js";

interface GlobalOptions {
  db: string;
}

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Map<string, string>; options: GlobalOptions } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      else flags.set(arg.slice(2), "true");
    } else {
      positional.push(arg);
    }
  }
  const db = flags.get("db") ?? resolve("data/app.db");
  return { command: positional[0] ?? "help", positional: positional.slice(1), flags, options: { db } };
}

function readPayload(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function printHeader(title: string): void {
  console.log("\n=== " + title + " ===");
}

function run(): void {
  const { command, positional, flags, options } = parseArgs(process.argv.slice(2));
  const db = openDatabase(options.db);
  const repository = new Repository(db);
  const before = (db.prepare("SELECT COUNT(*) AS c FROM batches").get() as { c: number }).c;

  try {
    switch (command) {
      case "import": {
        const file = requireString(positional[0], "usage: cli import <payload.json> [--idempotency-key=K] [--batch-id=ID]");
        const payload = readPayload(file) as Record<string, unknown>;
        printHeader("BEFORE import");
        console.log(`batches in db: ${before}`);
        const result = repository.importBatch({
          batchId: flags.get("batch-id") ?? (payload.batchId as string | undefined),
          idempotencyKey: flags.get("idempotency-key") ?? (payload.idempotencyKey as string | undefined),
          objectives: payload.objectives,
          referencePoint: payload.referencePoint,
          candidates: payload.candidates,
          scale: payload.scale as { factors: number[]; units: string[] } | undefined,
        });
        const after = (db.prepare("SELECT COUNT(*) AS c FROM batches").get() as { c: number }).c;
        printHeader("AFTER import (" + (result.created ? "created" : "idempotent replay") + ")");
        console.log(`batches in db: ${after} (delta ${after - before})`);
        console.log(`batchId=${result.batchId} revision=${result.revision}`);
        console.log(`front layers=${result.analysis.layers.length} infeasible=${result.analysis.infeasible.length}`);
        console.log(`hypervolume=${formatNumber(result.analysis.hypervolume)}`);
        break;
      }
      case "evidence": {
        const batchId = requireString(positional[0], "usage: cli evidence <batchId>");
        const analysis = repository.analyze(batchId);
        printHeader("dominance evidence for " + batchId);
        for (const entry of analysis.evidence) {
          if (!entry.feasible) {
            console.log(`- ${entry.candidateId}: INFEASIBLE (kept out of every feasible front)`);
            continue;
          }
          const reason = entry.dominatedBy.length
            ? "dominated by [" + entry.dominatedBy.join(", ") + "]"
            : "non-dominated";
          console.log(
            `- ${entry.candidateId} rank=${entry.rank} ${reason}; dominates [${entry.dominates.join(", ")}]; x=[${entry.normalized.join(", ")}]`,
          );
        }
        break;
      }
      case "layers": {
        const batchId = requireString(positional[0], "usage: cli layers <batchId>");
        const analysis = repository.analyze(batchId);
        printHeader("non-dominated layers for " + batchId);
        for (const layer of analysis.layers) {
          console.log(`rank ${layer.rank}: [${layer.points.join(", ")}]`);
        }
        console.log("infeasible (excluded): [" + analysis.infeasible.join(", ") + "]");
        break;
      }
      case "contributions": {
        const batchId = requireString(positional[0], "usage: cli contributions <batchId>");
        const analysis = repository.analyze(batchId);
        printHeader("single-point removal contributions for " + batchId);
        console.log("total front hypervolume = " + formatNumber(analysis.hypervolume));
        for (const contribution of analysis.contributions) {
          console.log(
            `- ${contribution.candidateId}: +${formatNumber(contribution.contribution)} ` +
              `(HV without=${formatNumber(contribution.hypervolumeWithout)}, rank=${contribution.rank})`,
          );
        }
        break;
      }
      case "compare": {
        const batchA = requireString(positional[0], "usage: cli compare <batchA> <batchB> [--scale=scale.json]");
        const batchB = requireString(positional[1], "usage: cli compare <batchA> <batchB>");
        const scale = flags.get("scale")
          ? (readPayload(flags.get("scale")!) as { factors: number[]; units: string[] })
          : undefined;
        const result = repository.compareBatches(batchA, batchB, scale);
        const report = repository.createReport(result.id, "default", {
          comparison: result.id,
          frozenReferencePoint: result.frozenReferencePoint,
          frozenScale: result.frozenScale ?? null,
          hvA: result.hvA,
          hvB: result.hvB,
          delta: result.delta,
          winner: result.winner,
          note: result.scaleNote ?? "raw hypervolume carries the product of objective units; it is not dimensionless",
        });
        printHeader("comparison (frozen reference point + scale)");
        console.log(`comparisonId=${result.id}`);
        console.log(`HV(A=${batchA}) = ${formatNumber(result.hvA)}`);
        console.log(`HV(B=${batchB}) = ${formatNumber(result.hvB)}`);
        console.log(`delta B-A = ${formatNumber(result.delta)} -> winner=${result.winner}`);
        if (result.scaleNote) console.log(result.scaleNote);
        console.log("infeasible A: [" + result.infeasibleA.join(", ") + "]");
        console.log("infeasible B: [" + result.infeasibleB.join(", ") + "]");
        console.log(`reportId=${report.reportId} (${report.created ? "new report" : "existing report"})`);
        break;
      }
      case "report": {
        const reportId = requireString(positional[0], "usage: cli report <reportId> [--out=file.json]");
        const report = repository.getReport(reportId);
        const text = JSON.stringify(report, null, 2);
        if (flags.get("out")) {
          const outPath = resolve(flags.get("out")!);
          mkdirSync(resolve(outPath, ".."), { recursive: true });
          writeFileSync(outPath, text);
          console.log("report exported to " + outPath);
        } else {
          console.log(text);
        }
        break;
      }
      case "list": {
        const list = repository.listBatches(100, 0);
        printHeader("batches");
        for (const batch of list.items) {
          console.log(`${batch.id} rev=${batch.revision} dims=${batch.objectives.length} created=${batch.createdAt}`);
        }
        console.log(`total=${list.total}`);
        break;
      }
      case "help":
      default:
        console.log(
          [
            "Commands (all data stays in this project; use --db=PATH to pick a sqlite file):",
            "  import <payload.json> [--idempotency-key=K] [--batch-id=ID]",
            "  evidence <batchId>",
            "  layers <batchId>",
            "  contributions <batchId>",
            "  compare <batchA> <batchB> [--scale=scale.json]",
            "  report <reportId> [--out=file.json]",
            "  list",
          ].join("\n"),
        );
    }
  } finally {
    db.close();
  }
}

function requireString(value: string | undefined, usage: string): string {
  if (!value) throw new AppError("VALIDATION_ERROR", usage);
  return value;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

try {
  run();
} catch (error) {
  if (error instanceof AppError) {
    console.error(`error [${error.code}]: ${error.message}`);
    if (error.details) console.error(JSON.stringify(error.details));
    process.exit(1);
  }
  throw error;
}

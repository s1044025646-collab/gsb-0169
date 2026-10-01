#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "../db/migrate.js";
import { openRepository } from "../db/repository.js";
import { AppError } from "../core/errors.js";
import { analyzeBatch, compareBatches, configHash } from "../core/compare.js";
import { computeContributions } from "../core/hypervolume.js";
import { mergeDuplicateCoordinates, toNormalPoints } from "../core/normalize.js";
import { BATCH_3D, BATCH_A, BATCH_B, DEMO_3D_PROBLEM, DEMO_PROBLEM } from "../data/fixtures.js";
import { DATA_DIR, DB_PATH } from "../server.js";
import { mkdirSync } from "node:fs";

interface CliContext {
  db: ReturnType<typeof openRepository>["db"];
  repo: ReturnType<typeof openRepository>["repo"];
}

function openCli(): CliContext {
  mkdirSync(DATA_DIR, { recursive: true });
  const { db, repo } = openRepository(DB_PATH);
  migrate(db);
  return { db, repo };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function header(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function printStatus(ctx: CliContext, problemId: string): void {
  const batches = ctx.repo.listBatches(problemId);
  console.log(`problem=${problemId} batches=${batches.length}`);
  for (const b of batches) {
    const page = ctx.repo.listCandidates(b.id, { limit: 1, offset: 0 });
    console.log(`  batch #${b.id} '${b.name}' currentCandidates=${page.total}`);
  }
}

function readJsonFile(path: string): unknown {
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) throw new AppError("NOT_FOUND", `file not found: ${abs}`);
  return JSON.parse(readFileSync(abs, "utf-8")) as unknown;
}

function usage(): void {
  console.log(`mohv - local non-dominated sorting & hypervolume CLI

Usage:
  mohv init-problem <config.json>
  mohv mk-batch <problemId> <batchName>
  mohv import <problemId> <batchName> <candidates.json>
  mohv list [problemId]
  mohv evidence <problemId> <batchName>
  mohv layers <problemId> <batchName>
  mohv contributions <problemId> <batchName>
  mohv compare <problemId> <batchA> <batchB>
  mohv report <problemId> <batchA> <batchB>
  mohv demo

Candidates JSON format:
  [{ "code": "S1", "values": [3, 3], "feasible": true }]
`);
}

function cmdDemo(ctx: CliContext): void {
  header("DEMO before: fresh/empty state");
  let existed = true;
  try {
    ctx.repo.getProblem(DEMO_PROBLEM.id);
  } catch {
    existed = false;
  }
  console.log(existed ? `problem '${DEMO_PROBLEM.id}' already present` : "no demo problem yet");

  if (!existed) {
    ctx.repo.createProblem(DEMO_PROBLEM, () => new Date().toISOString());
  }
  // Create batches (ignore conflict on repeat runs).
  const ensureBatch = (name: string): number => {
    try {
      return ctx.repo.createBatch(DEMO_PROBLEM.id, name, () => new Date().toISOString());
    } catch {
      return ctx.repo.getBatch(DEMO_PROBLEM.id, name).id;
    }
  };
  const idA = ensureBatch("alpha");
  const idB = ensureBatch("beta");
  try {
    console.log("importing alpha:", ctx.repo.importCandidates(idA, ctx.repo.getProblem(DEMO_PROBLEM.id), BATCH_A, () => new Date().toISOString()));
    console.log("importing beta:", ctx.repo.importCandidates(idB, ctx.repo.getProblem(DEMO_PROBLEM.id), BATCH_B, () => new Date().toISOString()));
  } catch (err) {
    if (!(err instanceof AppError && err.code === "VALIDATION_ERROR")) throw err;
    console.log("candidates already imported (repeat run; data retained)");
  }

  header("DEMO after import: alpha layers + hypervolume");
  console.log(JSON.stringify(analyzeBatch(ctx.repo.allCurrentCandidates(idA), ctx.repo.getProblem(DEMO_PROBLEM.id), idA), null, 2));

  header("DEMO compare alpha vs beta");
  const report = compareBatches(
    ctx.repo.getProblem(DEMO_PROBLEM.id),
    { batchId: idA, name: "alpha", candidates: ctx.repo.allCurrentCandidates(idA) },
    { batchId: idB, name: "beta", candidates: ctx.repo.allCurrentCandidates(idB) },
  );
  console.log(JSON.stringify(report, null, 2));
  ctx.repo.saveReport({
    problemId: DEMO_PROBLEM.id,
    batchAId: idA,
    batchBId: idB,
    configHash: report.configHash,
    configJson: "{}",
    result: report,
    now: () => new Date().toISOString(),
  });

  // 3D demonstration
  try {
    ctx.repo.createProblem(DEMO_3D_PROBLEM, () => new Date().toISOString());
  } catch {
    /* repeat run */
  }
  let id3d: number;
  try {
    id3d = ctx.repo.createBatch(DEMO_3D_PROBLEM.id, "gamma", () => new Date().toISOString());
  } catch {
    id3d = ctx.repo.getBatch(DEMO_3D_PROBLEM.id, "gamma").id;
  }
  try {
    ctx.repo.importCandidates(id3d, ctx.repo.getProblem(DEMO_3D_PROBLEM.id), BATCH_3D, () => new Date().toISOString());
  } catch {
    /* repeat run */
  }
  header("DEMO 3D gamma layers + hypervolume");
  console.log(JSON.stringify(analyzeBatch(ctx.repo.allCurrentCandidates(id3d), ctx.repo.getProblem(DEMO_3D_PROBLEM.id), id3d).hypervolume, null, 2));
}

function main(argv: string[]): number {
  const [command, ...args] = argv;
  const ctx = openCli();
  try {
    switch (command) {
      case "init-problem": {
        const path = args[0];
        if (!path) throw new AppError("BAD_REQUEST", "config.json path required");
        const body = readJsonFile(path) as {
          id: string;
          dimension: number;
          objectives: never;
          referencePoint: number[];
        };
        const config = ctx.repo.createProblem(body, () => new Date().toISOString());
        console.log(`created problem '${config.id}' dim=${config.dimension} hash=${configHash(config)}`);
        return 0;
      }
      case "mk-batch": {
        const [problemId, name] = args;
        if (!problemId || !name) throw new AppError("BAD_REQUEST", "usage: mk-batch <problemId> <name>");
        printStatus(ctx, problemId);
        const id = ctx.repo.createBatch(problemId, name, () => new Date().toISOString());
        console.log(`created batch #${id} '${name}'`);
        printStatus(ctx, problemId);
        return 0;
      }
      case "import": {
        const [problemId, batchName, file] = args;
        if (!problemId || !batchName || !file) throw new AppError("BAD_REQUEST", "usage: import <problemId> <batch> <file>");
        const config = ctx.repo.getProblem(problemId);
        const batch = ctx.repo.getBatch(problemId, batchName);
        header(`BEFORE import into '${batchName}'`);
        printStatus(ctx, problemId);
        const candidates = readJsonFile(file);
        if (!Array.isArray(candidates)) throw new AppError("VALIDATION_ERROR", "JSON file must contain an array of candidates");
        const result = ctx.repo.importCandidates(batch.id, config, candidates as never, () => new Date().toISOString());
        header(`AFTER import into '${batchName}'`);
        console.log("inserted:", result.inserted, "revised:", result.revised);
        printStatus(ctx, problemId);
        return 0;
      }
      case "list": {
        if (args[0]) {
          printStatus(ctx, args[0]);
        } else {
          for (const p of ctx.repo.listProblems()) console.log(`${p.id} dim=${p.dimension}`);
        }
        return 0;
      }
      case "evidence":
      case "layers":
      case "contributions": {
        const [problemId, batchName] = args;
        if (!problemId || !batchName) throw new AppError("BAD_REQUEST", `usage: ${command} <problemId> <batch>`);
        const config = ctx.repo.getProblem(problemId);
        const batch = ctx.repo.getBatch(problemId, batchName);
        const candidates = ctx.repo.allCurrentCandidates(batch.id);
        const analysis = analyzeBatch(candidates, config, batch.id);
        if (command === "evidence") {
          header(`dominance evidence for '${batchName}'`);
          for (const e of analysis.evidence) {
            console.log(
              `${e.code} coords=[${e.coords.map(fmt).join(", ")}] rank=${e.rank} ` +
                `dominates=[${e.dominates.join(", ")}] dominatedBy=[${e.dominatedBy.join(", ")}]`,
            );
          }
          for (const p of analysis.infeasible) console.log(`${p.code} INFEASIBLE (excluded from fronts)`);
        } else if (command === "layers") {
          header(`non-dominated layers for '${batchName}'`);
          for (const layer of analysis.layers) {
            console.log(`rank ${layer.rank}:`);
            for (const p of layer.points) {
              console.log(`  ${p.codes.join("+")} -> [${p.coords.map(fmt).join(", ")}]  ids=[${p.candidateIds.join(",")}]`);
            }
          }
          if (analysis.infeasible.length) {
            console.log("infeasible (separate):", analysis.infeasible.map((p) => p.code).join(", "));
          }
          console.log(`hypervolume = ${fmt(analysis.hypervolume.value)} ${analysis.hypervolume.unitLabel}`);
        } else {
          const points = mergeDuplicateCoordinates(
            toNormalPoints(
              candidates.filter((c) => c.feasible).map((c) => ({ id: c.id, code: c.code, values: c.values, feasible: true })),
              config,
            ),
          );
          const { full, contributions } = computeContributions(points, config);
          header(`single-removal contributions for '${batchName}'`);
          console.log(`full hypervolume = ${fmt(full)}`);
          for (const ctr of contributions) {
            console.log(
              `  ${ctr.codes.join("+")} contribution=${fmt(ctr.contribution)}` +
                (ctr.duplicate ? "  [duplicate coordinates]" : ""),
            );
          }
        }
        return 0;
      }
      case "compare":
      case "report": {
        const [problemId, nameA, nameB] = args;
        if (!problemId || !nameA || !nameB) throw new AppError("BAD_REQUEST", `usage: ${command} <problemId> <batchA> <batchB>`);
        const config = ctx.repo.getProblem(problemId);
        const a = ctx.repo.getBatch(problemId, nameA);
        const b = ctx.repo.getBatch(problemId, nameB);
        const result = compareBatches(
          config,
          { batchId: a.id, name: a.name, candidates: ctx.repo.allCurrentCandidates(a.id) },
          { batchId: b.id, name: b.name, candidates: ctx.repo.allCurrentCandidates(b.id) },
        );
        console.log(`configHash=${result.configHash} ref=[${result.frozenReferencePoint.join(", ")}]`);
        console.log(`A '${nameA}': HV=${fmt(result.batchA.hypervolume)} front=${result.batchA.frontSize}`);
        console.log(`B '${nameB}': HV=${fmt(result.batchB.hypervolume)} front=${result.batchB.frontSize}`);
        console.log(`delta HV(B-A)=${fmt(result.deltaHypervolume)} ${result.unitLabel} -> ${result.indicator}`);
        if (command === "report") {
          const saved = ctx.repo.saveReport({
            problemId,
            batchAId: a.id,
            batchBId: b.id,
            configHash: result.configHash,
            configJson: JSON.stringify({ referencePoint: config.referencePoint, objectives: config.objectives }),
            result,
            now: () => new Date().toISOString(),
          });
          console.log(`report #${saved.id} ${saved.reused ? "(reused: same parameters)" : "(new: parameters frozen)"}`);
        }
        return 0;
      }
      case "demo":
        cmdDemo(ctx);
        return 0;
      default:
        usage();
        return command === undefined ? 0 : 1;
    }
  } finally {
    ctx.db.close();
  }
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  if (err instanceof AppError) {
    console.error(`error [${err.code}]: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details));
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
}


#!/usr/bin/env -S npx tsx
/**
 * Issue #246 — a real, invokable producing-side entrypoint for the local-only Repo Factory
 * result producer (`src/bootstrap/repo-factory-producer.ts`).
 *
 * WHY this exists
 *
 *   `produceRepoFactoryResult` had no caller anywhere in `src/` — only tests reached it,
 *   which is the exact shape #416 was closed for: an optional seam whose existence was
 *   labelled as capability. This script is that caller. It is deliberately thin and stays
 *   strictly on the producing side of Integration §7 Phase I/J: it builds one local-only
 *   `repo-factory.result.v2` and hands it to the same canonical parser
 *   (`parseRepoFactoryResult`) that `BootstrapActivation.activate()` calls — proving the
 *   producer's output really does pass the real parser, not a lookalike check.
 *
 *   It stops there on purpose. It never calls `BootstrapActivation.activate()` and never
 *   touches the run engine, project registry, or repository registry — that is Phase J
 *   activation/registration, explicitly out of this issue's boundary (no GitHub write, no
 *   repository creation beyond a local git repository, no activation, one repository).
 *
 * Run: npx tsx scripts/repo-factory-produce-local.ts --plan=<path-to-plan.json> --work-dir=<dir>
 * Prints the parser-validated RepoFactoryResult JSON to stdout and exits 0 on success.
 * Prints the reason code, message and evidence to stderr and exits 1 on any refusal —
 * from plan validation, the producer itself, or the canonical parser.
 */
import { readFileSync } from "node:fs";

import { produceRepoFactoryResult, type RepoFactoryPlanFixture } from "../src/bootstrap/repo-factory-producer.ts";
import { parseRepoFactoryResult } from "../src/bootstrap/repo-factory-result.ts";

const argValue = (flag: string): string | null => {
  const prefix = `--${flag}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
};

const fail = (message: string): never => {
  process.stderr.write(`repo-factory-produce-local: ${message}\n`);
  process.exit(1);
};

const main = async (): Promise<void> => {
  const planPath = argValue("plan");
  const workDir = argValue("work-dir");
  if (!planPath || !workDir) {
    fail("usage: npx tsx scripts/repo-factory-produce-local.ts --plan=<path> --work-dir=<dir>");
    return;
  }

  let plan: RepoFactoryPlanFixture;
  try {
    plan = JSON.parse(readFileSync(planPath, "utf8")) as RepoFactoryPlanFixture;
  } catch (err) {
    fail(`cannot read or parse plan at ${planPath}: ${(err as Error).message}`);
    return;
  }

  const produced = await produceRepoFactoryResult({ plan, workDir });
  if (!produced.allowed) {
    fail(
      `producer refused — ${produced.reasonCode}: ${produced.message}\n` +
        JSON.stringify(produced.evidence, null, 2),
    );
    return;
  }

  // The handoff this entrypoint exists to prove: the producer's own output, run through the
  // exact parser `BootstrapActivation.activate()` calls before anything is registered.
  const parsed = parseRepoFactoryResult(produced.value);
  if (!parsed.allowed) {
    fail(
      `producer output failed the canonical parser — ${parsed.reasonCode}: ${parsed.message}\n` +
        JSON.stringify(parsed.evidence, null, 2),
    );
    return;
  }

  process.stdout.write(`${JSON.stringify(parsed.value, null, 2)}\n`);
};

main().catch((err) => {
  process.stderr.write(`repo-factory-produce-local: unexpected error: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

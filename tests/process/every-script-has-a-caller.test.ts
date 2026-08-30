import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #705 — `verify-reason-codes.mjs` was correct and reachable from nowhere: not a `pnpm`
 * script, not a CI step, not called by any other script. `scripts/verify-every-script-has-a-
 * caller.mjs` is the check that this cannot recur silently. This file proves the check
 * actually does the two things its own docstring claims, rather than being green because it
 * inspects nothing (the repeated failure mode this repository's own review history names):
 *
 *   1. removing a script's only caller — its `pnpm` entry, here, since that is the only
 *      caller a script gains in this fixture — makes the census fail, naming that script.
 *   2. naming that same script in EXEMPT, with a reason, is what suppresses the failure —
 *      not silence, not a passing script by coincidence.
 *
 * A third case matches the trap #705 warned about by name: "an exemption list that nothing
 * consults is the same defect wearing different clothes." An EXEMPT entry naming a file that
 * does not exist in scripts/ has to fail loudly too, or the census could carry a stale entry
 * forever without anyone noticing it stopped referring to anything.
 *
 * #709's review found the first cut of this check too wide: it matched a script's filename
 * as a plain substring anywhere in `package.json` or a workflow, so a YAML comment or a
 * dead `echo scripts/x.mjs` counted as a caller exactly like a real invocation. The four
 * cases below prove the narrowed check both ways — a mention that never executes must not
 * satisfy it, and a genuine invocation must — plus that an EXEMPT entry with no reason fails
 * the same way a stale one does.
 */
const ROOT = process.cwd();
const SCRIPT = "scripts/verify-every-script-has-a-caller.mjs";

/** A copy of scripts/, package.json, and .github/workflows/ — not a git clone, so this
 * measures the working tree's own wiring, uncommitted changes included. */
const scratchRepo = (): string => {
  const dir = join(tempDir("acp-script-callers-"), "repo");
  mkdirSync(join(dir, ".github"), { recursive: true });
  cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
  cpSync(join(ROOT, ".github", "workflows"), join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, "package.json"), readFileSync(join(ROOT, "package.json")));
  return dir;
};

const run = (dir: string): { status: number | null; stdout: string; stderr: string } => {
  const done = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
};

/** Removes one script's only caller: its `pnpm` entry in package.json. The workflow files are
 * left untouched, so a script that is genuinely reached only via package.json (true of most
 * of them — see #705's report) becomes reached by nothing at all. */
const dropPackageJsonCaller = (dir: string, scriptFilename: string): void => {
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const entry = Object.entries(pkg.scripts as Record<string, string>).find(([, command]) =>
    command.includes(`scripts/${scriptFilename}`),
  );
  if (!entry) {
    throw new Error(
      `fixture assumption broke: no package.json script currently invokes scripts/${scriptFilename}`,
    );
  }
  delete pkg.scripts[entry[0]];
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
};

const addExemption = (dir: string, scriptFilename: string, reason: string): void => {
  const checkerPath = join(dir, SCRIPT);
  const source = readFileSync(checkerPath, "utf8");
  const marker = "const EXEMPT = {";
  const at = source.indexOf(marker);
  if (at === -1) throw new Error("fixture assumption broke: EXEMPT declaration not found");
  const insertAt = at + marker.length;
  writeFileSync(
    checkerPath,
    `${source.slice(0, insertAt)}\n  "${scriptFilename}": ${JSON.stringify(reason)},${source.slice(insertAt)}`,
  );
};

/** Appends a line to the copied ci.yml that mentions a script's filename without executing
 * it: either a YAML comment, or a `run:` step whose command only echoes the name rather than
 * invoking it. Both are the exact shape #709's review found the substring-based check
 * treating as a caller. */
const injectDeadMention = (dir: string, scriptFilename: string, style: "comment" | "echo"): void => {
  const workflowPath = join(dir, ".github", "workflows", "ci.yml");
  const source = readFileSync(workflowPath, "utf8");
  const line =
    style === "comment"
      ? `      # a stray mention, never executed: scripts/${scriptFilename}`
      : `      - run: echo scripts/${scriptFilename} is deprecated`;
  writeFileSync(workflowPath, `${source}\n${line}\n`);
};

/** Appends a real `run:` step to the copied ci.yml that directly invokes a script — the
 * genuine-invocation counterpart to `injectDeadMention`, proving the check still recognizes
 * a caller that actually runs the thing. */
const injectRealInvocation = (dir: string, scriptFilename: string): void => {
  const workflowPath = join(dir, ".github", "workflows", "ci.yml");
  const source = readFileSync(workflowPath, "utf8");
  writeFileSync(workflowPath, `${source}\n      - run: node scripts/${scriptFilename}\n`);
};

// A script this fixture is free to pick on: it must currently be reached through
// package.json alone (no workflow reference), so dropping its one caller leaves it with
// none. `verify-tx-denial-sites.mjs` — wired in this same PR — fits: `guards:tx-denials`
// is its only caller, and it is never named directly in any workflow `run:` step.
const TARGET_SCRIPT = "verify-tx-denial-sites.mjs";

describe("the every-script-has-a-caller census", () => {
  it("passes on the working tree as it stands", () => {
    const done = run(scratchRepo());

    expect(done.stdout).toContain("orphaned");
    expect(done.status).toBe(0);
  });

  it("fails when a script's only caller is removed", () => {
    const dir = scratchRepo();
    dropPackageJsonCaller(dir, TARGET_SCRIPT);

    const done = run(dir);

    expect(done.stderr).toContain(`scripts/${TARGET_SCRIPT}`);
    expect(done.stderr).toContain("no caller");
    expect(done.status).toBe(1);
  });

  it("is suppressed by naming the same script in EXEMPT, with a reason", () => {
    const dir = scratchRepo();
    dropPackageJsonCaller(dir, TARGET_SCRIPT);
    addExemption(dir, TARGET_SCRIPT, "probe: fixture-only exemption, not a real one");

    const done = run(dir);

    expect(done.stdout).toContain(`scripts/${TARGET_SCRIPT}`);
    expect(done.stdout).toContain("fixture-only exemption");
    expect(done.status).toBe(0);
  });

  it("fails on a stale EXEMPT entry naming a file that is not in scripts/", () => {
    const dir = scratchRepo();
    addExemption(dir, "census-probe-does-not-exist.mjs", "this file was never real");

    const done = run(dir);

    expect(done.stderr).toContain("census-probe-does-not-exist.mjs");
    expect(done.stderr).toContain("stale");
    expect(done.status).toBe(1);
  });

  it("is not satisfied by a comment mentioning the script's filename", () => {
    const dir = scratchRepo();
    dropPackageJsonCaller(dir, TARGET_SCRIPT);
    injectDeadMention(dir, TARGET_SCRIPT, "comment");

    const done = run(dir);

    // A stray comment must not be counted as a caller — the census still reports the
    // script as orphaned, not wired via .github/workflows.
    expect(done.stderr).toContain(`scripts/${TARGET_SCRIPT}`);
    expect(done.stderr).toContain("no caller");
    expect(done.status).toBe(1);
  });

  it("is not satisfied by a dead `echo` of the script's filename", () => {
    const dir = scratchRepo();
    dropPackageJsonCaller(dir, TARGET_SCRIPT);
    injectDeadMention(dir, TARGET_SCRIPT, "echo");

    const done = run(dir);

    // `echo scripts/x.mjs` mentions the name but never runs it — same requirement as the
    // comment case, proven separately since the two are different code paths in the fix.
    expect(done.stderr).toContain(`scripts/${TARGET_SCRIPT}`);
    expect(done.stderr).toContain("no caller");
    expect(done.status).toBe(1);
  });

  it("is satisfied by a genuine direct invocation once the package.json caller is gone", () => {
    const dir = scratchRepo();
    dropPackageJsonCaller(dir, TARGET_SCRIPT);
    injectRealInvocation(dir, TARGET_SCRIPT);

    const done = run(dir);

    // The counterpart to the two cases above: an actual `run: node scripts/x.mjs` step
    // does count, so the negative results above are about position, not about the census
    // being unable to see workflow-based callers at all. A confirmed caller prints nothing
    // by name (only the unconfirmed ones are listed), so the proof is a clean pass with no
    // "no caller" failure line anywhere in the output.
    expect(done.stderr).not.toContain("no caller");
    expect(done.stdout).toContain("orphaned");
    expect(done.status).toBe(0);
  });

  it("fails on an EXEMPT entry with an empty reason", () => {
    const dir = scratchRepo();
    dropPackageJsonCaller(dir, TARGET_SCRIPT);
    addExemption(dir, TARGET_SCRIPT, "");

    const done = run(dir);

    // An exemption that records no reason is the same trap as a stale one: it looks like
    // coverage and lets nobody check it later.
    expect(done.stderr).toContain(`${TARGET_SCRIPT}`);
    expect(done.stderr.toLowerCase()).toContain("empty");
    expect(done.status).toBe(1);
  });
});

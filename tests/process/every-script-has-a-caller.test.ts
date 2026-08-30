import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #705 — `verify-reason-codes.mjs` was correct and reachable from nowhere. The census keeps
 * that from recurring by following executable positions in workflows and package commands,
 * and child-process calls in the test suite CI already runs. This file proves those paths and
 * the limits the census reports rather than treating any filename mention as execution.
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
 * #709's review supplied three more counterexamples: interpreter arguments that are not the
 * executed file, omitted `.sh`/`.py`/extensionless children, and package reachability
 * propagated from callee to caller. Each has a named regression below. The four production
 * entrypoints the review found under `pnpm test` are also required to report their test files.
 */
const ROOT = process.cwd();
const SCRIPT = "scripts/verify-every-script-has-a-caller.mjs";

/** A copy of scripts/, tests/, package.json, and .github/workflows/ — not a git clone, so this
 * measures the working tree's own wiring, uncommitted changes included. */
const scratchRepo = (): string => {
  const dir = join(tempDir("acp-script-callers-"), "repo");
  mkdirSync(join(dir, ".github"), { recursive: true });
  cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
  cpSync(join(ROOT, "tests"), join(dir, "tests"), { recursive: true });
  cpSync(join(ROOT, ".github", "workflows"), join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, "package.json"), readFileSync(join(ROOT, "package.json")));
  writeFileSync(join(dir, "vitest.config.ts"), readFileSync(join(ROOT, "vitest.config.ts")));
  return dir;
};

const run = (dir: string, args: string[] = []): { status: number | null; stdout: string; stderr: string } => {
  const done = spawnSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
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

/** Appends a line to the copied ci.yml that mentions a script's filename without executing it. */
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

const injectWorkflowCommand = (dir: string, command: string): void => {
  const workflowPath = join(dir, ".github", "workflows", "ci.yml");
  const source = readFileSync(workflowPath, "utf8");
  writeFileSync(workflowPath, `${source}\n      - run: ${command}\n`);
};

const addPackageScript = (dir: string, name: string, command: string): void => {
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.scripts[name] = command;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
};

const addScript = (dir: string, name: string): void => {
  writeFileSync(join(dir, "scripts", name), "exit 0\n");
};

type Caller =
  | { type: "workflow"; file: string; ciReachable: boolean }
  | { type: "package.json"; script: string; ciReachable: boolean }
  | { type: "test"; file: string; ciReachable: boolean };

type Census = {
  wired: Array<{ name: string; callers: Caller[]; ciConfirmed: boolean }>;
  withoutDetectedCaller: string[];
  limitations: string[];
};

const runJson = (dir: string): Census => {
  const done = run(dir, ["--json"]);
  expect(done.status, done.stderr).toBe(0);
  return JSON.parse(done.stdout) as Census;
};

// A package-only script with no workflow or suite caller, so dropping that alias leaves the
// fixture with no statically detectable execution path.
const TARGET_SCRIPT = "close-with-evidence.mjs";

describe("the every-script-has-a-caller census", () => {
  it("passes on the working tree as it stands", () => {
    const done = run(scratchRepo());

    expect(done.stdout).toContain("0 without a statically detected caller");
    expect(done.stdout).toContain("paths assembled at runtime");
    expect(done.status).toBe(0);
  });

  it("fails when a script's only caller is removed", () => {
    const dir = scratchRepo();
    dropPackageJsonCaller(dir, TARGET_SCRIPT);

    const done = run(dir);

    expect(done.stderr).toContain(`scripts/${TARGET_SCRIPT}`);
    expect(done.stderr).toContain("no statically detected caller");
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

    // A stray comment must not be counted as a caller.
    expect(done.stderr).toContain(`scripts/${TARGET_SCRIPT}`);
    expect(done.stderr).toContain("no statically detected caller");
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
    expect(done.stderr).toContain("no statically detected caller");
    expect(done.status).toBe(1);
  });

  it("is satisfied by a genuine direct invocation once the package.json caller is gone", () => {
    const dir = scratchRepo();
    dropPackageJsonCaller(dir, TARGET_SCRIPT);
    injectRealInvocation(dir, TARGET_SCRIPT);

    const done = run(dir);

    // The counterpart to the two cases above: an actual `run: node scripts/x.mjs` step
    // does count, so the negative results above are about position, not about the census
    // being unable to see workflow-based callers at all.
    expect(done.stderr).not.toContain("no statically detected caller");
    expect(done.stdout).toContain("0 without a statically detected caller");
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

  it("rejects interpreter arguments that are not executable positions", () => {
    const dir = scratchRepo();
    dropPackageJsonCaller(dir, TARGET_SCRIPT);
    injectWorkflowCommand(dir, `node --eval 0 scripts/${TARGET_SCRIPT}`);
    injectWorkflowCommand(dir, `sh -c true scripts/${TARGET_SCRIPT}`);
    injectWorkflowCommand(dir, `npx echo scripts/${TARGET_SCRIPT}`);

    const done = run(dir);

    expect(done.stderr).toContain(`scripts/${TARGET_SCRIPT}`);
    expect(done.stderr).toContain("no statically detected caller");
    expect(done.status).toBe(1);
  });

  it("finds shell Python and extensionless orphan scripts", () => {
    const dir = scratchRepo();
    const names = ["census-probe.sh", "census-probe.py", "census-probe"];
    for (const name of names) addScript(dir, name);

    const done = run(dir);

    for (const name of names) expect(done.stderr).toContain(`scripts/${name}`);
    expect(done.status).toBe(1);
  });

  it("classifies the four existing suite entrypoints as test callers", () => {
    const census = runJson(scratchRepo());
    const expected = new Map([
      ["verify-tx-denial-sites.mjs", "tests/process/the-tx-denial-census-sees-a-write-then-deny.test.ts"],
      ["verify-release-version.mjs", "tests/unit/release-version.test.ts"],
      ["verify-enforcement-symbols.mjs", "tests/unit/enforcement-symbols.test.ts"],
      ["verify-acceptance-adapter-source.mjs", "tests/unit/acceptance-adapter-source.test.ts"],
    ]);

    for (const [name, file] of expected) {
      const entry = census.wired.find((item) => item.name === name);
      expect(entry?.callers).toContainEqual({ type: "test", file, ciReachable: true });
      expect(entry?.ciConfirmed).toBe(true);
    }
    expect(census.limitations.join(" ")).toContain("paths assembled at runtime");
  });

  it("counts a literal test child process as a caller", () => {
    const dir = scratchRepo();
    const name = "test-caller-probe.sh";
    addScript(dir, name);
    const testPath = join(dir, "tests", "process", "static-script-caller.test.ts");
    writeFileSync(
      testPath,
      `import { spawnSync } from "node:child_process";\n` +
        `const script = "scripts/${name}";\n` +
        `spawnSync("sh", [script], { encoding: "utf8" });\n`,
    );

    const census = runJson(dir);
    const entry = census.wired.find((item) => item.name === name);
    expect(entry?.callers).toContainEqual({
      type: "test",
      file: "tests/process/static-script-caller.test.ts",
      ciReachable: true,
    });
  });

  it("does not propagate CI reachability from callee back to an unused caller", () => {
    const dir = scratchRepo();
    const name = "reverse-graph-probe.sh";
    addScript(dir, name);
    addPackageScript(dir, "unused-reverse-probe", `sh scripts/${name} && pnpm scripts:callers`);

    const census = runJson(dir);
    const entry = census.wired.find((item) => item.name === name);
    expect(entry?.callers).toContainEqual({
      type: "package.json",
      script: "unused-reverse-probe",
      ciReachable: false,
    });
    expect(entry?.ciConfirmed).toBe(false);
  });

  it("propagates CI reachability from a package caller to its callee", () => {
    const dir = scratchRepo();
    const name = "forward-graph-probe.sh";
    addScript(dir, name);
    addPackageScript(dir, "forward-graph-inner", `sh scripts/${name}`);
    addPackageScript(dir, "forward-graph-outer", "pnpm forward-graph-inner");
    injectWorkflowCommand(dir, "pnpm forward-graph-outer");

    const census = runJson(dir);
    const entry = census.wired.find((item) => item.name === name);
    expect(entry?.callers).toContainEqual({
      type: "package.json",
      script: "forward-graph-inner",
      ciReachable: true,
    });
    expect(entry?.ciConfirmed).toBe(true);
  });

  it("uses any CI reached package alias for a multiply aliased script", () => {
    const census = runJson(scratchRepo());
    const entry = census.wired.find((item) => item.name === "build-native-peercred.mjs");

    expect(entry?.callers).toContainEqual({
      type: "package.json",
      script: "postinstall",
      ciReachable: false,
    });
    expect(entry?.callers).toContainEqual({
      type: "package.json",
      script: "native:peercred:build",
      ciReachable: true,
    });
    expect(entry?.ciConfirmed).toBe(true);
  });
});

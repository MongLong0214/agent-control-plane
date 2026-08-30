import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #705 — `verify-reason-codes.mjs` was correct and reachable from nowhere. This census keeps a
 * deliberately narrower inventory: every direct script has a statically plausible invocation
 * site or an exemption. It does not claim that a site executes. These tests require its output,
 * comments, data, and test names to preserve that one sentence.
 *
 *   1. removing a script's only plausible site — its `pnpm` entry in this fixture — makes the
 *      census fail, naming that script.
 *   2. naming that same script in EXEMPT, with a reason, is what suppresses the failure —
 *      not silence, not a passing script by coincidence.
 *
 * A third case matches the trap #705 warned about by name: "an exemption list that nothing
 * consults is the same defect wearing different clothes." An EXEMPT entry naming a file that
 * does not exist in scripts/ has to fail loudly too, or the census could carry a stale entry
 * forever without anyone noticing it stopped referring to anything.
 *
 * #709's reviews supplied interpreter operands, direct-child extensions, graph direction, and
 * test reachability counterexamples. A skipped test and a local fake named `spawnSync` are still
 * plausible text shapes but cannot prove execution. The paired regressions run synthetic Vitest
 * files: the skipped and fake sites leave their marker absent, while a real spawn writes it. The
 * census must report all three static sites as execution-unproven instead of inventing certainty.
 */
const ROOT = process.cwd();
const SCRIPT = "scripts/verify-every-script-has-a-plausible-caller.mjs";
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");

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

/** Removes one script's only plausible site: its `pnpm` entry in package.json. */
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

/** Appends command-shaped `run:` text to the copied ci.yml. The census recognizes its static
 * position but deliberately does not claim the workflow or command will execute. */
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

type PlausibleSite =
  | { type: "workflow"; file: string; plausibleCiRoute: boolean; execution: "unproven" }
  | { type: "package.json"; script: string; plausibleCiRoute: boolean; execution: "unproven" }
  | { type: "test"; file: string; plausibleCiRoute: boolean; execution: "unproven" };

type Census = {
  claim: string;
  withPlausibleSites: Array<{
    name: string;
    plausibleSites: PlausibleSite[];
    plausibleCiRoute: boolean;
  }>;
  withoutPlausibleSite: string[];
  limitations: string[];
  remainingWork: string;
};

const runJson = (dir: string): Census => {
  const done = run(dir, ["--json"]);
  expect(done.status, done.stderr).toBe(0);
  return JSON.parse(done.stdout) as Census;
};

const runFixtureTest = (
  dir: string,
  testFile: string,
  marker: string,
): { status: number | null; stdout: string; stderr: string } => {
  const nodeModules = join(dir, "node_modules");
  if (!existsSync(nodeModules)) symlinkSync(join(ROOT, "node_modules"), nodeModules, "dir");
  const done = spawnSync(process.execPath, [VITEST, "run", testFile, "--config", "vitest.config.ts"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, CI: "", ACP_SCRIPT_CALLER_MARKER: marker },
  });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
};

const addMarkerScript = (dir: string, name: string): string => {
  const marker = join(dir, `${name}.entered`);
  writeFileSync(
    join(dir, "scripts", name),
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(process.env.ACP_SCRIPT_CALLER_MARKER, "entered\\n");\n`,
  );
  return marker;
};

// A package-only script with no workflow or suite site, so dropping that alias leaves the
// fixture with no statically plausible invocation site.
const TARGET_SCRIPT = "close-with-evidence.mjs";

describe("the every-script-has-a-plausible-caller census", () => {
  it("passes on the working tree as it stands", () => {
    const done = run(scratchRepo());

    expect(done.stdout).toContain("0 without a statically plausible site");
    expect(done.stdout).toContain(
      "Every regular direct child of scripts/ has at least one statically plausible invocation site, or a named exemption.",
    );
    expect(done.stdout).toContain("Static analysis does not prove execution");
    expect(done.stdout).toContain("it.skip");
    expect(done.stdout).toContain("issue #705");
    expect(done.status).toBe(0);
  });

  it("fails when a script's only plausible site is removed", () => {
    const dir = scratchRepo();
    dropPackageJsonCaller(dir, TARGET_SCRIPT);

    const done = run(dir);

    expect(done.stderr).toContain(`scripts/${TARGET_SCRIPT}`);
    expect(done.stderr).toContain("no statically plausible invocation site");
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

  it("does not treat a comment as a plausible invocation site", () => {
    const dir = scratchRepo();
    dropPackageJsonCaller(dir, TARGET_SCRIPT);
    injectDeadMention(dir, TARGET_SCRIPT, "comment");

    const done = run(dir);

    // A stray comment is not even a plausible invocation site.
    expect(done.stderr).toContain(`scripts/${TARGET_SCRIPT}`);
    expect(done.stderr).toContain("no statically plausible invocation site");
    expect(done.status).toBe(1);
  });

  it("does not treat a dead echo as a plausible invocation site", () => {
    const dir = scratchRepo();
    dropPackageJsonCaller(dir, TARGET_SCRIPT);
    injectDeadMention(dir, TARGET_SCRIPT, "echo");

    const done = run(dir);

    // `echo scripts/x.mjs` mentions the name but never runs it — same requirement as the
    // comment case, proven separately since the two are different code paths in the fix.
    expect(done.stderr).toContain(`scripts/${TARGET_SCRIPT}`);
    expect(done.stderr).toContain("no statically plausible invocation site");
    expect(done.status).toBe(1);
  });

  it("counts a workflow command shaped invocation as a plausible site", () => {
    const dir = scratchRepo();
    dropPackageJsonCaller(dir, TARGET_SCRIPT);
    injectRealInvocation(dir, TARGET_SCRIPT);

    const done = run(dir);

    // This establishes only that the static census recognizes the command position. Its
    // mandatory limit still refuses to claim that the workflow reaches or executes the step.
    expect(done.stderr).not.toContain("no statically plausible invocation site");
    expect(done.stdout).toContain("0 without a statically plausible site");
    expect(done.stdout).toContain("Static analysis does not prove execution");
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

  it("rejects interpreter arguments that are not plausible entrypoint positions", () => {
    const dir = scratchRepo();
    dropPackageJsonCaller(dir, TARGET_SCRIPT);
    injectWorkflowCommand(dir, `node --eval 0 scripts/${TARGET_SCRIPT}`);
    injectWorkflowCommand(dir, `sh -c true scripts/${TARGET_SCRIPT}`);
    injectWorkflowCommand(dir, `npx echo scripts/${TARGET_SCRIPT}`);

    const done = run(dir);

    expect(done.stderr).toContain(`scripts/${TARGET_SCRIPT}`);
    expect(done.stderr).toContain("no statically plausible invocation site");
    expect(done.status).toBe(1);
  });

  it("finds shell Python and extensionless scripts with no plausible site", () => {
    const dir = scratchRepo();
    const names = ["census-probe.sh", "census-probe.py", "census-probe"];
    for (const name of names) addScript(dir, name);

    const done = run(dir);

    for (const name of names) expect(done.stderr).toContain(`scripts/${name}`);
    expect(done.status).toBe(1);
  });

  it("reports four existing suite spawn sites as execution unproven", () => {
    const census = runJson(scratchRepo());
    const expected = new Map([
      ["verify-tx-denial-sites.mjs", "tests/process/the-tx-denial-census-sees-a-write-then-deny.test.ts"],
      ["verify-release-version.mjs", "tests/unit/release-version.test.ts"],
      ["verify-enforcement-symbols.mjs", "tests/unit/enforcement-symbols.test.ts"],
      ["verify-acceptance-adapter-source.mjs", "tests/unit/acceptance-adapter-source.test.ts"],
    ]);

    for (const [name, file] of expected) {
      const entry = census.withPlausibleSites.find((item) => item.name === name);
      expect(entry?.plausibleSites).toContainEqual({
        type: "test",
        file,
        plausibleCiRoute: true,
        execution: "unproven",
      });
      expect(entry?.plausibleCiRoute).toBe(true);
    }
    expect(census.limitations.join(" ")).toContain("Static analysis does not prove execution");
  });

  it("reports a skipped spawn as execution unproven", () => {
    const dir = scratchRepo();
    const name = "skipped-spawn-probe.mjs";
    const marker = addMarkerScript(dir, name);
    const testFile = "tests/process/skipped-spawn-probe.test.ts";
    writeFileSync(
      join(dir, testFile),
      `import { it } from "vitest";\n` +
        `import { spawnSync } from "node:child_process";\n` +
        `import { join } from "node:path";\n` +
        `it.skip("does not enter the script", () => {\n` +
        `  const script = join(process.cwd(), "scripts", "${name}");\n` +
        `  spawnSync(process.execPath, [script], { encoding: "utf8" });\n` +
        `});\n`,
    );

    const nested = runFixtureTest(dir, testFile, marker);
    expect(nested.status, `${nested.stdout}\n${nested.stderr}`).toBe(0);
    expect(existsSync(marker)).toBe(false);

    const census = runJson(dir);
    const entry = census.withPlausibleSites.find((item) => item.name === name);
    expect(entry?.plausibleSites).toContainEqual({
      type: "test",
      file: testFile,
      plausibleCiRoute: true,
      execution: "unproven",
    });
    expect(census.limitations.join(" ")).toContain("it.skip");
  });

  it("reports a local fake spawn as execution unproven", () => {
    const dir = scratchRepo();
    const name = "fake-spawn-probe.mjs";
    const marker = addMarkerScript(dir, name);
    const testFile = "tests/process/fake-spawn-probe.test.ts";
    writeFileSync(
      join(dir, testFile),
      `import { expect, it } from "vitest";\n` +
        `import { join } from "node:path";\n` +
        `const spawnSync = (_command: string, _argv: string[]) => ({ status: 0 });\n` +
        `it("calls only the local fake", () => {\n` +
        `  const script = join(process.cwd(), "scripts", "${name}");\n` +
        `  expect(spawnSync(process.execPath, [script]).status).toBe(0);\n` +
        `});\n`,
    );

    const nested = runFixtureTest(dir, testFile, marker);
    expect(nested.status, `${nested.stdout}\n${nested.stderr}`).toBe(0);
    expect(existsSync(marker)).toBe(false);

    const census = runJson(dir);
    const entry = census.withPlausibleSites.find((item) => item.name === name);
    expect(entry?.plausibleSites).toContainEqual({
      type: "test",
      file: testFile,
      plausibleCiRoute: true,
      execution: "unproven",
    });
    expect(census.limitations.join(" ")).toContain("import origin");
  });

  it("counts a real spawn as plausible and leaves execution unproven", () => {
    const dir = scratchRepo();
    const name = "real-spawn-probe.mjs";
    const marker = addMarkerScript(dir, name);
    const testFile = "tests/process/real-spawn-probe.test.ts";
    writeFileSync(
      join(dir, testFile),
      `import { expect, it } from "vitest";\n` +
        `import { spawnSync } from "node:child_process";\n` +
        `import { join } from "node:path";\n` +
        `it("enters the script", () => {\n` +
        `  const script = join(process.cwd(), "scripts", "${name}");\n` +
        `  expect(spawnSync(process.execPath, [script], { encoding: "utf8" }).status).toBe(0);\n` +
        `});\n`,
    );

    const nested = runFixtureTest(dir, testFile, marker);
    expect(nested.status, `${nested.stdout}\n${nested.stderr}`).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("entered\n");

    const census = runJson(dir);
    const entry = census.withPlausibleSites.find((item) => item.name === name);
    expect(entry?.plausibleSites).toContainEqual({
      type: "test",
      file: testFile,
      plausibleCiRoute: true,
      execution: "unproven",
    });
  });

  it("does not propagate a plausible CI route from callee back to an unused package site", () => {
    const dir = scratchRepo();
    const name = "reverse-graph-probe.sh";
    addScript(dir, name);
    addPackageScript(dir, "unused-reverse-probe", `sh scripts/${name} && pnpm scripts:plausible-callers`);

    const census = runJson(dir);
    const entry = census.withPlausibleSites.find((item) => item.name === name);
    expect(entry?.plausibleSites).toContainEqual({
      type: "package.json",
      script: "unused-reverse-probe",
      plausibleCiRoute: false,
      execution: "unproven",
    });
    expect(entry?.plausibleCiRoute).toBe(false);
  });

  it("propagates a plausible CI route from a package site to its callee", () => {
    const dir = scratchRepo();
    const name = "forward-graph-probe.sh";
    addScript(dir, name);
    addPackageScript(dir, "forward-graph-inner", `sh scripts/${name}`);
    addPackageScript(dir, "forward-graph-outer", "pnpm forward-graph-inner");
    injectWorkflowCommand(dir, "pnpm forward-graph-outer");

    const census = runJson(dir);
    const entry = census.withPlausibleSites.find((item) => item.name === name);
    expect(entry?.plausibleSites).toContainEqual({
      type: "package.json",
      script: "forward-graph-inner",
      plausibleCiRoute: true,
      execution: "unproven",
    });
    expect(entry?.plausibleCiRoute).toBe(true);
  });

  it("uses any plausibly CI routed package alias for a multiply aliased script", () => {
    const census = runJson(scratchRepo());
    const entry = census.withPlausibleSites.find((item) => item.name === "build-native-peercred.mjs");

    expect(entry?.plausibleSites).toContainEqual({
      type: "package.json",
      script: "postinstall",
      plausibleCiRoute: false,
      execution: "unproven",
    });
    expect(entry?.plausibleSites).toContainEqual({
      type: "package.json",
      script: "native:peercred:build",
      plausibleCiRoute: true,
      execution: "unproven",
    });
    expect(entry?.plausibleCiRoute).toBe(true);
  });
});

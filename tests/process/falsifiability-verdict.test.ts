import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterEach(cleanupTempDirs);

const run = (statuses: string[], exitCode: number, options: {
  success?: boolean; names?: string[]; file?: string; selector?: string; missing?: boolean;
  malformed?: boolean; noRunner?: boolean; realVitest?: boolean;
  compiler?: "missing" | "signaled";
  target?: string; original?: string; find?: string; replace?: string;
} = {}) => {
  const root = realpathSync(tempDir("acp-mutation-verdict-"));
  const put = (path: string, body: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  // Exercise the working runner through its real report path and output, including restoration.
  for (const path of ["scripts/verify-guards-are-falsifiable.mjs", "scripts/run-vitest-gate.mjs",
    "scripts/lib/falsifiability-cases.mjs", "scripts/verify-enforcement-symbols.mjs"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(import.meta.dirname, "../..", path), join(root, path));
  }
  const target = options.target ?? "guard.mjs";
  const original = options.original ?? "export const guard = true;\n";
  put(target, original);
  put("tests/probe.test.ts", options.realVitest ? `import { afterAll, expect, it } from "vitest";
 it("the named test", () => { expect(true).toBe(true); });
 afterAll(() => { throw new Error("intentional teardown failure"); });
` : "");
  put("tsconfig.json", JSON.stringify({ compilerOptions: { noEmit: true, types: [], skipLibCheck: true },
    files: [target] }));
  put("scripts/falsifiability-cases/probe.mjs", `const probe = ${JSON.stringify({
    id: "verdict-probe", what: "verdict probe", file: target,
    find: options.find ?? "guard = true", replace: options.replace ?? "guard = false",
    killedBy: [`tests/probe.test.ts::${options.selector ?? "the named test"}`],
  })};\nexport default probe;\n`);
  const failed = statuses.filter((status) => status === "failed").length;
  const report = {
    numTotalTestSuites: 1, numPassedTestSuites: failed ? 0 : 1,
    numFailedTestSuites: failed ? 1 : 0, numPendingTestSuites: 0,
    numTotalTests: statuses.length, numPassedTests: statuses.filter((status) => status === "passed").length,
    numFailedTests: failed, numPendingTests: statuses.filter((status) => status === "skipped").length,
    numTodoTests: 0, success: options.success ?? failed === 0,
    testResults: [{ name: join(root, options.file ?? "tests/probe.test.ts"), startTime: 100, endTime: 110,
      assertionResults: statuses.map((status, index) => ({
        fullName: options.names?.[index] ?? (index === 0 ? "suite the named test" : "suite unrelated test"), status,
      })),
    }],
  };
  if (options.realVitest) {
    symlinkSync(join(import.meta.dirname, "../../node_modules"), join(root, "node_modules"), "dir");
  } else {
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    if (options.compiler === "signaled") {
      put("node_modules/typescript/bin/tsc", 'process.kill(process.pid, "SIGTERM");\n');
    } else if (options.compiler !== "missing") {
      // The package is reachable without a .bin/tsc wrapper, as in a partially linked checkout.
      symlinkSync(join(import.meta.dirname, "../../node_modules/typescript"), join(root, "node_modules/typescript"), "dir");
    }
  }
  if (!options.realVitest && !options.noRunner) {
    // The harness supplies "run" as argv[1]; sh reads that fixture. Executing newly generated
    // runner scripts directly stalled in the local sandbox.
    symlinkSync("/bin/sh", join(root, "node_modules/.bin/vitest"));
    put("run", 'exec node ./node_modules/vitest-stub.cjs "$@"\n');
    put("node_modules/vitest-stub.cjs", `const fs = require("node:fs");
fs.writeFileSync("vitest-ran", "yes");
const path = process.argv.find((arg) => arg.startsWith("--outputFile.json=")).split("=")[1];
${options.missing ? "" : `fs.writeFileSync(path, ${JSON.stringify(options.malformed ? "{" : JSON.stringify(report))});`}
process.exit(${exitCode});
`);
  }
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "--quiet"]);
  git(["add", target]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Create guard fixture"]);
  const result = spawnSync(process.execPath, [join(root, "scripts/verify-guards-are-falsifiable.mjs"),
    "--only=verdict-probe"], { cwd: root, encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(readFileSync(join(root, target), "utf8")).toBe(original);
  expect(existsSync(join(root, ".git/verify-guards-in-flight.json"))).toBe(false);
  return { status: result.status, output: `${result.stdout}${result.stderr}`,
    ran: existsSync(join(root, "vitest-ran")), root };
};

describe("a mutation kill belongs to the named assertion", () => {
  it("refuses the real Vitest false kill: the named test passes and afterAll throws", () => {
    const result = run([], 0, { realVitest: true });
    expect(result.output).toContain("RUN FAILURE");
    expect(result.output).not.toMatch(/^  killed /m);
    expect(result.status).toBe(1);
  });

  it("recognizes Vitest's zero-execution report when the name pattern matches nothing", () => {
    const result = run([], 0, { realVitest: true, selector: "definitely-no-such-test-name-xyz" });
    expect(result.output).toContain("DEAD SELECTOR");
    expect(result.output).not.toMatch(/^  killed /m);
    expect(result.status).toBe(1);
  });

  it.each([false, true])("refuses a nonzero exit with zero failed assertions: success=%s", (success) => {
    const result = run(["passed"], 1, { success });
    expect(result.output).not.toMatch(/^  killed /m);
    expect(result.output).toContain("RUN FAILURE");
    expect(result.status).toBe(1);
  });

  it("does not credit an unrelated failed assertion in the same file", () => {
    const result = run(["passed", "failed"], 1);
    expect(result.output).toContain("UNRELATED FAILURE");
    expect(result.output).not.toMatch(/^  killed /m);
    expect(result.status).toBe(1);
  });

  it("does not credit the named assertion from another file", () => {
    const result = run(["failed"], 1, { file: "tests/other.test.ts" });
    expect(result.output).not.toMatch(/^  killed /m);
    expect(result.status).toBe(1);
  });

  it("credits a failed named assertion using the same regex as the test filter", () => {
    const result = run(["passed", "failed"], 1, {
      names: ["suite the transport detaches: empty", "suite the transport detaches: partial"],
      selector: "the transport detaches: (empty|partial)",
    });
    expect(result.output).toMatch(/^  killed /m);
    expect(result.output).toContain("RESULT: PASS");
    expect(result.status).toBe(0);
  });

  it.each([{ missing: true }, { malformed: true }])("refuses an unreadable report: %j", (options) => {
    const result = run(["failed"], 1, options);
    expect(result.output).toContain("RUN FAILURE");
    expect(result.output).not.toMatch(/^  killed /m);
    expect(result.status).toBe(1);
  });

  it("refuses a selector whose named assertion was skipped", () => {
    const result = run(["skipped", "failed"], 1);
    expect(result.output).toContain("DEAD SELECTOR");
    expect(result.output).not.toMatch(/^  killed /m);
    expect(result.status).toBe(1);
  });

  it("reports a surviving witness separately from an unrelated failure", () => {
    const result = run(["passed"], 0);
    expect(result.output).toContain("SURVIVED");
    expect(result.output).not.toContain("UNRELATED FAILURE");
    expect(result.status).toBe(1);
  });

  it("refuses a test file that could not load", () => {
    const result = run([], 1, { success: false });
    expect(result.output).toContain("RUN FAILURE");
    expect(result.output).not.toMatch(/^  killed /m);
    expect(result.status).toBe(1);
  });

  it("keeps the did-not-run guard when Vitest cannot start", () => {
    const result = run(["failed"], 1, { noRunner: true });
    expect(result.output).toContain("could not run");
    expect(result.output).toContain("A run that did not happen cannot kill a guard");
    expect(result.output).not.toMatch(/^  killed /m);
    expect(result.output).not.toContain("guard(s) removed on purpose");
    expect(result.status).toBe(1);
  });

  it("refuses a missing compiler without judging the mutant or running its witness", () => {
    const result = run(["failed"], 1, { target: "guard.ts", compiler: "missing" });
    expect(result.output).toContain("COMPILER UNAVAILABLE");
    expect(result.output).toContain("could not run tsc (typescript/bin/tsc)");
    expect(result.output).toContain(`searched for typescript/bin/tsc in: ${join(result.root, "scripts/node_modules")}, ${join(result.root, "node_modules")}`);
    expect(result.output).not.toContain("mutant did not compile");
    expect(result.output).not.toContain("INVALID MUTANT");
    expect(result.output).not.toContain("COMPILED");
    expect(result.output).not.toContain("killed");
    expect(result.output).not.toContain("guard(s) removed on purpose");
    expect(result.ran).toBe(false);
    expect(result.status).toBe(1);
  });

  it("refuses an interrupted compiler without judging the mutant or running its witness", () => {
    const result = run(["failed"], 1, { target: "guard.ts", compiler: "signaled" });
    expect(result.output).toContain("COMPILER UNAVAILABLE");
    expect(result.output).toContain("terminated by signal SIGTERM");
    expect(result.output).not.toContain("mutant did not compile");
    expect(result.output).not.toContain("killed");
    expect(result.output).not.toContain("guard(s) removed on purpose");
    expect(result.ran).toBe(false);
    expect(result.status).toBe(1);
  });

  it.each([
    { target: "guard.mjs", original: "export const guard = true;\n", find: "true", replace: "(" },
    { target: "guard.ts", original: "export const guard: boolean = true;\n", find: "true", replace: '"wrong type"' },
  ])("refuses an invalid mutant before running its witness: $target", (options) => {
    const result = run(["failed"], 1, options);
    expect(result.output).toContain("INVALID MUTANT");
    expect(result.output).toContain("unusable row: mutant did not compile");
    expect(result.output).not.toContain("COMPILER UNAVAILABLE");
    expect(result.output).not.toMatch(/^  killed /m);
    expect(result.ran).toBe(false);
    expect(result.status).toBe(1);
  });

  it("accepts a TypeScript mutant that compiles and fails its named witness", () => {
    const result = run(["failed"], 1, { target: "guard.ts" });
    expect(existsSync(join(result.root, "node_modules/.bin/tsc"))).toBe(false);
    expect(result.output).toContain("COMPILED");
    expect(result.output).toMatch(/^  killed /m);
    expect(result.ran).toBe(true);
    expect(result.status).toBe(0);
  });

  it.each([0, 2])("requires exactly one anchor in the verdict path: %s occurrences", (count) => {
    const result = run(["failed"], 1, { original: "// guard = true\n".repeat(count) });
    expect(result.output).toContain(count === 0 ? "no longer matches" : "matches 2 places");
    expect(result.output).not.toMatch(/^  killed /m);
    expect(result.ran).toBe(false);
    expect(result.status).toBe(1);
  });
});

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterEach(cleanupTempDirs);

const run = (statuses: string[], exitCode: number, options: {
  success?: boolean; names?: string[]; file?: string; selector?: string; missing?: boolean;
} = {}) => {
  const root = realpathSync(tempDir("acp-mutation-verdict-"));
  const put = (path: string, body: string, executable = false) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, { mode: executable ? 0o755 : 0o644 });
  };
  // Exercise the working runner through its real report path and output, including restoration.
  for (const path of ["scripts/verify-guards-are-falsifiable.mjs", "scripts/run-vitest-gate.mjs",
    "scripts/lib/falsifiability-cases.mjs", "scripts/verify-enforcement-symbols.mjs"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(import.meta.dirname, "../..", path), join(root, path));
  }
  put("guard.txt", "guard present\n");
  put("tests/probe.test.ts", "");
  put("scripts/falsifiability-cases/probe.mjs", `const probe = ${JSON.stringify({
    id: "verdict-probe", what: "verdict probe", file: "guard.txt", find: "guard present", replace: "guard absent",
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
  put("node_modules/.bin/vitest", `#!${process.execPath}
const fs = require("node:fs");
const path = process.argv.find((arg) => arg.startsWith("--outputFile.json=")).split("=")[1];
${options.missing ? "" : `fs.writeFileSync(path, ${JSON.stringify(JSON.stringify(report))});`}
process.exit(${exitCode});
`, true);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "--quiet"]);
  git(["add", "guard.txt"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Create guard fixture"]);
  const result = spawnSync(process.execPath, [join(root, "scripts/verify-guards-are-falsifiable.mjs"),
    "--only=verdict-probe"], { cwd: root, encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(readFileSync(join(root, "guard.txt"), "utf8")).toBe("guard present\n");
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

describe("a mutation kill belongs to the named assertion", () => {
  it.each([false, true])("refuses a nonzero exit with zero failed assertions: success=%s", (success) => {
    const result = run(["passed"], 1, { success });
    expect(result.output).not.toMatch(/^  killed /m);
    expect(result.output).toContain("RUN FAILURE");
    expect(result.status).toBe(1);
  });

  it("does not credit an unrelated failed assertion in the same file", () => {
    const result = run(["passed", "failed"], 1);
    expect(result.output).toContain("SURVIVED");
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

  it("refuses a missing report", () => {
    const result = run(["failed"], 1, { missing: true });
    expect(result.output).not.toMatch(/^  killed /m);
    expect(result.status).toBe(1);
  });

  it("refuses a selector whose named assertion was skipped", () => {
    const result = run(["skipped", "failed"], 1);
    expect(result.output).toContain("DEAD SELECTOR");
    expect(result.output).not.toMatch(/^  killed /m);
    expect(result.status).toBe(1);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";

/**
 * The gate that refuses a bounded child whose budget cannot fire inside its own case.
 *
 * Every case here runs the real script against a fixture tree rather than against `tests/`, for
 * the reason the sibling census gives about its own `--root=`: without it the only way to show
 * this gate can fail is to put a failing call into a real test file, and a gate that has never
 * been shown to fail is a gate nobody has measured.
 *
 * The fixture supplies only the test files. The two numbers the script compares against — the
 * helper's `CHILD_BUDGET_MS` and the config's `testTimeout` — are deliberately read from the real
 * repository in both modes, because they are the authority the rule is about; a fixture that
 * supplied its own copies would be checking the fixture.
 */
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repositoryRoot, "scripts", "verify-child-budgets-fit-their-cases.mjs");
const QUICK_CHILD_BUDGET_MS = 10_000;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "acp-child-budget-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
  return root;
};

const run = (root: string) =>
  boundedSpawnSync(process.execPath, [script, `--root=${root}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: QUICK_CHILD_BUDGET_MS,
  });

/** The import is what makes a name a wrapper here, so every fixture that means one writes it. */
const IMPORT = `import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";\n`;

it("refuses the default budget inside a case that declares less than it", () => {
  const root = fixture({
    "process/narrow-case.test.ts":
      IMPORT +
      `it("does a thing", () => {\n` +
      `  boundedSpawnSync("true", []);\n` +
      `}, 20_000);\n`,
  });

  const done = run(root);

  expect(done.stdout).toContain("process/narrow-case.test.ts:3");
  expect(done.stdout).toContain("takes the default 55000ms inside a case that allows 20000ms");
  expect(done.status).toBe(1);
});

it("accepts the same call once it states a budget that fits", () => {
  const root = fixture({
    "process/narrow-case.test.ts":
      IMPORT +
      `it("does a thing", () => {\n` +
      `  boundedSpawnSync("true", [], { timeout: 10_000 });\n` +
      `}, 20_000);\n`,
  });

  const done = run(root);

  expect(done.stdout).toContain("RESULT: PASS");
  expect(done.status).toBe(0);
});

it("reads a case timeout written as arithmetic, rather than reporting it unreadable", () => {
  // `30 * 60 * 1000` is how the long cases in this repository spell half an hour. Before this was
  // folded, the six e2e sites under such a case were reported UNREAD while the gate said PASS —
  // uncovered and healthy-looking at the same time, which is the shape the gate exists to refuse.
  const root = fixture({
    "process/arithmetic-case.test.ts":
      IMPORT +
      `it("does a long thing", () => {\n` +
      `  boundedSpawnSync("true", []);\n` +
      `}, 30 * 60 * 1000);\n`,
  });

  const done = run(root);

  expect(done.stdout).not.toContain("UNREAD");
  expect(done.stdout).toContain("1 bounded child call(s); 1 fit their case");
  expect(done.status).toBe(0);
});

it("says it could not read a case timeout it cannot evaluate, instead of assuming it is generous", () => {
  const root = fixture({
    "process/opaque-case.test.ts":
      IMPORT +
      `import { SOME_TIMEOUT } from "./elsewhere.ts";\n` +
      `it("does a thing", () => {\n` +
      `  boundedSpawnSync("true", []);\n` +
      `}, SOME_TIMEOUT);\n`,
  });

  const done = run(root);

  // Not a failure: an unreadable ceiling is not evidence of a violation. It is reported, because
  // silently treating it as 60s would make the gate stop covering exactly the files that hid
  // their number behind a name.
  expect(done.stdout).toContain("UNREAD");
  expect(done.stdout).toContain("the case declares a timeout this check cannot read");
  expect(done.status).toBe(0);
});

it("does not read a locally defined function wearing the wrapper's name", () => {
  // The name-trusting version of this would report a violation here. `boundedSpawnSync` below is
  // an ordinary local function: it has no budget, the helper's default is not its default, and
  // reading its second argument as options would be reading a different function's shape.
  const root = fixture({
    "process/local-fake.test.ts":
      `const boundedSpawnSync = (_file: string, _argv: string[]) => ({ status: 0 });\n` +
      `it("does a thing", () => {\n` +
      `  boundedSpawnSync("true", []);\n` +
      `}, 20_000);\n`,
  });

  const done = run(root);

  expect(done.stdout).toContain("0 bounded child call(s)");
  expect(done.status).toBe(0);
});

it("counts a module-scope call as having no case to fit, rather than passing it silently", () => {
  // Module scope is the position where *no* vitest timeout can fire at all, so there is nothing to
  // compare against — but a reader has to see how much of the tree is in it, or "fits" reads as a
  // claim about the whole file.
  const root = fixture({
    "process/module-scope.test.ts": IMPORT + `const WHERE = boundedSpawnSync("true", []);\n`,
  });

  const done = run(root);

  expect(done.stdout).toContain("1 are at module scope and have no case to fit");
  expect(done.status).toBe(0);
});

it("passes on the working tree as it stands", () => {
  const done = boundedSpawnSync(process.execPath, [script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: QUICK_CHILD_BUDGET_MS,
  });

  expect(done.stdout).toContain("RESULT: PASS");
  expect(done.stdout).toContain("0 do not");
  expect(done.status).toBe(0);
});

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repositoryRoot, "scripts", "verify-stale-coordinate-literals.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "acp-stale-coordinate-"));
  roots.push(root);
  return root;
};

const write = (root: string, path: string, text: string): void => {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
};

const run = (root: string) =>
  spawnSync(process.execPath, [script, `--root=${root}`, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

const parsedReport = (result: ReturnType<typeof run>) =>
  JSON.parse(result.stdout) as {
    scanned: { tests: number; documents: number };
    findings: Array<{ kind: string; path: string }>;
  };

const parsedFindings = (result: ReturnType<typeof run>) => parsedReport(result).findings;

it("an existing production line copied into a test is rejected", () => {
  const root = fixture();
  const productionPath = "src/bootstrap/hermes-bootstrap.ts";
  write(root, productionPath, "export const bind = () => undefined;\n");
  write(
    root,
    "tests/unit/positive.test.ts",
    `const body = ${JSON.stringify(`${productionPath}:341   cp.bindings.bind({...})`)};\n`,
  );

  const result = run(root);
  expect(result.status).toBe(1);
  expect(parsedFindings(result).map((item) => item.kind)).toEqual(["test-source-line"]);
});

it("a discovered file count pinned to a literal is rejected", () => {
  const root = fixture();
  write(
    root,
    "tests/unit/corpus.test.ts",
    [
      'import { spawnSync } from "node:child_process";',
      'const listed = spawnSync("git", ["ls-files", "*.ts"]);',
      "const jsIssues = listed.stdout;",
      "expect(jsIssues).toHaveLength(254);",
      "",
    ].join("\n"),
  );

  const result = run(root);
  expect(result.status).toBe(1);
  expect(parsedFindings(result).map((item) => item.kind)).toEqual(["discovered-file-count"]);
});

it("a measured SHA is consumed by its reproduction command", () => {
  const root = fixture();
  write(
    root,
    "docs/design/census.md",
    [
      "Measured against `8622195`. The result is reproducible with",
      "`node docs/design/census.mjs --json`.",
      "",
    ].join("\n"),
  );

  const result = run(root);
  expect(result.status).toBe(1);
  expect(parsedFindings(result).map((item) => item.kind)).toEqual(["unbound-measured-ref"]);
});

it("a workflow job total copied into documentation is rejected", () => {
  const root = fixture();
  const currentTotal = ["The workflow now has", "five jobs."].join(" ");
  write(root, "docs/ops/branch-protection.md", `${currentTotal}\n`);

  const result = run(root);
  expect(result.status).toBe(1);
  expect(parsedFindings(result).map((item) => item.kind)).toEqual(["workflow-job-total"]);
});

it("reports all four repeated moving coordinate forms", () => {
  const root = fixture();
  const productionPath = "src/bootstrap/hermes-bootstrap.ts";
  write(root, productionPath, "export const bind = () => undefined;\n");
  write(
    root,
    "tests/unit/all.test.ts",
    [
      'import { spawnSync } from "node:child_process";',
      `const body = ${JSON.stringify(`${productionPath}:341   cp.bindings.bind({...})`)};`,
      'const listed = spawnSync("git", ["ls-files", "*.ts"]);',
      "expect(listed.stdout).toHaveLength(254);",
      "",
    ].join("\n"),
  );
  write(
    root,
    "docs/design/census.md",
    "Measured against `8622195`; replay with `node docs/design/census.mjs --json`.\n",
  );
  write(
    root,
    "docs/ops/branch-protection.md",
    `${["The workflow now has", "five jobs."].join(" ")}\n`,
  );

  const result = run(root);
  expect(result.status).toBe(1);
  expect(parsedFindings(result).map((item) => item.kind).sort()).toEqual([
    "discovered-file-count",
    "test-source-line",
    "unbound-measured-ref",
    "workflow-job-total",
  ]);
});

it("a missing production path remains a stable negative control", () => {
  const root = fixture();
  const missingPath = ["src/does/not", "exist.ts"].join("/");
  write(
    root,
    "tests/unit/missing.test.ts",
    `const body = ${JSON.stringify(`${missingPath}:42   deliberatelyMissing()`)};\n`,
  );

  const result = run(root);
  expect(result.status).toBe(0);
  expect(parsedFindings(result)).toEqual([]);
});

it("unrelated and derived lengths remain valid beside git discovery", () => {
  const root = fixture();
  write(
    root,
    "tests/unit/derived.test.ts",
    [
      'import { spawnSync } from "node:child_process";',
      'const listed = spawnSync("git", ["ls-files", "*.ts"]);',
      "expect([1, 2]).toHaveLength(2);",
      "expect(listed.stdout).toHaveLength(expectedFiles.length);",
      "",
    ].join("\n"),
  );

  const result = run(root);
  expect(result.status).toBe(0);
  expect(parsedFindings(result)).toEqual([]);
});

it("the same variable name in another test block has an independent binding", () => {
  const root = fixture();
  write(
    root,
    "tests/unit/scopes.test.ts",
    [
      'import { spawnSync } from "node:child_process";',
      'it("discovers files", () => {',
      '  const listed = spawnSync("git", ["ls-files", "*.ts"]);',
      "  expect(listed.stdout).toEqual(expect.anything());",
      "});",
      'it("checks a local list", () => {',
      '  const listed = ["one", "two"];',
      "  expect(listed).toHaveLength(2);",
      "});",
      "",
    ].join("\n"),
  );

  const result = run(root);
  expect(result.status).toBe(0);
  expect(parsedFindings(result)).toEqual([]);
});

it("a node command that consumes its measured SHA remains valid", () => {
  const root = fixture();
  write(
    root,
    "docs/design/census.md",
    "Measured against `8622195`; replay with `node docs/design/census.mjs --ref 8622195 --json`.\n",
  );

  const result = run(root);
  expect(result.status).toBe(0);
  expect(parsedFindings(result)).toEqual([]);
});

it("an unrelated node command beside a bound reproduction command remains valid", () => {
  const root = fixture();
  write(
    root,
    "docs/design/census.md",
    [
      "Measured against `8622195`; replay with",
      "`node docs/design/census.mjs --ref 8622195 --json`.",
      "Record the runtime with `node --version`.",
      "",
    ].join("\n"),
  );

  const result = run(root);
  expect(result.status).toBe(0);
  expect(parsedFindings(result)).toEqual([]);
});

it("historical workflow wording remains valid", () => {
  const root = fixture();
  write(
    root,
    "docs/ops/history.md",
    "The workflow's one job had the id verify before the matrix split.\n",
  );

  const result = run(root);
  expect(result.status).toBe(0);
  expect(parsedFindings(result)).toEqual([]);
});

it("a hypothetical workflow job count remains valid", () => {
  const root = fixture();
  write(
    root,
    "docs/ops/conditional.md",
    "If the workflow has two jobs, split the slower one before adding a matrix.\n",
  );

  const result = run(root);
  expect(result.status).toBe(0);
  expect(parsedFindings(result)).toEqual([]);
});

it("the scan enters both tests and documents", () => {
  const root = fixture();
  write(root, "tests/unit/empty.test.ts", "expect(true).toBe(true);\n");
  write(root, "docs/empty.md", "No moving coordinates here.\n");

  const result = run(root);
  expect(result.status).toBe(0);
  expect(parsedReport(result).scanned).toEqual({ tests: 1, documents: 1 });
});

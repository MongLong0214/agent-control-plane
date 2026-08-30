import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = join(root, "scripts", "verify-reason-code-usage.mjs");

interface Census {
  declaredCodes: number;
  exitCode: number | null;
  limitations: string[];
  problems: string[];
  withoutStaticOutflow: Array<{ code: string }>;
  notes: string[];
}

const census = (fixtureRoot?: string): Census => {
  const args = [script, "--json"];
  if (fixtureRoot) args.push(`--root=${fixtureRoot}`);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  try {
    return {
      exitCode: result.status,
      ...(JSON.parse(result.stdout) as Omit<Census, "exitCode">),
    };
  } catch {
    throw new Error(`reason-code census did not return JSON:\n${result.stdout}${result.stderr}`);
  }
};

const fixtureCensus = (source: string, catalogueMetadata = ""): Census => {
  const fixture = mkdtempSync(join(tmpdir(), "reason-code-census-"));
  try {
    mkdirSync(join(fixture, "src", "core"), { recursive: true });
    mkdirSync(join(fixture, "src", "db"), { recursive: true });
    mkdirSync(join(fixture, "tests"), { recursive: true });
    writeFileSync(
      join(fixture, "src", "core", "reason-codes.ts"),
      `export const ReasonCode = {\n  X: "X",\n} as const;\n${catalogueMetadata}`,
    );
    writeFileSync(join(fixture, "src", "producer.ts"), source);
    writeFileSync(join(fixture, "src", "db", "schema.sql"), "");
    writeFileSync(join(fixture, "src", "db", "migrations.ts"), "");
    writeFileSync(
      join(fixture, "src", "db", "database.ts"),
      "const TRIGGER_CODES: Record<string, ReasonCode> = {\n};\n",
    );
    return census(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
};

/** Every declaration has a direct outflow or a machine-verified indirect outflow. */
it("every declared reason code has a verified static outflow", () => {
  const result = census();

  expect(result.withoutStaticOutflow).toEqual([]);
  expect(result.problems).toEqual([]);
  expect(result.exitCode).toBe(0);
});

/** Catalogue metadata is scanned for undeclared members but cannot satisfy an outflow. */
it("catalogue metadata references are declared", () => {
  const production = census();
  const result = fixtureCensus(
    "export const produce = () => ReasonCode.X;\n",
    "export const metadata = new Set([ReasonCode.NOT_DECLARED]);\n",
  );

  expect(production.problems).toEqual([]);
  expect(production.exitCode).toBe(0);
  expect(result.problems).toContain(
    "src/** references an undeclared ReasonCode member: NOT_DECLARED (src/core/reason-codes.ts:4)",
  );
  expect(result.exitCode).toBe(1);
});

/** Production trigger denials and mappings agree. */
it("production trigger denials and mappings agree", () => {
  const result = census();

  expect(result.exitCode).toBe(0);
  expect(result.problems).toEqual([]);
  expect(result.notes).toEqual([]);
});

it("a false branch is not a static outflow", () => {
  const result = fixtureCensus(
    "export const decoy = () => { if (false) finish(ReasonCode.X); };\n",
  );

  expect(result.withoutStaticOutflow.map((entry) => entry.code)).toEqual(["X"]);
  expect(result.exitCode).toBe(1);
});

it("a live sink branch is a static outflow", () => {
  const result = fixtureCensus(
    "export const produce = () => { if (true) finish(ReasonCode.X); };\n",
  );

  expect(result.withoutStaticOutflow).toEqual([]);
  expect(result.exitCode).toBe(0);
});

it("a Set literal is not a static outflow", () => {
  const result = fixtureCensus("export const metadata = new Set([ReasonCode.X]);\n");

  expect(result.withoutStaticOutflow.map((entry) => entry.code)).toEqual(["X"]);
  expect(result.exitCode).toBe(1);
});

it("a z literal is not a static outflow", () => {
  const result = fixtureCensus("export const schema = z.literal(ReasonCode.X);\n");

  expect(result.withoutStaticOutflow.map((entry) => entry.code)).toEqual(["X"]);
  expect(result.exitCode).toBe(1);
});

it("a return comparison is not a static outflow", () => {
  const result = fixtureCensus(
    "export const classify = (value: string) => { return value === ReasonCode.X; };\n",
  );

  expect(result.withoutStaticOutflow.map((entry) => entry.code)).toEqual(["X"]);
  expect(result.exitCode).toBe(1);
});

it("a concise arrow comparison is not a static outflow", () => {
  const result = fixtureCensus(
    "export const classify = (value: string) => value === ReasonCode.X;\n",
  );

  expect(result.withoutStaticOutflow.map((entry) => entry.code)).toEqual(["X"]);
  expect(result.exitCode).toBe(1);
});

it("a parenthesized comparison is not a static outflow", () => {
  const result = fixtureCensus(
    "export const classify = (value: string) => { return value === (ReasonCode.X); };\n",
  );

  expect(result.withoutStaticOutflow.map((entry) => entry.code)).toEqual(["X"]);
  expect(result.exitCode).toBe(1);
});

it("a returned collection membership check is not a static outflow", () => {
  const result = fixtureCensus(
    "export const classify = () => { return [ReasonCode.X].includes(value); };\n",
  );

  expect(result.withoutStaticOutflow.map((entry) => entry.code)).toEqual(["X"]);
  expect(result.exitCode).toBe(1);
});

it("a disposition sentence is not a static outflow", () => {
  const result = fixtureCensus(
    'export const disposition = "X is retained for a future consumer";\n',
  );

  expect(result.withoutStaticOutflow.map((entry) => entry.code)).toEqual(["X"]);
  expect(result.exitCode).toBe(1);
});

it("direct return values are static outflows", () => {
  const returned = fixtureCensus("export const produce = () => { return ReasonCode.X; };\n");
  const concise = fixtureCensus("export const produce = () => ReasonCode.X;\n");

  expect(returned.withoutStaticOutflow).toEqual([]);
  expect(returned.exitCode).toBe(0);
  expect(concise.withoutStaticOutflow).toEqual([]);
  expect(concise.exitCode).toBe(0);
});

it("an uncalled function reports reachability as undecidable", () => {
  const result = fixtureCensus(
    'const neverCalled = () => deny(ReasonCode.X, "not reached", {});\nvoid neverCalled;\n',
  );

  expect(result.withoutStaticOutflow).toEqual([]);
  expect(result.limitations).toContain(
    "reachability: cannot decide — no call graph is built; a static outflow inside an uncalled function may satisfy this census",
  );
  expect(result.exitCode).toBe(0);
});

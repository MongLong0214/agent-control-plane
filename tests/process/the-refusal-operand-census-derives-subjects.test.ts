import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "acp-derived-operands-"));
  roots.push(root);
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write("scripts/lib/falsifiability-cases.mjs", 'export const CASES_DIR = "scripts/falsifiability-cases";');
  write("scripts/lib/refusal-operand-exclusions.mjs", "export const FILE_EXCLUSIONS = new Map([]);");
  write("scripts/lib/refusal-operands-unanswered.mjs", "export const UNANSWERED = new Map([]);");
  write("scripts/verify-guards-are-falsifiable.mjs", "const GUARDS = [];");
  mkdirSync(join(root, "src"));
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
  copyFileSync("scripts/verify-refusal-operands-are-watched.mjs", join(root, "scripts/verify-refusal-operands-are-watched.mjs"));
  return { write, run: () => spawnSync(process.execPath, ["scripts/verify-refusal-operands-are-watched.mjs"], {
    cwd: root, encoding: "utf8",
  }) };
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("discovers an unwritten name by its operands and ignores operators in prose", () => {
  const { write, run } = fixture();
  write("src/a-future-authority.ts", "export const eligible = (a: boolean, b: boolean) => a && b;");
  write("src/prose.ts", '// deny(a && b);\nexport const label = "a || b";');
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("scanned 2 file(s); selected 1 deciding file(s); excluded 0 deciding file(s)");
  expect(result.stdout).toContain("1 file(s) contain no &&/|| operands");
  expect(result.stdout).toContain("2 of 2 operand(s) have no row or UNANSWERED reason");
});

it("removing the only exclusion brings every operand into scope", () => {
  const { write, run } = fixture();
  write("src/legacy.ts", "export const eligible = (a: boolean, b: boolean) => a || b;");
  write("scripts/lib/refusal-operand-exclusions.mjs", 'export const FILE_EXCLUSIONS = new Map([["src/legacy.ts", "pre-existing operands not yet answered"]]);');
  const excluded = run();
  expect(excluded.status).toBe(0);
  expect(excluded.stdout).toContain("scanned 1 file(s); selected 0 deciding file(s); excluded 1 deciding file(s)");
  write("scripts/lib/refusal-operand-exclusions.mjs", "export const FILE_EXCLUSIONS = new Map([]);");
  const included = run();
  expect(included.status).toBe(1);
  expect(included.stdout).toContain("scanned 1 file(s); selected 1 deciding file(s); excluded 0 deciding file(s)");
  expect(included.stdout).toContain("2 of 2 operand(s) have no row or UNANSWERED reason");
});

it("counts individual operands and tails and reads quoted concatenated row anchors", () => {
  const { write, run } = fixture();
  write("src/authority.ts", "const eligible = (a, b, c) => a === 1 && (b === 2 || c === 3);\n");
  write("scripts/falsifiability-cases/exact.mjs", 'const row = { "file": "src/authority.ts", "find": "a === " + "1" }; export default row;');
  const red = run();
  expect(red.status).toBe(1);
  expect(red.stdout).toContain("2 of 3 operand(s) have no row or UNANSWERED reason");
  write("scripts/verify-guards-are-falsifiable.mjs", 'const GUARDS = [{file: "src/authority.ts", find: "b === 2"}, {file: "src/authority.ts", find: "c === 3"}];');
  const green = run();
  expect(green.status).toBe(0);
  expect(green.stdout).toContain("3 of 3 operand(s)");
});

it("does not credit a nearby line, another file, a skipped row or an undeclared object", () => {
  const { write, run } = fixture();
  write("src/authority.ts", "const neighbour = 1;\nconst eligible = a && b;");
  write("src/other.ts", "const eligible = a && b;");
  write("scripts/verify-guards-are-falsifiable.mjs", 'const unrelated = {file: "src/authority.ts", find: "const eligible = a && b;"};\nconst GUARDS = [{file: "src/authority.ts", find: "const neighbour = 1;"}, {file: "src/authority.ts", find: "const eligible = a && b;", skip: "deferred"}, {file: "src/other.ts", find: "const eligible = a && b;"}];');
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("2 of 4 operand(s) have no row or UNANSWERED reason");
});

it("does not let an unanswered occurrence hide a new repeated operand", () => {
  const { write, run } = fixture();
  write("src/authority.ts", "const eligible = a && b;");
  write("scripts/lib/refusal-operands-unanswered.mjs", 'export const UNANSWERED = new Map([["src/authority.ts::a::1", "no independent witness"], ["src/authority.ts::b::1", "no independent witness"]]);');
  expect(run().status).toBe(0);
  write("src/authority.ts", "const eligible = a && b && a;");
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("1 of 3 operand(s) have no row or UNANSWERED reason");
});

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
  // The operand counts are asserted, not only the file counts: this branch made them derived,
  // and a fixture is where that is cheapest to pin. Two operands in the one deciding file, none
  // excluded, and the parts summing to the whole.
  expect(result.stdout).toContain(
    "scanned 2 file(s); selected 1 deciding file(s) holding 2 operand(s); " +
      "excluded 0 deciding file(s) holding 0 unanswered operand(s), 2 in total",
  );
  expect(result.stdout).toContain("1 file(s) contain no &&/|| operands");
  expect(result.stdout).toContain("2 of 2 operand(s) have no row or UNANSWERED reason");
});

it("removing the only exclusion brings every operand into scope", () => {
  const { write, run } = fixture();
  write("src/legacy.ts", "export const eligible = (a: boolean, b: boolean) => a || b;");
  write("scripts/lib/refusal-operand-exclusions.mjs", 'export const FILE_EXCLUSIONS = new Map([["src/legacy.ts", "pre-existing operands not yet answered"]]);');
  const excluded = run();
  expect(excluded.status).toBe(0);
  // The excluded operand count moves with the Map — the fixture-level form of the
  // reconciliation the census now refuses on.
  expect(excluded.stdout).toContain(
    "scanned 1 file(s); selected 0 deciding file(s) holding 0 operand(s); " +
      "excluded 1 deciding file(s) holding 2 unanswered operand(s), 2 in total",
  );
  write("scripts/lib/refusal-operand-exclusions.mjs", "export const FILE_EXCLUSIONS = new Map([]);");
  const included = run();
  expect(included.status).toBe(1);
  expect(included.stdout).toContain(
    "scanned 1 file(s); selected 1 deciding file(s) holding 2 operand(s); " +
      "excluded 0 deciding file(s) holding 0 unanswered operand(s), 2 in total",
  );
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

/**
 * #839. The census selects an operand only inside a `&&` or `||`, so a refusal decided by a single
 * comparison, a ternary or a unary `!` is invisible to it — no row, no UNANSWERED entry, and a
 * PASS that says nothing about it. #834 is what that cost: `observed.startedAt === null` is a plain
 * comparison, so nothing ever demanded a witness for the branch that took the canonical role
 * offline, and nothing would have after #833's exclusions were lifted either.
 *
 * This does not demand witnesses for those conditions — that is the larger change #839 is about.
 * It requires the census to *state its own reach*, so the ratio is printed rather than derived by
 * whoever next tries to size the work.
 */
it("reports how many branch conditions it could never select, not just the ones it did", () => {
  const { write, run } = fixture();
  // Four conditions, one selectable. The other three are exactly the forms that took #834's
  // branch out of reach: a plain comparison, a unary negation, and a ternary.
  write(
    "src/reach.ts",
    [
      "export const f = (a: number, b: number, c: boolean) => {",
      "  if (a === 1 && b === 2) return 'selectable';",
      "  if (a === 3) return 'plain comparison';",
      "  if (!c) return 'unary';",
      "  return c ? 'ternary' : 'no';",
      "};",
      "",
    ].join("\n"),
  );

  const reach = run().stdout.split("\n").find((line) => line.startsWith("CENSUS REACH:")) ?? "";

  // The numbers, not merely that a line exists: a report that always said "0 of 0" would satisfy
  // any weaker assertion while telling an operator nothing.
  expect(reach).toContain("1 of 4 branch condition(s)");
  expect(reach).toContain("the other 3 decide a branch in a form this census never asks about");
  // Said out loud, because `while`, `switch` and `??` are not counted either — a reader must not
  // read 4 as the total number of ways this file decides anything.
  expect(reach).toContain("lower bound");
});

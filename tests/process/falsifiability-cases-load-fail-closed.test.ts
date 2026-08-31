import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { CASES_DIR, loadFalsifiabilityCases } from "../../scripts/lib/falsifiability-cases.mjs";

afterAll(cleanupTempDirs);

/**
 * #741 moved the mutation rows out of one array in one file and into one module per case, because
 * whether two branches conflicted was decided by where each happened to insert rather than by
 * whether the changes said anything about each other.
 *
 * That trade has a price and this file is where it is paid. A directory of modules can lose a row
 * in a way an array cannot: the array died loudly when it did not parse, whereas a loader that
 * shrugs at a module it could not read subtracts a row and reports the survivors as a full sweep.
 * Every property below is a way the loader could report coverage it does not have.
 *
 * The resolution that started this cut an object boundary and left a file with a `SyntaxError` in
 * it, while `grep -c "what:"` counted 298 rows and the arithmetic agreed. So the load runs before
 * the harness reads its own table, before it snapshots, and before it mutates anything — a broken
 * case has no path to a count check, which is the last test in this file.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");

const OBJECT_LITERAL = (id: string, extra = "") => `{
  id: ${JSON.stringify(id)},
  what: "a placeholder row for ${id}",
  file: "package.json",
  find: "  \\"name\\":",
  replace: "",
  killedBy: ["tests/placeholder.test.ts"],
  ${extra}
}`;

const ROW = (id: string, extra = ""): string => `export default ${OBJECT_LITERAL(id, extra)};\n`;

/**
 * A repository-shaped temp root: a case directory, the modules under test, and whatever files the
 * rows' `killedBy` entries name. Built rather than pointed at the real repository so a fixture
 * cannot pass by borrowing a real row.
 */
const fakeRoot = (modules: Readonly<Record<string, string>>, tests: readonly string[] = []): string => {
  const root = tempDir("acp-741-cases-");
  mkdirSync(join(root, CASES_DIR), { recursive: true });
  for (const [name, body] of Object.entries(modules)) {
    writeFileSync(join(root, CASES_DIR, name), body);
  }
  for (const path of tests) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), "");
  }
  return root;
};

const load = (root: string): Promise<unknown> => loadFalsifiabilityCases(root);

describe("the falsifiability case loader is fail-closed", () => {
  it("loads one row per module, in file-name order", async () => {
    const root = fakeRoot(
      { "b-second.mjs": ROW("b-second"), "a-first.mjs": ROW("a-first") },
      ["tests/placeholder.test.ts"],
    );

    const rows = (await load(root)) as { id: string }[];

    expect(rows.map((row) => row.id)).toEqual(["a-first", "b-second"]);
  });

  it("refuses an empty case directory rather than reporting a sweep with no subject", async () => {
    const root = fakeRoot({});

    await expect(load(root)).rejects.toThrow(/holds no \.mjs case modules/);
  });

  it("refuses a missing case directory rather than treating zero rows as zero failures", async () => {
    const root = tempDir("acp-741-nodir-");

    await expect(load(root)).rejects.toThrow(/does not exist/);
  });

  it("refuses a case module it cannot parse instead of skipping past it", async () => {
    const root = fakeRoot(
      {
        "a-healthy.mjs": ROW("a-healthy"),
        // The exact shape the 2026-08-31 conflict resolution produced: an object boundary cut
        // mid-row, leaving an unterminated literal.
        "b-broken.mjs": 'export default {\n  id: "b-broken",\n  what: "unterminated",\n',
      },
      ["tests/placeholder.test.ts"],
    );

    await expect(load(root)).rejects.toThrow(/b-broken\.mjs: could not be loaded/);
  });

  it("refuses two case modules that claim the same id", async () => {
    const root = fakeRoot(
      { "a-one.mjs": ROW("shared-id"), "b-two.mjs": ROW("shared-id") },
      ["tests/placeholder.test.ts"],
    );

    await expect(load(root)).rejects.toThrow(/is already used by a-one\.mjs/);
  });

  it("refuses a case module that exports an array of rows", async () => {
    const root = fakeRoot(
      { "a-many.mjs": `export default [${OBJECT_LITERAL("a-many")}];\n` },
      ["tests/placeholder.test.ts"],
    );

    await expect(load(root)).rejects.toThrow(/exports an array of 1 row\(s\)/);
  });

  it("refuses a case module carrying a second export beside its row", async () => {
    const root = fakeRoot(
      { "a-two.mjs": `${ROW("a-two")}export const alsoARow = { id: "sneaky" };\n` },
      ["tests/placeholder.test.ts"],
    );

    await expect(load(root)).rejects.toThrow(/must have exactly one export/);
  });

  it("refuses a killedBy that names a test file which does not exist", async () => {
    // `vitest run <path>` exits non-zero for a path matching no file, and the harness reads a
    // non-zero exit as a kill — so this row would report coverage forever, having run nothing.
    const root = fakeRoot({ "a-dead.mjs": ROW("a-dead") });

    await expect(load(root)).rejects.toThrow(/killedBy names tests\/placeholder\.test\.ts, which does not exist/);
  });

  it("refuses an unrecognised field rather than reading a typo as an absent one", async () => {
    const root = fakeRoot(
      { "a-typo.mjs": ROW("a-typo", 'killedby: ["tests/placeholder.test.ts"],') },
      ["tests/placeholder.test.ts"],
    );

    await expect(load(root)).rejects.toThrow(/unrecognised field "killedby"/);
  });
});

describe("a broken case module stops the harness before the run starts", () => {
  const git = (args: readonly string[], cwd: string): string =>
    execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

  /**
   * The whole of acceptance 2, end to end, through the real script.
   *
   * A linked worktree at `HEAD` rather than the working copy — the same rule the harness itself
   * follows and the same one the worktree regression test follows, so this exercises the committed
   * harness. `--only` is given a filter that matches no row, so a healthy tree finishes in a moment
   * with exit 0; the only difference between the two halves below is the broken module on disk.
   */
  const inWorktreeWithCase = (
    caseFile: string | null,
    body: string,
    run: (result: ReturnType<typeof spawnSync>) => void,
  ): void => {
    const parent = tempDir("acp-741-e2e-");
    const worktree = join(parent, "checkout");
    git(["worktree", "add", "--detach", "--quiet", worktree, git(["rev-parse", "HEAD"], REPO_ROOT)], REPO_ROOT);
    try {
      if (caseFile !== null) writeFileSync(join(worktree, CASES_DIR, caseFile), body);
      run(
        spawnSync(
          process.execPath,
          [join(worktree, "scripts", "verify-guards-are-falsifiable.mjs"), "--only=__matches_no_row__"],
          { cwd: worktree, encoding: "utf8" },
        ),
      );
    } finally {
      git(["worktree", "remove", "--force", worktree], REPO_ROOT);
      rmSync(parent, { recursive: true, force: true });
    }
  };

  it("passes on an unmodified checkout, so the failure below is the broken case and nothing else", () => {
    inWorktreeWithCase(null, "", (result) => {
      expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).not.toContain("could not be loaded");
      expect(result.status).toBe(0);
    });
  });

  it("fails on a syntax error in one case before it reads its own table or touches the tree", () => {
    inWorktreeWithCase("zz-deliberately-broken.mjs", 'export default {\n  id: "zz",\n', (result) => {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(result.status).toBe(1);
      expect(output).toContain("zz-deliberately-broken.mjs: could not be loaded");
      expect(output).toContain("so nothing was run");
      // A loader that skipped the module instead would leave this run indistinguishable from the
      // one above: exit 0, no mention of the file. The two negatives are the checks that must not
      // have been reached — the `what:` count is the one that answered 298 about a file that did
      // not parse.
      expect(output).not.toContain("`what:` line(s)");
      expect(output).not.toContain("RESULT: PASS");
    });
  });
});

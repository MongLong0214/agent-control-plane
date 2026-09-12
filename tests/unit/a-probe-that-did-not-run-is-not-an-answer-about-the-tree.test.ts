import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs, makeRepo } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #859, the half a merge-gate review found: giving `git()` a time bound turned a hang into a wrong
 * answer at a caller the bound's own commit did not touch.
 *
 * `RepositoryRegistry.register` read the work-tree root as
 * `await toplevel(path).catch(() => null)` and denied `NOT_FOUND`, *"path is not inside a git work
 * tree"*, for anything that came back null. Before the bound existed the only way into that catch
 * was git actually saying so, because a git that never returned made the call hang — it never
 * produced a wrong answer. With a bound the call *returns*, by throwing, straight into the blanket
 * catch, and a real work tree was reported as not being one.
 *
 * The subject is the distinction between "git answered no" and "git never ran", so the assertion
 * is that the refusal does not claim anything about the path. A timeout and an unresolvable binary
 * are the same class here — both are `git()` refusing rather than answering — and the missing
 * binary is the one a test can produce without waiting out a bound.
 */
describe("a work-tree probe that did not run is not an answer about the tree", () => {
  let restorePath: string | undefined;
  let emptyBin = "";

  beforeEach(() => {
    emptyBin = mkdtempSync(join(tmpdir(), "acp-no-git-"));
    restorePath = process.env.PATH;
    // `sanitizedGitEnv()` keeps PATH, which is what makes the binary unresolvable from here.
    process.env.PATH = emptyBin;
  });

  afterEach(() => {
    if (restorePath === undefined) delete process.env.PATH;
    else process.env.PATH = restorePath;
    rmSync(emptyBin, { recursive: true, force: true });
  });

  it("does not tell the owner a real work tree is not one when git could not run", async () => {
    const harness = makeHarness();
    // Created while git was still resolvable: this is unambiguously a work tree, which is what
    // makes `NOT_FOUND` a false statement rather than a defensible one.
    const repository = restoredPath(() => makeRepo());

    const refused = await harness.cp.repositories.register({
      checkoutPath: repository,
      identity: "local:probe-did-not-run",
    });

    expect(refused.allowed).toBe(false);
    // The claim under test. `NOT_FOUND` here means "path is not inside a git work tree" — a
    // positive statement about the filesystem, and the one this site used to make.
    expect(refused.reasonCode).not.toBe(ReasonCode.NOT_FOUND);
    if (refused.allowed) throw new Error("expected a refusal");
    expect(refused.message).toContain("probe did not complete");
    expect(refused.evidence).toMatchObject({ probe: "rev-parse --show-toplevel" });
  });

  it("still says NOT_FOUND when git runs and answers that this is no work tree", async () => {
    // The control. Without it, a registry that refused everything with the new message would pass
    // the case above while having lost the ability to report a genuine non-work-tree.
    const harness = makeHarness();
    const notARepo = restoredPath(() => mkdtempSync(join(tmpdir(), "acp-plain-dir-")));

    const refused = await restoredPathAsync(() =>
      harness.cp.repositories.register({
        checkoutPath: notARepo,
        identity: "local:plain-directory",
      }),
    );

    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.NOT_FOUND);
    rmSync(notARepo, { recursive: true, force: true });
  });

  /** Runs one step with the real PATH, so fixtures can be built while git is still reachable. */
  const restoredPath = <T,>(step: () => T): T => {
    const broken = process.env.PATH;
    if (restorePath === undefined) delete process.env.PATH;
    else process.env.PATH = restorePath;
    try {
      return step();
    } finally {
      process.env.PATH = broken;
    }
  };

  const restoredPathAsync = async <T,>(step: () => Promise<T>): Promise<T> => {
    const broken = process.env.PATH;
    if (restorePath === undefined) delete process.env.PATH;
    else process.env.PATH = restorePath;
    try {
      return await step();
    } finally {
      process.env.PATH = broken;
    }
  };
});

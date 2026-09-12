/**
 * #859 — the half that only appeared once `git()` had a bound.
 *
 * `RepositoryRegistry.register` read the work-tree root through `toplevel(path).catch(() => null)`
 * and denied `NOT_FOUND`, *"path is not inside a git work tree"*, for anything null. That was
 * sound while the only reachable throw was git answering exit 128 — and a git that never returned
 * *hung* rather than throwing, so the site never produced a wrong answer. Bounding `git()` made it
 * return by throwing `GIT_TIMEOUT`, which fell into the same catch, and a real work tree was
 * reported as not being one. A merge-gate review reproduced it at 403 ms on a genuine work tree.
 *
 * The mutation inverts the test, which sends a probe that did not run to the `NOT_FOUND` branch —
 * the shipped defect — and git's real answer to the probe branch. It is killed by the case whose
 * git cannot be resolved at all: the same "did not run" class as a timeout, and the only member of
 * it a test can produce without waiting out a bound.
 *
 * Inverted rather than forced to `if (true)`, and that is not a style choice. `if (true)` makes
 * the statements after the block unreachable, TypeScript does not apply narrowing in unreachable
 * code, and `err` reverts to `unknown` — the mutant then dies of TS18046 rather than of a test,
 * which is not a row. Measured with `--only` before this sentence was written.
 *
 * Its sibling case in the same file is the control: a plain directory, with git working, must
 * still be `NOT_FOUND`. Without it a registry that forwarded *everything* would pass the row while
 * having lost the ability to report a genuine non-work-tree — which is the error the first repair
 * of this defect actually made, caught by that control.
 */
const aProbeThatDidNotRunIsNotAVerdictOnTheTree = {
  id: "a-probe-that-did-not-run-is-not-a-verdict-on-the-tree",
  what: "a work-tree probe that could not run refuses as a probe failure, never as a claim that the path is no work tree",
  file: "src/registry/repository-registry.ts",
  find: '    if (typeof err.evidence["exitCode"] === "number") {\n',
  replace: '    if (typeof err.evidence["exitCode"] !== "number") {\n',
  killedBy: [
    "tests/unit/a-probe-that-did-not-run-is-not-an-answer-about-the-tree.test.ts::does not tell the owner a real work tree is not one when git could not run",
  ],
};

export default aProbeThatDidNotRunIsNotAVerdictOnTheTree;

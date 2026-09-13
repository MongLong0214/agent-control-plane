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
 * The mutation replaces git's own answer with "the evidence carries a numeric exit code", which is
 * the discriminator the **first** repair of this defect used and a merge-gate review disproved two
 * ways. The killing case is the 128 one on purpose: the mutant and the real code answer
 * *identically* for a missing binary, because that shape carries `failureCode` and no `exitCode` —
 * so only a numeric exit on a real work tree separates them, which is what `fatal: detected
 * dubious ownership` produces. Measured: naming the missing-binary case left the row SURVIVED.
 *
 * `git()` was also synthesizing `exitCode: 1` for a child killed by an outside signal, and
 * `rev-parse` exits **128** for every fatal — `fatal: detected dubious ownership` on a path that
 * *is* a work tree. So the mutant is not a hypothetical: it is the shipped code of the previous
 * round, and both of its triggers have their own killing cases in the same file.
 *
 * Only git's words establish non-membership. That is the rule `probeWorktree`
 * (src/guard/workspace-probe.ts) already applied to this same question, and this site now shares
 * it rather than inventing a second answer.
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
  find: "    if (namesNoWorkTree(err.message)) {\n",
  replace: '    if (typeof err.evidence["exitCode"] === "number") {\n',
  killedBy: [
    "tests/unit/a-probe-that-did-not-run-is-not-an-answer-about-the-tree.test.ts::does not read a fatal 128 as git answering, when the path is a work tree",
  ],
};

export default aProbeThatDidNotRunIsNotAVerdictOnTheTree;

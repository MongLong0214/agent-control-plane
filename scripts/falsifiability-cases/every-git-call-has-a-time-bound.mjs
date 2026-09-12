/**
 * #859 — `maxBuffer` bounds how much a git command may say; this bounds how long it may take. Without it `promisify(execFile)` waits forever — an index lock another process holds, a stalled filesystem, a credential helper waiting on a prompt with no terminal. Killed by a `git` on PATH that sleeps 60s against a 300ms bound, with a real git and a real repository as the control.
 */
const everyGitCallHasATimeBound = {
  id: 'every-git-call-has-a-time-bound',
  what: 'no git invocation can outlive its bound, so a git that never returns fails the caller instead of stopping it',
  file: "src/git/git.ts",
  find: '      timeout,\n',
  replace: '\n',
  killedBy: [
    'tests/unit/every-git-call-has-a-time-bound.test.ts::kills a git that outlives its bound and says git never answered',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default everyGitCallHasATimeBound;

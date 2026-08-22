# Hooks

Versioned so they can be reviewed, and pointed at by `core.hooksPath` so they are the ones that
run. Install with:

```sh
git config core.hooksPath .githooks
```

`pnpm hooks:check` fails when that pointer is missing, so the install is verifiable rather than
assumed. It is a one-line local config because git will not let a repository set it for you — a
hook that a clone silently starts running is a code-execution path, and git closes it deliberately.

## What each one refuses, and what it cost to learn

**`pre-commit`**

- Committing while `verify-guards-are-falsifiable.mjs` has a mutation applied. It edits guarded
  sources in place and restores them at the end; a commit during that window takes the mutation.
  Twice — 2026-08-19 by way of a killed run, 2026-08-22 by way of a live one. Both put a *removed
  guard* into a commit. The harness's own check asks "is the tree dirty", which is false in the
  killed case and irrelevant in the live case; the sentinel file exists in exactly both.
- Committing a source edit that left a falsifiability row anchored to a line that no longer
  exists. The row then checks nothing while still reporting the guard as covered. Three times on
  one branch, each found forty minutes into CI. `--anchors-only` is a string search and costs a
  second.

**`commit-msg`**

- A CommitLore `Limit:` or `Ruled-out:` trailer wrapped across two lines. `git interpret-trailers`
  reads the last paragraph one trailer per line, so the continuation ends the block and the record
  is stored by nobody. Six times on 2026-08-22. CommitLore prints a warning, but a warning after a
  successful commit is a note about a mistake that is already in the history.

Both hooks refuse rather than warn, for the same reason: every one of these was already *detected*
by something that let the commit through.

**What a hook cannot reach.** A squash-merge commit is composed by GitHub from the arguments given
to `gh pr merge`, so no hook on this machine sees it. On 2026-08-22 a wrapped `Limit:` landed on
`main` that way, with this hook installed and working. Measuring it found the larger loss: a squash
concatenates every branch commit message and git reads only the *last* paragraph, so a merge drops
all but the final commit's records — 41 of 44 across the three merges then on `main`.

`scripts/merge-pr.mjs` (`pnpm merge`) is the path that can reach it: it hands the draft body to
`commitlore squash-preserve`, which carries the branch's records onto the merge message, then runs
the same check this hook runs before anything is merged. Nothing *forces* a merge through it —
`gh pr merge` still works — so the post-merge `pnpm trailers HEAD~1..HEAD` step in CI stays as the
loud failure on any other path.

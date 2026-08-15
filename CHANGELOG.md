# Changelog

Entries are newest first. `scripts/verify-release-version.mjs` requires the top heading here to
equal `package.json`'s version, so the two cannot drift apart the way they did before #516.

This file records **what a release is**, not how much of it there is. Counts belong to
`scripts/ssot-report.mjs`, which derives them from the tree it is run against; a count typed here
would be a claim about a moment, stated where people read it as current (#448 item 4).

## 1.0.0

The first release with a version anybody decided.

`package.json` had said `1.3.0` since the commit that created it — a scaffold default, never a
statement, and never read by anything in `src/`. Meanwhile the release being worked toward was
v1.0.0. Nothing reconciled the two because nothing compared them (#516).

`1.0.0` is the honest number: it is this project's first release, and the lineage `1.3.0` implied
does not exist. No tags precede this one.

### What this release is

A control plane that holds eight hard invariants (CP-HI-01..08) and refuses rather than degrades
when it cannot prove one. The properties it enforces, and the tests that fail when each enforcement
is removed, are recorded in `docs/CONTRIBUTING.md`'s mutation tables — including the exceptions and
the gaps, with their expiry conditions.

Current state, always derived rather than restated:

```
node scripts/ssot-report.mjs          what is open, closed, and reconciled
node scripts/verify-invariant-coverage.mjs   which invariants have tests naming them
node scripts/verify-evidence-freshness.mjs   which evidence describes an earlier tree
```

### Known not-done at this release

- The two-repository merge sequence has not been executed against real repositories (#512, #240).
  The path is implemented and unit-proven; the live run is blocked externally.
- The 3-project, 30-lifecycle observation window is not met (#241, #418).
- The Telegram live round-trip has never been observed (#510).

These are listed because a release that omits them would be claiming a completeness the tree does
not have, which is the failure mode this project spends most of its effort removing.

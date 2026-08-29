#!/usr/bin/env node
/**
 * #664 — `tx()` treats a denied `Decision` as an ordinary return value and commits it.
 * A body that writes and then decides against itself leaves the write behind unless it
 * opts into `txDecision()` instead, which rolls back on a denial exactly as a throw would.
 *
 * "I looked" is not the same as a check (the issue's own words). This is the check: it
 * finds every `db.tx(() => { ... })` body in `src/` that writes and later returns a
 * denied `Decision`, and requires each one to be either:
 *
 *   - converted to `txDecision()`, or
 *   - named in EXEMPT below, with the reason the write must survive a denial anyway
 *     (a body that writes unconditional housekeeping a later decision only reads, the
 *     same shape github-kernel.ts's claim-expiry sweep and managed-write-guard.ts's
 *     renewal sweep both are).
 *
 * A site that is neither is the exact trap #664 reported: nobody decided anything for
 * it, and `tx()`'s default (commit) is silently wrong for it.
 *
 * This is a textual census, not a type checker. It keys exemptions by a stable string
 * found in the body rather than a file:line, because a line number goes stale the moment
 * something above it grows (measured elsewhere in this repo) — see
 * scripts/verify-append-only-tables-are-closed.mjs for the same lesson learned once already.
 *
 * An adversarial review of #679 (the PR converting the first six sites) found that this
 * census did not cover what it claimed: reverting a converted site back to plain `tx()`
 * still passed, because two of the six real `txDecision()` bodies never registered as
 * "writes, then can deny" in the first place —
 *
 *   - `WRITE_PATTERN` only matched literal `.run(`/`.exec(`. `SessionRegistry.transition`
 *     and `RunEngine.transition` each wrap their own `db.run(...)` and are called by name,
 *     not inlined, so a body that writes only by calling one of them looked write-free.
 *   - `DENY_PATTERN` only matched a literal `return deny(...)`. A denial that is instead
 *     *propagated* — `const x = someCall(...); if (!x.allowed) return x;`, or a generic
 *     `return deny<T>(...)` — did not match the pattern at all.
 *
 * Both are fixed below by broadening the two patterns rather than special-casing the two
 * sites that exposed the gap, so the same shape is caught wherever else it appears (it
 * turned out to appear in three more places — see EXEMPT and DEFERRED for how each was
 * resolved). `tests/process/the-tx-denial-census-sees-a-write-then-deny.test.ts` now
 * reverts *every* converted site in turn, not just one, so this class of gap fails loudly
 * instead of silently the next time a site's exact wording changes.
 *
 * A second review found a live instance of the *next* level of this same gap:
 * `TaskGraph.finishExecution` wrote an append-only baseline row through
 * `#baseline.recordInvocationFinished(...)` (a helper, not `.run(`/`.exec(`/`.transition(`),
 * and then `#baseline.recordTaskClassification(...)` — an unrelated, independent call —
 * could still deny. `WRITE_PATTERN` below now also recognises the `recordXxx(`/`record(`
 * family (`AuditLog.record`, `BaselineRecorder.record*`) and `.enqueue(` (`Outbox.enqueue`),
 * the same "helper wraps its own `db.run`, called by name" shape `.transition(` already
 * covered — and `finishExecution` itself was fixed (see task-graph.ts).
 *
 * That widening was tried against the whole tree before committing to it, not just
 * against the one counterexample, and it produced four *new* matches that turned out to
 * be false positives, not real traps — each is in EXEMPT below with the specific reason:
 *
 *   - Three (`RunEngine.dispatch`, `RunEngine.transition`, `TaskGraph.startExecution`) are
 *     a recorder call guarded by the very next line (`if (!x.allowed) return x`) with
 *     nothing else written first — the guard's own denial is reached with nothing to roll
 *     back, and where the caller is `Db.applyRunStateTransition`, a nested denial is
 *     converted to a *throw* (`fail(...)`), which the ordinary pre-#664 `tx()` rollback
 *     path already handles correctly.
 *   - One (`BindingRegistry.bind`) is a recorder whose only failure mode is its own INSERT
 *     hitting a UNIQUE constraint, caught and turned into a deny in the same statement —
 *     the "write" and the "deny" are the same attempt failing, not a write that survives a
 *     later, independent denial.
 *
 * So the same broadening that found one real bug produced four false alarms in one pass,
 * each requiring the same close reading as finding a real trap to resolve. That is
 * evidence about the shape of the problem, not just this one round of it: a write
 * performed by calling *some* method, by name, is fundamentally not distinguishable from a
 * "read a Decision and guard it" call without knowing what that method's body does — which
 * is exactly the "textual census, not a type checker" limit this script has stated from
 * the start. `WRITE_PATTERN` is therefore a curated, closed list of names known (by having
 * been read) to perform their own write and reachably deny after some other write in the
 * calling body — not a claim to recognise every write a body might perform through a
 * helper. A write performed by a method not on this list, at a point after which
 * something else in the body can still deny, is invisible here. Widen this list — and
 * re-run it against the whole tree, the way this round was, before trusting the result —
 * when another such site turns up; do not read a passing run as proof none remain.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

// A curated, closed list — see the header comment above for what "curated" cost to learn
// and why this is not a general helper-write detector. `.transition(` is
// `SessionRegistry.transition` / `RunEngine.transition`; `.record`-family is
// `AuditLog.record` and `BaselineRecorder.record`/`recordInvocationFinished`/
// `recordTaskClassification`/etc; `.enqueue(` is `Outbox.enqueue`. Each wraps its own
// `db.run(...)` and is called by name, not inlined, so a literal `.run(`/`.exec(` search
// alone is blind to a write performed this way.
const WRITE_PATTERN = /\.run\(|\.exec\(|\.transition\(|\.record\w*\(|\.enqueue\(/;
// A denial-shaped return is either a literal `deny(...)` call (optionally generic, as in
// `deny<RoleBinding>(...)`), or the `if (!x.allowed) return x;` idiom this codebase uses
// everywhere to propagate a Decision produced by an earlier call without re-wrapping it in
// a literal `deny(...)`. The second alternative is deliberately loose (a bounded lazy scan
// for `return <same identifier>` after the guard, not a full parse) — over-matching here
// only means a site gets reviewed and resolved below, where under-matching is the #679 gap.
const DENY_PATTERN =
  /return\s+deny(?:<[^>]*>)?\(|if\s*\(\s*!\s*(\w+)\.allowed\s*\)[\s\S]{0,300}?return\s+\1\b/;

/**
 * Every plain `tx()` body this census has confirmed writes unconditional housekeeping
 * that a denial must not undo. Each entry is keyed by a substring unique to that body,
 * not by file:line.
 */
const EXEMPT = [
  {
    file: "github/github-kernel.ts",
    marker: "UPDATE resource_claims SET status = 'EXPIRED'",
    reason:
      "assertClaim's expiry sweep must land regardless of the decision, so the guard and " +
      "the partial unique index agree in the same transaction (#664 comment thread).",
  },
  {
    file: "guard/managed-write-guard.ts",
    marker: "the run holds no live claim on this repository, so the write cannot be fenced",
    reason:
      "renewRequiredClaims sweeps overdue claims before deciding, the same shape as " +
      "github-kernel.ts's assertClaim; the sweep must survive every denial in this body.",
  },
  {
    file: "ingress/ingress-guard.ts",
    marker: "this message's turn was already claimed and its outcome was never recorded",
    reason:
      "claimTurn's only write is inside the branch that returns allow; every deny in this " +
      "body is reached only when nothing was written, so there is nothing to roll back.",
  },
  {
    file: "ceo/production-gate.ts",
    marker: "CEO ${input.decision}",
    reason:
      "the only `.transition(` in this body is `runs.transition(...)` itself, guarded " +
      "immediately by `if (!transition.allowed) return transition`; RunEngine.transition " +
      "denies only in its own pre-write guards (illegal edge, missing completion " +
      "authority), so this specific deny is reached with nothing yet written. Nothing " +
      "after that guard can deny.",
  },
  {
    file: "run/run-engine.ts",
    marker: "§29/§30.3 — activation, its envelope and its audit record are one operation",
    reason:
      "dispatch's recordTransitionEvidence/enqueueTransitionEnvelope callbacks run inside " +
      "Db.applyRunStateTransition, which converts either denying into a *throw* " +
      "(`fail(...)`), not a returned Decision — a throw already rolls the whole " +
      "transaction back via tx()'s ordinary, pre-#664 mechanism. recordDispatchBaseline's " +
      "own denial is reached before its own write (same shared BaselineRecorder.record " +
      "shape as below), and nothing in this body denies after the transition commits.",
  },
  {
    file: "run/run-engine.ts",
    marker: "§29 — the state edge, its evidence and its envelope are one operation",
    reason:
      "RunEngine.transition's own recordTransitionEvidence callback runs inside the same " +
      "Db.applyRunStateTransition wrapper as dispatch above, for the identical reason: a " +
      "nested denial there is a throw, not a returned Decision, and tx()'s ordinary " +
      "rollback already covers it.",
  },
  {
    file: "run/task-graph.ts",
    marker: "const invocationBaseline = this.#baseline.recordInvocationStarted(",
    reason:
      "startExecution's recordInvocationStarted is guarded immediately " +
      "(`if (!invocationBaseline.allowed) return invocationBaseline`), and " +
      "BaselineRecorder.record denies only in its own pre-write guards (unknown run, " +
      "prohibited/credential field) — so this deny is reached with nothing written. " +
      "Nothing later in this body denies after the two INSERTs that follow.",
  },
  {
    file: "session/binding-registry.ts",
    marker: "const recorded = this.recordTargetBinding(actorId, input.verifiedTarget)",
    reason:
      "recordTargetBinding's only write is the INSERT it attempts, caught in a try/catch " +
      "that turns a UNIQUE-constraint failure into this deny — the write and the deny are " +
      "the same statement failing, not an earlier write surviving a later, independent one.",
  },
  {
    file: "run/task-graph.ts",
    marker: "TASK_EXECUTION_LATE_RESULT_IGNORED",
    reason:
      "finishExecution's preflight audit write is the only forensic record of a late/" +
      "superseded result and must survive the denial right after it, the same shape as " +
      "github-kernel.ts's expiry sweep — which is exactly why the rest of finishExecution " +
      "(the part #664 actually traps) was split into its own txDecision() instead of " +
      "folding this preflight into it.",
  },
];

/**
 * A site the census finds and a human has confirmed is a *real*, currently-unfixed
 * instance of the #664 shape — as opposed to EXEMPT, where the write is intentionally
 * meant to survive a denial. A DEFERRED entry is a known open defect with a tracking
 * issue, not a claim of safety, and is reported as such rather than folded into
 * "documented exemption(s)" where a reader could mistake it for one.
 */
const DEFERRED = [
  {
    file: "cto/cto-lifecycle.ts",
    marker: "the CTO binding changed while runtime shutdown was in progress",
    reason:
      "suspendProject's STOPPED transition commits, then bindings.revoke() can deny " +
      "(e.g. a concurrent resolveEscalation flips a BLOCKED run back to ACTIVE between " +
      "the two calls) — and by then the external provider has already been told to " +
      "stop, which is not reversible, so this is not a mechanical tx()->txDecision() " +
      "substitution. Needs an explicit compensation policy and an interleaving test. " +
      "Tracked in #692; see the comment at the call site.",
    issue: "#692",
  },
];

/** Recursively list `.ts` files under `dir`, skipping test files. */
const listTsFiles = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
};

/** Find `db.tx(() => {` / `db.txDecision(() => {` call sites and their bracket-balanced body. */
const findTxSites = (text) => {
  const lines = text.split("\n");
  const sites = [];
  const opener = /\.(tx|txDecision)\(\(\)\s*=>\s*\{\s*$/;
  for (let i = 0; i < lines.length; i += 1) {
    const match = opener.exec(lines[i]);
    if (!match) continue;
    let depth = 1;
    let end = i;
    for (let j = i + 1; j < lines.length && depth > 0; j += 1) {
      const line = lines[j];
      for (const ch of line) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
      if (depth === 0) end = j;
    }
    sites.push({
      kind: match[1],
      startLine: i + 1,
      endLine: end + 1,
      body: lines.slice(i, end + 1).join("\n"),
    });
  }
  return sites;
};

const files = listTsFiles(SRC);
const trapped = [];
const exempted = [];
const deferred = [];
const converted = [];
const matchedExemptMarkers = new Set();
const matchedDeferredMarkers = new Set();

for (const path of files) {
  const rel = relative(SRC, path);
  const text = readFileSync(path, "utf8");
  for (const site of findTxSites(text)) {
    // The first write is the earliest point at which a rollback would have something to
    // undo. Any denial reachable after it — not just the textually-first denial in the
    // body — is the trap, so this checks "does some denial follow the first write",
    // not "does the first denial follow the first write".
    const firstWriteIndex = site.body.search(WRITE_PATTERN);
    const denyAfterWrite =
      firstWriteIndex !== -1 &&
      [...site.body.matchAll(new RegExp(DENY_PATTERN, "g"))].some(
        (m) => m.index > firstWriteIndex,
      );
    if (!denyAfterWrite) continue;

    if (site.kind === "txDecision") {
      converted.push({ file: rel, line: site.startLine });
      continue;
    }

    const exemption = EXEMPT.find((e) => e.file === rel && site.body.includes(e.marker));
    if (exemption) {
      matchedExemptMarkers.add(exemption.marker);
      exempted.push({ file: rel, line: site.startLine, reason: exemption.reason });
      continue;
    }

    const deferral = DEFERRED.find((d) => d.file === rel && site.body.includes(d.marker));
    if (deferral) {
      matchedDeferredMarkers.add(deferral.marker);
      deferred.push({ file: rel, line: site.startLine, reason: deferral.reason, issue: deferral.issue });
      continue;
    }

    trapped.push({ file: rel, line: site.startLine });
  }
}

const unmatchedExemptions = EXEMPT.filter((e) => !matchedExemptMarkers.has(e.marker));
const unmatchedDeferrals = DEFERRED.filter((d) => !matchedDeferredMarkers.has(d.marker));

process.stdout.write(
  `#664 tx-denial census: ${converted.length} using txDecision, ${exempted.length} documented ` +
    `exemption(s), ${deferred.length} deferred known defect(s), ${trapped.length} undocumented ` +
    `trap(s).\n`,
);

// All four are reported, rather than exiting on the first: a marker drifting out of the
// body it named and a genuinely new trap can happen in the same change, and stopping
// at whichever this script checks first would hide the others from the reader.
if (trapped.length > 0) {
  process.stdout.write("\nUndocumented: a plain tx() body writes, then can return a denial.\n");
  for (const t of trapped) process.stdout.write(`  ${t.file}:${t.line}\n`);
  process.stdout.write(
    "\nEither convert the call to txDecision(), or add it to EXEMPT in this script with the " +
      "reason the write must survive a denial.\n",
  );
}

if (deferred.length > 0) {
  process.stdout.write(
    "\nDeferred: a real, currently-unfixed tx-denial trap with a tracking issue (not a claim " +
      "the write is safe):\n",
  );
  for (const d of deferred) {
    process.stdout.write(`  ${d.file}:${d.line} (${d.issue})\n`);
  }
}

if (unmatchedExemptions.length > 0) {
  process.stdout.write("\nAn EXEMPT entry named a body this census could not find (a stale exemption):\n");
  for (const e of unmatchedExemptions) process.stdout.write(`  ${e.file}: "${e.marker}"\n`);
  process.stdout.write(
    "\nAn exemption nothing consults is a place for the next reader to believe something was " +
      "decided; remove it or fix the marker.\n",
  );
}

if (unmatchedDeferrals.length > 0) {
  process.stdout.write("\nA DEFERRED entry named a body this census could not find (a stale deferral):\n");
  for (const d of unmatchedDeferrals) process.stdout.write(`  ${d.file}: "${d.marker}" (${d.issue})\n`);
  process.stdout.write(
    "\nEither the defect was fixed (move this to EXEMPT or remove it) or the site's wording " +
      "moved (fix the marker) — a deferral nothing consults hides an open defect entirely.\n",
  );
}

if (trapped.length > 0 || unmatchedExemptions.length > 0 || unmatchedDeferrals.length > 0) {
  process.stdout.write(
    `\nRESULT: FAIL — ${trapped.length} undocumented tx-denial trap(s), ` +
      `${unmatchedExemptions.length} stale exemption(s), ${unmatchedDeferrals.length} stale ` +
      `deferral(s).\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `RESULT: PASS — every tx() body that writes and can deny is either txDecision, a named, ` +
    `matched exemption, or a named, matched, tracked deferral.\n`,
);

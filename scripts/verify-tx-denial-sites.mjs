#!/usr/bin/env node
/**
 * #664 — `tx()` treats a denied `Decision` as an ordinary return value and commits it.
 * A body that writes and then decides against itself leaves the write behind unless it
 * opts into `txDecision()` instead, which rolls back on a denial exactly as a throw would.
 *
 * "I looked" is not the same as a check (the issue's own words). This is the check: it
 * finds every `db.tx(...)`/`db.txDecision(...)` call site this census can open — a braced
 * body (`() => { ... }`) or a concise body that is one call resolved to a same-file
 * definition (`() => this.foo(...)`) — that writes and later returns a denied `Decision`,
 * and requires each one to be either:
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
 *
 * A third review found the same gap one axis over: not the *write* inside a body, but the
 * *opener* that finds the body at all. Two real production sites — `ManagedWriteGuard`'s
 * `decideWrite` (called as `db.tx(() => this.decideWrite(request))`) and `Outbox`'s
 * `acknowledgeInTx` (called as `db.tx(() => this.acknowledgeInTx(...))`) — write unconditional
 * housekeeping that must survive the denials right after it, the identical shape the
 * existing EXEMPT entries already document, but the census could not even *count* them:
 * a zero-argument arrow whose body is one call, not a brace, matched nothing at all.
 *
 * Both turned out to be deliberate, not bugs — confirmed by reading each callee, not
 * assumed: `decideWrite` opens with `this.expireOverdueClaims()`, the identical
 * partial-unique-index expiry sweep already exempted elsewhere in this file, and
 * `acknowledgeInTx`'s two early branches each write an `OUTBOX_ACK_REJECTED` audit record
 * immediately before the deny it explains — an audit trail for the rejection, not a write
 * that outlives an unrelated later denial. Both are in EXEMPT below.
 *
 * Rather than widen the opener detection to match this one new shape and leave the
 * output's own claim exactly where it was — the pattern this file's last three rounds
 * fell into, each round finding a wider set of sites while the printed "every" stayed
 * equally absolute — this round changes the claim first: `findTxSites` now returns which
 * shapes it actually resolved, an opener it *saw* but could not classify fails the census
 * by name instead of being silently skipped (see `unresolvedOpeners` below), and the PASS
 * message says what was actually inspected — a braced body or a concise single-call body
 * resolved to a same-file definition — rather than asserting coverage of every shape a
 * zero-argument arrow can legally take in TypeScript. A concise body that calls something
 * other than a single same-file name (a ternary, a chained expression, a name defined in
 * another file) is exactly such a shape, and is meant to surface as unresolved, not pass
 * silently, until it actually needs handling.
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
// `recordTaskClassification`/etc; `.enqueue(` is `Outbox.enqueue`; `expireOverdueClaims(`
// is `ManagedWriteGuard`'s own claim-expiry sweep (confirmed by reading it: a literal
// `UPDATE resource_claims SET status = 'EXPIRED'`, the same write
// `renewRequiredClaims` already does inline, called instead through `decideWrite`, which
// only the opener fix below can even reach). Each wraps its own `db.run(...)` and is
// called by name, not inlined, so a literal `.run(`/`.exec(` search alone is blind to a
// write performed this way.
const WRITE_PATTERN = /\.run\(|\.exec\(|\.transition\(|\.record\w*\(|\.enqueue\(|\.expireOverdueClaims\(/;
// A denial-shaped return is either a literal `deny(...)` call (optionally generic, as in
// `deny<RoleBinding>(...)`), or the `if (!x.allowed) return x;` idiom this codebase uses
// everywhere to propagate a Decision produced by an earlier call without re-wrapping it in
// a literal `deny(...)`. The second alternative is deliberately loose (a bounded lazy scan
// for `return <same identifier>` after the guard, not a full parse) — over-matching here
// only means a site gets reviewed and resolved below, where under-matching is the #679 gap.
const DENY_PATTERN =
  /return\s+deny(?:<[^>]*>)?\(|if\s*\(\s*!\s*(\w+)\.allowed\s*\)[\s\S]{0,300}?return\s+\1\b/;

/**
 * The exact semantic set this scanner must prove. This is not an allowlist: an entry earns
 * credit only when the independently discovered transaction body has write-then-deny evidence,
 * and any missing, extra, or differently-shaped entry fails the scan. `symbol` locates the
 * owning same-file definition; `label` is the stable operator-facing identity printed below.
 */
const EXPECTED_CONVERTED_SITES = [
  { file: "verify/verification-engine.ts", symbol: "pinRunScopedCommands", label: "VerificationEngine.pinRunScopedCommands", evidence: "direct" },
  { file: "cto/cto-lifecycle.ts", symbol: "prepareSwitchover", label: "CtoLifecycle.prepareSwitchover", evidence: "direct" },
  { file: "cto/cto-lifecycle.ts", symbol: "acknowledgeHandoff", label: "CtoLifecycle.acknowledgeHandoff", evidence: "direct" },
  { file: "cto/cto-lifecycle.ts", symbol: "recoveryTakeover", label: "CtoLifecycle.recoveryTakeover", evidence: "direct" },
  { file: "cto/cto-lifecycle.ts", symbol: "suspendProject", label: "CtoLifecycle.suspendProject (prepare)", evidence: "direct" },
  { file: "daemon/finalizer.ts", symbol: "acquireAttempt", label: "DaemonFinalizer lease acquisition", evidence: "direct" },
  { file: "run/run-engine.ts", symbol: "invalidateCandidate", label: "RunEngine.invalidateCandidate", evidence: "direct" },
  { file: "run/candidate-pipeline.ts", symbol: "acquireAttempt", label: "CandidatePipeline lease acquisition", evidence: "direct" },
  { file: "session/binding-registry.ts", symbol: "bind", label: "BindingRegistry.bind", evidence: "direct" },
  { file: "session/binding-registry.ts", symbol: "switchTo", label: "BindingRegistry.switchTo", evidence: "direct" },
  { file: "run/task-graph.ts", symbol: "finishExecution", label: "TaskGraph.finishExecution (post-preflight)", evidence: "direct" },
  { file: "ingress/ingress-guard.ts", symbol: "completeClaimFromHermesReceipt", label: "IngressGuard.completeClaimFromHermesReceipt", evidence: "direct" },
  { file: "ingress/ingress-guard.ts", symbol: "claimOwnerBatch", label: "IngressGuard.claimOwnerBatch", evidence: "direct" },
  { file: "ingress/ingress-guard.ts", symbol: "completeReplyAndResolveTurn", label: "IngressGuard.completeReplyAndResolveTurn", evidence: "helper:#recordResultHere" },
  { file: "ingress/ingress-guard.ts", symbol: "settleReplyAndTurn", label: "IngressGuard.settleReplyAndTurn", evidence: "helper:#recordResultHere" },
  { file: "ingress/ingress-guard.ts", symbol: "completeNoReplyAndResolveTurn", label: "IngressGuard.completeNoReplyAndResolveTurn", evidence: "helper:#completeNoReplyHere" },
  { file: "ingress/ingress-guard.ts", symbol: "acknowledgeTerminalTelegramReply", label: "acknowledgeTerminalTelegramReply", evidence: "direct" },
  { file: "outbox/outbox.ts", symbol: "completeForHolder", label: "Outbox.completeForHolder", evidence: "direct" },
  { file: "outbox/outbox.ts", symbol: "rejectForHolder", label: "Outbox.rejectForHolder", evidence: "direct" },
];

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
    file: "cto/cto-lifecycle.ts",
    marker: "owner session stopped during project suspension",
    reason:
      "the irreversible provider stop has already happened before this transaction, so " +
      "STOPPED must survive a returned denial. The #692 compensation re-checkpoints any " +
      "CEO-resolved ACTIVE run after STOPPED before revoke; the interleaving regression " +
      "proves that resolveEscalation interleaving no longer makes revoke deny.",
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
    file: "run/task-graph.ts",
    marker: "TASK_EXECUTION_LATE_RESULT_IGNORED",
    reason:
      "finishExecution's preflight audit write is the only forensic record of a late/" +
      "superseded result and must survive the denial right after it, the same shape as " +
      "github-kernel.ts's expiry sweep — which is exactly why the rest of finishExecution " +
      "(the part #664 actually traps) was split into its own txDecision() instead of " +
      "folding this preflight into it.",
  },
  {
    file: "guard/managed-write-guard.ts",
    marker: "this.expireOverdueClaims();\n\n    const operation = request.operation as WriteOperation;",
    reason:
      "decideWrite (reached only via the concise opener `db.tx(() => this.decideWrite(request))` " +
      "— confirmed by reading it, not assumed) opens with the identical claim-expiry sweep " +
      "renewRequiredClaims already does inline a few hundred lines above (also EXEMPT here, " +
      "same reason): the sweep must land regardless of which of decideWrite's ~30 validation " +
      "denials follows. decideWrite never writes to the database anywhere else — every " +
      "GuardGrant it returns is an in-memory object; `#grants.set(...)` happens in a different " +
      "method, after decide() returns, against an in-process Map, not a SQLite transaction.",
  },
  {
    file: "outbox/outbox.ts",
    marker: "kind: \"OUTBOX_ACK_REJECTED\",",
    reason:
      "acknowledgeInTx (reached only via `db.tx(() => this.acknowledgeInTx(...))`, another " +
      "concise opener) writes an OUTBOX_ACK_REJECTED audit record immediately before each of " +
      "its two early denies — confirmed by reading it: the record is the forensic explanation " +
      "for the rejection, not a write that outlives a later, unrelated denial, and both denies " +
      "are self-contained (write-and-deny in the same branch). The success path's own write " +
      "(`UPDATE outbox SET status = 'ACKED'`) is unconditional and nothing denies after it.",
  },
];

/**
 * A site the census finds and a human has confirmed is a *real*, currently-unfixed
 * instance of the #664 shape — as opposed to EXEMPT, where the write is intentionally
 * meant to survive a denial. A DEFERRED entry is a known open defect with a tracking
 * issue, not a claim of safety, and is reported as such rather than folded into
 * "documented exemption(s)" where a reader could mistake it for one.
 */
const DEFERRED = [];

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

/**
 * Locates a function or method definition by name in `text` and returns its
 * bracket-balanced body, or null if the name cannot be found or its body cannot be
 * matched. Handles both a class member (`private foo(`, `async foo(`, `#foo(`) and a free
 * function (`function foo(`, `const foo = (`) — the two shapes this file's own concise
 * `tx(() => callee(...))` openers actually call into (see CONCISE_OPENER below).
 *
 * A multi-line parameter list puts the opening `{` on a later line than the name (see
 * `Outbox.acknowledgeInTx`), so this does not assume the definition line itself ends in
 * `{`: it finds the name, then the matching close-paren of *its own* parameter list by
 * paren-depth, then the first `{` after that (skipping any return-type annotation), then
 * brace-balances from there.
 */
const findNamedDefinition = (text, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const defPattern = new RegExp(
    `(?:^|\\n)[ \\t]*(?:export\\s+)?(?:private\\s+|public\\s+|protected\\s+|static\\s+|readonly\\s+|` +
      `async\\s+|override\\s+|const\\s+|let\\s+|var\\s+)*` +
      `(?:function\\s+)?${escaped}\\s*(?:=\\s*(?:async\\s*)?)?\\(`,
  );
  const defMatch = defPattern.exec(text);
  if (!defMatch) return null;
  // `defMatch[0]` already consumes the opening "(" of the parameter list — its last
  // character — so paren-depth starts there, already at 1.
  let parenDepth = 0;
  let i = defMatch.index + defMatch[0].length - 1;
  for (; i < text.length; i += 1) {
    if (text[i] === "(") parenDepth += 1;
    else if (text[i] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        i += 1;
        break;
      }
    }
  }
  let angleDepth = 0;
  let openBrace = -1;
  for (; i < text.length; i += 1) {
    if (text[i] === "<") angleDepth += 1;
    else if (text[i] === ">" && angleDepth > 0) angleDepth -= 1;
    else if (text[i] === "{" && angleDepth === 0) {
      openBrace = i;
      break;
    }
  }
  if (openBrace === -1) return null;
  let braceDepth = 0;
  let j = openBrace;
  for (; j < text.length; j += 1) {
    if (text[j] === "{") braceDepth += 1;
    else if (text[j] === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) {
        j += 1;
        break;
      }
    }
  }
  if (braceDepth !== 0) return null;
  return { body: text.slice(openBrace, j), start: defMatch.index, end: j };
};

const findNamedBody = (text, name) => findNamedDefinition(text, name)?.body ?? null;

// The braced-body opener this census has always recognised: `.tx(() => { ... })`.
const BLOCK_OPENER = /\.(tx|txDecision)\(\(\)\s*=>\s*\{\s*$/;
// The *other* shape a zero-argument arrow can take: a concise body that is itself one
// call — `.tx(() => this.decideWrite(request))`, `.tx(() => this.#resolveTurnHere(...))`,
// or `.tx(() => someFreeFunction(...))`. An adversarial review of #679 found two real
// production sites in exactly this shape (managed-write-guard.ts, outbox.ts) that the
// census could not even see, let alone classify — this is the same "helper carries the
// real body" gap `WRITE_PATTERN`'s widening closed on the *write* axis, on the *opener*
// axis instead. `(?!\{)` keeps this from ever double-matching the block form above.
const CONCISE_OPENER = /\.(tx|txDecision)\(\(\)\s*=>\s*(?!\{)((?:this\.)?#?[A-Za-z_$][\w$]*)\(/;

/** Find `db.tx(...)` / `db.txDecision(...)` call sites and their bracket-balanced body. */
const findTxSites = (text) => {
  const lines = text.split("\n");
  const lineStarts = [];
  let nextLineStart = 0;
  for (const line of lines) {
    lineStarts.push(nextLineStart);
    nextLineStart += line.length + 1;
  }
  const sites = [];
  const unresolved = [];
  for (let i = 0; i < lines.length; i += 1) {
    const blockMatch = BLOCK_OPENER.exec(lines[i]);
    if (blockMatch) {
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
        kind: blockMatch[1],
        startLine: i + 1,
        endLine: end + 1,
        sourceIndex: lineStarts[i] + blockMatch.index,
        body: lines.slice(i, end + 1).join("\n"),
      });
      continue;
    }

    const conciseMatch = CONCISE_OPENER.exec(lines[i]);
    if (!conciseMatch) continue;
    const callee = conciseMatch[2].replace(/^this\./, "");
    const body = findNamedBody(text, callee);
    if (body === null) {
      unresolved.push({ startLine: i + 1, callee });
      continue;
    }
    sites.push({
      kind: conciseMatch[1],
      startLine: i + 1,
      endLine: i + 1,
      sourceIndex: lineStarts[i] + conciseMatch.index,
      body,
    });
  }
  return { sites, unresolved };
};

const denyAfter = (body, index) => [...body.matchAll(new RegExp(DENY_PATTERN, "g"))]
  .some((match) => match.index > index);

/**
 * Return the evidence that makes the owning transaction write-then-deny. Direct evidence wins.
 * Otherwise trace exactly one private same-file helper call: the helper must contain a known write
 * spelling and the owning body must propagate a denial after that call. This bounded one-hop rule
 * is what keeps helper extraction from making the owning method disappear from the census.
 */
const writeThenDenyEvidence = (text, body) => {
  const firstWriteIndex = body.search(WRITE_PATTERN);
  if (firstWriteIndex !== -1 && denyAfter(body, firstWriteIndex)) return "direct";

  const helperCallPattern = /this\.(#[A-Za-z_$][\w$]*)\s*\(/g;
  for (const helperCall of body.matchAll(helperCallPattern)) {
    const helper = helperCall[1];
    const definition = findNamedDefinition(text, helper);
    if (!definition || !WRITE_PATTERN.test(definition.body)) continue;
    if (denyAfter(body, helperCall.index)) return `helper:${helper}`;
  }
  return null;
};

const semanticOwner = (rel, text, site) => {
  const matches = EXPECTED_CONVERTED_SITES.filter((entry) => {
    if (entry.file !== rel) return false;
    const definition = findNamedDefinition(text, entry.symbol);
    return definition !== null &&
      definition.start <= site.sourceIndex &&
      site.sourceIndex < definition.end;
  });
  return matches.length === 1 ? matches[0] : null;
};

const semanticKey = (entry, evidence) => `${entry.file} :: ${entry.label} :: ${evidence}`;

const files = listTsFiles(SRC);
const trapped = [];
const exempted = [];
const deferred = [];
const converted = [];
const matchedExemptMarkers = new Set();
const matchedDeferredMarkers = new Set();
// A concise opener (`.tx(() => someCall(...))`) this census *saw* but could not resolve
// to a body — a stale/unhandled shape, not silence. Reported and failed on, the same as
// an undocumented trap: a call shape the scanner cannot classify is exactly what "every"
// must not be true over.
const unresolvedOpeners = [];

for (const path of files) {
  const rel = relative(SRC, path);
  const text = readFileSync(path, "utf8");
  const { sites, unresolved } = findTxSites(text);
  for (const u of unresolved) unresolvedOpeners.push({ file: rel, line: u.startLine, callee: u.callee });
  for (const site of sites) {
    const evidence = writeThenDenyEvidence(text, site.body);
    if (evidence === null) continue;

    if (site.kind === "txDecision") {
      const owner = semanticOwner(rel, text, site);
      converted.push({
        file: rel,
        line: site.startLine,
        evidence,
        owner,
      });
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
const expectedConvertedKeys = EXPECTED_CONVERTED_SITES.map((entry) =>
  semanticKey(entry, entry.evidence));
const actualConvertedKeys = converted.map((site) => site.owner
  ? semanticKey(site.owner, site.evidence)
  : `${site.file} :: unresolved-owner@${site.line} :: ${site.evidence}`);
const actualConvertedKeySet = new Set(actualConvertedKeys);
const missingConvertedSites = expectedConvertedKeys.filter((key) => !actualConvertedKeySet.has(key));
const expectedConvertedKeySet = new Set(expectedConvertedKeys);
const unexpectedConvertedSites = actualConvertedKeys.filter((key) => !expectedConvertedKeySet.has(key));
const duplicateConvertedSites = actualConvertedKeys.filter(
  (key, index) => actualConvertedKeys.indexOf(key) !== index,
);
const provenConvertedSites = converted.filter((site) =>
  site.owner !== null && site.owner.evidence === site.evidence);

process.stdout.write(
  `#664 tx-denial census: ${converted.length} using txDecision, ${exempted.length} documented ` +
    `exemption(s), ${deferred.length} deferred known defect(s), ${trapped.length} undocumented ` +
    `trap(s).\n`,
);
process.stdout.write("\nConverted semantic roster:\n");
for (const site of provenConvertedSites) {
  process.stdout.write(`  PROVEN txDecision ${site.owner.file} :: ${site.owner.label}\n`);
  process.stdout.write(`    evidence ${site.evidence}\n`);
}

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

if (
  missingConvertedSites.length > 0 ||
  unexpectedConvertedSites.length > 0 ||
  duplicateConvertedSites.length > 0
) {
  process.stdout.write(
    "\nConverted semantic roster mismatch: every entry needs independently discovered " +
      "write-then-deny evidence in its owning method.\n",
  );
  for (const key of missingConvertedSites) process.stdout.write(`  MISSING ${key}\n`);
  for (const key of unexpectedConvertedSites) process.stdout.write(`  UNEXPECTED ${key}\n`);
  for (const key of duplicateConvertedSites) process.stdout.write(`  DUPLICATE ${key}\n`);
}

if (unresolvedOpeners.length > 0) {
  process.stdout.write(
    "\nSeen but not classified: a concise-body opener this census could not resolve to a " +
      "definition in the same file (not a literal call, or the name lives elsewhere):\n",
  );
  for (const u of unresolvedOpeners) process.stdout.write(`  ${u.file}:${u.line} -> ${u.callee}(...)\n`);
  process.stdout.write(
    "\nAn opener this census can see but cannot classify is not silence — it fails here rather " +
      "than being read as covered.\n",
  );
}

if (
  trapped.length > 0 ||
  unmatchedExemptions.length > 0 ||
  unmatchedDeferrals.length > 0 ||
  unresolvedOpeners.length > 0 ||
  missingConvertedSites.length > 0 ||
  unexpectedConvertedSites.length > 0 ||
  duplicateConvertedSites.length > 0
) {
  process.stdout.write(
    `\nRESULT: FAIL — ${trapped.length} undocumented tx-denial trap(s), ` +
      `${unmatchedExemptions.length} stale exemption(s), ${unmatchedDeferrals.length} stale ` +
      `deferral(s), ${unresolvedOpeners.length} unresolved opener(s), ` +
      `${missingConvertedSites.length} missing converted semantic site(s), ` +
      `${unexpectedConvertedSites.length} unexpected converted semantic site(s), ` +
      `${duplicateConvertedSites.length} duplicate converted semantic site(s).\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `RESULT: PASS — every tx()/txDecision() body this census can open (a braced body, or a ` +
    `concise body that is one call resolved to a same-file definition) that writes directly, ` +
    `or propagates a denial after a bounded one-hop private same-file helper with a known write, ` +
    `is either txDecision, a named, matched exemption, or a named, matched, tracked deferral; ` +
    `the exact converted semantic roster is proven.\n`,
);

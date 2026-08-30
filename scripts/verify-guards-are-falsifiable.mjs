#!/usr/bin/env node
/**
 * Every guard below is deleted on purpose, and a named test has to notice.
 *
 * A test that supplies the thing it is meant to observe passes whether or not the guard exists.
 * That shape appeared four separate times in one day — a compiler that validated its output with
 * an external validator instead of its own, an atomicity check that only exercised the success
 * path, a phase assertion made against a hand-built plan rather than the compiler's, a leak check
 * that searched for words where the rule forbids values. Each was caught by removing the guard by
 * hand and watching the suite stay green, and each time the removal happened because someone
 * remembered to do it. Remembering is the part that fails.
 *
 * So the mutation is the test. For each row: apply the edit that removes the guard, run only the
 * tests that claim to cover it, and require at least one of them to fail. A row that survives is
 * reported as a guard nothing is watching.
 *
 * Two structural failures matter as much as the behavioural ones:
 *
 *   - An anchor that no longer matches its file fails. A guard that moved out from under its row
 *     is a guard this harness has stopped checking, and silence would read as coverage.
 *   - A locus symbol from `verify-enforcement-symbols.mjs` with no row here fails. That script
 *     says so itself: "A symbol existing is not a symbol working." This is the half it does not
 *     do, and reading its list at runtime means adding a locus there forces a row here.
 *
 * What this does not catch: a test that dies for the wrong reason. The mutation proves the test
 * is coupled to the guard, not that it asserts the right thing about it. That is the reviewer's
 * job and this file does not replace it.
 *
 * Runs in CI as its own step, never alongside `vitest`: it edits the working tree in place and
 * restores it, so a concurrent run would read a mutated file as the real one.
 *
 * Dependency-free, in the shape of the other verify scripts (PRD §17.4).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");

/**
 * `symbols` ties a row to the enforcement loci named by the Buzz-transition gate; every symbol in
 * that list must be claimed by some row. `find` must match its file exactly once — a mutation
 * with two homes is a mutation that is not about a specific guard.
 */
/**
 * A `killedBy` entry, which may name a file or one test inside it (`path::test name`).
 *
 * File granularity was the default and it credits a row with a kill it did not earn. Found by an
 * independent review on 2026-08-22 and reproduced: the row "evidence that cannot set the outcome
 * still counts against a retry" mutates the *consistency* computation, and the retry test it is
 * named for kept passing — an independent completion count refuses that retry. What died was a
 * different test in the same file, and because the harness reads any failure in the named file as
 * a kill, the row reported retry coverage it never had.
 *
 * That is the defect this whole harness exists to find, in the harness's own attribution.
 */
const splitKilledBy = (entry) => {
  const at = entry.indexOf("::");
  return at === -1 ? { path: entry, name: null } : { path: entry.slice(0, at), name: entry.slice(at + 2) };
};

/**
 * `vitest run` arguments for a row's `killedBy`.
 *
 * `-t` filters by test name across every file in the run, so a row naming one test in one file is
 * run as that pair. Mixing a named test with a bare file in one row would apply the filter to both
 * and silently narrow the bare one, so that combination is refused rather than run.
 */
const vitestArgsFor = (killedBy) => {
  const parts = killedBy.map(splitKilledBy);
  const named = parts.filter((p) => p.name !== null);
  if (named.length === 0) return parts.map((p) => p.path);
  if (named.length !== parts.length) {
    throw new Error(
      `killedBy mixes a named test with a bare file (${killedBy.join(", ")}); -t would narrow both`,
    );
  }
  if (new Set(named.map((p) => p.name)).size > 1) {
    throw new Error(`killedBy names more than one test (${killedBy.join(", ")}); -t takes one pattern`);
  }
  return [...parts.map((p) => p.path), "-t", named[0].name];
};

const GUARDS = [
  {
    // Two lifecycles in one field: the reply reservation writes `result_json` whole, and an
    // ordinary timeout produces a reply, so the claim and the turn identity went with it.
    what: "the turn claim is stored apart from the reply it will produce",
    file: "src/ingress/ingress-guard.ts",
    find: "          `UPDATE inbound_messages SET turn_claim_json = ?",
    replace: "          `UPDATE inbound_messages SET result_json = ?",
    killedBy: [
      "tests/unit/a-turn-and-a-reply-are-two-lifecycles.test.ts::keeps the claim and its identity when a reply is reserved",
    ],
  },
  {
    // Without it a finished turn's claim is never cleared, and every replay of a completed
    // exchange reports an unknown outcome — a hold created by the fix above.
    what: "a turn whose reply the transport accepted stops being outstanding",
    file: "src/ingress/ingress-guard.ts",
    find: "      return this.#resolveTurnHere(channel, nonce);",
    replace: "      return completed;",
    killedBy: [
      "tests/unit/a-turn-and-a-reply-are-two-lifecycles.test.ts::resolves the turn in the same transaction that records the reply",
    ],
  },
  {
    // The #662 hole: a caller that dispatched, reported that nothing ran, and got attempt 2
    // admitted while attempt 1 was still in flight.
    what: "a dispatched turn cannot be reported as never started",
    file: "src/conversation/turn-coordinator.ts",
    find: '      if (phase === "BEFORE" && this.dispatched(identity.turnRequestId)) {',
    replace: "      if (false) {",
    killedBy: [
      "tests/unit/a-dispatch-is-a-fact.test.ts::refuses the claim that contradicts the ledger's own record",
    ],
  },
  {
    what: "a turn is dispatched once, because a second dispatch is the owner's message sent twice",
    file: "src/conversation/turn-coordinator.ts",
    find: "      if (this.dispatched(permit.turnRequestId)) {",
    replace: "      if (false) {",
    killedBy: [
      "tests/unit/a-dispatch-is-a-fact.test.ts::refuses a second dispatch of the same turn",
    ],
  },
  {
    // Insertability is a property of the destination. Read from the source, an ordinary column that
    // becomes generated lands in the INSERT and SQLite refuses it.
    what: "a rebuild judges what it can write from the table it writes into",
    file: "src/db/migrations.ts",
    find: "      const kind = destination.get(row.name);",
    replace: "      const kind = row.hidden;",
    killedBy: [
      "tests/unit/a-rebuild-carries-the-rows-it-finds.test.ts::carries a computed column into a table that stores it",
    ],
  },
  {
    // ABORTED means the execution can no longer write. Recording one for a turn whose incarnation
    // is still current admits attempt 2 while attempt 1 may still deliver.
    what: "a resolution needs a fence — verified, or the operator's explicit word",
    file: "src/conversation/turn-coordinator.ts",
    find: '      if (fence === "ASSERTED" && input.fenceAsserted !== true) {',
    replace: "      if (false) {",
    killedBy: [
      "tests/unit/an-unresolved-turn-has-an-operator-exit.test.ts::refuses while the execution that holds the turn may still be running",
    ],
  },
  {
    // The copy list was written by hand and omitted four NOT NULL columns; every test database is
    // empty when a migration runs, so nothing noticed.
    what: "a table rebuild carries every column both tables share",
    file: "src/db/migrations.ts",
    find: '  const columns = sharedColumns(raw, "canonical_turns", "canonical_turns_rebuilt").join(", ");',
    replace: '  const columns = "turn_request_id, target_actor_id, prompt_digest, lifecycle_state, claimed_at";',
    killedBy: [
      "tests/unit/a-rebuild-carries-the-rows-it-finds.test.ts::copies every column of an existing turn, including the four a hand-written list forgot",
    ],
  },
  {
    // The operands check cannot see this one — it is a chain written on one line — so the row is
    // what watches it.
    what: "a resolution with no reason and no evidence is refused",
    file: "src/conversation/turn-coordinator.ts",
    find: '    if (input.reasonCode.trim() === "" || input.evidenceDigest.trim() === "") {',
    replace: "    if (false) {",
    killedBy: [
      "tests/unit/an-unresolved-turn-has-an-operator-exit.test.ts::refuses a resolution that says nothing",
    ],
  },
  {
    // The operator authority exists to release a hold in the retry-safe direction. Allowed to
    // record a completion, it would let a person assert something nobody observed — and a turn
    // marked COMPLETED is never re-run, so the owner's question disappears.
    what: "the operator authority can only record ABORTED, in the table",
    file: "src/db/schema.sql",
    find: "        AND observing_authority IN ('HERMES_TARGET', 'OWNER_AFTER_TARGET_FENCE',\n                                    'OPERATOR_AFTER_REVIEW')))",
    replace: "        AND observing_authority IN ('HERMES_TARGET', 'OWNER_AFTER_TARGET_FENCE',\n                                    'OPERATOR_AFTER_REVIEW'))\n    OR observing_authority = 'OPERATOR_AFTER_REVIEW')",
    killedBy: [
      "tests/unit/an-unresolved-turn-has-an-operator-exit.test.ts::cannot record a completion, in the table and not only in the method",
    ],
  },
  {
    // Without the actor comparison an operator holding one conversation's turn id settles another's.
    what: "a resolution names the conversation it settles, not just the turn",
    file: "src/conversation/turn-coordinator.ts",
    find: "      if (held?.target_actor_id !== input.targetActorId) {",
    replace: "      if (held === undefined) {",
    killedBy: [
      "tests/unit/an-unresolved-turn-has-an-operator-exit.test.ts::refuses a turn on another conversation, so one turn id cannot settle another's",
    ],
  },
  {
    // The tool that inherits the records writes one paragraph per source commit, and git stores
    // only the last. Without the collapse the merge path preserves nothing it claims to.
    what: "the inherited records are collapsed into one block git will keep",
    file: "scripts/lib/collapse-trailer-paragraphs.mjs",
    find: "  const paragraphs = message.split(/\\n{2,}/);",
    replace: "  return message;",
    killedBy: [
      "tests/process/the-merge-path-carries-the-record.test.ts::joins the per-commit paragraphs squash-preserve writes",
    ],
  },
  {
    // Measured on the head that merged the ledger: all three fields were NOT NULL and empty was
    // allowed, so a settlement could say COMPLETED and cite nothing.
    what: "a settlement that carries no receipt, evidence or reason is refused",
    file: "src/conversation/turn-coordinator.ts",
    find: "      if (blank.length > 0) {",
    replace: "      if (false) {",
    killedBy: [
      "tests/unit/turn-coordinator.test.ts::refuses a settlement that cites nothing, in the coordinator and in the table",
    ],
  },
  {
    what: "the observation table refuses an unevidenced row, not only the coordinator",
    file: "src/db/schema.sql",
    find: "  CHECK (receipt_id <> '' AND evidence_digest <> '' AND reason_code <> ''),",
    replace: "",
    killedBy: [
      "tests/unit/turn-coordinator.test.ts::refuses a settlement that cites nothing, in the coordinator and in the table",
    ],
  },
  {
    what: "an acceptance realm path that resolves inside production is refused",
    file: "src/acceptance/disposable-realm.ts",
    find: "    if (within(production, resolved)) {",
    replace: "    if (false) {",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // Comparing declared paths passes a scratch directory that is a symlink into production.
    what: "isolation is judged on the resolved path, not the one that was typed",
    file: "src/acceptance/disposable-realm.ts",
    find: "      return join(realpathSync(probe), ...missing);",
    replace: "      return resolve(path);",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    what: "a realm path outside the realm's own state directory is refused, so cleanup can be complete",
    file: "src/acceptance/disposable-realm.ts",
    find: "    if (!within(settled(request.paths.stateDir), settled(path))) {",
    replace: "    if (false) {",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // Only "it does not exist yet" justifies the ancestor walk. Treating every resolution
    // failure as a missing path let a symlink cycle through as a clean realm path.
    what: "a path that cannot be resolved is refused rather than guessed at",
    file: "src/acceptance/disposable-realm.ts",
    find: '      if (code !== "ENOENT") throw new UnresolvablePath(probe, code);',
    replace: "",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // A failure to look is not an observation that there is nothing there. Recording it as
    // absence made two unreadable censuses compare equal.
    what: "a census that could not be read is refused, not recorded as absence",
    file: "src/acceptance/disposable-realm.ts",
    find: '      if (code === "ENOENT") {',
    replace: "      if (true) {",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // The catch-all. Without it an unforeseen write that leaves the three lists identical passes.
    what: "a write that only the -wal sidecar records still fails the census",
    file: "src/acceptance/disposable-realm.ts",
    find: '  if (!sameFamily(before.databaseFamily, after.databaseFamily)) differences.push("databaseFamily");',
    replace: '  if (before.databaseFamily[0]?.mtimeMs !== after.databaseFamily[0]?.mtimeMs) differences.push("databaseFamily");',
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    what: "a new production actor fails the census",
    file: "src/acceptance/disposable-realm.ts",
    find: '  if (!sameMultiset(before.actorIds, after.actorIds)) differences.push("actorIds");',
    replace: "",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // The comparison this replaces joined and compared strings, so an element containing the
    // delimiter split across its neighbour and two different multisets read as equal.
    what: "two multisets are compared element by element, not by a joined spelling",
    file: "src/acceptance/disposable-realm.ts",
    find: "    const left = [...a].sort();\n    const right = [...b].sort();\n    return left.every((value, index) => value === right[index]);",
    replace: '    return [...a].sort().join("|") === [...b].sort().join("|");',
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    what: "a state directory left behind counts as residue even when it is empty",
    file: "src/acceptance/disposable-realm.ts",
    find: "  if (present(paths.stateDir)) {",
    replace: "  if (false) {",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // A retry disposition is what turns an unanswerable outcome into a duplicate.
    what: "every signal but an observed reply is inconclusive, and inconclusive is terminal",
    file: "src/acceptance/disposable-realm.ts",
    find: '  signal === "REPLY_OBSERVED" ? "CONTINUE" : "INCONCLUSIVE";',
    replace: '  signal === "SOCKET_CLOSED" ? "INCONCLUSIVE" : "CONTINUE";',
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // A pid alone is not an identity. Matching on it alone is how a cleanup kills whatever
    // inherited the number — here, the shared Hermes instance that must survive.
    what: "cleanup terminates a process only when the pid and its start time both match",
    file: "src/acceptance/disposable-realm.ts",
    find: "  owned.some((one) => one.pid === candidate.pid && one.startedAtMs === candidate.startedAtMs);",
    replace: "  owned.some((one) => one.pid === candidate.pid);",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    what: "the periodic capacity sweep gets a budget sized against the sweep, not against startup",
    symbols: ["sweepBudgetMs"],
    file: "src/daemon/daemon.ts",
    find: "  providerCount * COLLECTOR_TIMEOUT_MS + STARTUP_CAPACITY_REFRESH_BUDGET_MS;",
    replace: "  STARTUP_CAPACITY_REFRESH_BUDGET_MS;",
    killedBy: ["tests/unit/capacity-sweep-budget.test.ts"],
  },
  {
    // The default this replaces was `["hermes", "-z"]`, which spawns a fresh Hermes per turn.
    // It answered, so every behavioural test passed; what it never did was answer *as the same
    // CEO*. The mutation is the old default put back verbatim.
    what: "the runtime refuses to start without a session-pinned reply source",
    symbols: ["main"],
    file: "src/runtime/hermes-ceo.ts",
    find: "  if (replyAt === -1) {\n    process.stderr.write(REPLY_COMMAND_REQUIRED);\n    return 2;\n  }\n  const replyCommand = argv.slice(replyAt + 1);\n  const flags = argv.slice(0, replyAt);",
    replace: '  const replyCommand = replyAt === -1 ? ["hermes", "-z"] : argv.slice(replyAt + 1);\n  const flags = replyAt === -1 ? [...argv] : argv.slice(0, replyAt);',
    killedBy: ["tests/unit/hermes-ceo-runtime.test.ts"],
  },
  {
    what: "the tool bridge rewrites request ids so Hermes cannot collide with the runtime's own",
    symbols: ["serve"],
    file: "src/runtime/hermes-ceo.ts",
    find: "      line(upstream, { ...value, id: ourId });",
    replace: "      line(upstream, { ...value });",
    killedBy: ["tests/unit/hermes-ceo-runtime.test.ts"],
  },
  {
    what: "the tool bridge answers Hermes's initialize instead of sending a second one to ACP",
    symbols: ["serve"],
    file: "src/runtime/hermes-ceo.ts",
    find: '      if (method === "initialize") {',
    replace: "      if (false) {",
    killedBy: ["tests/unit/hermes-ceo-runtime.test.ts"],
  },
  {
    what: "the tool bridge forwards only the methods ACP agreed to receive on the CEO's connection",
    symbols: ["serve"],
    file: "src/runtime/hermes-ceo.ts",
    find: '      if (method !== "tools/list" && method !== "tools/call") {',
    replace: "      if (false) {",
    killedBy: ["tests/unit/hermes-ceo-runtime.test.ts"],
  },
  {
    what: "the CEO runtime declares sampling, so ordinary owner conversation is not refused",
    symbols: ["serve"],
    file: "src/runtime/hermes-ceo.ts",
    find: "            capabilities: { sampling: {} },",
    replace: "            capabilities: {},",
    killedBy: ["tests/unit/hermes-ceo-runtime.test.ts"],
  },
  {
    what: "the owner's answer is what the reply source printed, not a string the runtime made up",
    symbols: ["serve"],
    file: "src/runtime/hermes-ceo.ts",
    find: "                content: { type: \"text\", text },",
    replace: "                content: { type: \"text\", text: \"acknowledged\" },",
    killedBy: ["tests/unit/hermes-ceo-runtime.test.ts"],
  },
  {
    what: "a reply source that fails is reported to the owner rather than left silent",
    symbols: ["serve"],
    file: "src/runtime/hermes-ceo.ts",
    find: "          .catch((error: Error) => {\n            line(socket, {\n              jsonrpc: \"2.0\",\n              id,\n              error: { code: -32_000, message: `CEO reply source failed: ${error.message}` },\n            });\n          });",
    replace: "          .catch(() => {});",
    killedBy: ["tests/unit/hermes-ceo-runtime.test.ts"],
  },
  {
    what: "a CEO binding that appeared and was revoked mid-bootstrap is refused before anything is minted",
    symbols: ["constituteHermesAuthority"],
    file: "src/bootstrap/hermes-bootstrap.ts",
    find:
      "  const observed = cp.bindings.history(roleKey).length;\n" +
      "  if (observed !== expectedGeneration - 1) {\n",
    replace:
      "  const observed = cp.bindings.history(roleKey).length;\n" +
      "  if (false) {\n",
    killedBy: ["tests/scenarios/hermes-bootstrap-mutation.test.ts"],
  },
  {
    what: "the pre-constitution fence refuses to constitute a CEO once the daemon lock is gone",
    symbols: ["constituteHermesAuthority"],
    file: "src/bootstrap/hermes-bootstrap.ts",
    find:
      "  if (authorityHeld && !authorityHeld()) {\n" +
      "    return deny(ReasonCode.DAEMON_LOCK_LOST, \"daemon lock was lost before CEO constitution\", {});\n" +
      "  }\n",
    replace: "",
    killedBy: ["tests/scenarios/hermes-bootstrap-mutation.test.ts"],
  },
  {
    what: "the pre-launch fence refuses to spawn a Hermes runtime once the daemon lock is gone",
    symbols: ["createHermesBootstrapAuthority"],
    file: "src/bootstrap/hermes-bootstrap.ts",
    find:
      "      if (options.authorityHeld && !options.authorityHeld()) {\n" +
      "        return deny(ReasonCode.DAEMON_LOCK_LOST, \"daemon lock was lost before Hermes runtime launch\", {});\n" +
      "      }\n",
    replace: "",
    killedBy: ["tests/scenarios/hermes-bootstrap-mutation.test.ts"],
  },
  {
    what: "capacity having nothing to say about a provider is not the same as the role being uncovered",
    symbols: ["manages"],
    file: "src/daemon/daemon.ts",
    find:
      "          (!capacityManaged ||\n" +
      "            (currentCapacity !== null &&\n" +
      "              this.cp.capacity.isRoutableFor(currentCapacity, required.capability)));",
    replace:
      "          (currentCapacity !== null &&\n" +
      "            this.cp.capacity.isRoutableFor(currentCapacity, required.capability));",
    killedBy: ["tests/unit/continuity-r2.test.ts"],
  },
  {
    what: "the exemption is for providers capacity never measured, not for a missing reading",
    symbols: ["manages"],
    file: "src/capacity/capacity-monitor.ts",
    find: "    return this.providers.has(provider) || (USAGE_PROVIDERS as readonly string[]).includes(provider);",
    replace: "    return this.providers.has(provider);",
    killedBy: ["tests/unit/capacity-manages.test.ts"],
  },
  {
    what: "a run whose earlier repository failed post-merge verification still blocks the next merge",
    symbols: ["dependentMergeBlocked"],
    file: "src/github/github-kernel.ts",
    find: "  dependentMergeBlocked(runId: string, repositoryIdentity: string): Decision<void> {\n",
    replace:
      "  dependentMergeBlocked(runId: string, repositoryIdentity: string): Decision<void> {\n" +
      "    if (runId !== \"\" || repositoryIdentity !== \"\") return allow(ReasonCode.OK, undefined);\n",
    killedBy: ["tests/scenarios/github-hardening.test.ts"],
  },
  {
    what: "post-merge verification's answer decides the run, rather than being read and dropped",
    symbols: ["postMergeVerify"],
    file: "src/daemon/finalizer.ts",
    find: "        if (!verified.allowed) return this.handleFailure(runId, attemptId, verified as Decision<unknown>);",
    replace: "        if (false) return this.handleFailure(runId, attemptId, verified as Decision<unknown>);",
    killedBy: ["tests/scenarios/finalizer.test.ts"],
  },
  {
    what: "a run with no durable CEO approval cannot be finalized",
    symbols: ["finalizeApprovedRun"],
    file: "src/daemon/finalizer.ts",
    find: "    if (!this.isFinalizingState(initial.state)) {",
    replace: "    if (false) {",
    killedBy: ["tests/scenarios/finalizer.test.ts"],
  },
  {
    what: "the production gate refuses a session that no longer holds the CEO role",
    symbols: ["assertCurrentCeo"],
    file: "src/ceo/production-gate.ts",
    find: "  private assertCurrentCeo(sessionId: string): Decision<void> {\n",
    replace:
      "  private assertCurrentCeo(sessionId: string): Decision<void> {\n" +
      "    if (sessionId !== \"\") return allow(ReasonCode.OK, undefined);\n",
    killedBy: ["tests/unit/runtime-hardening.test.ts"],
  },
  {
    what: "a Buzz actor binding verifies the session secret and the actor allowlist",
    symbols: ["bindBuzzActor"],
    file: "src/session/session-registry.ts",
    find: "    const authenticated = this.verifySecret(input.sessionId, input.sessionSecret);\n    if (!authenticated.allowed) return authenticated;\n\n    const actorId = input.buzzActorId.trim();\n    if (actorId.length === 0 || !authenticator.isAllowedActor(\"buzz\", actorId)) {",
    replace:
      "    const authenticated = this.verifySecret(input.sessionId, input.sessionSecret);\n    void authenticated;\n\n    const actorId = input.buzzActorId.trim();\n    if (false) {",
    killedBy: ["tests/unit/outbox-buzz-claims-r2.test.ts"],
  },
  {
    what: "half-configured Buzz ingress is refused rather than run with one of the two settings",
    symbols: ["configuredBuzzActorIngressPolicy"],
    file: "src/daemon/agentcpd.ts",
    find: "  if (secret.length === 0 || allowedActors.length === 0) {",
    replace: "  if (false) {",
    killedBy: ["tests/unit/configured-ingress-policy.test.ts"],
  },
  {
    what: "the Buzz CLI transport sends on the channel it was given",
    symbols: ["BuzzTransport", "messagesSend", "channelsGet"],
    file: "src/buzz/buzz-adapter.ts",
    find: "        BUZZ_CLI_INVOCATIONS.messagesSend(channel),",
    replace: "        BUZZ_CLI_INVOCATIONS.messagesSend(\"mutated-channel\"),",
    killedBy: ["tests/unit/buzz-cli-surface.test.ts"],
  },
  {
    what: "a CEO socket admitted under a superseded binding is not still the owner's conversation",
    file: "src/mcp/ceo-conversation.ts",
    find: "    const current = peer.authenticate();\n    if (!current.allowed) {",
    replace: "    const current = peer.authenticate();\n    if (false) {",
    killedBy: ["tests/unit/ceo-conversation.test.ts"],
  },
  {
    what: "a CEO peer that never declared sampling is refused instead of asked",
    file: "src/mcp/ceo-conversation.ts",
    find: "    if (!server.server.getClientCapabilities()?.sampling) {",
    replace: "    if (false) {",
    killedBy: ["tests/unit/ceo-conversation.test.ts"],
  },
  {
    // #630: this is the single-flight guard the stack frame's sequential `await` used to provide
    // by accident. Made explicit in #634 so it still holds once that `await` is removed. Without
    // it, a second turn reaches `createMessage` while the first is still open and both land on
    // the same `--resume` session — the interleaving that cannot be unwound.
    what: "at most one turn is ever open on the CEO's canonical session",
    file: "src/mcp/ceo-conversation.ts",
    find: "    if (this.#inFlight) {",
    replace: "    if (false) {",
    killedBy: [
      "tests/unit/ceo-conversation.test.ts::refuses a second turn while the first is still open",
    ],
  },
  {
    what: "the grok billing read refuses to carry a bearer through a proxy or an unchecked certificate",
    file: "src/capacity/usage-collectors.ts",
    find: "    const unsafe = unsafeGrokTransport(process.env);",
    replace: "    const unsafe = null as string | null;",
    killedBy: ["tests/unit/grok-billing-probe.test.ts"],
  },
  {
    what: "the grok billing read never lets the underlying fetch message into the recorded reading",
    file: "src/capacity/usage-collectors.ts",
    find: "      if (error instanceof Error && /^grok billing/.test(error.message)) throw error;",
    replace: "      if (error instanceof Error) throw error;",
    killedBy: ["tests/unit/grok-billing-probe.test.ts"],
  },
  {
    what: "the grok billing read refuses a redirect rather than following it with the header",
    file: "src/capacity/usage-collectors.ts",
    find: "        redirect: \"error\",",
    replace: "        redirect: \"follow\",",
    killedBy: ["tests/unit/grok-billing-probe.test.ts"],
  },
  {
    what: "the handshake deadline stops governing once the peer has authenticated",
    file: "src/daemon/agentcpd.ts",
    find: "    beginRequest(method ?? \"<none>\");\n",
    replace: "",
    killedBy: ["tests/unit/operator-socket.test.ts"],
  },
  {
    what: "a connection that never authenticates is still closed by the handshake budget",
    file: "src/daemon/agentcpd.ts",
    find: "    finish(deny(ReasonCode.OPERATOR_UNAUTHENTICATED, \"operator handshake timed out\"));",
    replace: "    void 0;",
    killedBy: ["tests/unit/operator-socket.test.ts"],
  },
  {
    what: "the doctor's budget is sized against what a doctor pass waits on, not a round number",
    file: "src/daemon/agentcpd.ts",
    find: "  \"doctor.run\": PROVIDER_BUDGET_SLOTS * COLLECTOR_TIMEOUT_MS + DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS,",
    replace: "  \"doctor.run\": DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS,",
    killedBy: ["tests/unit/operator-socket.test.ts"],
  },
  {
    what: "a timed-out method is reported as unanswered, not as not having happened",
    file: "src/daemon/agentcpd.ts",
    find: "\"operator method did not answer within its budget; it was not cancelled and may still complete\"",
    replace: "\"operator method did not answer within its budget\"",
    killedBy: ["tests/unit/operator-socket.test.ts"],
  },
  {
    what: "the client budget outlasts the widest budget any daemon method may take",
    file: "src/cli/agentctl.ts",
    find: "export const DEFAULT_OPERATOR_CLIENT_TIMEOUT_MS = 180_000;",
    replace: "export const DEFAULT_OPERATOR_CLIENT_TIMEOUT_MS = 5_000;",
    killedBy: ["tests/unit/operator-socket.test.ts"],
  },
  {
    what: "a verification executable is judged on the binary it resolves to, not the name it was called by",
    file: "src/contracts/verification-command.ts",
    find: "  const resolvedName = resolvedPath !== null ? executableName(resolvedPath) : null;",
    replace: "  const resolvedName = executableName(argv0);",
    killedBy: ["tests/unit/verify-r2.test.ts"],
  },
  {
    what: "a turn is refused for an actor whose target no runtime attested",
    file: "src/conversation/turn-coordinator.ts",
    find: "      if (!attestation) {",
    replace: "      if (attestation === null) {",
    killedBy: ["tests/unit/turn-coordinator.test.ts"],
  },
  {
    what: "a turn is refused for an actor with no verified target at all — the embargo itself",
    file: "src/conversation/turn-coordinator.ts",
    find: "      if (!target) {",
    replace: "      if (target === null) {",
    killedBy: ["tests/unit/turn-coordinator.test.ts"],
  },
  {
    what: "the retry chain is consulted before a claim is admitted",
    file: "src/conversation/turn-coordinator.ts",
    find: "      if (!chained.allowed) return deny(chained.reasonCode, chained.message, chained.evidence);",
    replace: "      void chained;",
    killedBy: ["tests/unit/turn-coordinator.test.ts"],
  },
  {
    // Three conditions guard the retry rule and they overlap: a completion is refused by the
    // outcome test and by the observation count, and a completion beside a weaker record is also
    // a dispute. The only case any one of them refuses alone is a dispute with no completion in
    // it — a fenced ABORTED against a pre-dispatch NEVER_ADMITTED, where both records permit a
    // retry individually. So this is the row, and the other two carry none.
    what: "a retry is refused while the previous attempt's observations are still in dispute",
    file: "src/conversation/turn-coordinator.ts",
    find: '        unresolved?.observation_consistency !== "CONTRADICTED";',
    replace: "        true;",
    killedBy: ["tests/unit/turn-coordinator.test.ts"],
  },
  {
    // The retry rule collapsed to the shape it reads like. "Anything but completed" sounds
    // equivalent and admits the NULL outcome of a turn still in doubt, which is the one case
    // where the previous execution may still be writing.
    what: "a message whose previous attempt is still in doubt is not raced",
    file: "src/conversation/turn-coordinator.ts",
    find: '        (previous.outcome_kind === "NEVER_ADMITTED" || previous.outcome_kind === "ABORTED") &&',
    replace: '        previous.outcome_kind !== "COMPLETED" &&',
    killedBy: ["tests/unit/turn-coordinator.test.ts"],
  },
  {
    // The row this replaces guarded the old settle-by-UPDATE, which no longer exists. What
    // stands in its place is that evidence unable to *set* the outcome still counts against a
    // retry — the hole a review found, where an ACP-observed reply was invisible both as a
    // winner and as dissent, so a later weaker record settled the turn retry-safe.
    // Renamed after an independent review showed the old name was wider than the mutation. It
    // said "still counts against a retry" and the retry test kept passing — the completion count
    // below refuses that retry on its own. What the mutation actually kills is the consistency
    // computation, so that is what the row now claims, and it names the test rather than the file.
    what: "an observation that cannot set the outcome still counts as dissent",
    file: "src/conversation/turn-coordinator.ts",
    find: "    const distinct = new Set(unanswered.map((o) => o.observed_outcome));",
    replace:
      "    const distinct = new Set(unanswered.filter((o) => MATERIALIZING_AUTHORITIES.has(o.observing_authority)).map((o) => o.observed_outcome));",
    killedBy: [
      "tests/unit/turn-coordinator.test.ts::raises the disagreement rather than reporting it as consistent",
    ],
  },
  {
    what: "only the materializer may settle a turn, so an ordinary UPDATE cannot forge one",
    file: "src/db/schema.sql",
    find: "  AND acp_turn_materialization_authorized(",
    replace: "  AND 0 = 1 AND acp_turn_materialization_authorized(",
    killedBy: ["tests/unit/canonical-ledger-immutability.test.ts"],
  },
  {
    // There is no code to delete here: the guard is the *absence* of an expiry path. So the
    // mutation adds the sweeper someone will eventually be tempted to add, and requires a test
    // to notice. A hold that ages out is fail-open, which is the one direction this must not go.
    //
    // The first version of this row mutated `unresolved()`'s SELECT instead, which is a reader
    // and releases nothing. A hand-written sweeper passed the suite untouched while this row
    // reported the guard as covered — the row named the property and watched somewhere else.
    // It is written against `claim()` now, and the test that kills it claims again rather than
    // asking `unresolved()` what it thinks.
    what: "no age releases a hold — an unresolved turn stays unresolved until an authority settles it",
    file: "src/conversation/turn-coordinator.ts",
    find: "      const turnRequestId = `tr_${randomUUID().replace(/-/g, \"\")}`;",
    replace:
      "      this.db.run(\n" +
      "        `UPDATE canonical_turns SET lifecycle_state='SETTLED', outcome_kind='ABORTED',\n" +
      "           settled_at=?, resolution_authority='OWNER_AFTER_TARGET_FENCE', reason_code='STALE',\n" +
      "           evidence_digest='x', audit_event_id='x'\n" +
      "         WHERE target_actor_id = ? AND lifecycle_state='IN_DOUBT' AND claimed_at < ?`,\n" +
      "        [this.clock.nowIso(), input.targetActorId,\n" +
      "         new Date(this.clock.now().getTime() - 1_800_000).toISOString()],\n" +
      "      );\n" +
      "      const turnRequestId = `tr_${randomUUID().replace(/-/g, \"\")}`;",
    killedBy: ["tests/unit/turn-coordinator.test.ts"],
  },
  {
    // `TurnPermit` is a structural type, so the shape alone proves nothing. Without the signature
    // check any caller can write an object of that shape and settle a turn it never ran.
    what: "only a permit this coordinator issued can settle a turn",
    file: "src/conversation/turn-coordinator.ts",
    find: "    const issued = this.assertIssuedHere(permit);\n    if (!issued.allowed) return deny(issued.reasonCode, issued.message, issued.evidence);",
    replace: "    void this.assertIssuedHere(permit);",
    killedBy: ["tests/unit/turn-coordinator.test.ts"],
  },
  {
    what: "an attempt numbered below one is a malformed request, not a retry-ordering problem",
    file: "src/conversation/turn-coordinator.ts",
    find: "      if (source.attempt < 1) {",
    replace: "      if (false) {",
    killedBy: ["tests/unit/turn-coordinator.test.ts"],
  },
  {
    what: "a claimed turn records when it was claimed, so its age is read rather than guessed",
    file: "src/conversation/turn-coordinator.ts",
    find: "          promptDigest,\n          this.clock.nowIso(),",
    replace: '          promptDigest,\n          "1970-01-01T00:00:00.000Z",',
    killedBy: ["tests/unit/turn-coordinator.test.ts"],
  },
  {
    // The enforcement is the COALESCE, not the TypeScript that feeds it: mutating the parameter
    // changes nothing while the SQL still refuses to overwrite a value that is already there.
    what: "a terminal time is written once and not moved by a later observation",
    file: "src/conversation/turn-coordinator.ts",
    find: "                    settled_at = COALESCE(settled_at, ?),",
    replace: "                    settled_at = ?,",
    killedBy: ["tests/unit/turn-coordinator.test.ts"],
  },
  {
    what: "an adjudication has to say why, and on what",
    file: "src/conversation/turn-coordinator.ts",
    find: "    if (input.reasonCode.length === 0 || input.evidenceDigest.length === 0) {",
    replace: "    if (false) {",
    killedBy: ["tests/unit/adjudicating-a-disagreement.test.ts"],
  },
  {
    // Without it the word becomes a way to mark a conversation reviewed when nothing disagreed.
    what: "only a turn whose records actually disagree can be adjudicated",
    file: "src/conversation/turn-coordinator.ts",
    find: '      if (turn.observation_consistency !== "CONTRADICTED") {',
    replace: "      if (false) {",
    killedBy: ["tests/unit/adjudicating-a-disagreement.test.ts"],
  },
  {
    // A partial citation closes a disagreement while leaving part of it unread.
    what: "an adjudication has to cite every observation on the turn, and only those",
    file: "src/conversation/turn-coordinator.ts",
    find: "      if (uncited.length > 0 || input.citedObservationIds.some((id) => !conflicting.includes(id))) {",
    replace: "      if (false) {",
    killedBy: ["tests/unit/adjudicating-a-disagreement.test.ts"],
  },
  {
    // The first version resolved to whatever the caller passed, which let an adjudication choose
    // an outcome the evidence never produced.
    what: "an adjudication records the outcome the evidence produced and does not choose one",
    file: "src/conversation/turn-coordinator.ts",
    find: "    const unanswered = observations.filter((o) => !answered.has(o.observation_id));",
    replace: "    const unanswered = observations;",
    killedBy: ["tests/unit/adjudicating-a-disagreement.test.ts"],
  },
  {
    // The existence check alone let a caller admit `{text:"A"}` for a nonce and claim it with
    // `{text:"B"}`; `source_digest` recorded B's digest as what the nonce carried, permanently.
    what: "a source's payload must match what ingress recorded admitting for that nonce",
    file: "src/conversation/turn-coordinator.ts",
    find: "        return admitted?.payload_digest !== digestOf(candidate.payload);",
    replace: "        return false;",
    killedBy: [
      "tests/unit/turn-coordinator.test.ts::refuses a source whose payload is not the one ingress admitted for that nonce",
    ],
  },
  {
    // `assignments.session_id`/`session_incarnation` are the runtime *at binding time*; a
    // SURVIVED failover (#493) moves only `conversational_actors.current_session_id` and leaves
    // `assignments` untouched. Comparing the attestation against the binding-time session made a
    // fresh, honest attestation from a survived counterpart unmatchable — this mutation puts that
    // comparison back.
    what: "attestation currency is judged against the live session, not the one at binding time",
    file: "src/conversation/turn-coordinator.ts",
    find: "            AND sess.incarnation = att.executor_session_incarnation\n          ORDER BY att.attested_at DESC, att.rowid DESC",
    replace:
      "            AND sess.incarnation = att.executor_session_incarnation\n            AND asg.session_id = att.executor_session_id\n            AND asg.session_incarnation = att.executor_session_incarnation\n          ORDER BY att.attested_at DESC, att.rowid DESC",
    killedBy: [
      "tests/unit/turn-coordinator.test.ts::admits a claim after a SURVIVED failover, under the live session and the generation that never changed",
    ],
  },
  {
    // Two reviews found this at finer and finer grain. `role = kind` (an intermediate version of
    // this join) scoped to the actor's own role and was still not enough: generation is minted
    // per role_key, and `bind()` can reuse one physical actor across *different* role_keys that
    // share one role (#657) — `WORKER:task-A` and `WORKER:task-B` both have `role = 'WORKER'` and
    // each counts its own generation from 1. A `role`-only fix cannot tell them apart, so a stale
    // attestation for task-A's retired generation 1 is revived by task-B's own, unrelated,
    // generation 1. `assignment_id` has no such ambiguity — it names the exact role_key and
    // generation together, which a bare role name (or a bare generation number) cannot.
    what: "currency is judged on the exact assignment this attestation was made under, not on role alone",
    file: "src/conversation/turn-coordinator.ts",
    find: "           JOIN assignments asg\n             ON asg.assignment_id = att.assignment_id\n            AND asg.actor_id = ca.actor_id\n            AND asg.status = 'ACTIVE'",
    replace:
      "           JOIN assignments asg\n             ON asg.actor_id = ca.actor_id\n            AND asg.status = 'ACTIVE'\n            AND asg.role = ca.kind",
    killedBy: [
      "tests/unit/turn-coordinator.test.ts::refuses an unrelated role_key's generation reviving a retired one under the same role",
    ],
  },
  {
    // `assignment_id` pins *which* assignment an attestation speaks for; on its own it does not
    // check what the attestation *claims* about that assignment. A third review found this left
    // open: an attestation citing a real, currently ACTIVE assignment_id while recording a
    // generation that assignment's own row does not carry — the join matched on identity alone,
    // admitted the claim, and `canonical_turns` recorded a generation no attestation ever
    // attested.
    what: "an attestation's own generation must agree with the assignment it names, not just its identity",
    file: "src/conversation/turn-coordinator.ts",
    find: "            AND asg.binding_generation = att.binding_generation\n",
    replace: "",
    killedBy: [
      "tests/unit/turn-coordinator.test.ts::refuses an attestation whose claimed generation disagrees with the assignment it names",
    ],
  },
  {
    // The write-time half of the same fix: refused at the source, not only read back out.
    what: "an attestation whose generation disagrees with its assignment is refused at write time",
    file: "src/db/schema.sql",
    find: "WHEN NEW.assignment_id IS NOT NULL\n AND EXISTS (\n   SELECT 1 FROM assignments\n    WHERE assignment_id = NEW.assignment_id\n      AND binding_generation <> NEW.binding_generation\n )\nBEGIN",
    replace: "WHEN 0\nBEGIN",
    killedBy: [
      "tests/unit/turn-coordinator.test.ts::refuses to record an attestation whose generation disagrees with the assignment it names",
    ],
  },
  {
    // `target_binding_id` implies an actor (via `actor_target_bindings`); `assignment_id` implies
    // one too (via `assignments.actor_id`). Nothing but this condition checks that they agree —
    // without it, an attestation can cite a real, correctly-generationed assignment that simply
    // belongs to someone else, and the generation trigger has no way to see the mismatch because
    // there isn't one: the cited assignment's generation is exactly right, for its own actor.
    what: "the assignment consulted for currency must belong to this binding's own actor",
    file: "src/conversation/turn-coordinator.ts",
    find: "            AND asg.actor_id = ca.actor_id\n",
    replace: "",
    killedBy: [
      "tests/unit/turn-coordinator.test.ts::refuses an attestation whose assignment_id names a different actor's assignment entirely",
    ],
  },
  {
    // `conversational_actors.current_session_incarnation` is itself a copy of
    // `sessions.incarnation`, one table further out than the assignment's own generation. Nothing
    // compared it to that authority — only to another copy on the attestation, which is exactly
    // what let a fabricated incarnation, quietly written straight into the actor's column, sail
    // through unnoticed.
    what: "the incarnation is judged against the session's own column, not only the actor's copy of it",
    file: "src/conversation/turn-coordinator.ts",
    find: "            AND sess.incarnation = att.executor_session_incarnation\n",
    replace: "",
    killedBy: [
      "tests/unit/turn-coordinator.test.ts::refuses an attestation whose incarnation was never the session's own, though the actor's copy agrees",
    ],
  },
  {
    // The write-time half, on the insert path `mintActor` takes.
    what: "an actor cannot be created pointing at a session under an incarnation that session never had",
    file: "src/db/schema.sql",
    find: "CREATE TRIGGER IF NOT EXISTS conversational_actors_incarnation_matches_session_on_insert\nBEFORE INSERT ON conversational_actors\nWHEN NEW.current_session_id IS NOT NULL\n AND EXISTS (",
    replace:
      "CREATE TRIGGER IF NOT EXISTS conversational_actors_incarnation_matches_session_on_insert\nBEFORE INSERT ON conversational_actors\nWHEN 0\n AND EXISTS (",
    killedBy: [
      "tests/unit/turn-coordinator.test.ts::refuses to insert an actor whose incarnation was never the session's own",
    ],
  },
  {
    // The write-time half, on the update path a later switch or a raw write takes.
    what: "an actor's incarnation copy cannot be moved away from the session it names",
    file: "src/db/schema.sql",
    find: "CREATE TRIGGER IF NOT EXISTS conversational_actors_incarnation_matches_session_on_update\nBEFORE UPDATE OF current_session_id, current_session_incarnation ON conversational_actors\nWHEN NEW.current_session_id IS NOT NULL\n AND EXISTS (",
    replace:
      "CREATE TRIGGER IF NOT EXISTS conversational_actors_incarnation_matches_session_on_update\nBEFORE UPDATE OF current_session_id, current_session_incarnation ON conversational_actors\nWHEN 0\n AND EXISTS (",
    killedBy: [
      "tests/unit/turn-coordinator.test.ts::refuses to move the actor's incarnation copy away from the session it names",
    ],
  },
  {
    // The runtime-ready trigger only checks READY at the moment the pointer is written
    // (`conversational_actors_runtime_ready`); nothing re-checks it afterwards.
    // `SessionRegistry.transition` can move a session to ERROR or STOPPED without ever touching
    // the actor's live pointer, so pointing at *a* session is not the same fact as pointing at one
    // still usable.
    what: "the live pointer's session must still be usable, not merely still pointed at",
    file: "src/conversation/turn-coordinator.ts",
    find: "            AND sess.lifecycle = 'READY'\n",
    replace: "",
    killedBy: [
      "tests/unit/turn-coordinator.test.ts::refuses an attestation whose named session is no longer usable, though still the live pointer",
    ],
  },
  {
    // The wide version: releasing by file let a bystander's close hand the owner's slot away.
    what: "closing a handle frees only the capability slots that handle issued",
    file: "src/db/database.ts",
    find: '    if (this.#issuedHere.has("materialization")) {\n      ISSUED_TURN_MATERIALIZATION_AUTHORITIES.delete(this.identity);\n    }',
    replace: "    ISSUED_TURN_MATERIALIZATION_AUTHORITIES.delete(this.identity);",
    killedBy: ["tests/unit/ops-hardening.test.ts"],
  },
  {
    // The narrow version: never releasing made the issuance a process-lifetime lockout.
    what: "a capability slot is released when the connection holding it closes",
    file: "src/db/database.ts",
    find: "  close(): void {\n    if (this.#raw.open) this.#raw.close();\n    this.releaseIssuedCapabilities();",
    replace: "  close(): void {\n    if (this.#raw.open) this.#raw.close();",
    killedBy: ["tests/unit/ops-hardening.test.ts"],
  },
  {
    // v25 dropped eight of twenty-eight and recreated with IF NOT EXISTS, so twenty kept whatever
    // body they had. A database from 132309a then threw on every settlement and opened clean.
    what: "a migration that recreates the ledger triggers drops all of them first",
    file: "src/db/migrations.ts",
    find: "    raw.exec(ledgerTriggerDrops());\n    rebuildObservationsIfStale(raw);",
    replace: "    rebuildObservationsIfStale(raw);",
    killedBy: ["tests/unit/a-database-built-by-an-earlier-head.test.ts"],
  },
  {
    // A stale body always keeps its denial marker, so the substring check could never see one.
    what: "a load-bearing trigger is checked by its body, not by its name and marker",
    file: "src/db/migrations.ts",
    find: "    if (row?.sql && expectedBody !== undefined && normaliseTriggerSql(row.sql) !== expectedBody) {",
    replace: "    if (false) {",
    killedBy: ["tests/unit/a-database-built-by-an-earlier-head.test.ts"],
  },
  {
    // Two names for one inode were two capability slots, so a hard-link alias got its own.
    what: "the capability key names the file, not a path that reaches it",
    file: "src/db/database.ts",
    find: "            const stat = statSync(this.file);\n            return `${stat.dev}:${stat.ino}`;",
    replace: "            void statSync(this.file);\n            return this.file;",
    killedBy: ["tests/unit/ops-hardening.test.ts"],
  },
  {
    // A control plane that threw mid-construction kept the slots; no value came back to close.
    what: "a composition root that fails to build releases what it took",
    file: "src/app/control-plane.ts",
    find: "    } catch (error) {\n      this.db.close();\n      throw error;\n    }",
    replace: "    } catch (error) {\n      throw error;\n    }",
    killedBy: ["tests/unit/a-control-plane-that-failed-to-build.test.ts"],
  },
  {
    // Issuers that keep their own registry outlived the handle without this.
    what: "an issuer in another module hands its slot back when the connection closes",
    file: "src/db/database.ts",
    find: "    for (const release of this.#releases) release();",
    replace: "    for (const release of this.#releases) void release;",
    killedBy: ["tests/unit/a-control-plane-that-failed-to-build.test.ts"],
  },
  {
    // Before the door existed the daemon refused to start on a contradiction, so the action the
    // doctor named had no socket to reach.
    what: "a contradicted conversation parks the daemon instead of stopping it",
    file: "src/daemon/daemon.ts",
    find: '      finding.code.startsWith("CANONICAL_TURN_"),',
    replace: "      false,",
    killedBy: ["tests/unit/the-quarantine-has-an-operator-door.test.ts"],
  },
  {
    // Parking is weaker than stopping, so it must stay unreachable for a finding no door clears.
    what: "parking stays unreachable for a finding an operator cannot answer",
    file: "src/daemon/daemon.ts",
    find: "  blockingFindings.length > 0 &&\n  blockingFindings.every(",
    replace: "  blockingFindings.length > 0 &&\n  blockingFindings.some(",
    killedBy: ["tests/unit/the-quarantine-has-an-operator-door.test.ts"],
  },
  {
    // Without it the operator's remedy lands and `daemon.status` reports BOOTSTRAP for another
    // four minutes, which is the report disagreeing with what just happened.
    what: "a landed adjudication promotes the daemon rather than waiting out the recheck timer",
    file: "src/daemon/daemon.ts",
    find: '          if (adjudicated.allowed && this.#mode === "BOOTSTRAP") this.wakeBootstrap("OBSERVED");',
    replace: "          void adjudicated;",
    killedBy: ["tests/unit/daemon-bootstrap-door.test.ts"],
  },
  {
    // A refused adjudication changed nothing the doctor can see, so spending the wake-up on it
    // promotes on the strength of a denial.
    what: "a refused adjudication does not spend the park's wake-up",
    file: "src/daemon/daemon.ts",
    find: '          if (adjudicated.allowed && this.#mode === "BOOTSTRAP") this.wakeBootstrap("OBSERVED");\n          return adjudicated;',
    replace: '          if (this.#mode === "BOOTSTRAP") this.wakeBootstrap("OBSERVED");\n          return adjudicated;',
    killedBy: ["tests/unit/daemon-bootstrap-door.test.ts"],
  },
  {
    // The census could not see `BEFORE UPDATE OF`, so sixteen triggers were invisible to it —
    // `sessions` among them, whose secret hash a REPLACE rewrote on ACP's own connection.
    what: "the REPLACE census sees a guard written as BEFORE UPDATE OF a column",
    file: "scripts/verify-append-only-tables-are-closed.mjs",
    find: "  /CREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(\\w+)\\s*\\nBEFORE (INSERT|UPDATE|DELETE)(?: OF [^\\n]*?)?\\s+ON (\\w+)/g,",
    replace: "  /CREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(\\w+)\\s*\\nBEFORE (INSERT|UPDATE|DELETE) ON (\\w+)/g,",
    killedBy: ["tests/process/the-replace-census-sees-every-guard-form.test.ts"],
  },
  {
    // A credential the schema calls immutable, rewritten by a statement its guard never sees.
    what: "a session row cannot be rewritten by replacing it",
    file: "src/db/schema.sql",
    find: "  SELECT RAISE(ABORT, 'SESSION_NO_REPLACE');",
    replace: "  SELECT 1;",
    killedBy: ["tests/unit/replace-cannot-rewrite-a-guarded-row.test.ts"],
  },
  {
    // Naming less than the key refuses legitimate inserts; this one refused a rotation.
    what: "a REPLACE guard names its table's whole key",
    file: "src/db/schema.sql",
    find: "   WHERE (actor_id = NEW.actor_id AND actor_generation = NEW.actor_generation)",
    replace: "   WHERE (actor_id = NEW.actor_id)",
    killedBy: ["tests/unit/replace-cannot-rewrite-a-guarded-row.test.ts"],
  },
  {
    // Its first version required the WHEN clause on one line and silently checked sixteen of
    // twenty triggers, in the check written to close the census's blind spot.
    what: "the key check reads every no_replace trigger, whatever its line breaks",
    file: "scripts/verify-append-only-tables-are-closed.mjs",
    find: "  const uncovered = keys.filter(",
    replace: "  const uncovered = [].filter(",
    killedBy: ["tests/process/the-replace-census-sees-every-guard-form.test.ts"],
  },
  {
    // Dropping the predicate refuses legitimate inserts; dropping the index refuses nothing —
    // measured both ways, fifty-seven broken tests one way and a silent deletion the other.
    what: "a partial unique index contributes a key carrying its own predicate",
    file: "scripts/verify-append-only-tables-are-closed.mjs",
    find: "    keys.push(where === null ? columns : { columns, predicate: where[1].trim() });",
    replace: "    if (where === null) keys.push(columns);",
    killedBy: ["tests/process/the-replace-census-sees-every-guard-form.test.ts"],
  },
  {
    // Four conditions decide whether a repeated receipt is a redelivery or a second claim, and
    // replacing any one with `true` broke no test — `CONVERSATION_TURN_RECEIPT_REUSED` appeared
    // in none.
    what: "a receipt redelivered onto a different turn is refused",
    file: "src/conversation/turn-coordinator.ts",
    find: "          already.turn_request_id === identity.turnRequestId &&",
    replace: "          true &&",
    killedBy: ["tests/unit/a-receipt-identity-names-one-claim.test.ts"],
  },
  {
    what: "a receipt redelivered with a different outcome is refused",
    file: "src/conversation/turn-coordinator.ts",
    find: "          already.observed_outcome === observation.outcome &&",
    replace: "          true &&",
    killedBy: ["tests/unit/a-receipt-identity-names-one-claim.test.ts"],
  },
  {
    what: "a receipt redelivered with different evidence is refused",
    file: "src/conversation/turn-coordinator.ts",
    find: "          already.evidence_digest === observation.evidenceDigest &&",
    replace: "          true &&",
    killedBy: ["tests/unit/a-receipt-identity-names-one-claim.test.ts"],
  },
  {
    what: "a receipt redelivered with a different reason code is refused",
    file: "src/conversation/turn-coordinator.ts",
    find: "          already.reason_code === observation.reasonCode;",
    replace: "          true;",
    killedBy: ["tests/unit/a-receipt-identity-names-one-claim.test.ts"],
  },
  {
    // Two spellings of one directory resolved to two strings, and production was reachable twice.
    what: "containment is judged on what a path is, not on how it was spelled",
    file: "src/acceptance/disposable-realm.ts",
    find: "  const parentIdentity = identityOf(parent);",
    replace: "  const parentIdentity = null;",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // It asked "is it the same" while every other check here asks "is it inside", so a probe one
    // directory under the canonical root passed while still addressing the owner's conversation.
    what: "a probe target inside the canonical root is refused, not only one equal to it",
    file: "src/acceptance/disposable-realm.ts",
    find: "  if (within(settled(request.canonicalTargetRoot), settled(request.probeTargetRoot))) {",
    replace: "  if (false) {",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // A hard link resolves to itself while the bytes belong to production.
    what: "a realm file with a second name on disk is refused",
    file: "src/acceptance/disposable-realm.ts",
    find: "    if (existing?.isFile() === true && existing.nlink > 1) {",
    replace: "    if (false) {",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // The inputs whose comparison is the safety decision were the ones never required absolute.
    what: "the probe and canonical roots have to be absolute, like every other path here",
    file: "src/acceptance/disposable-realm.ts",
    find: '    ["probeTargetRoot", request.probeTargetRoot],\n    ["canonicalTargetRoot", request.canonicalTargetRoot],\n  ] as const) {',
    replace: "  ] as const) {",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // existsSync follows the link, so a dangling leftover read as clean.
    what: "residue is the directory entry, not what it points at",
    file: "src/acceptance/disposable-realm.ts",
    find: "      lstatSync(path);",
    replace: "      statSync(path);",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // ENOENT from a dangling symlink is a directory entry that redirects writes, not an absence.
    what: "a symlink to a file that does not exist yet is resolved through, not walked past",
    file: "src/acceptance/disposable-realm.ts",
    find: "      if (entry?.isSymbolicLink() === true) {",
    replace: "      if (false) {",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // The probe's Hermes instance would build its transcripts inside production state.
    what: "a probe target inside production is refused",
    file: "src/acceptance/disposable-realm.ts",
    find: "  if (within(production, settled(request.probeTargetRoot))) {",
    replace: "  if (false) {",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // The owner's conversation root inside the directory this run is licensed to delete.
    what: "the canonical root may not sit inside the directory cleanup removes whole",
    file: "src/acceptance/disposable-realm.ts",
    find: "  if (within(settled(request.paths.stateDir), settled(request.canonicalTargetRoot))) {",
    replace: "  if (false) {",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // Under WAL the sidecar is where the write lands, and it was outside every check.
    what: "the database's sidecars are checked the same way the database is",
    file: "src/acceptance/disposable-realm.ts",
    find: "    ...family,",
    replace: "",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // The path used to reach a link and the directory it lives in are different places once an
    // ancestor is itself a link, and a relative target follows the second.
    what: "a relative symlink target is resolved against the directory the link is in",
    file: "src/acceptance/disposable-realm.ts",
    find: "        const target = resolve(realpathSync(dirname(probe)), readlinkSync(probe));",
    replace: "        const target = resolve(dirname(probe), readlinkSync(probe));",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // A hand-written list here says "every path" and means "the ones someone remembered".
    what: "the checked path set is derived from RealmPaths rather than listed",
    file: "src/acceptance/disposable-realm.ts",
    find: "    ...Object.entries(request.paths).map(([name, path]) => [name, path] as const),",
    replace: '    ["stateDir", request.paths.stateDir] as const,',
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // `slice(1)` meant "all but the state directory" only while it happened to be written first.
    what: "the state directory is excluded from the containment loop by name, not by position",
    file: "src/acceptance/disposable-realm.ts",
    find: '  for (const [name, path] of named.filter(([field]) => field !== "stateDir")) {',
    replace: "  for (const [name, path] of named.slice(1)) {",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // Twice on this branch a probe reached production by creating a file there, and the census
    // called production unchanged.
    what: "something appearing under production is a census difference",
    file: "src/acceptance/disposable-realm.ts",
    find: "  if (!sameMultiset(before.productionEntries, after.productionEntries)) {",
    replace: "  if (false) {",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // An unreadable production root reported as empty makes "nothing is there" and "I could not
    // look" the same census.
    what: "a production root that cannot be listed is refused, not reported empty",
    file: "src/acceptance/disposable-realm.ts",
    find: '    if (code === "ENOENT") return allow(ReasonCode.OK, []);',
    replace: '    return allow(ReasonCode.OK, []);',
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // Half a census compares equal on the half it has.
    what: "a census that could not read production is refused rather than returned partial",
    file: "src/acceptance/disposable-realm.ts",
    find: "  if (!entries.allowed) return entries;",
    replace: "  if (false) return entries;",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // The other read. Both had to be separated to be killable: every input where the two fail
    // together leaves either check removable without a test noticing.
    what: "a census whose database family could not be read is refused too",
    file: "src/acceptance/disposable-realm.ts",
    find: "  if (!family.allowed) return family;",
    replace: "  if (false) return family;",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // Three of the five census comparisons had no test that failed when they were removed, in the
    // branch whose subject is exactly that. These two were the ones with no row either.
    what: "a changed assignment id is a census difference",
    file: "src/acceptance/disposable-realm.ts",
    find: "  if (!sameMultiset(before.assignmentIds, after.assignmentIds)) differences.push(\"assignmentIds\");",
    replace: "",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    what: "a changed binding generation is a census difference",
    file: "src/acceptance/disposable-realm.ts",
    find: "  if (!sameMultiset(before.bindingGenerations, after.bindingGenerations)) {",
    replace: "  if (false) {",
    killedBy: ["tests/unit/disposable-realm.test.ts"],
  },
  {
    // Every trigger here is written with `IF NOT EXISTS`, so a pattern requiring it counts only
    // the ones written the way its author pictured — and a trigger added without it was invisible
    // to two gates at once while both printed PASS.
    what: "the REPLACE census sees a trigger written without IF NOT EXISTS",
    file: "scripts/verify-append-only-tables-are-closed.mjs",
    find: "  /CREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(\\w+)\\s*\\nBEFORE (INSERT|UPDATE|DELETE)(?: OF [^\\n]*?)?\\s+ON (\\w+)/g,",
    replace: "  /CREATE TRIGGER IF NOT EXISTS (\\w+)\\s*\\nBEFORE (INSERT|UPDATE|DELETE)(?: OF [^\\n]*?)?\\s+ON (\\w+)/g,",
    killedBy: ["tests/process/the-replace-census-sees-every-guard-form.test.ts"],
  },
  {
    what: "the required-registry check sees a trigger written without IF NOT EXISTS",
    file: "scripts/verify-every-trigger-is-required.mjs",
    find: "const declared = [...schema.matchAll(/CREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(\\w+)/g)].map(",
    replace: "const declared = [...schema.matchAll(/CREATE TRIGGER IF NOT EXISTS (\\w+)/g)].map(",
    killedBy: ["tests/process/the-replace-census-sees-every-guard-form.test.ts"],
  },
  {
    // Requiring one line made a re-formatted entry read as "named by no registry" — a true failure
    // with a false reason, and the reason is what whoever reads it acts on.
    what: "the registry check recognises an entry however it is wrapped",
    file: "scripts/verify-every-trigger-is-required.mjs",
    find: "  [...migrations.matchAll(/\\{\\s*name:\\s*\"(\\w+)\"\\s*,\\s*sentinel:/g)].map((m) => m[1]),",
    replace: "  [...migrations.matchAll(/\\{ name: \"(\\w+)\", sentinel:/g)].map((m) => m[1]),",
    killedBy: ["tests/process/the-replace-census-sees-every-guard-form.test.ts"],
  },
  {
    // I documented this as unkillable and was refuted: an adjudication moves the turn off
    // CONTRADICTED while the completion observation stays on it.
    what: "a completion observation still blocks a retry after an adjudication",
    file: "src/conversation/turn-coordinator.ts",
    find: "        (anyCompletion?.n ?? 0) === 0 &&",
    replace: "        true &&",
    killedBy: ["tests/unit/a-receipt-identity-names-one-claim.test.ts"],
  },
  {
    // The quarantine is per actor, and this is the line that makes it so.
    what: "an adjudication may only be recorded by the actor whose turn it is",
    file: "src/conversation/turn-coordinator.ts",
    find: "      if (!turn || turn.target_actor_id !== input.targetActorId) {",
    replace: "      if (!turn) {",
    killedBy: ["tests/unit/adjudicating-a-disagreement.test.ts"],
  },
  {
    // A column written `<name> TYPE ... UNIQUE` is a key, and only the parenthesised form was read.
    what: "the REPLACE census sees a UNIQUE declared on the column",
    file: "scripts/verify-append-only-tables-are-closed.mjs",
    find: "  for (const inline of body.matchAll(/^\\s*(\\w+)\\s+[A-Z][^\\n]*?\\bUNIQUE\\b[^\\n]*$/gm)) {",
    replace: "  for (const inline of []) {",
    killedBy: ["tests/process/the-replace-census-sees-every-guard-form.test.ts"],
  },
  {
    // Contract 1's whole point, landing here: a turn claimed under one CEO generation is a
    // different CEO's work from a receipt minted under the next. Without this a reconciler
    // completes a turn on a receipt that was never about this claim.
    what: "a receipt naming a different CEO generation cannot complete the turn it names",
    file: "src/conversation/turn-coordinator.ts",
    find: "      if (row.binding_generation !== attested.bindingGeneration) {",
    replace: "      if (false) {",
    killedBy: [
      "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::does not complete a turn on a receipt naming a different CEO generation, and keeps sweeping the rest",
    ],
  },
  {
    // Sol's review of #691, round 1: the query the reconciler sends is built from the row it is
    // about to check, so an identity check built from that query instead of the port's answer
    // compares the database against itself and cannot fail. Reverting `result.targetActorId` to
    // `candidate.targetActorId` here reintroduces exactly that — a receipt attesting to the wrong
    // actor settles the turn anyway, because nothing but the candidate (self-sourced) was checked.
    what: "the reconciler checks the actor the receipt attests to, not the actor it already knew",
    file: "src/conversation/turn-coordinator.ts",
    find: "targetActorId: result.targetActorId,",
    replace: "targetActorId: candidate.targetActorId,",
    killedBy: [
      "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::does not complete a turn when the receipt attests to the wrong actor, even though the query it was asked under was correct",
    ],
  },
  {
    // Same defect, the other content field the tautology swallowed.
    what: "the reconciler checks the prompt digest the receipt attests to, not the one it already knew",
    file: "src/conversation/turn-coordinator.ts",
    find: "promptDigest: result.promptDigest,",
    replace: "promptDigest: candidate.promptDigest,",
    killedBy: [
      "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::does not complete a turn when the receipt attests to the wrong prompt",
    ],
  },
  {
    // Sol's review of #691, round 2: `reconcileWithReceipt` used to be public and receipt-shaped,
    // so anyone holding the coordinator could read a turn's identity from `unresolvedIdentities()`
    // and hand it back with a fabricated receipt — no `ReceiptPort` ever consulted. Restoring a
    // public method of that shape (taking a receipt as a plain argument) reopens exactly that; the
    // forgery test proves no such method exists to call.
    what: "no public method accepts a receipt from a caller — only this coordinator's own port can produce one",
    file: "src/conversation/turn-coordinator.ts",
    find: "  async reconcileUnresolved(",
    replace: "  reconcileWithReceipt(query, receipt) { return this.#settleFromReceipt(query.turnRequestId, query, receipt); }\n\n  async reconcileUnresolved(",
    killedBy: [
      "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::attack 1 — reassigning the coordinator's bound receipt port has no effect: the real field is not reachable by that name",
    ],
  },
  // No mutation row for "#receiptPort is a true private field": the only mechanical mutation that
  // removes it — un-prefixing the declaration while every read site still says `this.#receiptPort`
  // — does not compile. Measured: esbuild refuses it (`Private name "#receiptPort" must be
  // declared in an enclosing class`), vitest collects zero tests, and the harness would have
  // reported that as a "kill" without the named test's own assertion ever running — a collection
  // error standing in for a RED. The guard is real and is demonstrated by hand instead: reverting
  // this field and the exported singleton's freeze together (both are needed to keep the file
  // compiling) reopens attack 1 and attack 2 below, and restoring them closes it again.
  {
    // The other half of the same review: even a private field does not help if the *object* it
    // defaults to is exported, shared and mutable. Un-freezing here reopens overwriting
    // `NEVER_FOUND_RECEIPT_PORT.lookup` in place — no coordinator field ever touched, every
    // coordinator using the default affected.
    what: "the exported default receipt port is frozen, so its lookup method cannot be reassigned in place",
    file: "src/conversation/turn-coordinator.ts",
    find: "export const NEVER_FOUND_RECEIPT_PORT: ReceiptPort = Object.freeze({",
    replace: "export const NEVER_FOUND_RECEIPT_PORT: ReceiptPort = ({",
    killedBy: [
      "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::attack 2 — tampering with the exported NEVER_FOUND_RECEIPT_PORT singleton throws, and its answer is unchanged",
    ],
  },
  {
    // Contract 1's fourth field. Without this, a receipt for one turn can settle a different one
    // that happens to share the same actor, prompt and generation — precisely the case #691's round
    // 1 fix left unchecked, because `turnRequestId` was still taken from the query, not the answer.
    what: "a receipt attesting to a different turn than the one asked about cannot settle it",
    file: "src/conversation/turn-coordinator.ts",
    find: "    if (attested.turnRequestId !== turnRequestId) {",
    replace: "    if (false) {",
    killedBy: [
      "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::does not complete a turn when the receipt attests to a different turn id than the one asked about, even though actor, prompt and generation all agree",
    ],
  },
  {
    // Sol's third review of #691: contract 6 requires a matched receipt to move `TURN_COMPLETED`
    // and insert one reply-outbox item atomically, and nothing wired to `canonical_turns` performs
    // the second half. Removing this refusal reopens the exact gap: a receipt with perfectly
    // matching identity would record `COMPLETED` with no way to prove any reply was ever
    // preserved, and that transition cannot be undone through the ordinary API.
    what: "a receipt reporting completion is refused, because no reply-outbox insert can accompany it yet",
    file: "src/conversation/turn-coordinator.ts",
    find: '    if (receipt.outcome === "COMPLETED") {',
    replace: "    if (false) {",
    killedBy: [
      "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::does not complete a turn even when every identity field matches, because the reply obligation cannot yet be discharged",
    ],
  },
  {
    // #649 part A: `bind()` minted a fresh actor unconditionally, so re-bootstrapping against the
    // same Hermes transcript produced a second owner beside the first — two actors that collide on
    // nothing, so the alias was silent. Without this line the reuse path is computed and then
    // discarded, which is exactly that regression.
    what: "bind reuses the actor that already owns a verified target instead of minting a second one",
    file: "src/session/binding-registry.ts",
    find: "      const actorId = reused.value ?? this.mintActor(input.role, input.sessionId, session.incarnation);",
    replace: "      const actorId = this.mintActor(input.role, input.sessionId, session.incarnation);",
    killedBy: [
      "tests/unit/reconstitution-needs-a-verified-target.test.ts::reuses the actor rather than minting a second owner",
    ],
  },
  {
    // #664/#679 — acknowledgeHandoff's ACKED write must not survive a denial from the
    // nested bindings.switchTo call underneath it.
    what: "acknowledgeHandoff's ACKED write rolls back when switchTo denies underneath it",
    file: "src/cto/cto-lifecycle.ts",
    find: "    // #664 — this body's own ACKED write must not survive a denial, including one\n    // that comes back from the nested `bindings.switchTo` call below.\n    return this.db.txDecision(() => {",
    replace: "    // #664 — this body's own ACKED write must not survive a denial, including one\n    // that comes back from the nested `bindings.switchTo` call below.\n    return this.db.tx(() => {",
    killedBy: [
      "tests/scenarios/registry-cto.test.ts::#664 — acknowledgeHandoff's own ACKED write rolls back when switchTo denies underneath it",
    ],
  },
  {
    // A takeover that cannot repoint every live execution to the new generation must not
    // leave the old generation revoked and a new one minted — the guard that keeps a
    // run from being pinned to a revoked generation.
    what: "switchTo refuses a takeover that would strand a live, unabandonable execution",
    file: "src/session/binding-registry.ts",
    find: "        if (staleExecutions.length > 0 && !this.#tasks) {",
    replace: "        if (false) {",
    killedBy: [
      "tests/unit/binding-hardening.test.ts::switchTo denies a takeover that would strand a live, unabandonable execution, and rolls back its own writes",
    ],
  },
  {
    // Sol's fifth review of #691: `bindingGeneration` alone does not fence a `SURVIVED` failover,
    // which moves an actor's live runtime to a new session while deliberately keeping the same
    // generation. Removing this check reopens exactly that: a receipt naming the wrong target
    // binding would still settle the turn as long as turn, actor, prompt and generation agreed.
    what: "a receipt naming a different target binding than the one this turn was claimed against is refused",
    file: "src/conversation/turn-coordinator.ts",
    find: "      if (row.target_binding_id !== attested.targetBindingId) {",
    replace: "      if (false) {",
    killedBy: [
      "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::does not complete a turn when the receipt attests to the wrong target binding",
    ],
  },
  {
    // Same review, the attestation field: a stale or replaced attestation is not evidence about a
    // turn claimed under a different one, even when the binding and generation both still agree.
    what: "a receipt naming a different attestation than the one that verified this turn's target is refused",
    file: "src/conversation/turn-coordinator.ts",
    find: "      if (row.target_attestation_id !== attested.targetAttestationId) {",
    replace: "      if (false) {",
    killedBy: [
      "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::does not complete a turn when the receipt attests to the wrong attestation",
    ],
  },
  {
    // The field that actually catches a `SURVIVED` failover: `BindingRegistry.switchTo` moves the
    // actor's runtime to a new session while leaving `binding_generation` untouched, so this is
    // the one check standing between that failover and a wrongly settled turn.
    what: "a receipt naming a different executor session or incarnation than the one this turn was claimed under is refused",
    file: "src/conversation/turn-coordinator.ts",
    find: "        row.executor_session_id !== attested.executorSessionId ||",
    replace: "        false ||",
    killedBy: [
      "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::does not complete a turn when the receipt attests to a different runtime than the one this turn was claimed under, after a SURVIVED failover keeps the generation unchanged",
    ],
  },
  {
    // Sol's sixth review: `ReceiptPort.lookup` may return a `Promise` that never settles — a
    // legitimate slow implementation, not a misbehaving one — and the sweep used to await it with
    // no bound. Reverting to the bare port call here reopens that hang for every candidate after
    // the stuck one, and for the daemon startup call this sweep runs from.
    what: "a receipt lookup that never settles is bounded by a timeout, not awaited indefinitely",
    file: "src/conversation/turn-coordinator.ts",
    find: "        result = await this.#lookupWithTimeout({",
    replace: "        result = await this.#receiptPort.lookup({",
    killedBy: [
      "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::treats a lookup that never settles as no evidence after its timeout, and keeps sweeping the rest",
    ],
  },
  {
    // Sol's seventh review: a per-lookup timeout only abandoned a slow call, leaving its promise
    // — and any network work behind it — running. Removing the abort here reopens exactly that:
    // a real implementation with something to cancel is never told to.
    what: "a timed-out lookup's signal is aborted, not merely abandoned",
    file: "src/conversation/turn-coordinator.ts",
    find: "        controller.abort(new Error(`receipt lookup for ${query.turnRequestId} timed out`));",
    replace: "        void 0;",
    killedBy: [
      "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::aborts the signal it gave a lookup once that lookup's own timeout fires",
    ],
  },
  {
    // Sol's eighth review: a per-lookup timeout bounds one turn, not the whole pass. Seven
    // honestly slow lookups in one sweep add up past the periodic interval, and `runPeriodic` has
    // no in-flight guard — removing this check reopens the overlap the budget exists to prevent.
    what: "the sweep stops issuing new lookups once the whole pass exceeds its own budget",
    file: "src/conversation/turn-coordinator.ts",
    find: "      if (Date.now() - startedAt >= budgetMs) break;",
    replace: "      if (false) break;",
    killedBy: [
      "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::stops issuing new lookups once the whole pass exceeds its own budget, leaving the rest for the next sweep",
    ],
  },
  {
    // Sol's second (of this round) finding: a sweep that silently swallows every lookup failure
    // and still reports success is indistinguishable, to the daemon, from a port with nothing to
    // find. Removing the increment here reopens that — `failed` stays 0 no matter how many
    // lookups actually failed.
    what: "the sweep counts lookups it could not get an honest answer from",
    file: "src/conversation/turn-coordinator.ts",
    find: "        failed += 1;",
    replace: "        void 0;",
    killedBy: [
      "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::does not stop the sweep when one lookup throws",
    ],
  },
  {
    // The daemon-side half of the same finding: `runPeriodic` only backs off and audits on a
    // thrown `action()`. Without this throw, a sweep reporting `failed > 0` still reads to
    // `runPeriodic` — and to the health file — as an ordinary success.
    what: "the daemon throws when a turn-reconciliation sweep reports any failed lookups, so runPeriodic can see it",
    file: "src/daemon/daemon.ts",
    find: "    if (result.failed > 0) {",
    replace: "    if (false) {",
    killedBy: [
      "tests/unit/doctor-daemon-r2.test.ts::#639: a receipt port that fails every lookup is audited and degrades the health file, not read as an empty ledger",
    ],
  },
  {
    // The adapter owns the distinction: a 400 is terminal for this reply, while 429 and 5xx are
    // service conditions that stop the batch. Folding 400 into the latter restores the wedge.
    what: "a Telegram 400 is a permanent rejection rather than a retryable service condition",
    file: "src/ingress/telegram-polling.ts",
    find: "  if (statusCode === 429 || statusCode >= 500) {",
    replace: "  if (statusCode >= 400) {",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a permanent 400 records an unanswerable reply and advances past 101 later updates",
    ],
  },
  {
    // Telegram's response body is the only source of retry_after. Reading only the HTTP status
    // stops the current storm but schedules the next attempt earlier than Telegram requested.
    what: "a Telegram 429 preserves its retry after instruction",
    file: "src/ingress/telegram-polling.ts",
    find: "      retryAfterSeconds: statusCode === 429 ? telegramRetryAfterSeconds(payload) : null,",
    replace: "      retryAfterSeconds: null,",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a 429 rate limit stops the batch before later replies and owner gate prompts",
    ],
  },
  {
    // A known-not-sent service failure is safe to retry, but later sends in this batch must wait
    // for the requested or default backoff rather than joining the same outage.
    what: "a retryable Telegram service failure stops the current batch",
    file: "src/ingress/telegram-polling.ts",
    find:
      "          if (error.failure.kind === \"RETRYABLE\") {\n" +
      "            this.router.releaseResponse(outcome);\n" +
      "            throw error;\n" +
      "          }",
    replace:
      "          if (false) {\n" +
      "            this.router.releaseResponse(outcome);\n" +
      "            throw error;\n" +
      "          }",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a 5xx outage stops the batch before later replies and owner gate prompts",
    ],
  },
  {
    // Advancing is safe only after the permanent rejection is durably terminal. Releasing it to
    // RETRYABLE while advancing recreates the silent orphan behind the round-four wedge.
    what: "a permanent Telegram rejection is durably recorded as terminal",
    file: "src/ingress/telegram-polling.ts",
    find: "            this.router.abandonResponse(outcome, error.failure);",
    replace: "            this.router.releaseResponse(outcome);",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a permanent 400 records an unanswerable reply and advances past 101 later updates",
    ],
  },
  {
    // The first unknown result owns the batch until its one retry. Continuing immediately would
    // let later work pass an outcome that still has automatic recovery remaining.
    what: "the first unknown Telegram result holds the batch and offset for its bounded retry",
    file: "src/ingress/telegram-polling.ts",
    find:
      "          } else if (!this.router.recordUnknownResponse(outcome, error.failure)) {\n" +
      "            throw error;\n" +
      "          }",
    replace:
      "          } else {\n" +
      "            this.router.recordUnknownResponse(outcome, error.failure);\n" +
      "          }",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a lost response retries once then records unresolved and advances the offset",
    ],
  },
  {
    // Terminal delivery states are useful only if the inbound acknowledgement moves past them.
    // Removing this update leaves the unanswerable row visible but restores the 100-update wedge.
    what: "a terminal Telegram reply advances the inbound offset",
    file: "src/ingress/telegram-polling.ts",
    find: "      if (Number.isSafeInteger(update.update_id)) {",
    replace: "      if (false && Number.isSafeInteger(update.update_id)) {",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a permanent 400 records an unanswerable reply and advances past 101 later updates",
    ],
  },
  {
    // Two means the initial ambiguous result plus one ambiguous retry. Raising it silently grows
    // the duplicate bound and delays the terminal state that lets later ingress proceed.
    what: "an unknown Telegram reply gets one retry before becoming unresolved",
    file: "src/ingress/telegram-router.ts",
    find: "const UNKNOWN_DELIVERY_ATTEMPT_LIMIT = 2;",
    replace: "const UNKNOWN_DELIVERY_ATTEMPT_LIMIT = 3;",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a lost response retries once then records unresolved and advances the offset",
    ],
  },
  {
    // A terminal row without an authenticated operator surface is still silence. Doctor reads
    // the reply lifecycle directly because managed acknowledgements have no CEO turn claim.
    what: "doctor reports permanently unanswerable Telegram replies",
    file: "src/doctor/doctor.ts",
    find: "          AND json_extract(result_json, '$.deliveryStatus') IN ('UNANSWERABLE', 'UNRESOLVED')",
    replace: "          AND json_extract(result_json, '$.deliveryStatus') = 'UNRESOLVED'",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a permanent 400 records an unanswerable reply and advances past 101 later updates",
    ],
  },
  {
    // The terminal state must outlive ordinary nonce pruning or its Doctor finding disappears and
    // a retained update can look new again after the exact state meant to stop automatic resend.
    what: "terminal Telegram reply failures survive ordinary ingress pruning",
    file: "src/ingress/ingress-guard.ts",
    find:
      "                'PENDING',\n" +
      "                'UNKNOWN_RETRYABLE',\n" +
      "                'UNANSWERABLE',\n" +
      "                'UNRESOLVED'",
    replace:
      "                'PENDING',\n" +
      "                'UNKNOWN_RETRYABLE'",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a lost response retries once then records unresolved and advances the offset",
    ],
  },
];

const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);

/**
 * Check that every row still names a line that exists, and stop — no mutation, no tests.
 *
 * The full sweep takes over an hour, so it is something you run at the end and read in CI. That
 * left a gap wide enough to walk through three times on one branch: editing a guarded line renames
 * its anchor, the row silently stops checking anything, and nothing says so until the sweep gets
 * there. This pass is a string search and costs a second.
 *
 * It runs **before** the snapshot, the sentinel and the dirty check, and takes none of them. The
 * first version sat after all three and called the restore on its way out — so a hook that ran it
 * while a full sweep was mid-mutation wrote its own snapshot over the sweep's work, and the sweep
 * stopped with "changed underneath this run". A read-only check that has side effects is not a
 * read-only check, and this one is meant to be safe to run at any moment.
 */
const anchorsOnly = process.argv.includes("--anchors-only");

const rows = GUARDS.filter((g) => !g.skip).filter(
  (g) => !only || g.what.includes(only) || g.file.includes(only),
);

const out = (line) => process.stdout.write(line + "\n");
const failures = [];

/**
 * The table has as many entries as it has `what:` lines.
 *
 * A missing `},{` merges two rows into one object literal. JavaScript keeps the last value for a
 * duplicate key, so the earlier row is discarded — silently, and by every gate: the sweep reports
 * one fewer row while still saying each killed a named test, `--anchors-only` counts the survivors
 * and calls them all matched, and eslint has nothing to say about a duplicate key in an object
 * literal here. Measured on this file: 99 `what:` lines, 98 objects, and the row for
 * "a receipt redelivered with a different reason code" was gone — one of four conditions this
 * branch had just finished writing tests for.
 *
 * Counting the two is the whole check, and it is the "print what you inspected" rule turned on
 * this file's own table.
 */
const tableSource = readFileSync(fileURLToPath(import.meta.url), "utf8").match(
  /const GUARDS = \[([\s\S]*?)\n\];/,
);
if (tableSource === null) {
  out("verify-guards-are-falsifiable: could not read its own GUARDS table");
  process.exit(2);
}
const declaredWhats = [...tableSource[1].matchAll(/^\s*what: "/gm)].length;
if (declaredWhats !== GUARDS.length) {
  out(
    `verify-guards-are-falsifiable: the table has ${declaredWhats} \`what:\` line(s) and ` +
      `${GUARDS.length} row(s).`,
  );
  out("  A missing `},{` merges two rows into one object; the earlier one is discarded in silence.");
  out(`\nRESULT: FAIL — ${declaredWhats - GUARDS.length} row(s) were lost to a merged literal.`);
  process.exit(1);
}

if (anchorsOnly) {
  const dead = [];
  for (const guard of rows) {
    // The other field that goes stale, and the one nothing was checking. `vitest run <path>` exits
    // non-zero when the path matches no file — "No test files found" is a failure — and this
    // harness reads a non-zero exit as "the guard was killed". So renaming or deleting a
    // `killedBy` file makes its rows report a kill forever, having run no test at all. Found by a
    // review, which is the same way the anchor half was found.
    for (const test of guard.killedBy) {
      const { path: testPath } = splitKilledBy(test);
      if (!existsSync(join(ROOT, testPath))) {
        dead.push({
          guard,
          why: `killedBy names ${testPath}, which does not exist — vitest exits non-zero for a missing path, so this row reports a kill it never ran`,
        });
      }
    }
    const text = readFileSync(join(ROOT, guard.file), "utf8");
    const count = text.split(guard.find).length - 1;
    if (count !== 1) {
      dead.push({
        guard,
        why:
          count === 0
            ? "the mutation no longer matches this file — the guard moved, and this row stopped checking anything"
            : `the mutation matches ${count} places — a row that is not about one specific guard`,
      });
    }
  }
  for (const failure of dead) {
    out(`  ${failure.guard.file}`);
    out(`    ${failure.guard.what}`);
    out(`    ${failure.why}`);
  }
  if (dead.length > 0) {
    out(`\nRESULT: FAIL — ${dead.length} row(s) name a line that is not there.`);
    process.exit(1);
  }
  out(`verify-guards-are-falsifiable: ${rows.length} anchor(s) still match, exactly once each.`);
  out("An anchor that matches is not a guard that is tested — run the full sweep for that.");
  out("RESULT: PASS");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Safety. This edits tracked files in place. A dirty guarded file means a crash
// mid-run would be indistinguishable from the author's own work in progress.
// ---------------------------------------------------------------------------
const files = [...new Set(rows.map((g) => g.file))];

/**
 * The crash path the signal handlers below cannot cover.
 *
 * Every row runs vitest through `spawnSync`, which blocks the event loop for its whole duration.
 * A SIGTERM arriving in that window is queued and never delivered to JS, so the handler does not
 * run and the mutation stays on disk. Observed: a run killed by an outer timeout left a mutated
 * source file behind, and the next run reported it as *the author's* uncommitted work and advised
 * committing it. Following that advice commits a deliberately broken guard.
 *
 * So the originals are also written outside the process, before anything is mutated. A later run
 * reads them back, restores, and says so — which is the difference between a harness that can
 * crash and one whose crash quietly poisons the tree.
 *
 * Kept in the git directory because it must survive the crash, must never be committed, and must
 * not look like a source file to anything that scans the working tree.
 *
 * Resolved through `git rev-parse --git-path` rather than by joining `.git` onto the root. In a
 * linked worktree `.git` is a *file* pointing at the real git directory, so the join produces a
 * path under a regular file and every write dies with ENOTDIR. That is not a corner case here:
 * `git worktree add --detach` is how a review copy of a branch gets made, and this harness ran
 * inside one. Reproduced, then fixed.
 */
const INFLIGHT = resolve(
  ROOT,
  execFileSync("git", ["rev-parse", "--git-path", "verify-guards-in-flight.json"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim(),
);

/**
 * Puts back what this harness is *known* to have written, and refuses to touch anything else.
 *
 * The distinction matters because a crash is not the only thing that happens to a file. Between
 * the death and the next run, someone may legitimately have edited it — and the previous version
 * of this function wrote the snapshot back whenever the bytes differed from the original, which
 * silently destroys that edit. A repair that can eat an unrelated change is a worse failure than
 * the leftover mutation it exists to clean up, because nothing reports it.
 *
 * So three states, and only the middle one is written:
 *
 *   bytes === the original                  already clean; nothing to do
 *   bytes === one of this run's mutations    ours, and provably so; restore it
 *   anything else                            not ours; leave it alone and say so
 *
 * The candidate mutations are recomputed from the rows parked *at the time of the crash*, not
 * from the current table — a row edited since then would otherwise make this run's own leftovers
 * unrecognisable, which is the same blind spot in a slower form.
 */
const repairAbandonedRun = () => {
  let parked;
  try {
    parked = JSON.parse(readFileSync(INFLIGHT, "utf8"));
  } catch {
    return; // No file, or one this version cannot read. Either way there is nothing to put back.
  }
  const repaired = [];
  const unknown = [];
  for (const [file, text] of Object.entries(parked.originals ?? {})) {
    const current = readFileSync(join(ROOT, file), "utf8");
    if (current === text) continue;
    // Mirrors how a mutation is applied: `String.replace` with a string pattern, first match
    // only. The anchor was proven unique before any of them ran.
    const ours = (parked.mutations?.[file] ?? []).some(
      (m) => text.replace(m.find, m.replace) === current,
    );
    if (!ours) {
      unknown.push(file);
      continue;
    }
    writeFileSync(join(ROOT, file), text);
    repaired.push(file);
  }
  if (unknown.length > 0) {
    // Fail closed, and keep the sentinel: whoever resolves this by hand still needs it, and
    // deleting it here would throw away the only record of what the dead run was holding.
    out("verify-guards-are-falsifiable: a previous run died mid-mutation, and these files have");
    out("changed since in a way this harness did not write. Refusing to overwrite them.\n");
    for (const file of unknown) out("  " + file);
    out(`\nThe originals it was holding are in ${INFLIGHT}. Reconcile by hand, then delete it.`);
    process.exit(1);
  }
  rmSync(INFLIGHT, { force: true });
  if (repaired.length > 0) {
    out(`verify-guards-are-falsifiable: a previous run died mid-mutation; restored ${repaired.length} file(s)`);
    for (const file of repaired) out(`  ${file}`);
    out("");
  }
};

// Before the dirty check, because a leftover mutation *is* dirt, and reporting it as the author's
// work in progress is what sends someone to commit a deliberately broken guard.
repairAbandonedRun();

const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter((l) => l.trim().length > 0);
if (dirty.length > 0) {
  out("verify-guards-are-falsifiable: refusing to run — guarded files have uncommitted changes\n");
  for (const line of dirty) out("  " + line);
  out("\nThis harness edits these files and restores them. If it dies mid-run the restore is a\n");
  out("`git checkout --`, which would take your changes with it. Commit or stash first.\n");
  process.exit(1);
}

const originals = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
// The rows go in alongside the originals so a later run can tell this run's leftovers from an
// unrelated edit. Recomputing from the live table instead would stop recognising them the moment
// a row is edited — the same blind spot, arriving later.
writeFileSync(
  INFLIGHT,
  JSON.stringify({
    originals: Object.fromEntries(originals),
    mutations: Object.fromEntries(
      files.map((file) => [
        file,
        rows.filter((g) => g.file === file).map((g) => ({ find: g.find, replace: g.replace })),
      ]),
    ),
  }),
);
/**
 * Refuses to write over a file that is not in the state this harness left it in.
 *
 * Every write here is "put back what I know is there". When that is false, the write is not a
 * restore — it is an overwrite of whatever the other writer did, and it is invisible because
 * the harness goes on to report success.
 */
const ours = (path, expected, file, when) => {
  let actual;
  try {
    actual = readFileSync(path, "utf8");
  } catch (error) {
    fail(`${file} disappeared ${when}: ${error.message}`);
  }
  if (actual !== expected) {
    fail(
      `${file} changed underneath this run — refusing to overwrite it ${when}.\n` +
        "  Something else edited it after the harness snapshotted it at startup. Writing the\n" +
        "  snapshot back would destroy that edit. Nothing has been restored past this point;\n" +
        "  check `git diff` before re-running.",
    );
  }
};

const fail = (message) => {
  out(`verify-guards-are-falsifiable: ${message}\n`);
  process.exit(1);
};

const restore = () => {
  // The sentinel is cleared last, and only after every write above has returned. Clearing it
  // first would hand a crash mid-restore the same blind spot this whole mechanism exists to
  // close.
  for (const [file, text] of originals) {
    // Not `ours`: at this point the file is legitimately either mutated or already restored,
    // so there is no single expected value. Writing the snapshot is right unless the content is
    // neither — but distinguishing that needs the per-row expectation, which the loop above has
    // and this does not. The loop is where the check belongs; this is the crash path.
    writeFileSync(join(ROOT, file), text);
  }
  rmSync(INFLIGHT, { force: true });
};
let restored = false;
const restoreOnce = () => {
  if (!restored) {
    restored = true;
    restore();
  }
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restoreOnce();
    process.exit(130);
  });
}
process.on("uncaughtException", (error) => {
  restoreOnce();
  throw error;
});

// ---------------------------------------------------------------------------
// Structural: every anchor still matches, exactly once.
// ---------------------------------------------------------------------------
for (const guard of rows) {
  const text = originals.get(guard.file);
  const count = text.split(guard.find).length - 1;
  if (count !== 1) {
    failures.push({
      guard,
      why:
        count === 0
          ? "the mutation no longer matches this file — the guard moved, and this row stopped checking anything"
          : `the mutation matches ${count} places — a row that is not about one specific guard`,
    });
  }
}

// ---------------------------------------------------------------------------
// Structural: every enforcement locus is claimed by some row.
// ---------------------------------------------------------------------------
const symbolsSource = readFileSync(join(ROOT, "scripts/verify-enforcement-symbols.mjs"), "utf8");
const lociBlock = symbolsSource.match(/const LOCI = \{([\s\S]*?)\n\};/);
if (!lociBlock) {
  out("verify-guards-are-falsifiable: could not read the LOCI table out of verify-enforcement-symbols.mjs");
  restoreOnce();
  process.exit(1);
}
const loci = [...lociBlock[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
const claimed = new Set(GUARDS.flatMap((g) => g.symbols ?? []));
const unclaimed = loci.filter((s) => !claimed.has(s));

// ---------------------------------------------------------------------------
// Behavioural: remove each guard, require a named test to die.
// ---------------------------------------------------------------------------
try {
  for (const guard of rows) {
    if (failures.some((f) => f.guard === guard)) continue;
    const path = join(ROOT, guard.file);
    const original = originals.get(guard.file);
    // The snapshot was taken at startup, and a write from here is a write of that startup
    // content. If someone edited the file since — the run takes minutes, and the natural thing
    // to do while waiting is keep working — restoring the snapshot silently destroys their
    // edit. That happened on 2026-08-20, on a run that exited 0.
    //
    // So each write checks that the file is still where this harness left it. The startup guard
    // cannot cover this: it looks once, and what it establishes is only true at that instant.
    ours(path, original, guard.file, "before mutating");
    const mutated = original.replace(guard.find, guard.replace);
    writeFileSync(path, mutated);
    const done = spawnSync(VITEST, ["run", ...vitestArgsFor(guard.killedBy), "--reporter=dot"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, CI: "" },
      timeout: 600_000,
    });
    ours(path, mutated, guard.file, "before restoring");
    writeFileSync(path, original);

    // A test run that never happened is not a test run that failed.
    //
    // `spawnSync` reports a child it could not start, or one it killed at the timeout, as
    // `status: null` — and `done.error` carries the spawn failure. Reading only `status !== 0`
    // counts both as a kill, so with `node_modules/.bin/vitest` missing every row prints
    // "killed", the harness exits 0, and it prints its success banner. This file exists to
    // catch exactly that class in other people's code; it committed it in its own verdict.
    if (done.error || done.status === null) {
      restoreOnce();
      out("");
      out(`verify-guards-are-falsifiable: could not run ${guard.killedBy.join(", ")} for this row`);
      out(`  ${guard.file}  ${guard.what}`);
      out(`  ${done.error ? `spawn failed: ${done.error.message}` : `killed by signal ${done.signal ?? "?"}`}`);
      out("\nA run that did not happen cannot kill a guard. Refusing to report it as one.");
      process.exit(1);
    }
    const killed = done.status !== 0;
    out(`${killed ? "  killed " : "  SURVIVED"}  ${guard.file}  ${guard.what}`);
    if (!killed) {
      failures.push({
        guard,
        why: `the guard was removed and ${guard.killedBy.join(", ")} still passed — nothing is watching it`,
      });
    }
  }
} finally {
  restoreOnce();
}

// The restore has to be observable, not asserted. A harness that leaves a mutation behind is a
// harness that changed production and reported on tests.
for (const [file, text] of originals) {
  if (readFileSync(join(ROOT, file), "utf8") !== text) {
    out(`verify-guards-are-falsifiable: ${file} was not restored — restore it by hand before continuing`);
    process.exit(1);
  }
}

if (unclaimed.length > 0) {
  out("");
  out(`verify-guards-are-falsifiable: ${unclaimed.length} enforcement locus/loci have no falsifiability row`);
  for (const symbol of unclaimed) out(`  ${symbol}`);
  out("\nverify-enforcement-symbols.mjs proves these symbols exist. Existing is not working.");
}

if (failures.length > 0 || unclaimed.length > 0) {
  out("");
  for (const failure of failures) {
    out(`  ${failure.guard.file}`);
    out(`    ${failure.guard.what}`);
    out(`    ${failure.why}`);
  }
  out(
    "\nA guard no test can kill is worse than no guard: it answers 'is this checked?' with a yes.\n" +
      "Either write a test that fails when the guard is removed, or remove the guard.\n",
  );
  // Last line, always, and one of two words. The failure text above once read as a footer to
  // someone checking `tail -6`, and a red gate got reported as green — a pipeline's status is its
  // last command's, so `| tail` had already thrown the exit code away.
  out(`RESULT: FAIL — ${failures.length} row(s) and ${unclaimed.length} unclaimed locus/loci.`);
  process.exit(1);
}

out("");
out(`verify-guards-are-falsifiable: ${rows.length} guard(s) removed on purpose, each killed a named test`);
out(`${loci.length} enforcement locus/loci from verify-enforcement-symbols.mjs are all claimed.`);
out("A mutation proves the test is coupled to the guard, not that it asserts the right thing.");
out("RESULT: PASS");

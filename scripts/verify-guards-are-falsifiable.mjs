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
    find: "      const issued = this.assertIssuedHere(permit);\n      if (!issued.allowed) return deny(issued.reasonCode, issued.message, issued.evidence);",
    replace: "      void this.assertIssuedHere(permit);",
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
    find: "          already.turn_request_id === permit.turnRequestId &&",
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

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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");

/**
 * `symbols` ties a row to the enforcement loci named by the Buzz-transition gate; every symbol in
 * that list must be claimed by some row. `find` must match its file exactly once — a mutation
 * with two homes is a mutation that is not about a specific guard.
 */
const GUARDS = [
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
];

const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);

const rows = GUARDS.filter((g) => !g.skip).filter(
  (g) => !only || g.what.includes(only) || g.file.includes(only),
);

const out = (line) => process.stdout.write(line + "\n");
const failures = [];

// ---------------------------------------------------------------------------
// Safety. This edits tracked files in place. A dirty guarded file means a crash
// mid-run would be indistinguishable from the author's own work in progress.
// ---------------------------------------------------------------------------
const files = [...new Set(rows.map((g) => g.file))];
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
const restore = () => {
  for (const [file, text] of originals) writeFileSync(join(ROOT, file), text);
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
    writeFileSync(path, original.replace(guard.find, guard.replace));
    const done = spawnSync(VITEST, ["run", ...guard.killedBy, "--reporter=dot"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, CI: "" },
      timeout: 600_000,
    });
    writeFileSync(path, original);
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
  process.exit(1);
}

out("");
out(`verify-guards-are-falsifiable: ${rows.length} guard(s) removed on purpose, each killed a named test`);
out(`${loci.length} enforcement locus/loci from verify-enforcement-symbols.mjs are all claimed.`);
out("A mutation proves the test is coupled to the guard, not that it asserts the right thing.");

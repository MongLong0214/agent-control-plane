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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    what: "ci preflight refuses a workflow pnpm command whose package script is missing",
    file: "package.json",
    find: '    "trace": "tsx src/tools/traceability.ts",\n',
    replace: "",
    killedBy: ["tests/process/ci-preflight.test.ts::accepts every repository workflow command"],
  },
  {
    what: "ci preflight refuses an unmatched quote in a workflow run block",
    file: ".github/workflows/ci.yml",
    find: '          echo "the test matrix succeeded"',
    replace: '          echo "the test matrix succeeded""',
    killedBy: ["tests/process/ci-preflight.test.ts::accepts every repository workflow command"],
  },
  // sol-simplify: these rows exist only while ci preflight does; remove them with that guard.
  {
    what: "ci preflight reports a workflow pnpm command whose package script is missing",
    file: "scripts/verify-ci-preflight.mjs",
    find:
      "    failures.push(\n" +
      "      `${run.source}:${run.line}: pnpm invokes missing package script ${JSON.stringify(invocation.name)}`,\n" +
      "    );\n",
    replace: "",
    killedBy: [
      "tests/process/ci-preflight.test.ts::rejects a workflow pnpm command whose package script is missing",
    ],
  },
  {
    what: "ci preflight reports a Bash syntax error in a workflow run block",
    file: "scripts/verify-ci-preflight.mjs",
    find:
      '    failures.push(`${run.source}:${run.line}: run command fails bash -n: ${detail}`);\n',
    replace: "",
    killedBy: [
      "tests/process/ci-preflight.test.ts::rejects an unmatched quote in a workflow run block",
    ],
  },
  {
    what: "ci preflight reads at least one repository workflow file",
    file: "scripts/verify-ci-preflight.mjs",
    find:
      "const workflowNames = readdirSync(workflowsDir)\n" +
      '  .filter((name) => /\\.ya?ml$/i.test(name))\n' +
      "  .sort();\n",
    replace: "const workflowNames = [];\n",
    killedBy: ["tests/process/ci-preflight.test.ts::accepts every repository workflow command"],
  },
  // sol-simplify: #739's rows. They exist only while the gate manifest and its runner do;
  {
    what: "the gate-parity check requires the gates script to be exactly the runner's argv",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "  if (!isExactly) {\n",
    replace: "  if (false) {\n",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a gates script that mentions the runner's path while running something else",
    ],
  },
  {
    what: "the gate-parity check refuses a key on the runner step that is not run or env",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "        for (const name of keyNames) {\n" +
      "          if (RUNNER_STEP_KEYS.has(name)) continue;\n",
    replace: "        for (const name of []) {\n          if (RUNNER_STEP_KEYS.has(name)) continue;\n",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses an if: on the runner step, which would skip every gate",
    ],
  },
  {
    what: "the gate-parity check refuses environment on the runner step it did not declare",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "            if (RUNNER_STEP_ENV.has(variable.name)) continue;\n",
    replace: "            continue;\n",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses environment on the runner step other than the commit range",
    ],
  },
  {
    what: "the gate-parity check refuses an action the gate job does not declare",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "        if (declared === undefined) {\n",
    replace: "        if (false) {\n",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses an action in the gate job that no declaration names",
    ],
  },
  {
    what: "the gate-parity check refuses an action that is not pinned to a commit SHA",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "        if (!/^[0-9a-f]{40}$/.test(ref ?? \"\")) {\n" +
      "          fail(`${at}: ${JSON.stringify(uses)} is not pinned to a 40-character commit SHA`);\n" +
      "        }\n",
    replace: "",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a declared action that is not pinned to a commit SHA",
    ],
  },
  {
    what: "the gate-parity check refuses an action input that moves the tree",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "            if (declared.with.has(input.name)) continue;\n",
    replace: "            continue;\n",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses an action input that moves the tree CI checks out",
    ],
  },
  {
    what: "the gate-parity check refuses a key on a setup step of the gate job",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "      for (const name of keyNames) {\n" +
      "        if (name === \"run\") continue;\n",
    replace: "      for (const name of []) {\n        if (name === \"run\") continue;\n",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a key on a setup step, so no setup step can skip or move what follows",
    ],
  },
  {
    what: "the gate-parity check refuses a job key the gate job may not carry",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "      if (CI_GATE_JOB_KEYS.has(key.name)) continue;\n",
    replace: "      continue;\n",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a job-level key that would move or skip the whole gate job",
    ],
  },
  {
    what: "the gate-parity check refuses a top-level defaults or env in the gate workflow",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "      if (key.name !== \"defaults\" && key.name !== \"env\") continue;\n",
    replace: "      continue;\n",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a top-level defaults, which reaches into the gate job from above it",
    ],
  },
  {
    what: "the gate-parity check refuses a matrix dimension that changes which legs exist",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "          if (CI_GATE_JOB_STRATEGY.matrixKeys.has(dimension.name)) continue;\n",
    replace: "          continue;\n",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a matrix dimension that changes which legs exist",
    ],
  },
  {
    what: "the gate-parity check refuses a line inside the gate job it could not place",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "    for (const stray of job.unplaced) {\n",
    replace: "    for (const stray of []) {\n",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a step shape it cannot place, even when the step runs no command",
    ],
  },
  {
    what: "the gate-parity check requires exactly one runner step in the gate job",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "    if (runnerSteps !== 1) {\n",
    replace: "    if (false) {\n",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a second step running the runner",
    ],
  },
  // remove them with that contract, not before it.
  {
    what: "the gate-parity check refuses a gate the CI job runs outside the runner",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "        fail(\n" +
      "          `${where}: ${CI_GATE_JOB} runs ${JSON.stringify(command.key)} as its own step. ` +\n" +
      "            \"A gate CI runs and `pnpm gates` does not is exactly the drift #739 removes — put it \" +\n" +
      "            \"in GATES in scripts/lib/prepush-gates.mjs, or declare it as setup with a reason.\",\n" +
      "        );\n",
    replace: "",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a gate CI runs as its own step — the #736 shape, in the direction CI grows",
    ],
  },
  {
    what: "the gate-parity check refuses a command in the gate job it cannot name",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "          fail(\n" +
      "            `${where}: ${CI_GATE_JOB} runs ${JSON.stringify(segment)}, which is neither the gate ` +\n" +
      "              \"runner nor a declared setup command. The gate job may only build the environment \" +\n" +
      "              \"and run `pnpm gates`; anything else is a gate that exists on one side only.\",\n" +
      "          );\n",
    replace: "",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a command in the gate job it cannot name at all",
    ],
  },
  {
    what: "the gate-parity check refuses a CI job that never runs the gate runner",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "  fail(\n" +
      "    `${gateJobSource}: ${CI_GATE_JOB} never runs \\`pnpm ${RUNNER_SCRIPT}\\`. CI would then have its ` +\n" +
      "      \"own gate list, which is the second source of truth #739 exists to remove.\",\n" +
      "  );\n",
    replace: "",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a CI job that lists its own gates instead of invoking the runner",
    ],
  },
  {
    what: "the gate-parity check refuses a runner invocation carrying arguments",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "          fail(\n" +
      "            `${where}: the gate runner is invoked with ${JSON.stringify(command.args.join(\" \"))}; ` +\n" +
      "              \"it must be invoked with no arguments so that CI runs the whole manifest\",\n" +
      "          );\n",
    replace: "",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a runner invocation carrying arguments, which is how a subset gets in",
    ],
  },
  {
    what: "the gate-parity check refuses a manifest gate that names no package script",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "    fail(`the gate manifest names ${JSON.stringify(gate.script)}, which is not a package script`);\n",
    replace: "",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a manifest gate whose package script a merge deleted",
    ],
  },
  {
    what: "the gate-parity check refuses verification in another job that no declaration explains",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "        fail(\n" +
      "          `${where}: job ${JSON.stringify(run.job)} runs ${JSON.stringify(command.key)}, which is ` +\n" +
      "            \"neither in the gate manifest nor declared in VERIFICATION_OUTSIDE_THE_RUNNER. \" +\n" +
      "            `Add it to GATES, or declare ${JSON.stringify(declarationKey)} with the reason it is ` +\n" +
      "            \"not a pre-push gate.\",\n" +
      "        );\n",
    replace: "",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses verification in another job that no declaration explains",
    ],
  },
  {
    what: "the gate-parity check refuses a declaration that names nothing a workflow runs",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "    fail(`VERIFICATION_OUTSIDE_THE_RUNNER declares ${JSON.stringify(key)}, which no workflow runs; remove it`);\n",
    replace: "",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a declaration that no longer names anything a workflow runs",
    ],
  },
  {
    what: "the gate-parity check refuses a command-shaped line it could not attribute",
    file: "scripts/verify-ci-runs-the-gate-runner.mjs",
    find:
      "      fail(\n" +
      "        `${source}:${index + 1}: a command-shaped line outside every parsed run block: ` +\n" +
      "          `${JSON.stringify(line.trim())}. This check could not classify it, so it refuses rather ` +\n" +
      "          \"than report a coverage it does not have.\",\n" +
      "      );\n",
    replace: "",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses a run: form it cannot attribute, rather than reporting a coverage it does not have",
    ],
  },
  {
    what: "the gate runner stops at the first failing gate",
    file: "scripts/run-prepush-gates.mjs",
    find:
      "  if (status !== 0) {\n" +
      "    failure = { printed, status, detail, index };\n" +
      "    break;\n" +
      "  }\n",
    replace:
      "  if (status !== 0) {\n" +
      "    failure = { printed, status, detail, index };\n" +
      "  }\n",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::stops at the first failing gate and exits with that gate's status",
    ],
  },
  {
    what: "the gate runner exits with the failing gate's status",
    file: "scripts/run-prepush-gates.mjs",
    find:
      "process.exit(failure ? failure.status : 0);\n",
    replace:
      "process.exit(0);\n",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::stops at the first failing gate and exits with that gate's status",
    ],
  },
  {
    what: "the gate runner counts a signal-killed gate as a failure",
    file: "scripts/run-prepush-gates.mjs",
    find:
      "  const status = child.error ? 1 : child.signal ? 128 : (child.status ?? 1);\n",
    replace:
      "  const status = child.error ? 1 : child.signal ? 0 : (child.status ?? 1);\n",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::counts a gate killed by a signal as a failure, not as an exit code of zero",
    ],
  },
  {
    what: "the gate runner refuses an argument that would run part of the set",
    file: "scripts/run-prepush-gates.mjs",
    find:
      "if (unknown.length > 0) {\n" +
      "  process.stderr.write(\n" +
      "    `gates: unrecognised argument(s): ${unknown.join(\" \")}\\n` +\n" +
      "      \"gates runs the whole set; there is deliberately no way to run part of it.\\n\",\n" +
      "  );\n" +
      "  process.exit(2);\n" +
      "}\n",
    replace: "",
    killedBy: [
      "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::refuses an argument, because a subset of the gates is the thing that failed #736",
    ],
  },
  {
    // This is the one static outflow for the code. Its catalogue classification remains,
    // proving that membership metadata and prose cannot satisfy the outflow census.
    what: "every declared reason code has a verified static outflow",
    file: "src/conversation/turn-coordinator.ts",
    find: "          ReasonCode.CONVERSATION_TARGET_ATTESTATION_STALE,\n",
    replace:
      '          ("CONVERSATION_TARGET_ATTESTATION_STALE is retained for a future consumer",\n' +
      "            ReasonCode.CONVERSATION_TARGET_UNATTESTED),\n",
    killedBy: [
      "tests/process/reason-code-static-outflow-census.test.ts::every declared reason code has a verified static outflow",
    ],
  },
  {
    what: "a SQLite trigger reason code reaches the typed translator",
    file: "src/db/database.ts",
    find: "  SESSION_INCARNATION_IMMUTABLE: ReasonCode.SESSION_INCARNATION_IMMUTABLE,\n",
    replace: "  SESSION_INCARNATION_IMMUTABLE: ReasonCode.CONFLICT,\n",
    killedBy: [
      "tests/process/reason-code-static-outflow-census.test.ts::every declared reason code has a verified static outflow",
    ],
  },
  {
    what: "catalogue metadata references are declared",
    file: "src/core/reason-codes.ts",
    find: '  CONVERSATION_TARGET_ATTESTATION_STALE: "CONVERSATION_TARGET_ATTESTATION_STALE",\n',
    replace: "",
    killedBy: [
      "tests/process/reason-code-static-outflow-census.test.ts::catalogue metadata references are declared",
    ],
  },
  {
    what: "production trigger denials and mappings agree",
    file: "scripts/verify-reason-code-usage.mjs",
    find: '  ["src/db/migrations.ts", read("src/db/migrations.ts")],\n',
    replace: "",
    killedBy: [
      "tests/process/reason-code-static-outflow-census.test.ts::production trigger denials and mappings agree",
    ],
  },
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
    //
    // The anchor carries the line above the mutated one on purpose: `completeNoReplyAndResolveTurn`
    // ends in the same `return this.#resolveTurnHere(channel, nonce);` (#672's no-reply path shares
    // the same terminal resolution), and a one-line anchor matched both — a row that is not about
    // one specific guard. `if (!completed.allowed) return completed;` exists only in this method's
    // reply-completion transaction, so pairing it with the mutated line is what makes this row
    // about the reply path and not the no-reply one below.
    what: "a turn whose reply the transport accepted stops being outstanding",
    file: "src/ingress/ingress-guard.ts",
    find: "      if (!completed.allowed) return completed;\n      return this.#resolveTurnHere(channel, nonce);",
    replace: "      if (!completed.allowed) return completed;\n      return completed;",
    killedBy: [
      "tests/unit/a-turn-and-a-reply-are-two-lifecycles.test.ts::resolves the turn in the same transaction that records the reply",
    ],
  },
  {
    // The no-reply counterpart of the row above: `completeNoReplyAndResolveTurn` never reserves
    // or completes a reply, so `result_json` stays whatever it was when the turn was claimed —
    // usually null. `isRecoverableIngressResult(null)` reads null as "never ran", so a claim that
    // is resolved but whose result was never marked non-recoverable looks, to a later replay,
    // exactly like a message that only got as far as being admitted. `recoverInFlight` then
    // re-admits it and the handler runs a second time — worse than #672's original bug, which at
    // least refused the redelivery outright. This is the mutation that removes the marker write
    // and keeps only the resolution, reproducing exactly that.
    what: "a turn with no reply is marked non-recoverable, not only resolved",
    file: "src/ingress/ingress-guard.ts",
    find:
      "      const updated = this.db.run(\n" +
      "        `UPDATE inbound_messages SET result_json = ? WHERE channel = ? AND nonce = ? AND (\n" +
      "           result_json IS NULL OR (\n" +
      "             json_extract(result_json, '$.kind') = 'TELEGRAM_WORKFLOW' AND\n" +
      "             json_extract(result_json, '$.phase') = 'ADMITTED'\n" +
      "           )\n" +
      "         )`,\n" +
      "        [JSON.stringify({ kind: \"TELEGRAM_NO_REPLY\" }), channel, nonce],\n" +
      "      );\n" +
      "      if (updated.changes !== 1) {\n" +
      "        // The read above passed but the write's own WHERE clause did not match — belt-and-braces\n" +
      "        // against the same class of collapse `#recordResultHere`'s row-count check guards (#682,\n" +
      "        // third review): a mismatch here means `result_json` changed between the read and this\n" +
      "        // write, and reporting success regardless would be exactly the wrong-answer-with-\n" +
      "        // confidence this method exists to refuse.\n" +
      "        return deny(\n" +
      "          ReasonCode.RESOURCE_COLLISION,\n" +
      "          \"ingress result changed underneath the no-reply resolution\",\n" +
      "          { channel, nonce },\n" +
      "        );\n" +
      "      }\n" +
      "      this.db.run(\n" +
      "        `UPDATE inbound_messages\n" +
      "            SET turn_claim_json = json_set(turn_claim_json, '$.noReplyAt', ?)\n" +
      "          WHERE channel = ? AND nonce = ?`,\n" +
      "        [this.clock.nowIso(), channel, nonce],\n" +
      "      );",
    replace:
      "      this.db.run(\n" +
      "        `UPDATE inbound_messages\n" +
      "            SET turn_claim_json = json_set(turn_claim_json, '$.noReplyAt', ?)\n" +
      "          WHERE channel = ? AND nonce = ?`,\n" +
      "        [this.clock.nowIso(), channel, nonce],\n" +
      "      );",
    killedBy: [
      "tests/unit/ingress-no-reply-turn-resolution.test.ts::a synthetic fresh no-reply outcome is resolved by pollOnce",
    ],
  },
  {
    // The exact collapse Sol's review found (#682): `repliedAt` means the transport accepted a
    // reply, and `completeNoReplyAndResolveTurn` produced no reply — writing `repliedAt` here
    // would tell a later reader Telegram has a message it never received. Retargeting the write
    // at `repliedAt` instead of `noReplyAt` reproduces exactly the field collapse that was
    // reviewed and blocked; the row-level assertion this kills is the one Sol asked for, because
    // `unresolvedTurns` and a redelivery's reason code both close over either field and cannot
    // tell this mutation apart from the correct write.
    what: "a no-reply turn is marked by its own field, not by reusing the reply's",
    file: "src/ingress/ingress-guard.ts",
    find: "            SET turn_claim_json = json_set(turn_claim_json, '$.noReplyAt', ?)",
    replace: "            SET turn_claim_json = json_set(turn_claim_json, '$.repliedAt', ?)",
    killedBy: [
      "tests/unit/ingress-no-reply-turn-resolution.test.ts::a synthetic fresh no-reply outcome is resolved by pollOnce",
    ],
  },
  {
    // The idempotency half of the same guard: a no-reply resolution must never move a claim that
    // already carries a terminal fact, most importantly a real `repliedAt` from a reply the
    // transport actually accepted. Removing the check lets a stray or duplicate call overwrite
    // that evidence — unreachable through the router today (`resolveNoReplyOutcome` never calls
    // this for a replayed outcome, and a fresh claim cannot already have `repliedAt`), which is
    // exactly why it needs its own row rather than resting on that being true forever.
    what: "a no-reply resolution never moves a claim that already has a terminal fact",
    file: "src/ingress/ingress-guard.ts",
    find: "      if (claim.repliedAt !== undefined || claim.noReplyAt !== undefined) {",
    replace: "      if (false) {",
    killedBy: [
      "tests/unit/ingress-no-reply-turn-resolution.test.ts::#682: never writes noReplyAt over a turn whose reply already resolved",
    ],
  },
  {
    // The other order of the same guard (#682, second review): the row above covers
    // reply-then-no-reply, but `#resolveTurnHere` — reachable directly through `resolveTurn`,
    // not only through `completeReplyAndResolveTurn`'s own PENDING precondition — had no
    // matching refusal for no-reply-then-reply. A *third* review found the first fix for this
    // was itself a no-op: the WHERE clause silently matched zero rows and the function still
    // returned `allow(OK)` regardless. This mutation removes the explicit, checked refusal that
    // replaced it — writing `repliedAt` over a claim `completeNoReplyAndResolveTurn` already
    // closed with `noReplyAt` would again leave one row asserting both "no reply was produced"
    // and "the transport accepted a reply", and this time reporting success while doing it.
    what: "resolveTurn refuses, rather than silently no-ops, over a claim a no-reply resolution already closed",
    file: "src/ingress/ingress-guard.ts",
    find:
      "      if (claim.noReplyAt !== undefined) {\n" +
      "        // A *different* terminal fact already closed this claim. Writing `repliedAt` now would\n" +
      "        // assert both \"no reply was produced\" and \"the transport accepted a reply\" on one row —\n" +
      "        // refuse rather than silently do nothing and report success.\n" +
      "        return deny(\n" +
      "          ReasonCode.RESOURCE_COLLISION,\n" +
      "          \"cannot record a reply for a turn already resolved as no-reply\",\n" +
      "          { channel, nonce },\n" +
      "        );\n" +
      "      }\n",
    replace: "",
    killedBy: [
      "tests/unit/ingress-no-reply-turn-resolution.test.ts::#682: resolveTurn refuses rather than silently no-ops over a turn a no-reply resolution already closed",
    ],
  },
  {
    // Found by Sol's counterexample (#682, third review): `reserveResponse` calls
    // `recordResultIf(…, "AVAILABLE")` before the two rows above ever run, and that check reads
    // only `result_json`'s own delivery status — the `TELEGRAM_NO_REPLY` marker has none, so a
    // reservation against an already-no-reply-resolved turn read as available. Worse than the two
    // rows above on its own: the reservation alone overwrites the non-recoverable marker with a
    // `sent: false` reply reservation, which `isRecoverableIngressResult` reads as recoverable —
    // reopening #672's exact vulnerability before `completeReplyAndResolveTurn` is ever reached.
    // Refused here outright, rather than left to a later rollback, because this is the only place
    // that also protects the reservation taken on its own.
    what: "a reply reservation is refused for a turn already resolved as no-reply",
    file: "src/ingress/ingress-guard.ts",
    find: "        if (claim.noReplyAt !== undefined || claim.settledAt !== undefined) {",
    replace: "        if (false) {",
    killedBy: [
      "tests/unit/ingress-no-reply-turn-resolution.test.ts::#682: reserveResponse refuses a reply for a turn already resolved as no-reply",
    ],
  },
  {
    // The fourth reader of `repliedAt`-as-"is this turn finished" (#682, Sol's review): #685
    // repointed this check at `turn_claim_json` after #671 split the lifecycles, but kept
    // `repliedAt IS NULL` as the only "still outstanding" test — the same collapse the ingress
    // rows above guard against, arriving through a reader nobody had enumerated. Without the
    // `noReplyAt` clause, a turn a handler genuinely decided not to reply to reports
    // `TURN_OUTCOME_UNKNOWN` to `agentctl doctor system` forever, escalating to ERROR after
    // `UNRESOLVED_TURN_ESCALATION_MINUTES` for a turn nothing is waiting on.
    what: "doctor agrees with ingress that a no-reply resolution closes a claim",
    file: "src/doctor/doctor.ts",
    find: "          AND json_extract(turn_claim_json, '$.noReplyAt') IS NULL",
    replace: "",
    killedBy: [
      "tests/unit/doctor-sees-unresolved-turns.test.ts::#682: does not report a turn resolved by noReplyAt as still outstanding",
    ],
  },
  {
    // Found by Sol's review of #672's own PR (#682): `route()` reports `reply: null` for two
    // different facts, and this guard is what keeps them apart. Recovery turns a surviving
    // PENDING reservation into an explicit UNRESOLVED result and returns `reply: null`; without
    // `outcome.replayed`, the no-reply path tries to overwrite that delivery-unknown fact.
    what: "a replayed outcome is never read as a fresh no-reply, even when both carry reply: null",
    file: "src/ingress/telegram-router.ts",
    find: "    if (outcome.reply || !outcome.admitted || outcome.replayed) return;",
    replace: "    if (outcome.reply || !outcome.admitted) return;",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a claimed turn's PENDING reply becomes delivery-unknown on redelivery instead of false no-reply",
    ],
  },
  {
    // Found by Sol's review (#682): the constructor validates `nonceTtlMs` against the transport
    // retention floor (#673) exactly once, but `policies` is a `Readonly<Record<...>>` whose
    // readonly is shallow — it stops reassigning an entry, not writing to the `IngressPolicy`
    // object that entry points at. Reading `policy.nonceTtlMs` again here re-reads a value the
    // caller still owns and can still mutate, so the floor the constructor just refused to allow
    // could reopen silently after construction. Reading a value this guard copied out at
    // construction, and never re-reads from the caller's object, is what makes the floor hold for
    // the object's whole lifetime rather than only at the instant it was built.
    what: "the nonce ttl floor holds even if the caller mutates the policy object afterward",
    file: "src/ingress/ingress-guard.ts",
    find: "    this.prune(request.channel, this.#nonceTtlMsByChannel[request.channel] ?? DEFAULT_NONCE_TTL_MS);",
    replace: "    this.prune(request.channel, policy.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS);",
    killedBy: [
      "tests/unit/ingress-nonce-ttl-transport-retention.test.ts::#682: holds the floor even if the caller mutates the policy object after construction",
    ],
  },
  {
    // Found by Sol's review (#682, round 8): the constructor's floor was keyed by the channel's
    // name (`TRANSPORT_RETENTION_MS["telegram"]`) alone, so any transport answering to that
    // channel — a custom one that genuinely retains longer than 24h, or one nobody has measured
    // at all — got the same 24h figure as the officially-measured `api.telegram.org` client.
    // Mutating the derivation back to the bare channel-name lookup removes exactly that: a
    // transport that declares a longer `transportRetentionMs` no longer raises the floor it is
    // constructed against.
    what: "the retention floor is derived from the transport's own declared retention, not the channel's name",
    file: "src/ingress/ingress-guard.ts",
    find:
      "      const retention = policy.transportRetentionMs !== undefined\n" +
      "        ? policy.transportRetentionMs\n" +
      "        : TRANSPORT_RETENTION_MS[channel];",
    replace: "      const retention = TRANSPORT_RETENTION_MS[channel];",
    killedBy: [
      "tests/unit/ingress-retention-derives-from-transport.test.ts::raises the effective floor to a longer-than-24h transportRetentionMs rather than refusing, when nonceTtlMs is not explicit",
    ],
  },
  {
    // The other half of the same review comment: a caller stating explicitly that a transport's
    // retention is not known (`transportRetentionMs: null`) must refuse construction rather than
    // silently fall back to a measured figure that described a different server. Removing the
    // check restores exactly the assumption #682 (round 8) found: an unmeasured transport gets
    // the 24h floor anyway.
    what: "construction refuses a policy that states its transport's retention is unknown",
    file: "src/ingress/ingress-guard.ts",
    find:
      "      if (retention === null) {\n" +
      "        // The caller stated explicitly that this channel's transport retention is not known —\n" +
      "        // a self-hosted endpoint nobody has measured, or a stand-in for one. Assuming the\n" +
      "        // measured `api.telegram.org` figure applies anyway would be this issue's original\n" +
      "        // mistake in a new place, so this refuses rather than guesses. Marked with `code` and\n" +
      "        // `channel` (see `isTransportRetentionUnknown` above) so a caller can tell this refusal\n" +
      "        // apart from every other reason this constructor throws.\n" +
      "        throw Object.assign(\n" +
      "          new Error(\n" +
      "            `ingress policy for '${channel}' does not know its transport's redelivery retention ` +\n" +
      "              `(transportRetentionMs is null); refusing to assume a measured default applies to a ` +\n" +
      "              `transport that has not stated its own (#682)`,\n" +
      "          ),\n" +
      "          { code: TRANSPORT_RETENTION_UNKNOWN, channel },\n" +
      "        );\n" +
      "      }\n",
    replace: "",
    killedBy: [
      "tests/unit/ingress-retention-derives-from-transport.test.ts::refuses to construct when the transport's retention is unmeasured, regardless of nonceTtlMs",
    ],
  },
  {
    // Production's own wiring, not just the guard's constructor: `startTelegramLongPollListener`
    // used to build `IngressGuard` *before* choosing the real transport, so nothing there could
    // ever have supplied this fact even after the guard learned to ask for it. Removing the wire
    // (leaving `transportRetentionMs` unset) silently falls back to the old channel-keyed 24h
    // default regardless of what transport was actually selected — including a custom one, or
    // Telegram's own client pointed at a self-hosted `ACP_TELEGRAM_API_BASE_URL` this repository
    // has never measured.
    what: "production wiring threads the chosen transport's own declared retention into the guard",
    file: "src/ingress/telegram-polling.ts",
    find: "      transportRetentionMs: transport.redeliveryRetentionMs ?? config.transportRetentionMs ?? null,\n",
    replace: "",
    killedBy: [
      "tests/unit/ingress-retention-derives-from-transport.test.ts::production wiring refuses to start against a transport whose retention is unknown, chosen before this fix constructed the guard",
    ],
  },
  {
    // Found by Sol's second review (#682, round 8 follow-up): the derivation above is right, but
    // `agentcpd.ts`'s `main()` wraps every listener it starts in one `try`/`catch` that tears all
    // of them down on any failure — so `IngressGuard`'s refusal for an unmeasured transport used
    // to take the *whole daemon* down, not just Telegram, for a deployment that configured a
    // supported self-hosted Bot API server on purpose. Mutating the guard back to an
    // unconditional rethrow removes exactly the narrow catch that keeps MCP, Buzz and the
    // operator door running when only Telegram's transport retention is unknown.
    what: "an unmeasured transport's retention refuses only Telegram ingress, not the whole daemon",
    file: "src/daemon/agentcpd.ts",
    find: "    if (!isTransportRetentionUnknown(error)) throw error;",
    replace: "    throw error;",
    killedBy: [
      "tests/unit/daemon-startup.test.ts::#682 round 8 follow-up: starts the daemon but refuses Telegram ingress when the transport's retention is unknown",
    ],
  },
  {
    // Found by Sol's second review (#682, round 8's second follow-up): a transport whose
    // retention is genuinely *longer* than the default was refused exactly like one whose
    // retention is unknown, conflating "different" with "unknown". Mutating the auto-derived
    // floor back to the bare default removes exactly the raise: a known 48h retention with no
    // explicit `nonceTtlMs` would then get a silent, unsafe 24h floor instead of 48h.
    what: "the effective floor is raised to a known, longer transport retention rather than left at the bare default",
    file: "src/ingress/ingress-guard.ts",
    find: "        ttl = retention !== undefined ? Math.max(DEFAULT_NONCE_TTL_MS, retention) : DEFAULT_NONCE_TTL_MS;",
    replace: "        ttl = DEFAULT_NONCE_TTL_MS;",
    killedBy: [
      "tests/unit/ingress-retention-derives-from-transport.test.ts::raises the effective floor to a longer-than-24h transportRetentionMs rather than refusing, when nonceTtlMs is not explicit",
    ],
  },
  {
    // Found by Sol's third review (#682, round 8's third pass): refusing an unmeasured
    // transport left an operator who knows their self-hosted server's real redelivery window
    // with no production way to say so. Mutating away just the `config.transportRetentionMs`
    // fallback (leaving the transport's own report and the outright refusal intact) removes
    // exactly the escape hatch, without also disabling the surrounding refusal-when-unknown
    // guard a coarser mutation on this line would.
    what: "ACP_TELEGRAM_TRANSPORT_RETENTION_MS fills the gap when the transport itself reports unknown",
    file: "src/ingress/telegram-polling.ts",
    find: "transport.redeliveryRetentionMs ?? config.transportRetentionMs ?? null",
    replace: "transport.redeliveryRetentionMs ?? null",
    killedBy: [
      "tests/unit/ingress-retention-derives-from-transport.test.ts::fills the gap for a transport that reports its own retention as unknown",
    ],
  },
  {
    // Without reading the environment variable at all, the escape hatch above has nothing to
    // fill the gap with — `config.transportRetentionMs` would always be `undefined`, and an
    // operator who set `ACP_TELEGRAM_TRANSPORT_RETENTION_MS` would see it silently ignored.
    what: "ACP_TELEGRAM_TRANSPORT_RETENTION_MS is read and validated into the configured Telegram config",
    file: "src/ingress/telegram-polling.ts",
    find:
      "  const transportRetentionMs = parseOptionalBoundedInteger(\n" +
      "    environment[\"ACP_TELEGRAM_TRANSPORT_RETENTION_MS\"],\n" +
      "    60_000,\n" +
      "    30 * 24 * 60 * 60 * 1000,\n" +
      "  );",
    replace: "  const transportRetentionMs = undefined;",
    killedBy: [
      "tests/unit/ingress-retention-derives-from-transport.test.ts::is read into the configured config, validated the same way as the other Telegram integer settings",
    ],
  },
  {
    // Found by Sol's fourth review (#682, round 8's fourth pass): `ACP_TELEGRAM_TRANSPORT_RETENTION_MS`
    // was added to the code's `TELEGRAM_ENVIRONMENT_VARIABLES` but never to
    // `deploy/install-launchd.sh`'s Keychain-export loop — the only place a launchd deployment's
    // environment actually comes from. An operator on that supported deployment could set the
    // Keychain entry and it would never reach the daemon; the escape hatch this PR built did not
    // work on the deployment shape that matters. Mutating the loop back to omit the name
    // reintroduces exactly that drift.
    what: "the launchd launcher exports every ACP_TELEGRAM_* variable the code reads, not a hand-kept subset",
    file: "deploy/install-launchd.sh",
    find: "  ACP_TELEGRAM_DEFAULT_PROJECT_ID ACP_TELEGRAM_API_BASE_URL ACP_TELEGRAM_TRANSPORT_RETENTION_MS; do",
    replace: "  ACP_TELEGRAM_DEFAULT_PROJECT_ID ACP_TELEGRAM_API_BASE_URL; do",
    killedBy: [
      "tests/unit/telegram-env-launcher-drift.test.ts::TELEGRAM_ENVIRONMENT_VARIABLES is a subset of the launcher's optional-Keychain export loop",
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
    what: "a disposable workspace allocator that shares a path with live ACP state is refused",
    file: "src/acceptance/disposable-realm.ts",
    find: "    if (within(production, workspace) || within(workspace, production)) {",
    replace: "    if (false) {",
    killedBy: [
      "tests/unit/disposable-realm.test.ts::refuses a workspace allocator root inside production",
    ],
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
    what: "the disposable driver refuses an evidence sentence wider than its bounded observation",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: "  if (!claim.allowed) return claim;",
    replace: "  if (false) return claim;",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::refuses a claim wider than the bounded disposable observation",
    ],
  },
  {
    what: "an unobservable before census stops the disposable driver",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: "    if (!before.allowed) {\n      return before as Decision<SyntheticDisposableRealmObservation>;\n    }",
    replace: "    if (false) {\n      return before as Decision<SyntheticDisposableRealmObservation>;\n    }",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::refuses when the before census cannot be observed",
    ],
  },
  {
    what: "an ambiguous send is terminal before the disposable driver polls again",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: '        if (classifyProbeSignal(signal) === "INCONCLUSIVE") {',
    replace: "        if (false) {",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::treats an ambiguous send as terminal and never polls a second message",
    ],
  },
  {
    what: "the disposable driver requires two matching driver-handled ingress exchanges",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: "    if (!complete.allowed) {\n      return complete as Decision<SyntheticDisposableRealmObservation>;\n    }",
    replace: "    if (false) {\n      return complete as Decision<SyntheticDisposableRealmObservation>;\n    }",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::refuses when the real polling entry returns only one message",
    ],
  },
  {
    what: "the disposable trace contains exactly two settled driver-handled exchanges and one created target binding",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: "    counts.outcomes !== 2 ||\n    counts.pollCycles !== 2 ||\n    counts.sentReplies !== 2 ||\n    counts.driverTurns !== 2 ||\n    counts.ingressAppliedReplies !== 2 ||\n    counts.actorIds !== 1 ||\n    counts.targetActorIds !== 1",
    replace: "    false",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::refuses two actors created through the binding lifecycle",
    ],
  },
  {
    what: "each transport record is the reply the driver-owned callback supplied for that admitted update",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: "      sent.text !== expectedReply ||",
    replace: "      false ||",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::refuses a transport record that differs from the driver-owned callback reply",
    ],
  },
  {
    what: "the disposable driver refuses any synthetic baseline census difference",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: "    if (!unchanged.allowed) {\n      return unchanged as Decision<SyntheticDisposableRealmObservation>;\n    }",
    replace: "    if (false) {\n      return unchanged as Decision<SyntheticDisposableRealmObservation>;\n    }",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::refuses when the synthetic baseline changes during the probe",
    ],
  },
  {
    what: "the disposable driver refuses cleanup residue before the janitor removes it",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: "    if (!residue.allowed) {",
    replace: "    if (false) {",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::refuses cleanup that leaves realm residue and then removes it with the janitor",
    ],
  },
  {
    what: "cleanup refuses a process identity this disposable run did not own",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: "  const unowned = candidates.filter((candidate) => !mayTerminate(owned, candidate));",
    replace: "  const unowned = candidates.filter(() => false);",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::refuses to terminate a reused pid whose start time does not match",
    ],
  },
  {
    what: "the evidence artifact refuses a checked step that this run did not execute",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: "  if (unsupportedSteps.length > 0) {",
    replace: "  if (false) {",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::refuses an artifact that marks an unexecuted step as checked by the run",
    ],
  },
  {
    what: "the synthetic driver refuses before the live transport fallback when injection is absent",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: '      ...(options.fault === "SYNTHETIC_TRANSPORT_NOT_INJECTED" ? {} : { transport }),',
    replace: "      ...{},",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::runs two synthetic messages through the production Telegram entry and removes the realm",
    ],
  },
  {
    what: "the janitor creates the synthetic workspace after taking ownership of its cleanup pipe",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: '  workspace = mkdtempSync(join(root, "acp-655-synthetic-"));',
    replace: '  workspace = join(root, "not-created");',
    killedBy: [
      "tests/process/disposable-realm-janitor.test.ts::removes the workspace when the process holding its pipe is killed",
    ],
  },
  {
    what: "the crash janitor removes the synthetic workspace when its owner pipe closes",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: "    if (workspace !== null) rmSync(workspace, { recursive: true, force: true });",
    replace: "    if (false) rmSync(workspace, { recursive: true, force: true });",
    killedBy: [
      "tests/process/disposable-realm-janitor.test.ts::removes the workspace when the process holding its pipe is killed",
    ],
  },
  {
    what: "the disposable workspace root comes from a fixed OS path and not live ACP state",
    file: "src/core/disposable-workspace-root.ts",
    find: "    workspaceRoot: join(\n      systemTemporaryRoot,\n      `.agent-control-plane-disposable-realms-${account.uid}`,\n    ),",
    replace: '    workspaceRoot: join(account.homedir, ".agent-control-plane"),',
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::establishes workspace placement without inherited HOME TMPDIR NODE_OPTIONS or cwd",
    ],
  },
  {
    what: "the workspace janitor inherits no caller environment",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: "      env: {},",
    replace: "      env: { ...process.env },",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::establishes workspace placement without inherited HOME TMPDIR NODE_OPTIONS or cwd",
    ],
  },
  {
    what: "the workspace janitor starts in the established allocator root instead of caller cwd",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: "      cwd: workspaceRoot,",
    replace: "      cwd: undefined,",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::establishes workspace placement without inherited HOME TMPDIR NODE_OPTIONS or cwd",
    ],
  },
  {
    what: "the reviewer cannot read the disposable realm allocator",
    file: "src/runtime/cli-adapters.ts",
    find: "    disposableWorkspaceRoot,",
    replace: "",
    killedBy: [
      "tests/unit/reviewer-transcript-isolation.test.ts::places disposable allocator denials after the temporary write allowance",
    ],
  },
  {
    what: "the reviewer cannot write the disposable realm allocator through its temporary-directory allowance",
    file: "src/runtime/cli-adapters.ts",
    find: "  lines.push(`(deny file-write* (subpath ${quote(resolvePath(disposableWorkspaceRoot))}))`);",
    replace: "  void disposableWorkspaceRoot;",
    killedBy: [
      "tests/unit/reviewer-transcript-isolation.test.ts::places disposable allocator denials after the temporary write allowance",
    ],
  },
  {
    what: "the disposable realm launcher does not load a TMPDIR-backed TypeScript transform cache",
    file: "package.json",
    find:
      '    "acceptance:disposable-realm": "NODE_DISABLE_COMPILE_CACHE=1 node --experimental-transform-types scripts/run-disposable-realm-probe.ts",',
    replace:
      '    "acceptance:disposable-realm": "NODE_DISABLE_COMPILE_CACHE=1 node --import tsx scripts/run-disposable-realm-probe.ts",',
    killedBy: [
      "tests/process/disposable-realm-janitor.test.ts::does not write through inherited TMPDIR before the disposable workspace is established",
    ],
  },
  {
    what: "the disposable realm requests in-memory SQLite temporary storage",
    file: "src/acceptance/disposable-realm-driver.ts",
    find: '  databaseTemporaryStorage: "MEMORY",',
    replace: "",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::runs two synthetic messages through the production Telegram entry and removes the realm",
    ],
  },
  {
    what: "the control plane passes its SQLite temporary-storage policy to the database",
    file: "src/app/control-plane.ts",
    find:
      "      config.databaseTemporaryStorage === undefined\n" +
      "        ? {}\n" +
      "        : { temporaryStorage: config.databaseTemporaryStorage },",
    replace: "      {},",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::runs two synthetic messages through the production Telegram entry and removes the realm",
    ],
  },
  {
    what: "the database applies the requested in-memory SQLite temporary-storage policy",
    file: "src/db/database.ts",
    find: '        this.#raw.pragma("temp_store = MEMORY");',
    replace: "        void this.options.temporaryStorage;",
    killedBy: [
      "tests/unit/disposable-realm-driver.test.ts::runs two synthetic messages through the production Telegram entry and removes the realm",
    ],
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
    // A detached turn is not complete when pollOnce returns. Omitting it from the route list
    // restores the old return type's lie in a new form: the work is still running, but the cycle
    // says nothing was handed off and gives callers no promise to settle.
    what: "pollOnce names a detached CEO turn as pending instead of returning an empty cycle",
    file: "src/ingress/telegram-polling.ts",
    find: '        routes.push({ status: "CEO_TURN_PENDING", outcome: route });',
    replace: "",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::returns a pending CEO turn while refusing a second and reports the final offset when settled",
    ],
  },
  {
    // Detachment also removes the loop catch that used to impose retryDelayMs. Making a failed
    // update immediately retryable reopens the hot loop while its Telegram offset is held.
    what: "a detached Telegram route waits for retryDelayMs before it is attempted again",
    file: "src/ingress/telegram-polling.ts",
    find: "        retryAt: Date.now() + deliveryRetryDelayMs(error, this.options.retryDelayMs ?? 5_000),",
    replace: "        retryAt: Date.now(),",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::waits for retryDelayMs before a detached route is attempted again",
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
    what: "grok is excluded from the unattended capacity probe by default (#735)",
    symbols: ["isAutoProbeEnabled"],
    file: "src/capacity/capacity-monitor.ts",
    find: 'export const UNATTENDED_PROBE_EXCLUDED_BY_DEFAULT: ReadonlySet<string> = new Set(["grok"]);',
    replace: "export const UNATTENDED_PROBE_EXCLUDED_BY_DEFAULT: ReadonlySet<string> = new Set();",
    killedBy: [
      "tests/unit/grok-probe-retirement.test.ts::a default configuration does not probe grok during an unattended refresh",
    ],
  },
  {
    what: "naming grok in unattendedProbeOptIns actually restores it to the unattended probe",
    symbols: ["isAutoProbeEnabled"],
    file: "src/capacity/capacity-monitor.ts",
    find: "    return (this.#options.unattendedProbeOptIns ?? []).includes(provider);",
    replace: "    return false;",
    killedBy: [
      "tests/unit/grok-probe-retirement.test.ts::an explicit opt in probes grok during an unattended refresh",
    ],
  },
  {
    what: "a provider retired from the unattended probe is not also faulted for a sensor file the sweep will never refresh again",
    symbols: ["isAutoProbeEnabled"],
    file: "src/doctor/doctor.ts",
    find: "      if (!this.capacity.isAutoProbeEnabled(provider)) continue;\n",
    replace: "",
    killedBy: [
      "tests/unit/grok-probe-retirement.test.ts::a stale grok sensor file does not resurface as a doctor finding after retirement",
    ],
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
    // #676: ownership is attached to the real mutation surface. Losing symbol resolution makes
    // the synthetic call disappear and leaves only stale-owner noise.
    what: "the turn-fence writer check resolves the exact Db run symbol",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find:
      "const symbolIsDbRun = (symbol) =>\n" +
      "  symbol !== undefined && symbol.declarations?.some((declaration) => sameDeclaration(declaration));",
    replace: "const symbolIsDbRun = () => false;",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::fails when an inline SQL exact Db run call names a governed table outside its owner",
    ],
  },
  {
    what: "the turn-fence writer check rejects in-bound exact Db run calls outside the table owner",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find: "    if (!allowed.has(file)) applicationResidual.push({ table, file });",
    replace: "    if (false) applicationResidual.push({ table, file });",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::fails when an inline SQL exact Db run call names a governed table outside its owner",
    ],
  },
  {
    what: "the turn-fence writer check reports non-inline exact Db run calls outside its boundary",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find: "    nonInlineCalls.push({",
    replace: "    [].push({",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::reports Array join SQL outside the inline SQL boundary",
    ],
  },
  {
    what: "the turn-fence writer check rejects a captured exact Db run method",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find: "if (escapedRunReferences.length > 0) {",
    replace: "if (false) {",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::fails when exact Db run is captured instead of called directly",
    ],
  },
  {
    what: "the turn-fence writer check refuses a literal bracket capture of Db run",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find: 'semanticStringConstant(node.argumentExpression) === "run" &&',
    replace: 'semanticStringConstant(node.argumentExpression) === "not-run" &&',
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::refuses Db run captured through literal bracket access",
    ],
  },
  {
    what: "the turn-fence writer check resolves semantic constant run keys",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find:
      "const semanticStringConstant = (expression) => {\n" +
      "  const type = checker.getTypeAtLocation(expression);\n" +
      "  return (type.flags & ts.TypeFlags.StringLiteral) !== 0 ? type.value : undefined;\n" +
      "};",
    replace:
      "const semanticStringConstant = (expression) =>\n" +
      "  ts.isStringLiteralLike(expression) ? expression.text : undefined;",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::measures inline SQL syntax and semantic run key boundary forms",
    ],
  },
  {
    what: "the turn-fence writer check refuses object binding destructuring of Db run",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find:
      "if (ts.isBindingElement(node) && bindingCapturesRun(node) && typeHasDbRun(node.parent)) {",
    replace: "if (false) {",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::refuses Db run captured by object binding destructuring",
    ],
  },
  {
    what: "the turn-fence writer check refuses object assignment destructuring of Db run",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find:
      "      assignmentCapturesRun(node.left) &&\n" +
      "      typeHasDbRun(node.right)",
    replace: "      false",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::refuses Db run captured by object assignment destructuring",
    ],
  },
  {
    what: "the turn-fence writer check reports a stale application owner",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find: "    if (!seenFiles.has(owner)) staleOwners.push({ table, owner });",
    replace: "    if (false) staleOwners.push({ table, owner });",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::fails when a declared application owner no longer names its table",
    ],
  },
  {
    what: "the turn-fence writer check scans direct trigger SQL in schema sql",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find: "for (const match of strippedSchema.matchAll(WRITE)) {",
    replace: "for (const match of []) {",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::fails when a schema trigger body writes a governed table directly",
    ],
  },
  {
    what: "the turn-fence writer check scans both table names in schema renames",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find: "  for (const captured of [match[1], match[2]]) {",
    replace: "  for (const captured of [match[2]]) {",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::scans source and destination table names in schema renames",
    ],
  },
  {
    what: "the turn-fence writer check reports a stale named migration rebuild surface",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find: "  if (!hasExec) missingRebuildSurfaces.push({ table, surface });",
    replace: "  if (false) missingRebuildSurfaces.push({ table, surface });",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::fails when a named migration rebuild surface goes stale",
    ],
  },
  {
    what: "the turn-fence writer check discovers a CREATE TABLE with a comment at a keyword boundary",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find: "[...strippedSchema.matchAll(CREATE_TABLE)]",
    replace: "[...schema.matchAll(CREATE_TABLE)]",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::discovers a governed table declared with an SQL comment between CREATE and TABLE",
    ],
  },
  {
    what: "the turn-fence writer check discovers a schema-qualified CREATE TABLE declaration",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find: "(?:${IDENT}\\s*\\.\\s*)?(${IDENT})\\s*\\(`,",
    replace: "(${IDENT})\\s*\\(`,",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::discovers a governed table declared with a schema-qualified name",
    ],
  },
  {
    what: "the turn-fence writer check reports ownership for a table the schema no longer declares",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find: "if (orphanedOwners.length > 0 || orphanedRebuilds.length > 0) {",
    replace: "if (false) {",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::fails when declared ownership names a table the schema no longer declares",
    ],
  },
  {
    what: "the turn-fence writer check prints its exact boundary on every run",
    file: "scripts/verify-turn-fence-writer-census.mjs",
    find: "process.stdout.write(`CHECK: ${CLAIM}\\nBOUNDARY: ${BOUNDARY}\\n`);",
    replace: "process.stdout.write(`CHECK: ${CLAIM}\\n`);",
    killedBy: [
      "tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts::prints the exact boundary on every run",
    ],
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
    find: "      const actorId = reused.value ?? this.mintActor(\n        input.role,\n        input.sessionId,\n        session.incarnation,\n        freshCandidate,\n      );",
    replace: "      const actorId = this.mintActor(\n        input.role,\n        input.sessionId,\n        session.incarnation,\n        freshCandidate,\n      );",
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
    // #692 — the provider stop cannot be rolled back, so a CEO resolution that lands after
    // STOPPED must be checkpointed again before the binding revocation reads its live runs.
    what: "suspension reblocks a run that a CEO resolution revived after its owner stopped",
    file: "src/cto/cto-lifecycle.ts",
    find: "          if (run.state !== RunState.ACTIVE) continue;",
    replace: "          if (true) continue;",
    killedBy: [
      "tests/unit/cto-registry-r2.test.ts::reblocks an escalation resolved while suspension stops its owner",
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
    // #682 (fourth review): `completeNoReplyAndResolveTurn` used to overwrite `result_json`
    // unconditionally, gated only by `turn_claim_json` checks that cannot see a reply reservation
    // — `outcome.replayed` at the call site is a snapshot taken when `route()` returned, and
    // cannot see a reservation another poller commits after that snapshot and before this
    // transaction starts: `reserveResponse` writes `result_json` but never touches
    // `turn_claim_json`, so the checks above would still see a claim with neither terminal fact
    // and proceed to destroy a PENDING reservation — durable evidence that Telegram may already
    // have accepted a reply. Widening the WHERE clause back to an unconditional match (the
    // original bug) restores exactly that: a reservation lands, the no-reply path runs on the same
    // nonce, and the reservation is gone.
    what: "a no-reply resolution's write is bound to the row still being fresh ADMITTED, not any row for this nonce",
    file: "src/ingress/ingress-guard.ts",
    find:
      "        `UPDATE inbound_messages SET result_json = ? WHERE channel = ? AND nonce = ? AND (\n" +
      "           result_json IS NULL OR (\n" +
      "             json_extract(result_json, '$.kind') = 'TELEGRAM_WORKFLOW' AND\n" +
      "             json_extract(result_json, '$.phase') = 'ADMITTED'\n" +
      "           )\n" +
      "         )`,",
    replace: "        `UPDATE inbound_messages SET result_json = ? WHERE channel = ? AND nonce = ?`,",
    killedBy: [
      "tests/unit/ingress-no-reply-turn-resolution.test.ts::#682, fourth review: a reservation that lands after the router's snapshot survives the no-reply path",
    ],
  },
  {
    // #695: both places the DIRECT branch read `unresolvedTurns()` used only its first (oldest)
    // element. A second unresolved turn accumulates whenever an overriding claim itself goes
    // unresolved (A crashes, `/again` claims B, B also crashes) — and the override record must
    // name every outstanding nonce at claim time, not only the oldest, or a later `/again` is
    // recorded as overriding a turn that was never actually the only one outstanding.
    what: "the override record captures every unresolved nonce, not only the oldest",
    file: "src/ingress/telegram-router.ts",
    find: "        const overriddenUnresolvedNonces = unresolved.length > 0 ? unresolved.map((turn) => turn.nonce) : undefined;",
    replace: "        const overriddenUnresolvedNonces = unresolved[0] ? [unresolved[0].nonce] : undefined;",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::#695: names both unresolved turns, not only the oldest, once a second one accumulates",
    ],
  },
  {
    // Sol's BLOCK on the #695 fix above: `unresolvedTurns` rows are never pruned, so naming all
    // of them without a cap is unbounded — 146 real unresolved rows already produce a
    // 4,099-character joined line, past Telegram's 4,096-character sendMessage limit, and a
    // send failure there wedges the poller (it throws before the offset advances). Without the
    // cap, the reply reverts to enumerating every row.
    what: "the park reply names at most MAX_NAMED_UNRESOLVED_TURNS rows, summarizing the rest",
    file: "src/ingress/telegram-router.ts",
    find: "  const shown = unresolved.slice(0, MAX_NAMED_UNRESOLVED_TURNS);",
    replace: "  const shown = unresolved;",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::#695: bounds the park reply's enumeration past the cap, and still records every overridden nonce",
    ],
  },
  {
    // A blind review found this gap after the fix above shipped: #680 (main) wrote the singular
    // `overriddenUnresolvedNonce`, and `IngressGuard.prune` deliberately never removes an
    // unresolved claim, so a row in that shape does not age out on its own. Without the
    // normalization, `unresolvedTurns` would silently report `overriddenUnresolvedNonces:
    // undefined` for every such row, indistinguishable from a turn that overrode nothing.
    what: "unresolvedTurns normalizes a pre-#695 singular overriddenUnresolvedNonce into the plural array",
    file: "src/ingress/ingress-guard.ts",
    find: "  return { ...rest, overriddenUnresolvedNonces: [overriddenUnresolvedNonce] };",
    replace: "  return claim;",
    killedBy: [
      "tests/unit/ingress-turn-claim.test.ts::normalizes a pre-#695 row's singular overriddenUnresolvedNonce into the plural array",
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
    // The scheduled entrypoint imports TypeScript before it can inspect an issue. Removing the
    // install restores the clean-checkout ERR_MODULE_NOT_FOUND that blocked #689.
    what: "the scheduled tracker-loci workflow installs dependencies before starting its scanner",
    file: ".github/workflows/tracker-loci.yml",
    find: "      - run: pnpm install --frozen-lockfile --ignore-scripts",
    replace: "      - run: true",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::scheduled workflow installs dependencies before the tracker command can load TypeScript",
    ],
  },
  {
    // The clean scheduled-checkout probe exposes only packages declared in package.json. Replacing
    // the parser with a nonexistent bare import must fail before the fake GitHub client is reached.
    what: "every package imported by the scheduled tracker-loci entrypoint is resolvable after its declared install",
    file: "scripts/lib/tracker-loci-strip.mjs",
    find: 'import ts from "typescript";',
    replace: 'import ts from "tracker-loci-deliberately-missing";',
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::scheduled entrypoint resolves every import from the dependencies the workflow installs",
    ],
  },
  {
    // The top-level table covers both markers and variable-length runs without claiming every
    // container spelling. Removing tilde from the executable grammar reopens the false green.
    what: "supported top level fence marker length indentation and info string forms make vanished code stale",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find: '    markers: Object.freeze(["`", "~"]),',
    replace: '    markers: Object.freeze(["`"]),',
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::supported top level fence marker length indentation and info string forms make vanished code stale",
    ],
  },
  {
    what: "blockquote prefixes are removed before fence indentation is judged",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find: "  const blockquote = blockquoteLineForOpening(rawLine);",
    replace: "  const blockquote = { logical: rawLine, depth: 0 };",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::blockquote and list container relative fences make vanished code stale",
    ],
  },
  {
    what: "list markers and continuation indentation are removed before fence indentation is judged",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find: "  const directList = listItemLine(blockquote.logical);",
    replace: "  const directList = null;",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::blockquote and list container relative fences make vanished code stale",
    ],
  },
  {
    what: "an inline backtick span closes only on a run equal to its opener",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find: "      if (runEnd - cursor === openerLength) {",
    replace: "      if (runEnd - cursor > 0) {",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::a backtick run closes only at an equal length run",
    ],
  },
  {
    what: "a backtick wrapped citation consumes its whole equal length closing run",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find:
      "    if (closingRun?.length === backtickOpener.length) {\n" +
      "      return { matched: true, tail: after.slice(closingRun.length), unsupportedReason: null };\n" +
      "    }",
    replace:
      "    if (closingRun !== null) {\n" +
      "      return { matched: true, tail: after.slice(1), unsupportedReason: null };\n" +
      "    }",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::a backtick run closes only at an equal length run",
    ],
  },
  {
    what: "signed line numbers reach stale classification instead of disappearing at extraction",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find: '    integerSource: "-?\\\\d+",',
    replace: '    integerSource: "\\\\d+",',
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::negative line numbers in every supported coordinate form are stale instead of invisible",
    ],
  },
  {
    what: "symbol extraction accepts Unicode identifier starts from the shared grammar",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find: '  identifierStartSource: "[\\\\p{ID_Start}$_]",',
    replace: '  identifierStartSource: "[A-Za-z$_]",',
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::Unicode identifiers resolve when present and are stale when absent",
    ],
  },
  {
    what: "symbol search boundaries use identifier continuation instead of ASCII word boundaries",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find:
      "  return new RegExp(\n" +
      "    `(?<!${SYMBOL_GRAMMAR_RULES.identifierContinueSource}|${escapeRegex(SYMBOL_GRAMMAR_RULES.privatePrefix)})` +\n" +
      "      `${escaped}` +\n" +
      "      `(?!${SYMBOL_GRAMMAR_RULES.identifierContinueSource})`,\n" +
      '    "u",\n' +
      "  );",
    replace: '  return new RegExp(`\\\\b${escaped}\\\\b`, "u");',
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::dollar prefixed identifiers resolve when present and are stale when absent",
    ],
  },
  {
    what: "a private identifier prefix is part of the symbol search boundary",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find:
      "    `(?<!${SYMBOL_GRAMMAR_RULES.identifierContinueSource}|${escapeRegex(SYMBOL_GRAMMAR_RULES.privatePrefix)})` +",
    replace: "    `(?<!${SYMBOL_GRAMMAR_RULES.identifierContinueSource})` +",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::an unprefixed private identifier citation does not match the prefixed symbol",
    ],
  },
  {
    what: "a symbol citation is unresolved when its explicit path matches only an unrelated basename",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find: '    if (resolved.matchKind === "basename") {\n      unresolved.push({',
    replace: "    if (false) {\n      unresolved.push({",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::a parent relative symbol path is unresolved instead of matching only its basename",
    ],
  },
  {
    what: "a local slash branch does not register its final segment as a separate known ref",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find: '        refs.add(refname.slice("refs/heads/".length));',
    replace:
      '        const localRef = refname.slice("refs/heads/".length);\n' +
      "        refs.add(localRef);\n" +
      '        const slash = localRef.indexOf("/");\n' +
      "        if (slash !== -1) refs.add(localRef.slice(slash + 1));",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::a local slash branch does not manufacture a known short ref",
    ],
  },
  {
    what: "quoted non identifiers in a symbol citation report unsupported instead of disappearing",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find:
      "    if (symbol === null) {\n" +
      "      noteUnsupported(\n" +
      "        m[0],\n" +
      "        `quoted symbol \\`${m[1]}\\` is ${SYMBOL_GRAMMAR_RULES.invalidQuotedToken}; ` +\n" +
      "          `use ${SYMBOL_GRAMMAR_RULES.support} ` +\n" +
      '          "JavaScript/TypeScript identifier or dotted member-reference syntax, or rewrite the citation",\n' +
      "      );\n" +
      "      continue;\n" +
      "    }",
    replace: "    if (symbol === null) continue;",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::quoted non identifiers are unsupported instead of disappearing",
    ],
  },
  {
    what: "explicit citation shapes outside the grammar fail instead of reporting success",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find: "  unsupported.length > 0 ||\n  nonDurableFindings.length > 0 ||",
    replace: "  false ||\n  nonDurableFindings.length > 0 ||",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::explicit citation shapes outside the grammar fail as unsupported instead of disappearing",
    ],
  },
  {
    // A Markdown link's closing parenthesis sits just after the lexical path or URL match. Leaving
    // it in front of the following backtick makes the quoted content invisible and downgrades a
    // genuinely vanished line from STALE to ADVISORY.
    what: "a Markdown link closing delimiter is removed before its quoted content is read",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find: "    return { matched: true, tail: after.slice(close.length), unsupportedReason: null };",
    replace: "    return { matched: true, tail: after, unsupportedReason: null };",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::bare and Markdown linked loci give vanished quoted content the same STALE verdict",
    ],
  },
  {
    // Whitespace means the citation already ended. Crossing it consumes the opening backtick of
    // the quoted content and turns a real stale-content finding back into a line-number advisory.
    what: "a separator cannot consume the opening backtick of quoted citation content",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find: '  t = t.replace(/^[\\s:—–-]+/, ""); // the separator between a citation and what follows',
    replace: '  t = t.replace(/^[\\s`—–:-]+/, ""); // the separator between a citation and what follows',
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::a separator cannot consume the opening backtick of quoted citation content",
    ],
  },
  {
    // Dropping pages after the first one is the old 500-item blind spot in another spelling.
    what: "every open GitHub issue page is checked instead of silently truncating after five hundred",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find: "    return pages.flat().filter((issue) => !issue.pull_request);",
    replace: "    return pages.slice(0, 1).flat().filter((issue) => !issue.pull_request);",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::the GitHub API pagination includes a stale issue after the five hundredth",
    ],
  },
  {
    // URL.search is not part of URL.pathname. Folding it back into the pathname recreates the
    // exact false STALE from #689 for both query strings GitHub emits on blob links.
    what: "a GitHub blob URL query string is not part of its tracked path",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find: "    segments = parsed.pathname.split(\"/\").map((segment) => decodeURIComponent(segment));",
    replace:
      "    segments = `${parsed.pathname}${parsed.search}`.split(\"/\").map((segment) => decodeURIComponent(segment));",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::GitHub blob URL query strings do not become part of the tracked path",
    ],
  },
  {
    // With neither a known ref nor a tracked-file tail, a multi-segment span has more than one
    // possible boundary. Treating it like the unambiguous two-segment form manufactures a path.
    what: "an unknown multi segment blob ref is reported unresolved instead of absent",
    file: "scripts/verify-tracker-loci-resolve.mjs",
    find: "  if (segments.length === 2) {",
    replace: "  if (segments.length >= 2) {",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::an unknown multi segment blob ref is reported unresolved instead of absent",
    ],
  },
  {
    // Without the regex branch, the quote inside cli-adapters.ts's /(["\\])/g character class
    // opens a fake string and erases all three real declarations the production CLI checks.
    what: "a JavaScript regex literal is one atomic span before quotes and comments are dispatched",
    file: "scripts/lib/tracker-loci-strip.mjs",
    find: '      if (ch === "/" && regexStarts.has(i)) {',
    replace: "      if (false) {",
    killedBy: [
      "tests/unit/verify-tracker-loci-resolve.test.ts::ManagedWriteScope remains visible after a regex literal",
    ],
  },
  {
    // Treating every slash as a regex opener consumes the rest of a division line when no closing
    // slash exists, recreating the opposite half of the lexical ambiguity this fix must resolve.
    what: "a slash after an expression ending token remains division rather than opening a regex literal",
    file: "scripts/lib/tracker-loci-strip.mjs",
    find: '      if (ch === "/" && regexStarts.has(i)) {',
    replace: '      if (ch === "/") {',
    killedBy: ["tests/unit/tracker-loci-strip-invariants.test.ts::division does not open a regex literal"],
  },
  {
    // Without the envelope boundary, an HTML/plain-text proxy rejection falls through to the
    // status classifier and a 403 is consumed as if Telegram had rejected this one message.
    what: "an HTML 403 is a global retryable transport fault and holds the ordered offset",
    file: "src/ingress/telegram-polling.ts",
    find: "      if (!response.ok) {\n        if (!isTelegramApiError(parsed)) {",
    replace: "      if (!response.ok) {\n        if (false) {",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::an HTML 403 is a global retryable transport fault and holds the ordered offset",
    ],
  },
  {
    // A proxy can return Telegram-shaped JSON without Telegram's integer error_code. Removing
    // that discriminator consumes the request as a permanent Telegram rejection and drops it.
    what: "a JSON 403 without an error code is a global retryable transport fault and holds the ordered offset",
    file: "src/ingress/telegram-polling.ts",
    find:
      "  && telegramDescription(payload) !== null\n" +
      "  && Number.isSafeInteger(payload[\"error_code\"])\n" +
      "  && Number(payload[\"error_code\"]) > 0;",
    replace: "  && telegramDescription(payload) !== null;",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a JSON 403 without an error code is a global retryable transport fault and holds the ordered offset",
    ],
  },
  {
    // migrate_to_chat_id identifies this request's destination as obsolete. Removing that
    // structured signal leaves a message-specific 400 retryable and wedges 101 later updates.
    what: "a permanent 400 advances past 101 later updates and its terminal reply has an operator exit",
    file: "src/ingress/telegram-polling.ts",
    find: "  return telegramMigrateToChatId(payload) !== null",
    replace: "  return false",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a permanent 400 advances past 101 later updates and its terminal reply has an operator exit",
    ],
  },
  {
    // Telegram names the request's reply target as missing. Removing that semantic signal leaves
    // a message-specific 400 retryable and prevents the earlier pending turn from draining.
    what: "a later permanent 400 cannot advance the offset past an earlier pending CEO turn",
    file: "src/ingress/telegram-polling.ts",
    find: "    || description === \"Bad Request: reply message not found\"",
    replace: "    || false",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a later permanent 400 cannot advance the offset past an earlier pending CEO turn",
    ],
  },
  {
    // This description confines the refusal to the destination user. Removing it makes one
    // blocked chat hold unrelated updates even though the shared Bot API remains usable.
    what: "a structured Telegram 403 is terminal and advances the ordered offset",
    file: "src/ingress/telegram-polling.ts",
    find: "    || description === \"Forbidden: bot was blocked by the user\";",
    replace: "    || false;",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a structured Telegram 403 is terminal and advances the ordered offset",
    ],
  },
  {
    // Telegram has no structured scope field. Dropping the request-local predicate recreates the
    // 421 loss by consuming a self-hosted server's token-range configuration rejection.
    what: "a structured 421 token-range rejection is global and holds the ordered offset",
    file: "src/ingress/telegram-polling.ts",
    find: "  if (statusCode >= 400 && statusCode < 500 && isTelegramRequestLocalRejection(payload)) {",
    replace: "  if (statusCode >= 400 && statusCode < 500) {",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a structured 421 token-range rejection is global and holds the ordered offset",
    ],
  },
  {
    // Narrowing the server-error default to the familiar 503 makes an unlisted 502 look global
    // rather than retryable and lets an enumeration stand in for the status class.
    what: "a 5xx outage leaves its update retryable and holds the ordered offset",
    file: "src/ingress/telegram-polling.ts",
    find: "  if (statusCode >= 500 && statusCode < 600) {",
    replace: "  if (statusCode === 503) {",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a 5xx outage leaves its update retryable and holds the ordered offset",
    ],
  },
  {
    // An unrecognised response provides no evidence that this one request is permanently bad;
    // consuming it instead of holding the batch would silently discard the unexplained request.
    what: "an unrecognisable status is global and holds its ordered offset",
    file: "src/ingress/telegram-polling.ts",
    find:
      "  // No scope evidence means the failure may affect every request. Holding the ordered offset is\n" +
      "  // recoverable; terminalizing an unrecognised shared fault would silently lose the reply.\n" +
      "  return {\n" +
      "    kind: \"GLOBAL_REJECTION\",",
    replace:
      "  // No scope evidence means the failure may affect every request. Holding the ordered offset is\n" +
      "  // recoverable; terminalizing an unrecognised shared fault would silently lose the reply.\n" +
      "  return {\n" +
      "    kind: \"PERMANENT_REJECTION\",",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::an unrecognisable status is global and holds its ordered offset",
    ],
  },
  {
    // Removing the v34 boundary makes v33 current again, so opening it takes no pre-migration
    // backup before this binary can begin writing Hermes target-bind receipt evidence.
    what: "opening a v33 database takes an automatic rollback snapshot before v34 target-bind receipt state",
    file: "src/db/migrations.ts",
    find: "export const SCHEMA_VERSION = 34;",
    replace: "export const SCHEMA_VERSION = 33;",
    killedBy: [
      "tests/unit/database-migration-restore.test.ts::opening a v33 database takes an automatic rollback snapshot before v34 target-bind receipt state",
    ],
  },
  {
    // Telegram's response body is the only source of retry_after. Reading only the HTTP status
    // stops the current storm but schedules the next attempt earlier than Telegram requested.
    what: "a Telegram 429 preserves its retry after instruction",
    file: "src/ingress/telegram-polling.ts",
    find: "      retryAfterSeconds: telegramRetryAfterSeconds(payload),",
    replace: "      retryAfterSeconds: null,",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a 429 rate limit leaves its update retryable and holds the ordered offset",
    ],
  },
  {
    // A known-not-sent service failure is safe to retry. It must release the reserved reply and
    // reject its route so retryUpdate holds this update's place in the ordered offset queue.
    what: "a retryable Telegram service failure holds its ordered update",
    file: "src/ingress/telegram-polling.ts",
    find: "      if (policy.reply === \"RELEASE\") {",
    replace:
      "      if (false) {",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a 5xx outage leaves its update retryable and holds the ordered offset",
    ],
  },
  {
    // Advancing is safe only after the permanent rejection is durably terminal. Releasing it to
    // RETRYABLE while advancing recreates the silent orphan behind the round-four wedge.
    what: "a permanent Telegram rejection is durably recorded as terminal",
    file: "src/ingress/telegram-polling.ts",
    find: "        this.router.abandonResponse(outcome, error.failure);",
    replace: "        this.router.releaseResponse(outcome);",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a permanent 400 advances past 101 later updates and its terminal reply has an operator exit",
    ],
  },
  {
    // An unknown outcome may already be an accepted send. Retrying it can duplicate an external
    // message, so its reply state must be terminal before the listener stops.
    what: "an unknown send result is durably terminal without automatic retry",
    file: "src/ingress/telegram-polling.ts",
    find: "        this.router.recordUnknownResponse(outcome, error.failure);",
    replace: "        throw error;",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::an unknown send result is terminal without automatic retry and stops the loop",
    ],
  },
  {
    // The terminal reply state prevents a duplicate of this send; the batch action independently
    // prevents a later message from following an outcome whose scope is unknown.
    what: "an unknown send result stops the loop before a later message",
    file: "src/ingress/telegram-polling.ts",
    find: "  UNKNOWN: { reply: \"SETTLE\", batch: \"STOP\" },",
    replace: "  UNKNOWN: { reply: \"SETTLE\", batch: \"ADVANCE\" },",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::an unknown send result is terminal without automatic retry and stops the loop",
    ],
  },
  {
    // Runtime status reaches health through this value. Pinning it to running recreates the
    // invisible stop even though the listener still emits its exact UNKNOWN state.
    what: "UNKNOWN stop changes daemon health to stopped",
    file: "src/daemon/agentcpd.ts",
    find: "          running: status.running,",
    replace: "          running: true,",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::UNKNOWN stop changes daemon health to stopped",
    ],
  },
  {
    // The durable acknowledgement is not recovery by itself. Removing this live-listener action
    // recreates the issue: Doctor's database warning closes while the existing poller stays down.
    what: "the exact UNKNOWN reply acknowledgement resumes the existing Telegram listener",
    file: "src/daemon/daemon.ts",
    find: "            await this.#telegramIngressController?.resumeAfterAcknowledgement(nonce.value);",
    replace: "            await Promise.resolve(false);",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::exact nonce acknowledge restarts the existing listener",
    ],
  },
  {
    // Restarting the poller is not enough for Doctor to become truthful again. The recovered
    // listener must publish that it is running so daemon health leaves the stopped state.
    what: "Doctor stays truthful after acknowledge because ingress is running",
    file: "src/ingress/telegram-polling.ts",
    find: "    this.options.onRuntimeStatus?.({ running: true, stopReason: null, recoveryNonce: null });",
    replace: "",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::Doctor stays truthful after acknowledge because ingress is running",
    ],
  },
  {
    // Terminal delivery states are useful only if the inbound acknowledgement moves past them.
    // Removing this update leaves the unanswerable row visible but restores the 100-update wedge.
    what: "a terminal Telegram reply advances the inbound offset",
    file: "src/ingress/telegram-polling.ts",
    find:
      "          (outcome) => {\n" +
      "            this.completeUpdate(update.update_id);\n" +
      "            return outcome;\n" +
      "          },",
    replace:
      "          (outcome) => {\n" +
      "            return outcome;\n" +
      "          },",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a permanent 400 advances past 101 later updates and its terminal reply has an operator exit",
    ],
  },
  {
    // A recovered PENDING may be the record lagging a successful send. Returning its stored reply
    // asks the polling loop to cross the irreversible Telegram boundary a second time.
    what: "a crash after a successful send leaves one unresolved reply and never sends it again",
    file: "src/ingress/telegram-router.ts",
    find: "      return completedRoute(this.storedResponseOutcome(update, recovered, false));",
    replace: "      return completedRoute(this.storedResponseOutcome(update, recovered, true));",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a crash after a successful send leaves one unresolved reply and never sends it again",
    ],
  },
  {
    // A later route may settle while an earlier CEO turn is still running. Telegram's offset
    // confirms every lower update id, so the drain must stop at the first non-settled entry.
    what: "a later terminal reply cannot advance the offset past an earlier pending CEO turn",
    file: "src/ingress/telegram-polling.ts",
    find: "      if (this.#updateStates.get(next)?.status !== \"SETTLED\") break;",
    replace: "      if (false) break;",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a later permanent 400 cannot advance the offset past an earlier pending CEO turn",
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
      "tests/unit/telegram-ingress.test.ts::a permanent 400 advances past 101 later updates and its terminal reply has an operator exit",
    ],
  },
  {
    // Acknowledgement is the operator exit: the delivery fact stays terminal, while Doctor stops
    // presenting a reviewed NO_RETRY disposition as work nobody has addressed.
    what: "a permanent 400 advances past 101 later updates and its terminal reply has an operator exit",
    file: "src/doctor/doctor.ts",
    find: "          AND json_type(result_json, '$.operatorResolution') IS NULL",
    replace: "          AND json_type(result_json, '$.operatorResolution') IS NOT NULL",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a permanent 400 advances past 101 later updates and its terminal reply has an operator exit",
    ],
  },
  {
    // The stored disposition is deliberately NO_RETRY: an operator clears the alert without
    // asserting that Telegram delivered the reply or granting a later automatic resend.
    what: "a permanent 400 advances past 101 later updates and its terminal reply has an operator exit",
    file: "src/ingress/ingress-guard.ts",
    find:
      "  const operatorResolution: TelegramReplyOperatorResolution = {\n" +
      "    disposition: \"NO_RETRY\",",
    replace:
      "  const operatorResolution: TelegramReplyOperatorResolution = {\n" +
      "    disposition: \"RETRY\",",
    killedBy: [
      "tests/unit/telegram-ingress.test.ts::a permanent 400 advances past 101 later updates and its terminal reply has an operator exit",
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
      "tests/unit/telegram-ingress.test.ts::an unknown send result is terminal without automatic retry and stops the loop",
    ],
  },
  {
    // #693 — the no-replace trigger refuses a colliding or moved source row, never a fresh one: a
    // new (channel, nonce) at a new batch_ordinal, inserted onto a turn that already exists,
    // passed every WHEN clause above it. This is the write-time backstop: every source `claim()`
    // writes shares its turn's own `claim_audit_event_id`, so a source citing a *fresh*,
    // honestly-produced audit event — including one attached after the claim transaction has
    // closed — is refused. It is an equality check, not a provenance proof: a raw writer that
    // copies the turn's own `claim_audit_event_id` into the new row passes it (pinned by
    // "does NOT refuse a source that copies the turn's own claim event" in the same file), the same
    // residual every trigger here carries against a privileged raw-SQL writer.
    what: "a source citing a fresh audit event instead of its turn's own claim event is refused",
    file: "src/db/schema.sql",
    find: "WHEN NEW.admission_audit_event_id <> (\n  SELECT claim_audit_event_id FROM canonical_turns WHERE turn_request_id = NEW.turn_request_id\n)\nBEGIN",
    replace: "WHEN 0\nBEGIN",
    killedBy: [
      "tests/unit/canonical-turn-ledger.test.ts::refuses a source citing a fresh audit event instead of the turn's own claim event",
    ],
  },
  {
    what: "the startup probe enters each standalone scenario through the production daemon factory",
    file: "scripts/probe-daemon-startup.ts",
    find: "    const daemon = cp.createDaemon({ stateDir });\n    const observed = await observeStartup(daemon);",
    replace:
      "    const daemon = cp.daemonFinalizationAuthorities();\n    const observed = await observeStartup(daemon);",
    killedBy: [
      "tests/process/daemon-startup-probe.test.ts::keeps startup outcomes independent of provider login files",
    ],
  },
  {
    what: "the startup probe rebuilds the production daemon after provisioning a refused deployment",
    file: "scripts/probe-daemon-startup.ts",
    find: "    const retryDaemon = cp.createDaemon({ stateDir });\n    const immediate = await observeStartup(retryDaemon);",
    replace:
      "    const retryDaemon = cp.daemonFinalizationAuthorities();\n    const immediate = await observeStartup(retryDaemon);",
    killedBy: [
      "tests/process/daemon-startup-probe.test.ts::keeps startup outcomes independent of provider login files",
    ],
  },
  {
    what: "the startup probe injects isolated usage collectors before constructing production adapters",
    file: "scripts/probe-daemon-startup.ts",
    find: "  if (collectorMode === \"isolated\") config.adapterOptions = isolatedAdapterOptions();",
    replace: "  if (false) config.adapterOptions = isolatedAdapterOptions();",
    killedBy: [
      "tests/process/daemon-startup-probe.test.ts::keeps startup outcomes independent of provider login files",
    ],
  },
  {
    what: "the startup probe waits out the backoff it triggered before measuring recovery",
    file: "scripts/probe-daemon-startup.ts",
    find: "    await wait(Math.max(0, Date.parse(retryNotBefore) - waitStartedAt + 25));",
    replace: "    await wait(0);",
    killedBy: [
      "tests/process/daemon-startup-probe.test.ts::keeps startup outcomes independent of provider login files",
    ],
  },
  {
    // The rollback image can carry the very missing guard that made an upgrade fail. Operator
    // restore still requires that guard; this process-owned, exact-checksum snapshot must not.
    what: "automatic migration rollback validates the captured image without requiring the invariant that migration was repairing",
    file: "src/db/backup.ts",
    find: "  const manifest = validateBackup(backup.path, { assertSchemaInvariants: false });",
    replace: "  const manifest = validateBackup(backup.path, { assertSchemaInvariants: true });",
    killedBy: [
      "tests/unit/database-migration-restore.test.ts::restores a pinned v11 image whose missing guard was repaired before a later migration failure",
    ],
  },
  {
    // Renaming the old main file away while taking its forensic copy leaves no database for a
    // restart to open if the process dies before the staged image is installed.
    what: "restore keeps the live database readable until atomic replacement",
    file: "src/db/backup.ts",
    find: "      if (preservedDatabasePath) copyForensicFile(databasePath, preservedDatabasePath);",
    replace: "      if (preservedDatabasePath) renameSync(databasePath, preservedDatabasePath);",
    killedBy: [
      "tests/unit/database-migration-restore.test.ts::restore keeps the live database readable until atomic replacement",
    ],
  },
  {
    // Checkpointing first mutates the main file and can truncate the WAL before their forensic
    // copies exist. A hard link would share the same mutation, so the source set must be copied.
    what: "restore copies the original database and sidecars before checkpointing the live database",
    file: "src/db/backup.ts",
    find: "      preserveExisting();\n      preservationComplete = true;\n      if (hadDatabase) checkpointExistingWal(databasePath);",
    replace: "      if (hadDatabase) checkpointExistingWal(databasePath);\n      preserveExisting();\n      preservationComplete = true;",
    killedBy: [
      "tests/unit/database-migration-restore.test.ts::restore copies the original database and sidecars before checkpointing the live database",
    ],
  },
  {
    // A current database stamped one version back is not a released schema. The pinned SQL is v11,
    // so the verifier must enter the migration chain at the version that actually produced it.
    what: "the fresh database verifier opens its pinned released schema at v11",
    file: "scripts/verify-fresh-database.ts",
    find: "    raw.pragma(\"user_version = 11\");",
    replace: "    raw.pragma(`user_version = ${SCHEMA_VERSION - 1}`);",
    killedBy: [
      "tests/unit/database-migration-restore.test.ts::migrates pinned v11 and restores it after the injected post-v12 failure",
    ],
  },
  {
    what: "the plausible script-site census includes every regular direct child regardless of extension",
    file: "scripts/verify-every-script-has-a-plausible-caller.mjs",
    find:
      "const scriptFiles = readdirSync(scriptsDir)\n" +
      "  .filter((name) => statSync(join(scriptsDir, name)).isFile())\n" +
      "  .sort();",
    replace:
      "const scriptFiles = readdirSync(scriptsDir)\n" +
      "  .filter((name) => statSync(join(scriptsDir, name)).isFile())\n" +
      "  .filter((name) => /\\.(mjs|ts|js|cjs)$/.test(name))\n" +
      "  .sort();",
    killedBy: [
      "tests/process/every-script-has-a-plausible-caller.test.ts::finds shell Python and extensionless scripts with no plausible site",
    ],
  },
  {
    what: "an interpreter argument outside its plausible entrypoint position is not counted as a site",
    file: "scripts/verify-every-script-has-a-plausible-caller.mjs",
    find: "  return entrypoint !== null && isScriptOperand(entrypoint, needle);",
    replace: "  return words.includes(needle);",
    killedBy: [
      "tests/process/every-script-has-a-plausible-caller.test.ts::rejects interpreter arguments that are not plausible entrypoint positions",
    ],
  },
  {
    what: "every recognized test-spawn site is labeled execution unproven",
    file: "scripts/verify-every-script-has-a-plausible-caller.mjs",
    find:
      "  for (const test of testSources) {\n" +
      "    if (testFileHasPlausibleSpawn(test.text, name)) {\n" +
      "      sites.push({ type: \"test\", file: test.source, plausibleCiRoute: true, execution: \"unproven\" });\n" +
      "    }\n" +
      "  }",
    replace:
      "  for (const test of testSources) {\n" +
      "    if (testFileHasPlausibleSpawn(test.text, name)) {\n" +
      "      sites.push({ type: \"test\", file: test.source, plausibleCiRoute: true, execution: \"observed\" });\n" +
      "    }\n" +
      "  }",
    killedBy: [
      "tests/process/every-script-has-a-plausible-caller.test.ts::reports a skipped spawn as execution unproven",
    ],
  },
  {
    what: "a real suite spawn is included as a plausible test site",
    file: "scripts/verify-every-script-has-a-plausible-caller.mjs",
    find:
      "  for (const test of testSources) {\n" +
      "    if (testFileHasPlausibleSpawn(test.text, name)) {\n" +
      "      sites.push({ type: \"test\", file: test.source, plausibleCiRoute: true, execution: \"unproven\" });\n" +
      "    }\n" +
      "  }",
    replace: "  for (const test of []) void test;",
    killedBy: [
      "tests/process/every-script-has-a-plausible-caller.test.ts::counts a real spawn as plausible and leaves execution unproven",
    ],
  },
  {
    what: "a plausible package CI route flows from a reached site to the alias it invokes",
    file: "scripts/verify-every-script-has-a-plausible-caller.mjs",
    find:
      "const queue = [...plausiblyCiRoutedPackageScripts];\n" +
      "while (queue.length > 0) {\n" +
      "  const caller = queue.shift();\n" +
      "  for (const called of packageCallsIn(packageScripts[caller], packageScriptNames)) {\n" +
      "    if (plausiblyCiRoutedPackageScripts.has(called)) continue;\n" +
      "    plausiblyCiRoutedPackageScripts.add(called);\n" +
      "    queue.push(called);\n" +
      "  }\n" +
      "}",
    replace:
      "const queue = [];\n" +
      "let grew = true;\n" +
      "while (grew) {\n" +
      "  grew = false;\n" +
      "  for (const [caller, command] of packageScriptEntries) {\n" +
      "    if (plausiblyCiRoutedPackageScripts.has(caller)) continue;\n" +
      "    const callsReachedAlias = [...packageCallsIn(command, packageScriptNames)].some((called) =>\n" +
      "      plausiblyCiRoutedPackageScripts.has(called),\n" +
      "    );\n" +
      "    if (!callsReachedAlias) continue;\n" +
      "    plausiblyCiRoutedPackageScripts.add(caller);\n" +
      "    grew = true;\n" +
      "  }\n" +
      "}",
    killedBy: [
      "tests/process/every-script-has-a-plausible-caller.test.ts::does not propagate a plausible CI route from callee back to an unused package site",
    ],
  },
  {
    what: "any plausibly CI routed package alias marks a multiply aliased script route plausible",
    file: "scripts/verify-every-script-has-a-plausible-caller.mjs",
    find:
      "    withPlausibleSites.push({\n" +
      "      name,\n" +
      "      plausibleSites,\n" +
      "      plausibleCiRoute: plausibleSites.some((site) => site.plausibleCiRoute),\n" +
      "    });",
    replace:
      "    withPlausibleSites.push({\n" +
      "      name,\n" +
      "      plausibleSites,\n" +
      "      plausibleCiRoute: plausibleSites[0].plausibleCiRoute,\n" +
      "    });",
    killedBy: [
      "tests/process/every-script-has-a-plausible-caller.test.ts::uses any plausibly CI routed package alias for a multiply aliased script",
    ],
  },
  {
    what: "the scan enters both tests and documents",
    file: "scripts/verify-stale-coordinate-literals.mjs",
    find:
      'const testFiles = filesBelow("tests", (path) => sourceExtensions.has(extensionOf(path)));\n' +
      'const documentFiles = filesBelow("docs", (path) => path.endsWith(".md"));',
    replace: "const testFiles = [];\nconst documentFiles = [];",
    killedBy: [
      "tests/unit/verify-stale-coordinate-literals.test.ts::the scan enters both tests and documents",
    ],
  },
  {
    what: "an existing production line copied into a test is rejected",
    file: "scripts/verify-stale-coordinate-literals.mjs",
    find: "      if (!existsSync(join(repoRoot, productionPath))) continue;",
    replace: "      if (true) continue;",
    killedBy: [
      "tests/unit/verify-stale-coordinate-literals.test.ts::an existing production line copied into a test is rejected",
    ],
  },
  {
    what: "a missing production path remains a stable negative control",
    file: "scripts/verify-stale-coordinate-literals.mjs",
    find: "      if (!existsSync(join(repoRoot, productionPath))) continue;",
    replace: "      if (false) continue;",
    killedBy: [
      "tests/unit/verify-stale-coordinate-literals.test.ts::a missing production path remains a stable negative control",
    ],
  },
  {
    what: "a discovered file count pinned to a literal is rejected",
    file: "scripts/verify-stale-coordinate-literals.mjs",
    find:
      "          if (readsDiscoveredMembers) pins.push({ index: node.getStart(sourceFile), count: node.arguments[0].text });",
    replace:
      "          if (false) pins.push({ index: node.getStart(sourceFile), count: node.arguments[0].text });",
    killedBy: [
      "tests/unit/verify-stale-coordinate-literals.test.ts::a discovered file count pinned to a literal is rejected",
    ],
  },
  {
    what: "a measured SHA is consumed by its reproduction command",
    file: "scripts/verify-stale-coordinate-literals.mjs",
    find:
      "        const consumesMeasuredRef = new RegExp(`--ref(?:=|\\\\s+)${sha}(?:\\\\s|$)`).test(command[1]);",
    replace: "        const consumesMeasuredRef = true;",
    killedBy: [
      "tests/unit/verify-stale-coordinate-literals.test.ts::a measured SHA is consumed by its reproduction command",
    ],
  },
  {
    what: "a workflow job total copied into documentation is rejected",
    file: "scripts/verify-stale-coordinate-literals.mjs",
    find:
      "  const jobTotalPattern = /\\b(?:the\\s+)?workflow\\s+(?:now|currently)\\s+has\\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\\d+)\\s+jobs?\\b/gi;",
    replace: "  const jobTotalPattern = /$^/g;",
    killedBy: [
      "tests/unit/verify-stale-coordinate-literals.test.ts::a workflow job total copied into documentation is rejected",
    ],
  },
  {
    // #416 keeps V1's stated absence of enforcement honest; ACP 2.0 still needs its runtime guard.
    what: "the V1 experiment isolation census scans every production source file",
    file: "scripts/verify-v1-experiment-isolation-declaration.mjs",
    find: 'const sourceFiles = walk("src").filter((file) => file !== ISOLATION_MODULE);',
    replace: "const sourceFiles = [];",
    killedBy: [
      "tests/process/v1-experiment-isolation-declaration.test.ts::detects synthetic experiment state opening and validator consumption",
    ],
  },
  {
    what: "a reported failed test is a product failure",
    file: "scripts/run-vitest-gate.mjs",
    find: "  if (statusCounts.failed > 0) {",
    replace: "  if (statusCounts.failed < 0) {",
    killedBy: [
      "tests/process/vitest-result-gate.test.ts::fails when the result contains a failed test",
    ],
  },
  {
    what: "a reporter-pending assertion is incomplete rather than a completed skip",
    file: "scripts/run-vitest-gate.mjs",
    find:
      "  const pendingAssertions = assertions.filter(\n" +
      '    (assertion) => assertion?.status === "pending",\n' +
      "  ).length;\n" +
      "  const skippedAssertions = statusCounts.skipped;",
    replace:
      "  const pendingAssertions = 0;\n" +
      "  const skippedAssertions = report.numPendingTests;",
    killedBy: [
      "tests/process/vitest-result-gate.test.ts::classifies a reporter pending assertion as incomplete",
    ],
  },
  {
    what: "a nonzero exit after complete passing results is an unexplained run failure",
    file: "scripts/run-vitest-gate.mjs",
    find: "  if (exitCode !== 0) {",
    replace: "  if (exitCode === 0) {",
    killedBy: [
      "tests/process/vitest-result-gate.test.ts::fails closed when a nonzero exit follows complete passing results",
    ],
  },
  {
    what: "an unexplained run failure is not retried into a pass",
    file: "scripts/run-vitest-gate.mjs",
    find:
      "  const result = runAttempt(1);\n" +
      "  printClassification(result.classification, out);\n" +
      '  return result.classification.kind === "pass" ? 0 : 1;',
    replace:
      "  let result = runAttempt(1);\n" +
      "  printClassification(result.classification, out);\n" +
      '  if (result.classification.kind === "run-failure") {\n' +
      "    result = runAttempt(2);\n" +
      "    printClassification(result.classification, out);\n" +
      "  }\n" +
      '  return result.classification.kind === "pass" ? 0 : 1;',
    killedBy: [
      "tests/process/vitest-result-gate.test.ts::does not retry an unexplained run failure",
    ],
  },
  {
    // #737: the rollback preflight in docs/ops/owner-actions.md item 6 checks every file the
    // rollback will read before its first destructive command (`rm -rf .../dist`). This row
    // deletes the launcher check specifically, leaving the other checks around it intact, so a
    // test that only asserted "some check exists somewhere" could not be fooled by this — the
    // named test extracts the whole block and runs it against a fixture backup that is otherwise
    // fully valid and is missing only the launcher file, so with this line gone the extracted
    // script sails through every remaining check and actually runs `rm -rf` against the fixture's
    // live dist directory.
    what: "the rollback preflight refuses a missing launcher backup file before rm -rf runs",
    file: "docs/ops/owner-actions.md",
    find:
      '    test -s "$BYTES_BACKUP/com.agentcontrolplane.agentcpd.plist"\n' +
      '    test -s "$BYTES_BACKUP/agentcpd-launch.sh"\n' +
      '    test -s "$BACKUP_PATH"\n',
    replace:
      '    test -s "$BYTES_BACKUP/com.agentcontrolplane.agentcpd.plist"\n' +
      '    test -s "$BACKUP_PATH"\n',
    killedBy: ["tests/process/the-rollback-preflight-refuses-a-missing-backup-file.test.ts"],
  },
  {
    // #737, CEO's second-round finding: the launcher row above did not cover the *other* named
    // counterexample — nothing mutated the state-admin.js existence/readability guard, so that
    // half of the fixture had a test but no proof the test could fail. This row deletes both
    // lines (existence and readability are one guard for this file; deleting only one would still
    // leave the other blocking `rm -rf`, so it would not be about the file going missing at all).
    // Reproduced by hand before this row existed: with these two lines removed and the
    // state-admin-only-missing fixture otherwise fully valid, the extracted script ran `rm -rf`
    // for real and the named test failed on that — proving the guard was untested, not merely
    // unwritten.
    what: "the rollback preflight refuses a missing backup state-admin.js before rm -rf runs",
    file: "docs/ops/owner-actions.md",
    find:
      '    test -f "$BYTES_BACKUP/dist/db/state-admin.js"\n' +
      '    test -r "$BYTES_BACKUP/dist/db/state-admin.js"\n',
    replace: "",
    killedBy: ["tests/process/the-rollback-preflight-refuses-a-missing-backup-file.test.ts"],
  },
  {
    // #745 round 4, measured. Every `sqlite3` call in the database-backup block passes
    // `-readonly`, and a read-only connection to a WAL database must create the `-shm` file it is
    // not permitted to create: it fails `SQLITE_CANTOPEN (14)` and says nothing about why. The
    // document declares the live database is `delete` — measured, true — but `Db`'s constructor
    // sets `journal_mode = WAL` on a database it creates, so a state file made by this code rather
    // than inherited from an older one is WAL, and the declaration is a fact with an expiry date.
    //
    // Deleting this guard does not make the block succeed on a WAL source; it makes it fail with
    // an errno instead of a sentence. That is why the named test asserts the message and not the
    // exit status — the guard's whole content is that the refusal is legible.
    what: "the database backup step refuses a WAL source by name instead of failing with a bare errno",
    file: "docs/ops/owner-actions.md",
    find:
      '    SOURCE_JOURNAL_FORMAT="$(od -An -tu1 -j18 -N1 "$SOURCE_DB" | tr -d \' \')"\n' +
      '    if [ "$SOURCE_JOURNAL_FORMAT" != "1" ]; then\n' +
      '      echo "refusing: $SOURCE_DB has SQLite write-format $SOURCE_JOURNAL_FORMAT, not 1; a read-only connection cannot open a WAL database and this procedure is not verified for one" >&2; exit 1\n' +
      "    fi\n",
    replace: "",
    killedBy: [
      "tests/process/the-database-backup-step-fails-closed.test.ts::refuses a WAL source by name rather than letting a read-only connection fail with an errno",
    ],
  },
  {
    // #745 round 4, blocker 2. `readManifest` runs `assertPrivatePath` on the backup *and* its
    // manifest, and that requires mode exactly 0600. `.backup` writes with the ambient umask —
    // 0644 on this host — so without this line the restore refuses the artifact on permissions
    // before it ever reaches the manifest's contents. The named test runs the whole documented
    // procedure and hands the result to the real `restoreDatabase`, which is where this surfaces.
    what: "the database backup step makes the backup file private enough for the restore validator to read",
    file: "docs/ops/owner-actions.md",
    find: '    chmod 600 "$BACKUP_TMP"\n',
    replace: "",
    killedBy: [
      "tests/process/the-database-backup-step-fails-closed.test.ts::produces a backup that item 6's real restore validator accepts, end to end",
    ],
  },
  {
    // #745 round 4, blocker 2, the same for the manifest — a separate line, a separate way to
    // fail, and `assertPrivatePath` is called on both paths independently.
    what: "the database backup step makes the manifest private enough for the restore validator to read",
    file: "docs/ops/owner-actions.md",
    find: '    chmod 600 "${BACKUP_TMP}.manifest.json"\n',
    replace: "",
    killedBy: [
      "tests/process/the-database-backup-step-fails-closed.test.ts::produces a backup that item 6's real restore validator accepts, end to end",
    ],
  },
  {
    // #745 round 4, blocker 2, the defect itself. The document had invented a second manifest
    // schema (`agent-control-plane.sqlite-backup/online-v1`, `backupSha256`, `backupUserVersion`)
    // that `readManifest` in src/db/backup.ts refuses outright, so `state-admin.js restore`
    // rejected every backup this procedure produced — the procedure whose only purpose is to make
    // that restore possible.
    //
    // This row restores the old `format` string and nothing else. One field is enough: it is an
    // equality check in `readManifest`, and it proves the named test is coupled to what the
    // validator actually accepts rather than to a shape written down twice.
    what: "the database backup step writes the manifest schema the restore validator accepts, not one of its own",
    file: "docs/ops/owner-actions.md",
    find: '    { "format": "agent-control-plane.sqlite-backup/v1",\n',
    replace: '    { "format": "agent-control-plane.sqlite-backup/online-v1",\n',
    killedBy: [
      "tests/process/the-database-backup-step-fails-closed.test.ts::produces a backup that item 6's real restore validator accepts, end to end",
    ],
  },
  {
    // #745 round 4. `schemaVersion` is the one manifest field emitted unquoted, so a reading that
    // is empty or non-numeric does not produce a manifest that is merely wrong — it produces one
    // that is not JSON, and the failure then surfaces at restore time as a parse error rather
    // than here as a refusal. Deleting the guard lets the block publish that manifest and exit 0.
    what: "the database backup step refuses a non-integer user_version before it can emit a manifest that is not JSON",
    file: "docs/ops/owner-actions.md",
    find:
      '    case "$BACKUP_USER_VERSION" in\n' +
      "      ''|*[!0-9]*) echo \"refusing: user_version of $BACKUP_TMP is '$BACKUP_USER_VERSION', not an integer\" >&2; exit 1 ;;\n" +
      "    esac\n",
    replace: "",
    killedBy: [
      "tests/process/the-database-backup-step-fails-closed.test.ts::refuses when the backup's user_version does not read as an integer, before publishing a manifest",
    ],
  },
  {
    // #745 round 4, blocker 2's ordering half — the part that made the schema mismatch dangerous
    // rather than merely wrong. Item 6's preflight checked that a manifest *existed*; it never
    // checked that `restoreDatabase` would accept it, and those are different claims. So an
    // unreadable manifest failed *after* `rm -rf .../dist`, in the procedure you reach for when
    // things are already broken.
    //
    // Deleting the validating restore returns the preflight to existence-checking. The named test
    // supplies a backup whose file is real, private and integral and whose manifest is exactly
    // what this document wrote before this round: every remaining check passes, and `rm -rf` runs.
    what: "the rollback preflight validates the backup through the real restore before rm -rf, not merely that a manifest exists",
    file: "docs/ops/owner-actions.md",
    find:
      '    node "$BYTES_BACKUP/dist/db/state-admin.js" restore "$BACKUP_PATH" \\\n' +
      '      --database "$ROLLBACK_PREFLIGHT_DIR/state.sqlite" --confirm-restore\n',
    replace: "",
    killedBy: [
      "tests/process/the-rollback-preflight-refuses-a-missing-backup-file.test.ts::refuses to run rm -rf when the backup's manifest is one the real restore validator rejects",
    ],
  },
  {
    // #512: the database-backup step in item 4 step 2 replaced `state-admin.js backup` (which
    // needs a `better-sqlite3` binding a fresh `node` process cannot load) with SQLite's own
    // online backup API. Executing the old text against the real host produced an empty
    // `BACKUP_PATH` and `sqlite3 "" "PRAGMA integrity_check;"` printed `ok` — a real command, a
    // real success exit, and no backup at all. This row deletes the destination guard that makes
    // that shape unreachable (empty / already-exists / symlink), leaving the `mv` at the end free
    // to silently overwrite whatever already sits at the deterministic destination name — exactly
    // the "destination already exists" counterexample the named test drives.
    what: "the database backup step refuses an already-existing destination before writing anything",
    file: "docs/ops/owner-actions.md",
    find:
      '    if [ -z "$BACKUP_PATH" ] || [ -e "$BACKUP_PATH" ] || [ -L "$BACKUP_PATH" ]; then\n' +
      '      echo "refusing: $BACKUP_PATH is empty or already exists" >&2; exit 1\n' +
      "    fi\n",
    replace: "",
    killedBy: ["tests/process/the-database-backup-step-fails-closed.test.ts"],
  },
  {
    // #512, second guard on the same block: exit code alone does not prove the backup is good —
    // the reported defect was exactly a command that exited 0 while proving nothing. Deleting the
    // content comparison (keeping only a nonzero-exit check would still be satisfied by a stub
    // that prints the wrong text and exits 0) reproduces that shape for the destination file
    // instead of the empty path, and the named test's "bad integrity" fixture — a `sqlite3` stub
    // that answers every `integrity_check` with `malformed` at exit 0 — catches it.
    what: "the database backup step requires integrity_check stdout to be exactly ok, not just exit 0",
    file: "docs/ops/owner-actions.md",
    find:
      '    if [ "$INTEGRITY" != "ok" ]; then\n' +
      '      echo "refusing: integrity_check on $BACKUP_TMP returned \'$INTEGRITY\', not ok" >&2; exit 1\n' +
      "    fi\n",
    replace: "",
    killedBy: ["tests/process/the-database-backup-step-fails-closed.test.ts"],
  },
  {
    // #745, CEO round 2: the destination check runs once, before the backup, and does not close
    // the window between that check and publication. Two runs sharing a timestamp both pass it
    // independently and both reach the publish step; without an exclusive claim on the final
    // name, the second silently overwrites the first run's already-verified backup.
    //
    // Round 3 replaced a `mkdir` reservation with the final name itself, so this row now mutates
    // the claim that survived: `ln -f` unlinks an existing destination before linking, which
    // means it never fails `EEXIST` and grants no exclusivity at all — the exact property the
    // reservation was there for. The named test forces two runs onto one final name with a
    // pinned timestamp and a barrier, and sees the second one publish instead of refuse.
    what: "the database backup step claims the final name atomically so only one of two racing runs ever publishes",
    file: "docs/ops/owner-actions.md",
    find:
      '    if ! ln "${BACKUP_TMP}.manifest.json" "${BACKUP_PATH}.manifest.json" 2>/dev/null; then\n' +
      '      echo "refusing: another run already owns the final name $BACKUP_PATH" >&2\n' +
      "      exit 1\n" +
      "    fi\n",
    replace: '    ln -f "${BACKUP_TMP}.manifest.json" "${BACKUP_PATH}.manifest.json"\n',
    killedBy: [
      "tests/process/the-database-backup-step-fails-closed.test.ts::refuses a delayed claim: a run that passed the destination check before another run published cannot overwrite it",
    ],
  },
  {
    // #745, CEO round 3, counterexample 1: `trap … EXIT` does not run on `SIGKILL` or a host
    // power loss, so which name is written last — not the trap — is what decides what an
    // untrappable death can leave behind. The manifest is linked first and the database last, so
    // `$BACKUP_PATH` is the commit marker and the worst survivable state is a manifest with no
    // database (which item 6's `test -s "$BACKUP_PATH"` refuses).
    //
    // This row swaps the two links. The result is still atomic and still exclusive — the claim
    // is simply on the wrong name — which is why nothing about racing dies here: the mutation is
    // about ordering alone. The named test kills the run immediately after its first publish
    // call and finds a database sitting at the final path with no manifest beside it.
    what: "the database backup step links the database last so an untrappable death cannot leave one without a manifest",
    file: "docs/ops/owner-actions.md",
    find:
      '    if ! ln "${BACKUP_TMP}.manifest.json" "${BACKUP_PATH}.manifest.json" 2>/dev/null; then\n' +
      '      echo "refusing: another run already owns the final name $BACKUP_PATH" >&2\n' +
      "      exit 1\n" +
      "    fi\n" +
      "    MANIFEST_LINKED=1\n" +
      '    ln "$BACKUP_TMP" "$BACKUP_PATH"\n',
    replace:
      '    if ! ln "$BACKUP_TMP" "$BACKUP_PATH" 2>/dev/null; then\n' +
      '      echo "refusing: another run already owns the final name $BACKUP_PATH" >&2\n' +
      "      exit 1\n" +
      "    fi\n" +
      "    MANIFEST_LINKED=1\n" +
      '    ln "${BACKUP_TMP}.manifest.json" "${BACKUP_PATH}.manifest.json"\n',
    killedBy: [
      "tests/process/the-database-backup-step-fails-closed.test.ts::leaves no database at the final path when the run dies untrappably mid-publish, and the next run refuses rather than resuming",
    ],
  },
  {
    // #745, CEO round 2, second counterexample: publication writes two names, so an ordinary
    // failure between them can leave one of them alone at the final path. Deleting the unwind
    // reproduces that half-published shape — the named test fails the second publish call after
    // the first has succeeded, and without this line the manifest survives alone at
    // `$BACKUP_PATH.manifest.json` instead of the partial publish being unwound.
    what: "the database backup step unwinds a partial publish so no database-without-manifest survives at the final path",
    file: "docs/ops/owner-actions.md",
    find:
      '      if [ "$MANIFEST_LINKED" = "1" ] && [ ! -e "$BACKUP_PATH" ]; then\n' +
      '        rm -f "$BACKUP_PATH.manifest.json"\n' +
      "      fi\n",
    replace: "",
    killedBy: [
      "tests/process/the-database-backup-step-fails-closed.test.ts::leaves zero consumable backups at the final path when the second publish step fails after the first succeeded",
    ],
  },
  {
    // #745, CEO round 3, the derivative of counterexample 2 and its own property. The unwind
    // above must remove only names *this run* created, and only while the commit marker is
    // absent. The previous revision released its reservation on success, so the name no longer
    // recorded who owned it, and a later run that failed after claiming ran
    // `rm -f "$BACKUP_PATH" "$BACKUP_PATH.manifest.json"` over a stranger's verified backup.
    //
    // This row restores exactly that unconditional form — same anchor as the row above, opposite
    // mutation, because "unwinds its own partial publish" and "does not unwind anyone else's" are
    // two properties of one block and a single mutation cannot ask both. The named test lets one
    // run publish and a second, older run fail afterwards, then reads the published bytes back.
    what: "the database backup cleanup unlinks only what this run created, never a publication it merely collided with",
    file: "docs/ops/owner-actions.md",
    find:
      '      if [ "$MANIFEST_LINKED" = "1" ] && [ ! -e "$BACKUP_PATH" ]; then\n' +
      '        rm -f "$BACKUP_PATH.manifest.json"\n' +
      "      fi\n",
    replace: '      rm -f "$BACKUP_PATH" "$BACKUP_PATH.manifest.json"\n',
    killedBy: [
      "tests/process/the-database-backup-step-fails-closed.test.ts::a failed run does not delete another run's published backup",
    ],
  },
  {
    // #745, CEO round 3: `ln` claims the final name only because both names are on one
    // filesystem — across a mount boundary it fails outright, and the reflex fix for that failure
    // is a `mv`, which clobbers. The siblings-in-one-directory argument is true today and is
    // asserted rather than assumed, because an assumption nothing checks survives until the day
    // it stops holding. Deleting the assertion lets the run proceed on a temp file its own `stat`
    // reports on a different device, which the named test injects.
    what: "the database backup step proves the temp file and the destination share a filesystem before claiming with ln",
    file: "docs/ops/owner-actions.md",
    find:
      '    BACKUP_TMP_DEVICE="$(stat -f \'%d\' "$BACKUP_TMP")"\n' +
      '    BACKUP_DIR_DEVICE="$(stat -f \'%d\' "$BACKUP_DIR")"\n' +
      '    if [ -z "$BACKUP_TMP_DEVICE" ] || [ "$BACKUP_TMP_DEVICE" != "$BACKUP_DIR_DEVICE" ]; then\n' +
      '      echo "refusing: $BACKUP_TMP is not on the same filesystem as $BACKUP_DIR; ln cannot claim the final name atomically" >&2\n' +
      "      exit 1\n" +
      "    fi\n",
    replace: "",
    killedBy: [
      "tests/process/the-database-backup-step-fails-closed.test.ts::refuses when the temp file is not on the same filesystem as the destination directory",
    ],
  },
  {
    // #241 — the whole point of the acceptance readout. Forcing `observed` to true makes an
    // empty database compute accepted anomalies (all zero) and report OBSERVED_NO_ANOMALIES
    // instead of N/A: exactly the "0/PASS" shape the CEO ruling named as worse than the ceremony
    // it replaces.
    what: "an acceptance report with zero lifecycles reports NA rather than a zero anomaly count",
    file: "src/export/acceptance-report.ts",
    find: "  const observed = lifecycles.total > 0;",
    replace: "  const observed = true;",
    killedBy: [
      "tests/unit/acceptance-report.test.ts::reports NA for the verdict and every accepted anomaly when the database has no lifecycles",
    ],
  },
  {
    what: "a prevented forged-gate attempt is actually counted from its enforcement's writer",
    file: "src/export/acceptance-report.ts",
    find: "  forgedGates: [\n    { kind: \"GATE_REJECTED\", reasonCode: ReasonCode.GATE_CREATOR_UNTRUSTED },\n    { kind: \"GATE_REJECTED\", reasonCode: ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID },\n  ],",
    replace: "  forgedGates: [],",
    killedBy: [
      "tests/unit/acceptance-report.test.ts::a prevented attempt from a guard refusing a forged gate does not produce ANOMALIES_PRESENT",
    ],
  },
  {
    // #736 third correction: kind and reason_code, keyed alone, are not enough — a
    // MERGE_AUTHORITY_DENIED row exists under FINALIZATION_ATTEMPT_FAILED too (the daemon's own
    // finalizer lacking authority mid-finalization), and that is not a blocked unauthorised-merge
    // attempt. Widening the writer's kind to admit it reintroduces exactly that inversion.
    what: "unauthorizedMerges counts only the write-guard writer, not the unrelated finalization-failure writer of the same reason code",
    file: "src/export/acceptance-report.ts",
    find: "  unauthorizedMerges: [{ kind: \"MANAGED_WRITE_GUARD\", reasonCode: ReasonCode.MERGE_AUTHORITY_DENIED }],",
    replace:
      "  unauthorizedMerges: [\n" +
      "    { kind: \"MANAGED_WRITE_GUARD\", reasonCode: ReasonCode.MERGE_AUTHORITY_DENIED },\n" +
      "    { kind: \"FINALIZATION_ATTEMPT_FAILED\", reasonCode: ReasonCode.MERGE_AUTHORITY_DENIED },\n" +
      "  ],",
    killedBy: [
      "tests/unit/acceptance-report.test.ts::a MERGE_AUTHORITY_DENIED row written under FINALIZATION_ATTEMPT_FAILED not an unauthorized-merge event does not increment unauthorizedMerges",
    ],
  },
  {
    // Same correction, the other collapsed reason code: seven unrelated SQLite trigger sentinels
    // also translate to COMPLETION_AUTHORITY_DENIED (src/db/database.ts TRIGGER_CODES). Removing
    // the evidence.sqlite discriminator would count any of those seven as a false completion.
    what: "falseCompletions excludes a COMPLETION_AUTHORITY_DENIED row stamped with an unrelated SQLite trigger sentinel",
    file: "src/export/acceptance-report.ts",
    find: '      isGenuine: (evidence) => evidence["sqlite"] === undefined,',
    replace: "      isGenuine: () => true,",
    killedBy: [
      "tests/unit/acceptance-report.test.ts::a COMPLETION_AUTHORITY_DENIED row stamped with a non-completion SQLite sentinel does not increment falseCompletions",
    ],
  },
  {
    what: "the acceptance window is read from the data rather than a hardcoded constant",
    file: "src/export/acceptance-report.ts",
    find:
      "  const firstActivityAt = row?.first ?? null;\n" +
      "  const lastActivityAt = row?.last ?? null;",
    replace:
      '  const firstActivityAt = "2026-01-01T00:00:00.000Z";\n' +
      '  const lastActivityAt = "2026-01-01T00:00:00.000Z";',
    killedBy: [
      "tests/unit/acceptance-report.test.ts::derives the window from the data's own first and last activity rather than a constant",
    ],
  },
  {
    // The second correction from the CEO's review of #736 (efe7552): the first cut let a
    // prevented attempt (a guard denial) read as an accepted anomaly. This row reintroduces
    // exactly that bug — computing "is anything present" from `preventedAttempts` instead of
    // `acceptedAnomalies` — so a guard doing its job would flip the verdict to ANOMALIES_PRESENT.
    what: "ANOMALIES_PRESENT is decided from accepted anomalies, never from prevented attempts alone",
    file: "src/export/acceptance-report.ts",
    find: "  const entries = Object.entries(acceptedAnomalies) as [keyof AcceptedAnomalies, AcceptedAnomalyCount][];",
    replace: "  const entries = Object.entries(preventedAttempts) as [keyof AcceptedAnomalies, AcceptedAnomalyCount][];",
    killedBy: [
      "tests/unit/acceptance-report.test.ts::is ANOMALIES_PRESENT only when an accepted anomaly is an actual positive count, never from prevented attempts alone",
    ],
  },
  {
    // #575: the App permission check moved from a single exact shape to an append-only list
    // of exact shapes, precisely so the App's grant and this code no longer have to narrow in
    // the same instant. Removing the key-count check turns every shape's match into "contains
    // at least these keys at these levels" — a superset would then match, which is exactly the
    // silent broadening the list exists to prevent.
    what: "an App permission grant with an extra key beyond an approved shape is refused, not accepted as a superset",
    file: "src/github/credential-store.ts",
    find: "    Object.keys(permissions).length === expected.length &&\n",
    replace: "",
    killedBy: [
      "tests/unit/github-app-credential-store.test.ts::refuses the narrowed grant shape plus one extra permission — a superset is never accepted",
    ],
  },
  {
    // The transitional shape (the grant deployed before #575) has to keep matching until the
    // owner narrows the App in GitHub settings, and the narrowed target shape has to already
    // match so that narrowing needs no coordinated deploy. Downgrading the narrowed shape's
    // `actions` entry to `write` makes it require a permission level the actual narrowed grant
    // (`actions: read`) does not have, so only the transitional shape would still match —
    // reproducing exactly the ordering deadlock #575 exists to remove.
    what: "the narrowed post-575 target shape is present in the approved list, not only the transitional one",
    file: "src/github/credential-store.ts",
    find: "    actions: \"read\",\n",
    replace: "    actions: \"write\",\n",
    killedBy: [
      "tests/unit/github-app-credential-store.test.ts::accepts the narrowed post-575 target grant shape with merge_queues and statuses dropped and actions read added",
    ],
  },
  {
    // Requirement 4: a refusal must name which shapes were expected, not just that the match
    // failed — otherwise the operator has to read this source to learn what to grant. Removing
    // the shape description from the denial message reproduces the bare, unhelpful message this
    // guard replaced.
    what: "the permission-denied message names the approved shapes rather than only saying the match failed",
    file: "src/github/credential-store.ts",
    find: "          `(expected one of: ${describeApprovedPermissionShapes()})`,\n",
    replace: "          \"\",\n",
    killedBy: [
      "tests/unit/github-app-credential-store.test.ts::names every approved shape in the refusal message rather than only saying the match failed",
    ],
  },
  {
    // #734 criterion 3, the row that kills the shape the brief names explicitly: a re-evaluation
    // that fails must yield STALE right away, never the previous healthy value with a checked_at
    // that quietly stopped advancing. Forcing the condition to `false` makes a failed attempt
    // fall straight through to the freshness-window check, which still passes (the last success
    // is recent), so the previous — now wrong — status is returned as if nothing had failed.
    what: "#734: a doctor re-evaluation that fails is reported STALE immediately, not the retained previous healthy value",
    file: "src/doctor/doctor.ts",
    find: "  if (lastAttempt && !lastAttempt.ok && lastAttempt.generation > lastSuccess.generation) {\n",
    replace: "  if (false) {\n",
    killedBy: ["tests/unit/doctor-health-freshness.test.ts"],
  },
  {
    // The other direction of the same operand, and the one that says this is an *ordering* rather
    // than a latch. Dropping the generation comparison makes any failure ever recorded outrank
    // every success forever: a daemon that saw one transient probe failure would answer STALE
    // from then on, no matter how many healthy evaluations completed after it. A rule that can
    // only escalate is the same outage in the other direction, so both halves need a row.
    what: "#734: a failed doctor attempt that completed BEFORE the retained success does not mark it stale",
    file: "src/doctor/doctor.ts",
    find: "  if (lastAttempt && !lastAttempt.ok && lastAttempt.generation > lastSuccess.generation) {\n",
    replace: "  if (lastAttempt && !lastAttempt.ok) {\n",
    killedBy: [
      "tests/unit/doctor-health-freshness.test.ts::a failed attempt older than the current success does not retroactively mark it stale",
    ],
  },
  {
    // The other half of #734 criterion 1: an evaluation old enough to have exceeded the bounded
    // freshness window must not be handed back as its own (possibly long-stale) status. Forcing
    // this condition to `false` makes every report current forever, regardless of age — the
    // exact defect the whole freshness bound exists to remove.
    what: "#734: a doctor report older than the freshness window is reported STALE rather than reused as current",
    file: "src/doctor/doctor.ts",
    find: "  if (ageMs > freshnessMs) {\n",
    replace: "  if (false) {\n",
    killedBy: ["tests/unit/doctor-health-freshness.test.ts"],
  },
  {
    // #734 criterion 2: a continuity reconciliation is the daemon's own hook for "capacity or
    // continuity state changed", reached both by the periodic capacity-sensor tick and by the
    // reactive provider-failure callback. Removing the doctor refresh from it silently regresses
    // to the pre-#734 shape — a report re-evaluated only at startup — while every other part of
    // `reconcileContinuity` keeps working, so nothing else here would notice.
    what: "#734: a continuity reconciliation re-evaluates the persisted system doctor snapshot",
    file: "src/daemon/daemon.ts",
    find: '      await this.runPeriodic("doctor_refresh", () => this.runSystemDoctorCheck().then(() => undefined));\n',
    replace: "",
    killedBy: ["tests/unit/daemon-doctor-freshness.test.ts"],
  },
  {
    // The CEO's counterexample, made a guard: `runSystemDoctorCheck()`'s failure branch used to
    // update `#lastDoctorAttempt` in memory only and rethrow, leaving *the caller* responsible
    // for persisting it. `reconcileContinuity()`'s failure path read as covered only because
    // `runPeriodic`'s own catch calls `writeHealth` — but `OPERATOR_METHOD.DOCTOR_RUN`'s failure
    // is caught by `executeOperatorRequest`'s outer catch, which returns `INTERNAL_ERROR` and
    // never calls `writeHealth`, and `DAEMON_STATUS` serves `health.json` from disk. Removing
    // the persist from the failure branch itself reproduces exactly that: a failed re-evaluation
    // that stays in memory while `health.json` keeps answering the previous healthy value.
    what: "#734: a failed system-doctor re-evaluation persists STALE to disk inside its own failure branch, not only when a caller happens to writeHealth afterward",
    file: "src/daemon/daemon.ts",
    find: "      this.persistDoctorHealth();\n      throw err;\n",
    replace: "      throw err;\n",
    killedBy: ["tests/unit/daemon-doctor-freshness.test.ts"],
  },
  {
    // A persistence failure is not the caller's answer, on either branch. Rethrowing instead of
    // auditing puts a storage error where the doctor's outcome belongs: on the success path the
    // operator is told the run failed when it succeeded, and on the failure path the storage
    // error replaces the doctor rejection the method exists to surface. This is the guard that
    // makes "persistence is not evaluation" enforceable rather than merely arranged — the `try`
    // scope alone cannot be mutated into the defect, but the swallow can.
    what: "#734: a failed health persist is audited and dropped, never raised as the doctor evaluation's outcome",
    file: "src/daemon/daemon.ts",
    find: "      this.writeHealth(null);\n    } catch (writeErr) {\n",
    replace: "      this.writeHealth(null);\n    } catch (writeErr) {\n      throw writeErr;\n",
    killedBy: [
      "tests/unit/daemon-doctor-freshness.test.ts::a health-write failure after a doctor SUCCESS is not reclassified",
    ],
  },
  {
    // The audit sink is a sink, and an unprotected report of a failure is a second way for the
    // reporting to become the failure. Removing the inner `try` restores exactly the shape the
    // CEO blocked: an audit that throws escapes the write handler and replaces the doctor error
    // on its way to the operator, so the one fact the whole method exists to surface is the one
    // fact the caller does not receive.
    what: "#734: an audit failure while reporting a failed health persist does not replace the doctor error",
    file: "src/daemon/daemon.ts",
    find:
      "      try {\n        this.cp.audit.record({\n          kind: \"DAEMON_TIMER_FAILED\",\n" +
      "          reasonCode: ReasonCode.DAEMON_TIMER_FAILED,\n" +
      "          evidence: { timer: \"health\", error: safeErrorMessage(writeErr) },\n        });\n      } catch {\n",
    replace:
      "      {\n        this.cp.audit.record({\n          kind: \"DAEMON_TIMER_FAILED\",\n" +
      "          reasonCode: ReasonCode.DAEMON_TIMER_FAILED,\n" +
      "          evidence: { timer: \"health\", error: safeErrorMessage(writeErr) },\n        });\n      }\n      if (false) {\n",
    killedBy: [
      "tests/unit/daemon-doctor-freshness.test.ts::a doctor failure whose health write AND whose audit both fail",
    ],
  },
  {
    // The failed attempt's ticket must be a *fresh* completion position, because that is the only
    // thing that lets it outrank the success it supersedes. Handing it the retained success's own
    // number instead makes `lastAttempt.generation > lastSuccess.generation` false for every
    // failure that ever happens: the comparison stays in `resolveDoctorHealth`, reads as present,
    // and no failure can ever reach it. This is the operand, not the condition — a guard is only
    // as real as the value it is given.
    what: "#734: a failed system-doctor evaluation takes a fresh completion ticket, so it outranks the success it supersedes",
    file: "src/daemon/daemon.ts",
    find: "    } catch (err) {\n      const generation = ++this.#doctorCompletions;\n",
    replace: "    } catch (err) {\n      const generation = this.#lastDoctorSuccess?.generation ?? 0;\n",
    killedBy: [
      "tests/unit/daemon-doctor-freshness.test.ts::a slow re-evaluation that FAILS after a fast one succeeded",
    ],
  },
  {
    // The same operand on the success side. A success that records a number ahead of its own
    // completion position permanently outranks the next failure, so the daemon would answer with
    // a healthy verdict after a probe that just threw — #734's original defect, reintroduced
    // through the ordering rather than through the write. Off by one in the direction that fails
    // open, which is why it gets its own row rather than being read off the row above.
    what: "#734: a successful system-doctor evaluation records its own completion position, not one ahead of it",
    file: "src/daemon/daemon.ts",
    find: "    this.#lastDoctorSuccess = { report, generation };\n",
    replace: "    this.#lastDoctorSuccess = { report, generation: generation + 1 };\n",
    killedBy: [
      "tests/unit/daemon-doctor-freshness.test.ts::a re-evaluation that fails yields STALE immediately",
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

/**
 * Where each per-mutation run's JSON reporter writes, read back so a `killedBy` selector's
 * *actual* match count can be checked rather than assumed from the exit code — see the
 * dead-selector check below.
 *
 * Deliberately not `evidence/local/ci-vitest-results.json`, and not merely "not that path by
 * default" — `--outputFile.json=` below pins it, so `vitest.config.ts`'s mapping of the `json`
 * reporter to that path is never consulted for these runs. That path is where `pnpm test` writes
 * the *full* suite's result for `pnpm trace` to read (CI runs the suite once, not twice, for
 * exactly this reason). A mutation run only exercises `killedBy`'s one file or test, so had this
 * shared the path, the last row processed would leave that shared file holding a partial result —
 * `success: false`, a handful of tests, nothing else — and `pnpm trace` would read a `killed`
 * mutation (the harness working correctly) as the whole suite having failed. Reproduced end to
 * end in CI on this branch's own PR before this comment was written: `pnpm test` and
 * `pnpm guards:falsifiable` both green, `pnpm trace` red, reporting all 59 scenarios missing.
 *
 * This setup is intentionally below the `anchorsOnly` return. That mode promises no mutation,
 * no tests, and no writes; even an otherwise harmless temp directory breaks it in a read-only
 * environment.
 *
 * A fresh temp directory rather than a fixed name beside it: two sweeps must never share a file,
 * the same reason `INFLIGHT`'s sentinel is per-repository rather than per-row.
 */
const MUTATION_REPORT_DIR = mkdtempSync(join(tmpdir(), "acp-guards-falsifiable-"));
const MUTATION_JSON_REPORT = join(MUTATION_REPORT_DIR, "vitest-results.json");
// `process.on("exit", ...)` rather than a call at each full-sweep exit point, and a temp directory
// outside the repo is cheap enough to leave for the OS to reclaim on a crash — this is tidiness,
// not a correctness requirement the way `restoreOnce()` is.
process.on("exit", () => rmSync(MUTATION_REPORT_DIR, { recursive: true, force: true }));

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
    // Removed, not overwritten-on-read: a crash that exits with a status but never reaches the
    // JSON reporter would otherwise leave the *previous* row's report on disk, and the dead-
    // selector check below would silently score this row against a different guard's numbers.
    rmSync(MUTATION_JSON_REPORT, { force: true });
    const done = spawnSync(
      VITEST,
      [
        "run",
        ...vitestArgsFor(guard.killedBy),
        "--reporter=dot",
        "--reporter=json",
        // Pinned explicitly rather than left to vitest.config.ts's `outputFile.json` mapping —
        // that mapping points at the full-suite artifact `pnpm trace` reads, and a mutation run
        // only ever exercises one row's `killedBy`. See MUTATION_JSON_REPORT's comment.
        `--outputFile.json=${MUTATION_JSON_REPORT}`,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, CI: "" },
        timeout: 600_000,
      },
    );
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

    /**
     * A named `killedBy` entry (`path::test name`) runs as `-t "test name"` — a regex, not a
     * literal string. A name that happens to contain a regex metacharacter (`()[]{}.*+?^$|\`)
     * is parsed as one: an empty `()` group matches zero characters rather than the two literal
     * parens, so the pattern silently selects nothing. Vitest still exits 0 for that — "0 tests
     * ran" is not a failure to vitest — so `killed` above reads a `-t` that matched nothing the
     * same as one that matched and passed: `SURVIVED`, which is at least loud. The dangerous
     * direction is the other one: if some *other* test in the same file happens to fail (for any
     * reason, related or not), the file's exit is non-zero, this row prints `killed`, and the
     * test actually named by `killedBy` never ran at all. That row then claims coverage a
     * completely different test produced.
     *
     * So the match count is checked directly from what vitest itself observed, not inferred from
     * the exit code. `numPassedTests + numFailedTests` is how many tests the run actually
     * executed under the `-t` filter; a filtered-out test is neither, so a selector matching zero
     * tests is provable without guessing at what the name "should" match.
     */
    const namedSelectors = guard.killedBy.map(splitKilledBy).filter((p) => p.name !== null);
    let deadSelector = null;
    if (namedSelectors.length > 0) {
      let report = null;
      try {
        report = JSON.parse(readFileSync(MUTATION_JSON_REPORT, "utf8"));
      } catch {
        report = null;
      }
      const selected = report ? report.numPassedTests + report.numFailedTests : 0;
      if (selected === 0) {
        deadSelector = report
          ? `killedBy names "${namedSelectors[0].name}" as a -t pattern, and vitest ran 0 tests under it ` +
            `(${report.numTotalTests} in the file, all skipped) — the selector matches nothing, so this ` +
            "row's exit code is not evidence about the guard either way"
          : `killedBy names "${namedSelectors[0].name}", but no JSON test report was produced to confirm ` +
            "it selected anything";
      }
    }
    if (deadSelector) {
      out(`  DEAD SELECTOR  ${guard.file}  ${guard.what}`);
      failures.push({ guard, why: deadSelector });
      continue;
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

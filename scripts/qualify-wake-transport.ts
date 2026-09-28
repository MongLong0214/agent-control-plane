#!/usr/bin/env tsx
/**
 * Takes the U6 wake-transport reading of **one** build and records it beside the others.
 *
 * Deliberately an operator command rather than a test. The test asserts that the qualified set
 * and the committed readings agree and re-measures where it can; *producing* a reading is a
 * decision to say that this build is qualified, and a decision should not be a side effect of
 * running the suite.
 *
 * It measures whichever build the harness resolves — `ACP_CLAUDE_BINARY` first, then the pinned
 * launcher, then PATH — so pointing `ACP_CLAUDE_BINARY` at a specific build is how an operator
 * chooses what gets measured. That build's reading is written to
 * `evidence/u6-wake-transport-qualification/<name>@<version>.json`, added if it is new and
 * replacing that build's earlier reading if not. Every other build's reading is left exactly as it
 * was: this never reads, rewrites or removes a file it did not measure.
 *
 * Then add the build to `WAKE_TRANSPORT_QUALIFIED_CLIENTS` -- in that order. Adding a member before
 * its reading exists is the failure this whole slice exists to stop, and the feasibility test
 * refuses a member with no reading or with a reading whose verdict is not `qualified`.
 *
 * Exit status 1 when the verdict is not `qualified`. The reading is still recorded, because a
 * failed measurement is still a measurement; the suite then refuses it until it is either removed
 * or re-taken, so it cannot quietly stand behind a member.
 *
 * Usage: pnpm qualify:wake-transport
 */
import { qualify } from "../tests/feasibility/wake-transport-qualification/harness.ts";
import { isWakeTransportQualified } from "../src/mcp/role-conversation.ts";

const { receipt, path } = await qualify();

for (const run of receipt.runs) {
  const arm = run.injected ? "injection" : "control ";
  console.log(
    `${run.shape.padEnd(11)} ${arm}  model requests ${run.modelRequests} ` +
      `(baseline ${run.baselineModelRequests}), wake-carrying ${run.wakeCarryingModelRequests}, ` +
      `follow-up ${run.followUpAfterInjection}`,
  );
}
console.log(`\n${receipt.client.name}/${receipt.client.version}  ${receipt.client.imageSha256.slice(0, 16)}…`);
console.log(`verdict: ${receipt.verdict}`);
console.log(`reading: ${path}`);
console.log(
  isWakeTransportQualified(receipt.client)
    ? "already a member of WAKE_TRANSPORT_QUALIFIED_CLIENTS"
    : "not a member of WAKE_TRANSPORT_QUALIFIED_CLIENTS -- add it only if the verdict is qualified",
);

if (receipt.verdict !== "qualified") process.exitCode = 1;

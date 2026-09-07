#!/usr/bin/env tsx
/**
 * Re-takes the U6 wake-transport reading and rewrites the receipt the pin is checked against.
 *
 * Deliberately an operator command rather than a test. The test asserts that the pin and the
 * receipt agree and re-measures where it can; *producing* the receipt is a decision to say that
 * this build is qualified, and a decision should not be a side effect of running the suite.
 *
 * Run it after a client upgrade, then move `C0_QUALIFIED_CLIENT` to the version the receipt
 * reports -- in that order. Moving the pin first is the failure this whole slice exists to stop.
 *
 * Usage: pnpm qualify:wake-transport
 */
import { qualify } from "../tests/feasibility/wake-transport-qualification/harness.ts";

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
console.log(`receipt: ${path}`);

if (receipt.verdict !== "qualified") process.exitCode = 1;

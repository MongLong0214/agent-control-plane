#!/usr/bin/env -S node --import tsx
/**
 * #655 synthetic-first one-shot driver.
 *
 * There is intentionally no live mode, credential option, target selector or state-directory
 * argument. The driver generates two updates, a fake production baseline and a noncanonical
 * target inside one exclusively-created private workspace outside live ACP state, then removes
 * the workspace before printing evidence.
 */
import { runSyntheticDisposableRealmProbe } from "../src/acceptance/disposable-realm-driver.ts";

const result = await runSyntheticDisposableRealmProbe();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.allowed) process.exitCode = 1;

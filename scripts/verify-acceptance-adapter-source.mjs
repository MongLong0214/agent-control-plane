#!/usr/bin/env node
/**
 * The acceptance must not replace the deployment's provider adapters.
 *
 * `adapters:` hands `ControlPlane` fully-constructed instances, so every option it would have
 * passed becomes the caller's and each omission is silent. Four were lost that way, three of them
 * found by a live run failing hundreds of seconds in (#552):
 *
 *   reviewerEgress         surfaced as ISOLATION_LOST
 *   fallbacks              the preferred reviewer had nothing to fall through to
 *   providerCredentialDir  CLAUDE_CONFIG_DIR never exported; the child read a denied directory
 *   denyReadPaths          the acceptance denied its reviewer less than production does
 *
 * `adapterOptions:` inverts that — the deployment's configuration is the base and the caller names
 * only what differs — so the class of defect cannot recur. This check enforces the choice rather
 * than the symptoms.
 *
 * It replaced a key-parity check that compared the two construction sites field by field. That was
 * a stopgap: it made drift *visible*, one instance at a time, after it existed. This makes it
 * impossible, so there is nothing left to compare — the earlier check would now be measuring an
 * agreement that no longer has a way to fail.
 *
 * Fails closed: if the acceptance cannot be read, that is a failure rather than a pass.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ACCEPTANCE = "tests/e2e/real-component-integration.test.ts";
const REAL_ADAPTERS = ["ClaudeCliAdapter", "CodexCliAdapter", "GrokCliAdapter"];

const source = readFileSync(new URL(`../${ACCEPTANCE}`, import.meta.url), "utf8");

const constructed = REAL_ADAPTERS.filter((adapter) => source.includes(`new ${adapter}(`));
if (constructed.length > 0) {
  process.stdout.write(
    `verify-acceptance-adapter-source: the acceptance constructs real CLI adapters: ${constructed.join(", ")}\n`,
  );
  process.stdout.write(
    "\nPassing them through `adapters:` replaces everything ControlPlane configures, and an option\n" +
      "dropped there is silent until a live run fails. Use `adapterOptions:` and name only what\n" +
      "differs, so a future option arrives here without anyone noticing it had to.\n",
  );
  process.exit(1);
}

if (!source.includes("adapterOptions:")) {
  process.stdout.write(
    "verify-acceptance-adapter-source: the acceptance sets no adapterOptions and constructs no adapters\n",
  );
  process.stdout.write(
    "\nOne of the two must be true, or this check is reading a file that no longer configures\n" +
      "providers — agreement between nothing and nothing.\n",
  );
  process.exit(1);
}

process.stdout.write(
  "verify-acceptance-adapter-source: the acceptance overrides adapter options rather than replacing adapters\n",
);
process.stdout.write("Drift is prevented by construction here, not detected after the fact.\n");

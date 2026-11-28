import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * #682, round 8's fourth pass found an `ACP_TELEGRAM_*` variable the code read and
 * `deploy/install-launchd.sh`'s `for optional in ...` Keychain-export loop did not export — the
 * *only* place a launchd deployment's environment variables come from — so an operator could add
 * the Keychain entry and it would never reach the daemon. Nothing compared the two hand-kept lists.
 *
 * #1444 deleted the long-poll consumer, and with it every variable only that consumer read. The
 * comparison now runs both ways: every name the kept lane reads is exported, and the launcher
 * exports no `ACP_TELEGRAM_*` name nothing reads any more.
 */
const readRepoFile = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), "utf8");

describe("deploy/install-launchd.sh exports exactly the ACP_TELEGRAM_* variables the code reads", () => {
  it("the launcher's optional-Keychain loop and telegram-external.ts name the same ACP_TELEGRAM_* set", () => {
    const laneSource = readRepoFile("src/ingress/telegram-external.ts");
    const codeNames = [...new Set([...laneSource.matchAll(/"(ACP_TELEGRAM_[A-Z0-9_]+)"/g)].map((m) => m[1]!))].sort();
    // A floor on the extraction itself, so a moved anchor cannot make every assertion vacuous.
    expect(codeNames.length).toBeGreaterThanOrEqual(6);

    const launchdSource = readRepoFile("deploy/install-launchd.sh");
    const loopMatch = launchdSource.match(/for optional in([\s\S]*?); do/);
    if (!loopMatch) {
      throw new Error("could not find the launcher's `for optional in ...; do` Keychain export loop — this test's own anchor moved");
    }
    // Uppercase identifier tokens only — ignores the line-continuation backslashes and whitespace.
    const launcherNames = [...new Set(loopMatch[1]!.match(/ACP_TELEGRAM_[A-Z0-9_]+/g) ?? [])].sort();

    expect(launcherNames).toEqual(codeNames);
  });
});

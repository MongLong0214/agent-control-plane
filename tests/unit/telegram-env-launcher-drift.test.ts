import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * #682, round 8's fourth pass (Sol's fourth BLOCK) — `ACP_TELEGRAM_TRANSPORT_RETENTION_MS` (the
 * third pass's escape hatch) was added to `TELEGRAM_ENVIRONMENT_VARIABLES` in
 * `telegram-polling.ts` but never added to `deploy/install-launchd.sh`'s `for optional in ...`
 * Keychain-export loop — the *only* place a launchd deployment's environment variables actually
 * come from. An operator on that deployment (the supported one) could add the Keychain entry and
 * it would never reach the daemon's process environment: the escape hatch this PR built to
 * recover a self-hosted-transport deployment did not work on the one deployment shape that
 * matters.
 *
 * This is the fourth time this PR has surfaced a gap that predates it rather than one it created
 * (the channel-name retention assumption, the daemon-wide startup failure, the known-longer-window
 * refusal, and now this): nothing compared the launcher's hand-kept list against the code's own
 * list, so the two were free to drift apart silently. A hand-added variable is the symptom fix;
 * this test is the root fix — it will not go stale the way the hand-kept list did, because it
 * reads both files itself on every run rather than trusting that whoever added a name to one
 * remembered the other.
 */
const readRepoFile = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), "utf8");

describe("deploy/install-launchd.sh must export every ACP_TELEGRAM_* variable the code reads", () => {
  it("TELEGRAM_ENVIRONMENT_VARIABLES is a subset of the launcher's optional-Keychain export loop", () => {
    const telegramPollingSource = readRepoFile("src/ingress/telegram-polling.ts");
    const arrayMatch = telegramPollingSource.match(
      /const TELEGRAM_ENVIRONMENT_VARIABLES = \[([\s\S]*?)\] as const;/,
    );
    if (!arrayMatch) {
      throw new Error("could not find TELEGRAM_ENVIRONMENT_VARIABLES in telegram-polling.ts — this test's own anchor moved");
    }
    const codeNames = [...arrayMatch[1]!.matchAll(/"(ACP_TELEGRAM_[A-Z0-9_]+)"/g)].map((m) => m[1]!);
    // A sanity floor on the extraction itself: if this ever matched zero names, every assertion
    // below would pass vacuously and this test would silently stop checking anything.
    expect(codeNames.length).toBeGreaterThanOrEqual(10);

    const launchdSource = readRepoFile("deploy/install-launchd.sh");
    const loopMatch = launchdSource.match(/for optional in([\s\S]*?); do/);
    if (!loopMatch) {
      throw new Error("could not find the launcher's `for optional in ...; do` Keychain export loop — this test's own anchor moved");
    }
    // Uppercase identifier tokens only — deliberately ignores the line-continuation backslashes
    // and whitespace between them rather than trying to parse shell syntax.
    const launcherNames = new Set(loopMatch[1]!.match(/[A-Z][A-Z0-9_]*/g) ?? []);
    expect(launcherNames.size).toBeGreaterThanOrEqual(10);

    const missingFromLauncher = codeNames.filter((name) => !launcherNames.has(name));
    expect(
      missingFromLauncher,
      "every ACP_TELEGRAM_* name telegram-polling.ts reads must be exported by " +
        "deploy/install-launchd.sh's Keychain loop, or a launchd deployment can never set it",
    ).toEqual([]);
  });
});

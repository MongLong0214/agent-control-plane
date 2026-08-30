import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Daemon } from "../../src/daemon/daemon.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #682, round 8's second follow-up (Sol's second BLOCK) — a daemon that comes up healthy while
 * Telegram silently never started looked identical, on every existing health surface, to one
 * that never had Telegram configured at all: `health.json`'s `mode` and `lockHeld` say nothing
 * about ingress, and `agentctl doctor system`'s checks are all derived from durable DB state,
 * which a live-process refusal decision never touches.
 *
 * `Daemon.setTelegramIngressStatus` closes the gap `health.json` can close: the production
 * Telegram factory calls it on start, terminal stop, and acknowledgement-driven resume, and each
 * transition is written immediately (`OPERATOR_METHOD.DAEMON_STATUS`, which backs `agentctl daemon
 * status`, reads that file verbatim — see `handleOperatorRequest`'s `DAEMON_STATUS` case).
 *
 * `agentctl doctor system` has no equivalent: `Doctor`'s checks all read `cp.db`/host state, and
 * a live ingress decision is not durable state Doctor's checks (or a separate CLI invocation)
 * could observe. Extending Doctor to cover this would mean persisting the outcome into the
 * database, which is a larger, separate change — flagged in the PR body as a known gap rather
 * than silently left for someone to discover only by its absence from `doctor system`'s output.
 */
describe("#682 round 8's second follow-up: health.json reports Telegram ingress status", () => {
  it("records each Telegram ingress outcome distinctly in health.json", () => {
    const harness = makeHarness();
    const stateDir = tempDir("acp-telegram-ingress-health-");
    const daemon = new Daemon(harness.cp, { stateDir });
    const readHealth = (): { telegram: unknown } =>
      JSON.parse(readFileSync(join(stateDir, "health.json"), "utf8")) as { telegram: unknown };

    // Never configured — the ordinary, most common deployment.
    daemon.setTelegramIngressStatus({ configured: false, running: false, disabledReason: null });
    expect(readHealth().telegram).toEqual({ configured: false, running: false, disabledReason: null });

    // Configured, but refused: an unmeasured transport's retention (#682, round 8). Distinct from
    // "never configured" — the operator set this up on purpose, and the message says why.
    const disabledReason = "transport's redelivery retention is not known for channel 'telegram'";
    daemon.setTelegramIngressStatus({ configured: true, running: false, disabledReason });
    expect(readHealth().telegram).toEqual({ configured: true, running: false, disabledReason });

    // Configured and running.
    daemon.setTelegramIngressStatus({ configured: true, running: true, disabledReason: null });
    expect(readHealth().telegram).toEqual({ configured: true, running: true, disabledReason: null });
  });

  it("is written immediately, not only on the next periodic health tick", () => {
    // A daemon that sits idle between periodic health writes must not report a stale "no
    // opinion yet" the whole time it is up — this proves `setTelegramIngressStatus` itself
    // performs the write rather than merely setting a field the next tick happens to read.
    const harness = makeHarness();
    const stateDir = tempDir("acp-telegram-ingress-health-immediate-");
    const daemon = new Daemon(harness.cp, { stateDir });

    daemon.setTelegramIngressStatus({ configured: true, running: true, disabledReason: null });

    const health = JSON.parse(readFileSync(join(stateDir, "health.json"), "utf8")) as { telegram: unknown };
    expect(health.telegram).toEqual({ configured: true, running: true, disabledReason: null });
  });
});

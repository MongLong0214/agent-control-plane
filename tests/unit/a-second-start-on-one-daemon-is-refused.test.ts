import Database from "better-sqlite3";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * `start()` twice on one instance. A lock the entry point took before it opened anything is handed to the
 * daemon so its one start runs under it; that must not make a repeat call look like a first one. A repeat
 * would otherwise run startup again: a second DAEMON_STARTED row and a second set of timers.
 */
const startedRows = (database: string): number => {
  const raw = new Database(database, { readonly: true });
  try {
    return (raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'DAEMON_STARTED'").get() as { n: number }).n;
  } finally {
    raw.close();
  }
};

const harnessed = () => {
  const harness = makeHarness();
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  return { harness, database: join(harness.root, "state.sqlite"), stateDir: tempDir("acp-second-start-") };
};

describe("a second start() on the same daemon", () => {
  it("is refused when the daemon took its own lock", async () => {
    const { harness, database, stateDir } = harnessed();
    const daemon = new Daemon(harness.cp, { stateDir });
    expect((await daemon.start()).allowed).toBe(true);
    const intervals = vi.spyOn(globalThis, "setInterval");
    try {
      const second = await daemon.start();

      expect(second.allowed).toBe(false);
      if (!second.allowed) expect(second.reasonCode).toBe(ReasonCode.DAEMON_ALREADY_RUNNING);
      expect(startedRows(database)).toBe(1);
      expect(intervals).not.toHaveBeenCalled();
    } finally {
      intervals.mockRestore();
      await daemon.stop();
    }
  });

  it("is refused when the lock was handed in already held, after the one start that lease was for", async () => {
    const { harness, database, stateDir } = harnessed();
    const lock = new SingleInstanceLock(join(stateDir, "agentcpd.lock"));
    expect(lock.acquire(new Date().toISOString()).allowed).toBe(true);
    const daemon = new Daemon(harness.cp, { stateDir, lock });
    expect((await daemon.start()).allowed).toBe(true);
    const intervals = vi.spyOn(globalThis, "setInterval");
    try {
      const second = await daemon.start();

      expect(second.allowed).toBe(false);
      if (!second.allowed) expect(second.reasonCode).toBe(ReasonCode.DAEMON_ALREADY_RUNNING);
      expect(startedRows(database)).toBe(1);
      expect(intervals).not.toHaveBeenCalled();
    } finally {
      intervals.mockRestore();
      await daemon.stop();
    }
  });
});

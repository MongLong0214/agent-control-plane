import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { ControlPlane } from "../../src/app/control-plane.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * What a failed construction leaves behind.
 *
 * The composition root claims the once-per-database capabilities while it is still building
 * itself, which is what stops a later claimant from quietly becoming a second materializer. The
 * cost of that ordering is that the constructor can still throw afterwards — rejecting a
 * non-production adapter, for one — and a throw returns no value, so the caller has nothing to
 * close. Measured before this test existed: a first attempt with the wrong configuration took the
 * slots, and every corrected retry in the same process was refused with
 * `COMPLETION_AUTHORITY_DENIED`. The process could not be fixed, only restarted.
 *
 * A capability held by an object that does not exist is not exclusion, it is a leak.
 */
const testAdapter = {
  provider: "test",
  isProduction: false,
  complete: async () => ({ ok: true }),
} as never;

const configFor = (dir: string, allowNonProductionAdapters: boolean) => ({
  databasePath: join(dir, "state.sqlite"),
  worktreeRoot: join(dir, "worktrees"),
  capacityDir: join(dir, "capacity"),
  secretsDir: join(dir, "secrets"),
  adapters: [testAdapter],
  allowNonProductionAdapters,
  ownerIdentities: [{ channel: "cli", actor: "test-owner" } as const],
});

const privateRoot = (): string => {
  const dir = join(tempDir("acp-failed-build-"), "state");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  return dir;
};

describe("a control plane that threw while building itself", () => {
  it("hands back the capabilities it took, so a corrected retry can construct", () => {
    const dir = privateRoot();

    expect(() => new ControlPlane(configFor(dir, false))).toThrowError(
      /fabricates responses; it is test-only/,
    );

    const second = new ControlPlane(configFor(dir, true));
    try {
      // The property, stated where it can fail: the retry got a real materializer rather than
      // inheriting a slot the dead attempt still held.
      expect(second.conversation).toBeDefined();
    } finally {
      second.db.close();
    }
  });
});

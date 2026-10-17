import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { ACP_SCRATCH_ROOT } from "../../src/core/scratch-root.ts";

/**
 * #1093 — a test file that does nothing about HOME must still resolve a private scratch root.
 *
 * This file deliberately does not set HOME and does not import the setup that does: it is the
 * ordinary test file the issue is about. It only reads the path the product resolved and never
 * allocates, so even where the default is missing it fails without writing into live state.
 *
 * The live root is derived from the passwd entry, not from HOME, because HOME is the thing a test
 * run moves. The mutation that matters: drop `tests/helpers/isolated-home.ts` from `setupFiles`
 * in `vitest.config.ts` and every assertion here goes red.
 */
const liveHome = userInfo().homedir;
const liveState = join(liveHome, ".agent-control-plane");

const isWithin = (path: string, root: string): boolean => path === root || path.startsWith(`${root}${sep}`);

describe("a test run resolves a private HOME, never the operator's (#1093)", () => {
  it("resolves the scratch root outside the live daemon's state", () => {
    expect(isWithin(ACP_SCRATCH_ROOT, liveState), `ACP_SCRATCH_ROOT is ${ACP_SCRATCH_ROOT}`).toBe(false);
    expect(isWithin(ACP_SCRATCH_ROOT, realpathSync(liveHome))).toBe(false);
  });

  it("gives this process a HOME that is not the operator's", () => {
    expect(homedir()).not.toBe(liveHome);
    expect(ACP_SCRATCH_ROOT).toBe(join(homedir(), ".agent-control-plane", "scratch"));
  });

  it("hands the same private HOME to a child process", () => {
    // Scripts the suite runs as children import the scratch root themselves; they inherit HOME.
    const childHome = execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:os').homedir())"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(childHome).toBe(homedir());
    expect(childHome).not.toBe(liveHome);
  });
});

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { ACP_SCRATCH_ROOT, acpScratchDir } from "../../src/core/scratch-root.ts";

/**
 * ACP must not allocate its own transient state inside space the reviewer can write (#489).
 *
 * The reviewer profile allows writes to the per-user temp directory, because codex's in-process
 * app-server writes there and ignores `TMPDIR`. That allowance is only safe while nothing of ours
 * lives in the same tree: packet roots and verification scratch used to, and opening the directory
 * let a reviewer write into every other run's packet.
 *
 * Moving them out fixed it. This is what keeps it fixed — without a check, the relocation is a
 * convention, and the next person reaches for `tmpdir()` because it is one import shorter.
 *
 * The mutation that matters: point `ACP_SCRATCH_ROOT` back at `tmpdir()` and this goes red.
 */
describe("ACP allocates outside reviewer-writable space (#489)", () => {
  const reviewerWritable = realpathSync(tmpdir());

  it("keeps the scratch root outside the per-user temp directory", () => {
    // Both sides resolved. An earlier draft compared `ACP_SCRATCH_ROOT` raw against a resolved
    // tmpdir and passed even when the root *was* tmpdir — `/var` is a symlink to `/private/var`,
    // so the two spellings of the same directory did not match. That is the same trap that made
    // #489 look like an exec denial, hit again in the test written to guard against it.
    const root = realpathSync(acpScratchDir("acp-scratch-root-check-"));
    expect(
      root.startsWith(`${reviewerWritable}/`) || root === reviewerWritable,
      `the scratch root is inside the directory the reviewer profile makes writable (${reviewerWritable}), ` +
        "so a reviewer could modify another run's packet",
    ).toBe(false);
  });

  it("allocates real directories there, not merely names them", () => {
    // A root that is correct but unused would pass the assertion above while every caller kept
    // using tmpdir(). This proves the helper works, so switching a call site to it is a real move.
    const created = realpathSync(acpScratchDir("acp-scratch-test-"));
    expect(created.startsWith(`${reviewerWritable}/`)).toBe(false);
    expect(created.startsWith(realpathSync(ACP_SCRATCH_ROOT))).toBe(true);
  });
});

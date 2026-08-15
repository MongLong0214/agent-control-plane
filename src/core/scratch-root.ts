import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where ACP allocates its own transient directories — deliberately **not** the per-user temp
 * directory (#489).
 *
 * Packet roots, reviewer scratch and verification scratch used to be `mkdtemp(join(tmpdir(), …))`.
 * That was fine until the reviewer profile needed the per-user temp directory writable: codex's
 * in-process app-server writes there and ignores `TMPDIR`, so it cannot be redirected. Allowing
 * that directory while our own packets live inside it would let a reviewer write into every other
 * run's packet and every verification scratch on the machine — the artefacts the isolation exists
 * to protect.
 *
 * Moving our allocations out is what makes that allowance safe: the reviewer gets the directory it
 * insists on, and it holds nothing of ours.
 *
 * There is no fallback to `tmpdir()`. A fallback would silently restore the hole on exactly the
 * hosts where the directory could not be created, and a boundary that disappears under an error
 * is the failure mode this repository spends its time removing. If this cannot be prepared, the
 * caller fails.
 */
export const ACP_SCRATCH_ROOT = join(homedir(), ".agent-control-plane", "scratch");

/**
 * Creates a private transient directory under the scratch root and returns it.
 *
 * `mode: 0o700` on the root matters: the reviewer profile denies reads of daemon state by path,
 * and this tree is not on that list — the filesystem permission is what keeps another user out,
 * the same way it does for the per-user temp directory this replaces.
 */
export const acpScratchDir = (prefix: string): string => {
  mkdirSync(ACP_SCRATCH_ROOT, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(ACP_SCRATCH_ROOT, prefix));
};

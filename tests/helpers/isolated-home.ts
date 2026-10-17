import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll } from "vitest";

import { isWithin, LIVE_STATE_ROOT, resolvesToLiveState } from "./live-state-root.ts";

/**
 * #1093 — every test file runs with HOME at a private temporary directory, never the operator's.
 *
 * `ACP_SCRATCH_ROOT` (`src/core/scratch-root.ts`) is fixed from `homedir()` when that module first
 * loads, and so is every other HOME-derived path the product computes. A test file that had not
 * moved HOME before its first import allocated under the live daemon's scratch root — about 420
 * test-prefixed leftovers were counted there on 2026-10-16. Moving HOME inside a test body is too
 * late, because the root is already fixed, so this is a setup file: it runs before the test file
 * and anything that file imports. A file that wants its own HOME still sets it in `vi.hoisted`,
 * which runs after this and wins.
 *
 * The directory is deliberately not under `tmpdir()`. The reviewer profile makes the per-user temp
 * directory writable, and `scratch-root.test.ts` (#489) holds the scratch root outside it; a HOME
 * placed there would make the scratch reviewer-writable and turn that check red.
 *
 * Nothing here needs to read the live state root. Where a sandbox makes it unreadable, the guard
 * compares below it lexically and follows a link to it by reading the link itself; a HOME it cannot
 * account for is refused (`live-state-root.ts`), so isolation still holds and the run proceeds.
 */

/**
 * A system temporary root outside the reviewer-writable `tmpdir()`. There is no fallback to
 * `tmpdir()` or to the real home: a run that cannot be isolated fails here, before any test.
 */
const privateHomeBase = (): string => {
  const reviewerWritable = realpathSync(tmpdir());
  for (const candidate of ["/tmp", "/var/tmp"]) {
    if (!existsSync(candidate)) continue;
    const base = realpathSync(candidate);
    if (!isWithin(base, reviewerWritable)) return base;
  }
  throw new Error(`#1093: no temporary directory outside ${reviewerWritable} to hold a private test HOME`);
};

/**
 * Named here and created only once the file's tests are about to run (below), so a file whose tests
 * are all skipped — where no hook runs, `afterAll` included — leaves nothing behind. The name is
 * unguessable because its parent is a shared, world-writable directory.
 */
const privateHome = join(privateHomeBase(), `acp-test-home-${randomUUID()}`);
process.env["HOME"] = privateHome;
if (homedir() !== privateHome) {
  throw new Error(`#1093: os.homedir() ignored HOME=${privateHome}; this run cannot be kept out of live state`);
}

/**
 * A private HOME has no node-gyp header cache, so a native build under test downloaded Node's headers
 * on every run (measured: 31 MB into the private HOME, and the build then overran its 55 s bound under
 * full-suite load). The running Node's own headers are used instead, when they ship beside it.
 */
const nodePrefix = dirname(dirname(process.execPath));
if (process.env["npm_config_nodedir"] === undefined && existsSync(join(nodePrefix, "include", "node", "node.h"))) {
  process.env["npm_config_nodedir"] = nodePrefix;
}

const liveRootError = (what: string): Error =>
  new Error(
    `#1093: ${what} resolves the live daemon's scratch root under ${LIVE_STATE_ROOT}. ` +
      "Tests allocate under a private HOME; set HOME before the first import, never to the operator's home.",
  );

/**
 * The guard, in two halves. Before any test of the file runs, HOME — after this file and the test
 * file's own `vi.hoisted` have both had their say — must not lead to the live state root, so a file
 * that would allocate there fails before it can. The check is synchronous on purpose: an awaited
 * import here would hold the worker idle between collection and the first test, which is the window
 * `vitest-rpc-trace.test.ts` measures. After the file, the scratch root the product actually fixed
 * is compared too, which also catches a root fixed before HOME was moved.
 */
beforeAll(() => {
  if (resolvesToLiveState(join(homedir(), ".agent-control-plane", "scratch"))) throw liveRootError(`HOME (${homedir()})`);
  // Present before the first test, as an operator's home is. Left alone when the file chose its own.
  if (homedir() === privateHome) mkdirSync(privateHome, { recursive: true, mode: 0o700 });
});

afterAll(async () => {
  const { ACP_SCRATCH_ROOT } = await import("../../src/core/scratch-root.ts");
  if (resolvesToLiveState(ACP_SCRATCH_ROOT)) throw liveRootError(`ACP_SCRATCH_ROOT (${ACP_SCRATCH_ROOT})`);
});

/**
 * Removal is best-effort: a test may leave a read-only tree or a detached child behind, and a
 * leftover under the system temporary root must not turn a passing file red.
 */
const removePrivateHome = (): void => {
  try {
    rmSync(privateHome, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // The directory stays under the system temporary root, which the OS clears.
  }
};
afterAll(removePrivateHome);

import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * What the kernel records about the process on the other end of a connected `AF_UNIX` socket.
 *
 * `sessions.os_pid` (verified against process start time, #505) answers *is this pid still the
 * process we recorded* — a registry question, resolved from data this process wrote earlier. It
 * does not answer *is the peer on this socket that process*, because nothing connects the fd back
 * to the kernel's own record of who opened it. Only `getsockopt(SOL_LOCAL, ...)` does that, and
 * `effectivePid` is kept distinct from `peerPid` because they can differ (a peer reached through
 * an entitlement-checked proxy reports a different effective identity than the process that
 * opened the socket).
 */
export interface PeerCredentials {
  peerPid: number;
  effectivePid: number;
  uid: number;
  gid: number;
}

/**
 * This primitive is deliberately unreachable from every live surface (#539). Nothing in `src/`
 * outside this file imports it, and `scripts/verify-peercred-is-unreachable.mjs` enforces that as
 * a CI gate — a new call site is meant to fail that check, not this file's own correctness. See
 * `docs/CONTRIBUTING.md` ("peer identity is registry-level, not kernel-level") and ADR-0010 for
 * why the boundary is deliberate rather than an oversight.
 */
interface PeercredAddon {
  peercred(fd: number): { peerPid: number; effectivePid: number; uid: number; gid: number };
}

let addon: PeercredAddon | null | undefined;

const loadAddon = (): PeercredAddon | null => {
  if (addon !== undefined) return addon;
  if (process.platform !== "darwin") {
    addon = null;
    return addon;
  }
  try {
    const require = createRequire(import.meta.url);
    addon = require(join("..", "..", "native", "peercred", "build", "Release", "peercred.node")) as PeercredAddon;
  } catch {
    // Not built (e.g. `pnpm install` skipped the native build, or this is a non-macOS checkout
    // that reached here some other way). Fails closed: a caller gets null, the same "cannot be
    // established" shape `processStartedAt` (#505) uses, never a thrown surprise from a module
    // that legitimately may not exist on this machine.
    addon = null;
  }
  return addon;
};

/**
 * Reads the kernel's peer-credential record for a connected `AF_UNIX` socket's file descriptor.
 *
 * Returns `null` rather than throwing when the credential cannot be established — not on Darwin,
 * the native addon is not built, or the kernel call itself failed (e.g. `fd` is not a connected
 * `AF_LOCAL` socket). Fail-closed for the same reason `processStartedAt` (#505) is: an
 * unverifiable peer is treated as absent, not as verified.
 */
/**
 * The addon's N-API binding reads `fd` with `Napi::Number::Int32Value()`, which applies
 * ECMAScript `ToInt32` — reduction mod 2^32, not a range check. A `Number.isSafeInteger` value
 * above this bound (e.g. `2**32 + 5`) would silently wrap to a small, possibly valid fd (`5`),
 * so a caller expecting "obviously out of range" to mean "rejected" would instead get another
 * fd's real credentials back. Bounding to `int32` here, before the addon ever sees the value,
 * is what makes that wraparound unreachable rather than merely unlikely.
 */
const MAX_FD = 0x7fffffff;

export const getPeerCredentials = (fd: number): PeerCredentials | null => {
  if (!Number.isSafeInteger(fd) || fd < 0 || fd > MAX_FD) return null;
  const native = loadAddon();
  if (native === null) return null;
  try {
    return native.peercred(fd);
  } catch {
    return null;
  }
};

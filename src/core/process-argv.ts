import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * A genuine, kernel-supplied argv vector for an arbitrary pid — never `ps`'s rendered,
 * whitespace-joined text, which cannot preserve the boundary between a real argv element and text
 * that merely sits inside one quoted positional argument.
 *
 * - Linux: reads `/proc/<pid>/cmdline`, the kernel's own NUL-separated argv buffer, unreinterpreted
 *   by any shell.
 * - Darwin: no procfs exists, and `sysctl(8)` has no named OID for `KERN_PROCARGS2` — that MIB
 *   takes a raw numeric array that includes the target pid, reachable only via the `sysctl(3)` C
 *   function. This loads the native addon at `native/peercred/src/peercred.cc`'s `processArgv`
 *   export, which calls it directly and returns each argv element as a raw `Buffer` (no encoding
 *   claim made in C++).
 * - Every other platform, and any failure on either path (process gone, permission denied, a
 *   native/kernel error, an argc/NUL-vector mismatch, or an argv element that is not valid UTF-8),
 *   returns `null`. "Unavailable" is one outcome here, not several a caller must distinguish —
 *   every caller of this treats `null` as fail-closed, never as a reason to fall back to rendered
 *   text.
 *
 * This loads the same compiled addon independently of `src/core/peercred.ts`'s own peer-credential
 * wrapper: it does not import that module, re-export it, or name either of its exported symbols,
 * so `scripts/verify-peercred-is-unreachable.mjs`'s one-entry allowlist for that separate
 * primitive is untouched by this file existing.
 */
interface ProcessIntrospectionAddon {
  processArgv(pid: number): readonly Buffer[];
  processStartToken(pid: number): { sec: number; usec: number };
}

let addon: ProcessIntrospectionAddon | null | undefined;

const loadAddon = (): ProcessIntrospectionAddon | null => {
  if (addon !== undefined) return addon;
  if (process.platform !== "darwin") {
    addon = null;
    return addon;
  }
  try {
    const require = createRequire(import.meta.url);
    addon = require(
      join("..", "..", "native", "peercred", "build", "Release", "peercred.node"),
    ) as ProcessIntrospectionAddon;
  } catch {
    // Not built (e.g. `pnpm install` skipped the native build), or some other load failure. Fails
    // closed: a caller gets `null`, never a thrown surprise from a module that legitimately may
    // not exist on this machine.
    addon = null;
  }
  return addon;
};

/**
 * `fatal: true` is what makes this throw on invalid UTF-8 instead of Node's default lossy,
 * replacement-character decode (`Buffer.prototype.toString("utf8")` never throws — it silently
 * substitutes U+FFFD for anything it cannot decode, which is exactly the "best-effort" outcome
 * this file must not produce).
 */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** `null` the whole vector on the first undecodable element — a partially-decoded argv vector is not a trustworthy one. */
const decodeElements = (buffers: readonly Uint8Array[]): readonly string[] | null => {
  const out: string[] = [];
  for (const buf of buffers) {
    try {
      out.push(strictUtf8.decode(buf));
    } catch {
      return null;
    }
  }
  return out;
};

const readDarwinArgv = (pid: number): readonly string[] | null => {
  const native = loadAddon();
  if (native === null) return null;
  let raw: readonly Buffer[];
  try {
    raw = native.processArgv(pid);
  } catch {
    // Covers every native-side refusal uniformly: a kernel error (including the transient
    // EINVAL a just-exec'd process can report before its procargs record settles — this
    // deployment never queries a process that fresh, so it is not worked around here), an
    // argc <= 0, and an argv vector truncated before argc was satisfied.
    return null;
  }
  return decodeElements(raw);
};

const readLinuxArgv = (pid: number): readonly string[] | null => {
  let raw: Buffer;
  try {
    raw = readFileSync(`/proc/${pid}/cmdline`);
  } catch {
    return null;
  }
  // Empty (process gone, or a read that raced an exit) or not NUL-terminated at the end (a
  // truncated read) both fail closed rather than being treated as a zero-or-partial-element argv.
  if (raw.length === 0 || raw[raw.length - 1] !== 0) return null;
  const elements: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === 0) {
      elements.push(raw.subarray(start, i));
      start = i + 1;
    }
  }
  if (elements.length === 0) return null;
  return decodeElements(elements);
};

/**
 * Reads the real, OS-observed argv vector for `pid`. Returns `null` on any form of
 * unavailability — an unsupported platform, the process being gone, permission denied, a
 * malformed or truncated native/kernel response, or an argv element that is not valid UTF-8 —
 * never a partially-decoded or best-effort result.
 */
export const readProcessArgv = (pid: number): readonly string[] | null => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return readLinuxArgv(pid);
  if (process.platform === "darwin") return readDarwinArgv(pid);
  return null;
};

const readDarwinStartToken = (pid: number): string | null => {
  const native = loadAddon();
  if (native === null) return null;
  try {
    const { sec, usec } = native.processStartToken(pid);
    if (!Number.isFinite(sec) || !Number.isFinite(usec)) return null;
    return `darwin-tv:${sec}.${String(usec).padStart(6, "0")}`;
  } catch {
    return null;
  }
};

/**
 * `/proc/<pid>/stat`'s `comm` field (position 2) is parenthesized and may itself contain spaces or
 * parentheses, so the only reliable split point is the *last* `)` in the line — everything after
 * it is whitespace-separated fields starting at `state` (field 3). `starttime` is field 22, so
 * counted from `state` (index 0 in that remainder) it sits at index 19.
 */
const readLinuxStartToken = (pid: number): string | null => {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const lastParen = raw.lastIndexOf(")");
  if (lastParen === -1) return null;
  const fields = raw.slice(lastParen + 1).trim().split(/\s+/);
  const starttime = fields[19];
  if (starttime === undefined || !/^\d+$/.test(starttime)) return null;
  return `linux-clk:${starttime}`;
};

/**
 * An opaque, kernel-tracked process-start token at native resolution — never `ps -o lstart=`'s
 * rendered, whole-second, locale-dependent text, which cannot distinguish two processes started
 * within the same rendered second (a pid-reuse race can produce exactly that). Two calls for the
 * same live process return the identical token; two different processes essentially never share
 * one. `null` means unavailable — process gone, permission denied, or a native/kernel error — and
 * every caller treats that as fail-closed, never as a reason to fall back to rendered time.
 *
 * - Linux: `/proc/<pid>/stat`'s `starttime` field — clock ticks since boot, an opaque boot-local
 *   value never interpreted as a wall-clock time.
 * - Darwin: `proc_pidinfo(PROC_PIDTBSDINFO)`'s `pbi_start_tvsec`/`pbi_start_tvusec`, via the same
 *   native addon `readProcessArgv` loads.
 */
export const readProcessStartToken = (pid: number): string | null => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return readLinuxStartToken(pid);
  if (process.platform === "darwin") return readDarwinStartToken(pid);
  return null;
};

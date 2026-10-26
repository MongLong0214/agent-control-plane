import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import { hasCredentialShape } from "../core/credential-shapes.ts";
import { sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { acpScratchDir } from "../core/scratch-root.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  isVerificationCommandRefused,
  resolveVerificationExecutable,
  verificationExecutableRefusalMessage,
  verificationExecutableSearchPath,
  type VerificationCommand,
} from "../contracts/verification-command.ts";
import { isWithin } from "../guard/workspace-probe.ts";

const exec = promisify(execFile);

export interface SandboxRequest {
  command: VerificationCommand;
  /** Disposable worktree the command runs in. Nothing outside it is writable. */
  worktreePath: string;
  /** Extra environment values, filtered through the command's own allowlist. */
  env?: Record<string, string>;
  /**
   * Additional absolute paths the candidate must not read — the control plane's own
   * secret store and state directory, and any other checkout on this machine.
   */
  denyReadPaths?: readonly string[];
  /**
   * How the candidate's processes are limited (`ProcessLimitMode`). Trusted control-plane code
   * chooses it at the call site; nothing the candidate controls reaches it — a
   * `VerificationCommand` has no such field and the sandbox environment carries none. Anything
   * other than exactly `"supervised-budget"`, including omitting it, is `"no-spawn"`.
   */
  processLimit?: ProcessLimitMode;
}

/**
 * - `no-spawn`: the candidate runs under RLIMIT_NPROC 1, so every fork it attempts is refused.
 *   That limit is per *user* on macOS -- it counts every process this account already has, not the
 *   candidate's descendants -- so 1 is the only value that means anything there, and it means "no
 *   spawn at all". A gate command runs this way: gate-resolution-hook.ts relies on it.
 * - `supervised-budget`: the candidate may spawn, and the trusted supervisor counts its live
 *   descendants and kills the whole tree once they exceed `CANDIDATE_PROCESS_BUDGET`. This is a
 *   supervised, polled budget, not a kernel limit: see `RESOURCE_WRAPPER_PROGRAM` for what it does
 *   and does not cover.
 */
export type ProcessLimitMode = "no-spawn" | "supervised-budget";

/**
 * The most live descendants a `supervised-budget` candidate may have at once.
 *
 * `npm test` running `node --test` is the case it must admit: npm, its `sh -c`, the runner, and one
 * child per test file up to `os.availableParallelism() - 1` at a time -- 14 processes on a 12-core
 * Mac. 64 leaves room for that on a machine of up to ~60 cores, or a runner that adds a helper per
 * worker, while a fork loop is stopped some 60 processes in rather than at the account's limit
 * (`kern.maxprocperuid`, 8000 here), where it would starve every other process this user runs. It
 * is a fixed constant on purpose: the candidate and its manifest cannot raise it.
 */
export const CANDIDATE_PROCESS_BUDGET = 64;

export interface SandboxOutcome {
  status: "PASS" | "FAIL" | "TIMEOUT" | "ERROR";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputDigest: string;
  outputTruncated: boolean;
  peakRssMb: number | null;
  enforcement: SandboxEnforcement;
  reasonCode: string | null;
}

export interface SandboxEnforcement {
  worktreeIsolated: true;
  secretsStripped: true;
  networkPolicy: VerificationCommand["network"];
  networkEnforced: boolean;
  writeConfinement: boolean;
  /**
   * How reads are restricted. `sensitive-paths` is a deny list, not a whitelist: a
   * whitelist cannot be expressed for a Node toolchain, because dyld needs a set of
   * paths that is not enumerable in advance — denying reads wholesale aborts the
   * interpreter before it starts. So the credential stores are named and denied, and this
   * field says exactly that rather than claiming full read isolation.
   */
  readConfinement: "sensitive-paths" | "none";
  processGroupKill: true;
  resourceLimitsEnforced: boolean;
  /**
   * Which mechanism bounded memory. `hard` is a kernel address-space limit the candidate
   * cannot raise; `observed` is the RSS sampling below, used where the kernel does not
   * honour RLIMIT_AS (Darwin). `none` means neither mechanism was established, and can
   * therefore never accompany a passing outcome. Recorded because a reader of this evidence
   * must be able to tell the difference — CPU and process-count limits are hard in both
   * cases.
   */
  memoryLimit: "hard" | "observed" | "none";
  /**
   * Which process limit the candidate ran under (`ProcessLimitMode`). Absent only when nothing was
   * launched.
   */
  processLimit?: ProcessLimitMode;
  childContainmentEnforced: boolean;
  /** Why candidate containment was not claimed, when the proof failed or was unavailable. */
  childContainmentReason: string | null;
  mechanism: "seatbelt" | "none";
}

const SAFE_NODE_ENV = new Set(["development", "test", "production"]);
const SAFE_BOOLEAN_ENV = new Set(["0", "1"]);
/** Only these non-authority values may cross into a verification process. */
const SAFE_COMMAND_ENV: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ["NODE_ENV", (value) => SAFE_NODE_ENV.has(value)],
  ["NO_COLOR", (value) => SAFE_BOOLEAN_ENV.has(value)],
  ["FORCE_COLOR", (value) => SAFE_BOOLEAN_ENV.has(value)],
  ["TZ", (value) => /^[A-Za-z0-9_+\-/]{1,64}$/.test(value)],
]);
const RESOURCE_WRAPPER = "/usr/bin/python3";

/** The kernel child-list reader the supervisor loads. */
const CHILD_LIST_READER = "/usr/lib/libproc.dylib";
// Production always loads the real reader. The only supported way to change it is the scoped
// test seam below, which names a library that does not exist, so the proof that a supervisor
// without a child list fails closed exercises the real branch rather than a simulation of it.
let childListReader = CHILD_LIST_READER;

/**
 * What the supervisor reports on stderr when it ends a `supervised-budget` run itself. Each is
 * read together with its own exit status, so the marker alone -- which candidate output can also
 * print -- never decides anything; and each status is nonzero, so none of them can pass.
 */
export const PROCESS_LIMIT_EXCEEDED = "ACP_PROCESS_LIMIT_EXCEEDED";
export const PROCESS_LIMIT_UNAVAILABLE = "ACP_PROCESS_LIMIT_UNAVAILABLE";
export const DESCENDANT_OUTLIVED_CANDIDATE = "ACP_DESCENDANT_OUTLIVED_CANDIDATE";
const PROCESS_LIMIT_EXCEEDED_EXIT = 123;
const PROCESS_LIMIT_UNAVAILABLE_EXIT = 122;
const DESCENDANT_OUTLIVED_EXIT = 121;

/**
 * The descriptor on which the supervisor reports the outcome it is about to end with (`exit <code>`
 * or `signal <number>`). It is close-on-exec in the supervisor, so the candidate never holds it and
 * cannot write a report; a supervisor whose end does not match its report -- killed by a signal,
 * crashed, or ended before reporting -- has not reached one of its own outcomes.
 */
const SUPERVISOR_REPORT_FD = 3;

/** Whether the launched supervisor ended exactly as it reported it would. */
const supervisorEndedAsReported = (
  report: string,
  exit: { code: number | null; signal: NodeJS.Signals | null },
): boolean => {
  const reported = /^(exit|signal) (\d+)\n$/.exec(report);
  if (!reported) return false;
  const value = Number(reported[2]);
  return reported[1] === "exit"
    ? exit.signal === null && exit.code === value
    : exit.code === null && exit.signal !== null && osConstants.signals[exit.signal] === value;
};

/*
 * The wrapper is trusted control-plane code. It lowers both soft and hard limits before
 * handing control to candidate code, so candidate code cannot raise them again. The
 * process-group cleanup below is the containment control, not argv inspection.
 *
 * The process limit (`ProcessLimitMode`) is applied in the forked candidate child, never in the
 * supervisor, which must be allowed to fork that child:
 *
 * - `no-spawn` sets RLIMIT_NPROC 1, so the candidate and every descendant receive the hard
 *   refusal when they try to fork again.
 * - `budget` sets no process rlimit. The supervisor polls the candidate's tree through the kernel
 *   child list (`proc_listchildpids`) about once a millisecond, counts the live descendants it has
 *   found, and once they exceed the budget it freezes and kills every one of them and reports
 *   ACP_PROCESS_LIMIT_EXCEEDED. A child list it cannot read before the candidate starts refuses the
 *   run with no candidate started, reported as ACP_PROCESS_LIMIT_UNAVAILABLE. Once the candidate
 *   exists, a child list it cannot read, or a supervisor that was stopped and continued -- it did
 *   not watch the tree meanwhile -- ends the run the same way but as a cleanup it cannot prove,
 *   ACP_CHILD_CLEANUP_UNAVAILABLE. A tracked descendant running at the poll that sees the
 *   candidate exit is killed and reported as ACP_DESCENDANT_OUTLIVED_CANDIDATE, so the candidate's
 *   exit 0 does not pass -- even if that descendant ends during the settling turns that follow,
 *   which serve only the cleanup proof. A signal that would end the supervisor makes it stop the
 *   tree first. Every end the supervisor chooses is reported first on SUPERVISOR_REPORT_FD.
 *
 *   This is a supervised, polled budget, not a kernel limit, and it does not prevent escape. A
 *   descendant created and reparented between two polls is never seen (#461): it is neither
 *   counted nor killed. One that ends within a poll of the candidate's exit is not seen to outlive
 *   it. Between two polls the tree can grow past the budget before it is stopped. And the
 *   supervisor runs as the same user in the same sandbox, so the candidate can SIGKILL it: its end
 *   then matches no report, so containment is recorded as unproven and the run cannot pass, but
 *   descendants that left the launched process group are not reaped.
 *
 * The CPU and memory limits are per process and inherited, which is not the same as the
 * whole-tree budget. RLIMIT_CPU applies to each process on its own: every descendant starts with
 * its own full allowance, so a tree's total CPU can exceed it, and the wall-clock timeout is what
 * bounds the tree. RLIMIT_AS, where the kernel honours it, is also per process. Darwin's observed
 * RSS bound sums the launched process group, so a descendant that moves to a group of its own is
 * outside it. Only the process budget counts the tracked tree as a whole.
 *
 * The address-space limit is passed as 0 on hosts whose kernel does not honour
 * RLIMIT_AS (Darwin accepts the call and then ignores it, so `getrlimit` never confirms
 * it). Refusing every verification on such a host would not be caution — it would make
 * the only supported platform unable to verify anything — so the caller decides, and the
 * outcome records which memory bound was actually in force. CPU and process-count limits
 * are hard requirements everywhere and still fail closed; process-group cleanup is checked
 * separately.
 */
const RESOURCE_WRAPPER_PROGRAM = String.raw`
import ctypes, errno, os, resource, signal, struct, sys, time

REPORT_FD = ${SUPERVISOR_REPORT_FD}

def finish(code=None, signum=None):
    """End with one of the supervisor's own outcomes, first telling the trusted caller which one on
    a descriptor the candidate never holds. An exit that does not match a report is not one of them."""
    try:
        os.write(REPORT_FD, (("signal %d" % signum) if signum is not None else ("exit %d" % code)).encode("ascii") + b"\n")
    except OSError:
        pass
    if signum is not None:
        # The supervisor may handle this signal itself; its default action is what ends it here.
        try:
            signal.signal(signum, signal.SIG_DFL)
        except (OSError, RuntimeError, ValueError):
            pass
        os.kill(os.getpid(), signum)
        code = 128 + signum
    sys.exit(code)

def hard_limit(kind, value):
    soft, hard = resource.getrlimit(kind)
    if soft > value:
        resource.setrlimit(kind, (value, hard))
    resource.setrlimit(kind, (value, value))
    if resource.getrlimit(kind) != (value, value):
        raise RuntimeError("limit was not applied")

try:
    hard_limit(resource.RLIMIT_CPU, int(sys.argv[1]))
    address_space = int(sys.argv[2])
    if address_space > 0:
        hard_limit(resource.RLIMIT_AS, address_space)
    process_mode = sys.argv[3]
    process_budget = int(sys.argv[4])
    if process_mode not in ("no-spawn", "budget") or process_budget < 1:
        raise RuntimeError("unknown process limit " + process_mode)
    # Close-on-exec: the forked candidate drops the report descriptor when it execs.
    os.set_inheritable(REPORT_FD, False)
except Exception as error:
    print("ACP_RESOURCE_LIMIT_UNAVAILABLE:" + str(error), file=sys.stderr)
    finish(125)

try:
    libproc = ctypes.CDLL(sys.argv[5], use_errno=True)
    libproc.proc_listchildpids.argtypes = [ctypes.c_int32, ctypes.c_void_p, ctypes.c_int]
    libproc.proc_listchildpids.restype = ctypes.c_int
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    libproc.proc_pidinfo.restype = ctypes.c_int
except Exception:
    libproc = None

def child_pids(parent_pid):
    """Read the kernel's child list without executing a helper inside seatbelt."""
    if libproc is None:
        return None
    try:
        capacity = 64
        for _ in range(6):
            buffer = ctypes.create_string_buffer(capacity * 4)
            count = libproc.proc_listchildpids(parent_pid, buffer, capacity * 4)
            if count < 0:
                return None
            if count < capacity:
                return [
                    struct.unpack_from("i", buffer, offset)[0]
                    for offset in range(0, count * 4, 4)
                    if struct.unpack_from("i", buffer, offset)[0] > 0
                ]
            capacity *= 2
    except Exception:
        return None
    return None

def is_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

PROC_PIDT_SHORTBSDINFO = 13
SHORTBSDINFO_SIZE = 64

def is_running(pid):
    """Alive and not a zombie: a zombie still answers kill(pid, 0) but has no BSD info (ESRCH)."""
    if not is_alive(pid):
        return False
    if libproc is None:
        return True
    info = ctypes.create_string_buffer(SHORTBSDINFO_SIZE)
    if libproc.proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, info, SHORTBSDINFO_SIZE) > 0:
        return True
    return ctypes.get_errno() != errno.ESRCH

class Tree:
    """The candidate's descendants found so far: pid -> the process group it was in when found."""

    def __init__(self, root_pid):
        self.root = root_pid
        self.known = {}
        self.scan_available = True

    def scan(self):
        scanned = set()
        pending = [self.root] + list(self.known)
        while pending:
            parent = pending.pop()
            if parent in scanned:
                continue
            if parent != self.root and not is_alive(parent):
                scanned.add(parent)
                continue
            children = child_pids(parent)
            if children is None:
                self.scan_available = False
                return
            scanned.add(parent)
            for pid in children:
                if pid in self.known or pid in (os.getpid(), self.root):
                    continue
                try:
                    self.known[pid] = os.getpgid(pid)
                except OSError:
                    continue
                pending.append(pid)

def fence_descendants(root_pid):
    tree = Tree(root_pid)

    while True:
        tree.scan()
        waited, status = os.waitpid(root_pid, os.WNOHANG)
        if waited == root_pid:
            break
        time.sleep(0.001)

    # The candidate can exit just as it creates a detached child. Give the kernel child
    # list a few more turns before the child is reparented out of the candidate tree.
    for _ in range(20):
        tree.scan()
        time.sleep(0.001)

    if not tree.scan_available:
        return False, status

    for pid, pgid in tree.known.items():
        if not is_alive(pid):
            continue
        try:
            if pgid != os.getpgrp() and pgid == pid:
                os.kill(-pgid, signal.SIGKILL)
            else:
                os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    for _ in range(40):
        if not any(is_alive(pid) for pid in tree.known):
            return True, status
        time.sleep(0.025)
    return False, status

supervisor_signal = None
supervisor_continued = False

def on_supervisor_signal(signum, frame):
    global supervisor_signal
    if supervisor_signal is None:
        supervisor_signal = signum

def on_supervisor_continued(signum, frame):
    global supervisor_continued
    supervisor_continued = True

def guard_supervisor():
    """A signal that would end the supervisor makes it stop the tree first."""
    for kind in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGQUIT, signal.SIGUSR1,
                 signal.SIGUSR2, signal.SIGALRM, signal.SIGVTALRM, signal.SIGPROF, signal.SIGXCPU,
                 signal.SIGXFSZ):
        signal.signal(kind, on_supervisor_signal)
    for kind in (signal.SIGTSTP, signal.SIGTTIN, signal.SIGTTOU):
        signal.signal(kind, signal.SIG_IGN)
    # SIGSTOP cannot be caught, but the SIGCONT that ends it can: a supervisor that was stopped
    # did not watch the tree in the meantime.
    signal.signal(signal.SIGCONT, on_supervisor_continued)

def signal_tracked(pid, kind):
    """Signal one tracked descendant, and the whole group it leads when it leads one of its own."""
    try:
        pgid = os.getpgid(pid)
    except OSError:
        return
    try:
        if pgid == pid and pgid != os.getpgrp():
            os.kill(-pgid, kind)
        else:
            os.kill(pid, kind)
    except OSError:
        pass

def forget_exited(tree):
    for pid in [pid for pid in tree.known if not is_alive(pid)]:
        del tree.known[pid]

def stop_tree(tree, root_running):
    """Freeze, then kill, every tracked process: a stopped process cannot fork while it is killed."""
    frozen = set()
    if root_running:
        try:
            os.kill(tree.root, signal.SIGSTOP)
        except OSError:
            pass
    for _ in range(64):
        tree.scan()
        fresh = [pid for pid in tree.known if pid not in frozen and is_alive(pid)]
        if not fresh:
            break
        for pid in fresh:
            signal_tracked(pid, signal.SIGSTOP)
            frozen.add(pid)
    if root_running:
        try:
            os.kill(tree.root, signal.SIGKILL)
        except OSError:
            pass
    for pid in list(tree.known):
        if is_alive(pid):
            signal_tracked(pid, signal.SIGKILL)
    root_reaped = not root_running
    for _ in range(40):
        if not root_reaped:
            try:
                root_reaped = os.waitpid(tree.root, os.WNOHANG)[0] == tree.root
            except ChildProcessError:
                root_reaped = True
        if root_reaped and not any(is_alive(pid) for pid in tree.known):
            return True
        time.sleep(0.025)
    return False

def supervise_budget(root_pid, budget):
    """Returns why the supervisor stopped the run (or None), the candidate's wait status, how many
    tracked descendants were still running when it exited, the live count, and whether every
    tracked process was proven gone."""
    tree = Tree(root_pid)
    stop = None
    status = 0
    root_reaped = False
    while True:
        tree.scan()
        if not tree.scan_available:
            stop = "unavailable"
            break
        forget_exited(tree)
        if len(tree.known) > budget:
            stop = "exceeded"
            break
        if supervisor_signal is not None:
            stop = "signalled"
            break
        if supervisor_continued:
            stop = "unavailable"
            break
        waited, status = os.waitpid(root_pid, os.WNOHANG)
        if waited == root_pid:
            root_reaped = True
            break
        time.sleep(0.001)

    live = len(tree.known)
    outlived = set()
    if stop is None:
        # The verdict is read here, at the poll that saw the candidate exit: a tracked descendant
        # running now outlived it, even if it ends during the turns below.
        tree.scan()
        forget_exited(tree)
        outlived = {pid for pid in tree.known if is_running(pid)}
        # As in fence_descendants: a few more turns of the child list before a child that was
        # created as the candidate exited is reparented out of the tree. They serve the cleanup
        # proof; they can only add to the verdict, never take a descendant out of it.
        for _ in range(20):
            tree.scan()
            time.sleep(0.001)
        forget_exited(tree)
        live = len(tree.known)
        if not tree.scan_available or supervisor_continued:
            stop = "unavailable"
        elif live > budget:
            stop = "exceeded"
        outlived.update(pid for pid in tree.known if is_running(pid))
    return stop, status, len(outlived), live, stop_tree(tree, not root_reaped)

def report_candidate(pid):
    try:
        report_path = os.path.join(os.environ["TMPDIR"], "acp-candidate.pid")
        with open(report_path, "x", encoding="ascii") as report:
            report.write(str(pid) + "\n")
        return True
    except OSError:
        return False

if process_mode == "budget" and child_pids(os.getpid()) is None:
    # Known before any candidate exists, so nothing has run and there is nothing to clean up: the
    # run is refused as a budget that cannot be enforced, and no candidate is started.
    print("${PROCESS_LIMIT_UNAVAILABLE}: the kernel child list cannot be read, so no candidate was started", file=sys.stderr)
    finish(${PROCESS_LIMIT_UNAVAILABLE_EXIT})

candidate_pid = os.fork()
if candidate_pid == 0:
    try:
        if process_mode == "no-spawn":
            hard_limit(resource.RLIMIT_NPROC, 1)
    except Exception as error:
        print("ACP_RESOURCE_LIMIT_UNAVAILABLE:" + str(error), file=sys.stderr)
        os._exit(125)
    # The outer supervisor must record this exact pid before candidate code can exec.
    # A candidate cannot skip this stop without first becoming a different process.
    os.kill(os.getpid(), signal.SIGSTOP)
    os.execvpe(sys.argv[6], sys.argv[6:], os.environ)

if process_mode == "budget":
    guard_supervisor()

if not report_candidate(candidate_pid):
    try:
        os.kill(candidate_pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(candidate_pid, 0)
    except ChildProcessError:
        pass
    print("ACP_CHILD_CLEANUP_UNAVAILABLE: candidate identity handshake failed", file=sys.stderr)
    finish(126)

if process_mode == "no-spawn":
    reaped, candidate_status = fence_descendants(candidate_pid)
    if not reaped:
        print("ACP_CHILD_CLEANUP_UNAVAILABLE: descendant process remained", file=sys.stderr)
        finish(126)
else:
    stop, candidate_status, outlived, live, cleaned = supervise_budget(candidate_pid, process_budget)
    if not cleaned:
        print("ACP_CHILD_CLEANUP_UNAVAILABLE: descendant process remained", file=sys.stderr)
        finish(126)
    if supervisor_signal is not None:
        finish(signum=supervisor_signal)
    if stop == "exceeded":
        print("${PROCESS_LIMIT_EXCEEDED}: %d live descendants exceeded the supervised budget of %d; the candidate tree was killed" % (live, process_budget), file=sys.stderr)
        finish(${PROCESS_LIMIT_EXCEEDED_EXIT})
    if stop == "unavailable":
        # The candidate exists by now, so a tree the supervisor could not watch -- an unreadable
        # child list, or a stop it was continued from -- is a cleanup it cannot prove.
        print("ACP_CHILD_CLEANUP_UNAVAILABLE: the supervisor could not watch the candidate's process tree; it killed what it had tracked", file=sys.stderr)
        finish(126)
    if outlived:
        print("${DESCENDANT_OUTLIVED_CANDIDATE}: %d tracked descendant(s) were still running when the candidate exited; they were killed" % outlived, file=sys.stderr)
        if os.WIFEXITED(candidate_status) and os.WEXITSTATUS(candidate_status) == 0:
            finish(${DESCENDANT_OUTLIVED_EXIT})
if os.WIFEXITED(candidate_status):
    finish(os.WEXITSTATUS(candidate_status))
if os.WIFSIGNALED(candidate_status):
    finish(signum=os.WTERMSIG(candidate_status))
finish(125)
`;

/**
 * Darwin's `setrlimit(RLIMIT_AS, …)` succeeds and has no effect, so a hard address-space
 * bound cannot be established there. Where it cannot, the RSS observation below is the
 * memory bound and the outcome says so rather than claiming a limit it does not have. The
 * hard-address-space backend is unavailable only on Darwin.
 */
export const memoryLimitForPlatform = (
  platform: NodeJS.Platform = process.platform,
): "hard" | "observed" => (platform === "darwin" ? "observed" : "hard");

/**
 * macOS ships `/usr/bin/git` as an xcrun stub, not as git: it looks up the active developer
 * directory and then the tool inside it. Measured: for a developer directory that is not the
 * Command Line Tools -- an Xcode.app, as `xcode-select` names on GitHub's macOS runners -- that
 * lookup spawns `xcodebuild`, and when the spawn fails the stub exits 71 (EX_OSERR) before git ever
 * runs. Inside the sandbox it must fail: the candidate runs under RLIMIT_NPROC 1, which refuses
 * every spawn. So the stub is resolved here, outside the sandbox, and the sandbox execs the tool
 * itself. Nothing is added to the profile: the tool is read and executed exactly as the stub would
 * have exec'd it, and the sandbox no longer runs xcrun at all.
 *
 * Resolving outside also fixes which `git` runs. Inside, the sandbox PATH lists the worktree before
 * `/usr/bin`, so a candidate that commits an executable named `git` at its root was run in place of
 * git -- measured: `git status --porcelain` printed the candidate's output and exited 0 -- while the
 * allowlist outside had approved `/usr/bin/git`. Every other declared executable had the same
 * exposure until `verificationLaunchArgv` (#1102) launched each one by its approved absolute path.
 */
const XCRUN_STUBS: ReadonlySet<string> = new Set(["/usr/bin/git"]);
const XCRUN = "/usr/bin/xcrun";
/**
 * A bound, not a measurement: a warm `xcrun --find` answers in milliseconds, and a cold one on an
 * Xcode host runs `xcodebuild` first, which is the slow case this leaves room for.
 */
const XCRUN_FIND_TIMEOUT_MS = 30_000;

type DeveloperToolFinder = (name: string) => Promise<string>;

const xcrunFind: DeveloperToolFinder = async (name) => {
  const { stdout } = await exec(XCRUN, ["--find", name], {
    encoding: "utf8",
    timeout: XCRUN_FIND_TIMEOUT_MS,
    // The daemon's own developer-directory choice, and nothing else of its environment.
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: process.env["HOME"] ?? "",
      ...(process.env["DEVELOPER_DIR"] ? { DEVELOPER_DIR: process.env["DEVELOPER_DIR"] } : {}),
    },
  });
  return stdout.trim();
};

let findDeveloperTool: DeveloperToolFinder = xcrunFind;

const executableFileAt = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The xcrun-stub step of the argv the sandbox execs (`verificationLaunchArgv`): the argv it is given,
 * except that an xcrun stub at argv[0] is replaced by the absolute path of the tool it stands for. A tool that cannot be located, or a location that is
 * not an executable of the same name, is a refusal -- falling back to the stub would only move the
 * failure inside the sandbox, where it cannot say why.
 */
export const sandboxLaunchArgv = async (
  argv: readonly string[],
  context: { cwd: string; additionalRoots: readonly string[] },
): Promise<Decision<readonly string[]>> => {
  const resolved = resolveVerificationExecutable(argv[0] ?? "", context).resolvedPath;
  if (resolved === null || !XCRUN_STUBS.has(resolved)) return allow(ReasonCode.OK, argv);
  const name = basename(resolved);
  let found: string;
  try {
    found = await findDeveloperTool(name);
  } catch (error) {
    const failed = error as { stderr?: string; message?: string };
    return deny(ReasonCode.INVALID_ARGUMENT, `could not locate developer tool '${name}' outside the sandbox`, {
      stub: resolved,
      detail: (failed.stderr || failed.message || String(error)).trim().slice(0, 2_000),
    });
  }
  let target: string | null = null;
  try {
    target = isAbsolute(found) ? realpathSync(found) : null;
  } catch {
    target = null;
  }
  if (target === null || XCRUN_STUBS.has(target) || basename(target) !== name || !executableFileAt(target)) {
    return deny(ReasonCode.INVALID_ARGUMENT, `the located developer tool is not an executable '${name}'`, {
      stub: resolved,
      located: found,
      target,
    });
  }
  return allow(ReasonCode.OK, [target, ...argv.slice(1)]);
};

/**
 * The absolute path argv[0] names, with its symlinks left in place: a path as declared (a relative
 * one against the command's cwd), or a bare name looked up in the daemon-built search path in the
 * resolver's order. It is the alias the allowlist approved. The sandbox's PATH is never consulted,
 * and a relative entry on the daemon's PATH is made absolute here, against the daemon's cwd where
 * the resolver found it -- left relative, the sandbox would resolve it against the worktree.
 */
const approvedLaunchPath = (
  argv0: string,
  context: { cwd: string; additionalRoots: readonly string[] },
): string | null => {
  const raw = argv0.replaceAll("\\", sep);
  if (raw.includes(sep)) return isAbsolute(raw) ? raw : resolve(context.cwd, raw);
  for (const root of verificationExecutableSearchPath(context.additionalRoots)) {
    const candidate = resolve(root, raw);
    if (executableFileAt(candidate)) return candidate;
  }
  return null;
};

const realPathOf = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * The argv the sandbox execs (#1102): argv[0] is an absolute path the executable allowlist approved
 * outside the sandbox, never a name for the sandbox's PATH to look up. That PATH lists the worktree
 * ahead of `/usr/local/bin` and `/usr/bin`, and the daemon's PATH, where the allowlist also finds
 * tools, is not on it at all -- so a candidate that committed an executable named after a declared
 * command at its root ran in place of the approved tool. Measured: a declared `pnpm`, approved from
 * a directory on the daemon's PATH, printed the candidate's output and passed.
 *
 * The approved path itself runs, not its realpath: a tool that dispatches on argv[0] (a multiplexer
 * behind a `pnpm` symlink) must see the name it was declared by. Measured: launching the realpath ran
 * the multiplexer's help, which exited 0 where the declared `pnpm test` exited 17. At launch the
 * path must still lead to the tool the allowlist approved, or the command is refused. An xcrun stub
 * is then replaced by the tool it stands for, as `sandboxLaunchArgv` says.
 */
export const verificationLaunchArgv = async (
  argv: readonly string[],
  context: { cwd: string; additionalRoots: readonly string[] },
): Promise<Decision<readonly string[]>> => {
  const resolution = resolveVerificationExecutable(argv[0] ?? "", context);
  if (!resolution.allowed || resolution.resolvedPath === null) {
    return deny(ReasonCode.INVALID_ARGUMENT, verificationExecutableRefusalMessage(argv, context), {
      resolvedPath: resolution.resolvedPath,
    });
  }
  const launchPath = approvedLaunchPath(argv[0] ?? "", context);
  const target = launchPath === null ? null : realPathOf(launchPath);
  if (launchPath === null || target !== resolution.resolvedPath || !executableFileAt(launchPath)) {
    return deny(
      ReasonCode.INVALID_ARGUMENT,
      `verification executable '${resolution.name}' no longer leads to the tool the allowlist approved`,
      { approved: resolution.resolvedPath, launchPath, target },
    );
  }
  return sandboxLaunchArgv([launchPath, ...argv.slice(1)], context);
};

/** Test-only scopes. */
export const __testing = Object.freeze({
  /**
   * Point the supervisor at a child-list reader that does not exist, as on a host where libproc
   * cannot be loaded: the proof that a supervisor which cannot see the candidate's tree fails
   * closed instead of reporting the candidate's own exit status.
   */
  withChildListReaderUnavailable: async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = childListReader;
    childListReader = "/nonexistent/acp-child-list-reader-unavailable.dylib";
    try {
      return await operation();
    } finally {
      childListReader = previous;
    }
  },
  /** Stand in for `xcrun --find`, to place the developer tool where another host would have it. */
  withDeveloperToolFinder: async <T>(finder: DeveloperToolFinder, operation: () => Promise<T>): Promise<T> => {
    const previous = findDeveloperTool;
    findDeveloperTool = finder;
    try {
      return await operation();
    } finally {
      findDeveloperTool = previous;
    }
  },
});

const hardAddressSpaceAvailable = (): boolean => memoryLimitForPlatform() === "hard";

const RSS_SAMPLE_INTERVAL_MS = 100;

/**
 * Every `ps` this file runs is bounded in time, because the sandbox awaits those probes
 * unconditionally and `command.timeoutSeconds` binds the child, never our own waiting.
 *
 * The value is not chosen here. `src/core/process-identity.ts` runs the *same* probe —
 * `ps -o lstart= -p <pid>` — already bounded at 5s, and its docstring names this file while
 * explaining why the two are deliberately separate implementations: "that one is async and runs
 * inside the sandbox supervisor's event loop, while session registration is synchronous and on
 * the write path." The split was intended. The bound diverging across it was not, and because a
 * comment declared the two equivalent, nothing compared them (#859).
 *
 * Measured (#844): with a `ps` made to take 60s and nothing else changed, a command needing 50ms
 * against a 3-second budget took **180,086ms** unbounded and **15,079ms** bounded — three probes
 * serialised, each paying the bound instead of the latency. At 8s per `ps` the same command came
 * back `ERROR` / `SANDBOX_CHILD_CLEANUP_FAILED` after 24,081ms, and `#167`'s escalation test spent
 * 24,543ms against a one-second subject timeout. On CI that shape consumed the runner's full
 * 60,022ms budget on one lane while the other lane passed the same commit.
 *
 * Limit, stated rather than left to be discovered: this bounds the wait, not the verdict. A probe
 * that hits the bound still lands on the existing "could not be proved" path — which CP-HI-08
 * makes a refusal on purpose — so a machine slow enough to exceed it refuses instead of hanging,
 * and is still told it failed containment rather than that the host could not answer. Relabelling
 * that refusal is #859's other half and is deliberately not in this change.
 *
 * Ruled out: deriving the bound from `command.timeoutSeconds`. Half of these probes run during
 * cleanup, after the child is gone and its budget is spent, so there is no subject budget left to
 * derive from at the moment they need a bound.
 */
const PROCESS_PROBE_TIMEOUT_MS = 5_000;

/**
 * Under the budget, how long a supervisor asked to stop its tree has before its process group is
 * killed with it. The supervisor freezes and kills what it tracks within a few milliseconds; its
 * own proof that they are gone waits up to a second, so this covers that with room to spare.
 */
const SUPERVISOR_STOP_GRACE_MS = 2_000;
/**
 * Under the budget, how long the candidate's output may stay open after the supervisor exits
 * before whatever holds it is treated as an untracked descendant. Every tracked process is gone by
 * then, so a normal run closes its output within milliseconds of the supervisor's exit.
 */
const STDIO_DRAIN_GRACE_MS = 1_000;

const seatbeltAvailable = (): boolean => existsSync("/usr/bin/sandbox-exec");

/**
 * Runs one verification command under the isolation PRD §17.4 requires.
 *
 * On macOS the confinement is enforced by seatbelt (`sandbox-exec`): network is
 * denied at the syscall layer and writes are confined to the disposable worktree plus
 * the scratch root. The executable allowlist above remains defence in depth; an
 * allowlisted interpreter may still exec a shell, so these seatbelt and resource controls
 * are the boundary. Where that mechanism is unavailable the run fails closed with
 * SANDBOX_NETWORK_DENIED instead of quietly executing unconfined — CP-HI-08 forbids
 * reporting a weaker execution as a pass.
 */
export const runSandboxed = async (request: SandboxRequest): Promise<SandboxOutcome> => {
  const { command, worktreePath } = request;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const scratch = acpScratchDir("acp-sbx-");

  const mechanism: SandboxEnforcement["mechanism"] = seatbeltAvailable() ? "seatbelt" : "none";

  // The public schema rejects this earlier, but keep the process-launch boundary defensive
  // for legacy callers that hand the sandbox a structurally typed object. The same shared
  // predicate is used by the contract parser, so no wrapper option grammar is duplicated here.
  const executableContext = {
    cwd: resolve(worktreePath, command.cwd),
    additionalRoots: [worktreePath],
  };
  if (isVerificationCommandRefused(command.argv, executableContext)) {
    rmSync(scratch, { recursive: true, force: true });
    return refused(
      command,
      startedMs,
      startedAt,
      mechanism,
      ReasonCode.INVALID_ARGUMENT,
      verificationExecutableRefusalMessage(command.argv, executableContext),
    );
  }

  // Integration §12 allows `allowlist`, but seatbelt cannot express per-host network
  // policy. Claiming to honour a host allowlist while permitting all traffic would be a
  // silent downgrade, so it is refused until a mechanism that can enforce it exists.
  if (command.network === "allowlist") {
    rmSync(scratch, { recursive: true, force: true });
    return unconfined(
      command,
      startedMs,
      startedAt,
      mechanism,
      "network=allowlist cannot be enforced by the available mechanism",
    );
  }

  // Confinement is required for every command, not only when the network must be denied:
  // an unconfined command can also write anywhere and read any file this user can.
  if (mechanism === "none") {
    rmSync(scratch, { recursive: true, force: true });
    return unconfined(
      command,
      startedMs,
      startedAt,
      mechanism,
      "sandbox confinement mechanism unavailable; refusing to run unconfined",
    );
  }

  const targets = resolveCommandTargets(command, worktreePath);
  if (!targets.allowed) {
    rmSync(scratch, { recursive: true, force: true });
    return refused(command, startedMs, startedAt, mechanism, targets.reasonCode, targets.reason);
  }
  const launch = await verificationLaunchArgv(command.argv, executableContext);
  if (!launch.allowed) {
    rmSync(scratch, { recursive: true, force: true });
    return refused(
      command,
      startedMs,
      startedAt,
      mechanism,
      launch.reasonCode,
      `${launch.message}: ${JSON.stringify(launch.evidence)}`,
    );
  }
  const env = buildSandboxEnvironment(command, scratch, request.env, targets.worktree);
  if (!existsSync(RESOURCE_WRAPPER)) {
    rmSync(scratch, { recursive: true, force: true });
    return refused(
      command,
      startedMs,
      startedAt,
      mechanism,
      ReasonCode.SANDBOX_RESOURCE_LIMIT_UNAVAILABLE,
      "resource-limit wrapper is unavailable",
    );
  }

  // seatbelt matches on resolved paths — on macOS the temp root is a symlink
  // (/var/folders -> /private/var/folders), so an unresolved path would confine the
  // command to a directory it can never reach and every write would fail.
  const hardMemoryLimit = hardAddressSpaceAvailable();
  // Exactly one value selects the budget; anything else, including no value, is no-spawn.
  const supervisedBudget = request.processLimit === "supervised-budget";
  const processLimit: ProcessLimitMode = supervisedBudget ? "supervised-budget" : "no-spawn";
  const resourceArgs = [
    "-c",
    RESOURCE_WRAPPER_PROGRAM,
    String(command.maxCpuSeconds ?? command.timeoutSeconds),
    String(hardMemoryLimit ? command.maxMemoryMb * 1024 * 1024 : 0),
    supervisedBudget ? "budget" : "no-spawn",
    String(CANDIDATE_PROCESS_BUDGET),
    childListReader,
    ...launch.value,
  ];
  const file = "/usr/bin/sandbox-exec";
  const argv = [
    "-p",
    seatbeltProfile(command, targets.worktree, realpathSync(scratch), request.denyReadPaths ?? []),
    RESOURCE_WRAPPER,
    ...resourceArgs,
  ];

  const child = spawn(file, argv, {
    cwd: targets.cwd,
    env,
    detached: true, // own process group so the timeout can reap the whole tree
    // The fourth descriptor is SUPERVISOR_REPORT_FD, written only by the supervisor.
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  let supervisorReport = "";
  (child.stdio[SUPERVISOR_REPORT_FD] as Readable | null)?.on("data", (chunk: Buffer) => {
    if (supervisorReport.length < 256) supervisorReport += chunk.toString("utf8");
  });

  let closeSeen = false;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.on("error", () => resolveExit({ code: null, signal: null }));
      child.on("close", (code, signal) => {
        closeSeen = true;
        resolveExit({ code, signal });
      });
    },
  );
  // The leader (the supervisor) is this process's own child, so until its exit event its pid
  // cannot have been reused: signalling it by pid needs no start-time fence.
  let leaderExited = false;
  let settleLeaderExit: () => void = () => undefined;
  const leaderExit = new Promise<void>((resolveLeaderExit) => {
    settleLeaderExit = resolveLeaderExit;
  });
  child.on("error", () => settleLeaderExit());
  // Start the identity probe at once. A successful command can legitimately disappear
  // before `ps -o lstart` returns; that loses only the fenced signalling handle, not a
  // recorded RSS observation or a proven refusal to pass without containment.
  const identityAttempt = processIdentity(child.pid);
  let identity: ProcessIdentity | null = null;
  let candidateIdentity: ProcessIdentity | null = null;
  let timedOut = false;
  // Not knowing the leader's start time only costs us the ability to *signal* the group by
  // a fenced identity. Candidate containment has its own PID/start-time proof because the
  // candidate can call setsid(2) and leave the launcher's original process group.
  let isolationLost = false;
  let childContainmentReason: string | null = null;
  let escalation: NodeJS.Timeout | undefined;
  let closed = false;

  const markContainmentLost = (reason: string): void => {
    isolationLost = true;
    childContainmentReason ??= reason;
  };

  const candidateReportPath = join(scratch, "acp-candidate.pid");
  let candidateReportSeen = false;
  let settleCandidateObservation: () => void = () => undefined;
  const candidateObservation = new Promise<void>((resolveObservation) => {
    settleCandidateObservation = resolveObservation;
  });

  const signalUnfencedGroup = (signal: NodeJS.Signals): boolean => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  };

  const signalUnfencedLeader = (signal: NodeJS.Signals): boolean => {
    if (!child.pid) return false;
    try {
      process.kill(child.pid, signal);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  };

  const observeCandidate = async (): Promise<void> => {
    if (candidateReportSeen) return;
    let pidText: string;
    try {
      pidText = readFileSync(candidateReportPath, "utf8").trim();
    } catch {
      return;
    }
    // The wrapper creates the file before writing its one-line payload. Do not turn that
    // brief, empty-file window into a false containment failure.
    if (!pidText) return;
    candidateReportSeen = true;
    const pid = Number.parseInt(pidText, 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      markContainmentLost(`resource wrapper reported an invalid candidate pid '${pidText}'`);
      settleCandidateObservation();
      return;
    }
    const observed = await processIdentity(pid);
    if (!observed) {
      markContainmentLost(`candidate pid ${pid} could not be fenced by start time`);
      // The candidate is still SIGSTOPed because identity capture is the release gate. It
      // therefore cannot have changed session yet; kill the original group as the safe
      // fallback so an unavailable ps probe cannot strand a stopped child forever.
      signalUnfencedGroup("SIGKILL");
      settleCandidateObservation();
      return;
    }
    candidateIdentity = observed;
    try {
      // The candidate has been SIGSTOPed before exec. This direct continuation is the
      // release gate: it cannot run self-detachment code until its identity is recorded.
      process.kill(pid, "SIGCONT");
    } catch {
      markContainmentLost(`candidate pid ${pid} could not be released after identity capture`);
    }
    settleCandidateObservation();
  };

  // The candidate is stopped until its own identity is captured. Let the outer leader probe
  // finish first so a transient leader-identity race cannot also consume the only candidate
  // identity probe and leave the stopped child unreleasable.
  let identityProbeComplete = false;
  void identityAttempt.then(() => {
    identityProbeComplete = true;
    void observeCandidate();
  });
  const candidatePoll = setInterval(() => {
    if (identityProbeComplete) void observeCandidate();
  }, 1);

  const signalSupervisor = (signal: NodeJS.Signals): boolean => {
    if (!child.pid || leaderExited) return true;
    try {
      process.kill(child.pid, signal);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  };

  const killKnownTargets = async (signal: NodeJS.Signals): Promise<boolean> => {
    const candidateKilled = candidateIdentity
      ? await signalKnownProcess(candidateIdentity, signal)
      : true;
    if (supervisedBudget && candidateIdentity) {
      // Under the budget the supervisor is the only process that knows the candidate's
      // descendants, including those that left this process group. So it is asked to stop the
      // tree (any terminating signal makes it freeze and kill what it tracks), and continued in
      // case the candidate stopped it. Before a SIGKILL of the group, which would kill the
      // supervisor too, it gets a bounded moment to exit on its own; the group kill is the
      // fallback for a supervisor that does not.
      const asked = signalSupervisor(signal === "SIGKILL" ? "SIGTERM" : signal) && signalSupervisor("SIGCONT");
      if (signal === "SIGKILL") {
        let grace: NodeJS.Timeout | undefined;
        await Promise.race([
          leaderExit,
          new Promise<void>((resolveGrace) => {
            grace = setTimeout(resolveGrace, SUPERVISOR_STOP_GRACE_MS);
          }),
        ]);
        clearTimeout(grace);
      }
      const groupKilled = identity ? await killKnownGroup(identity, signal) : signalUnfencedLeader(signal);
      return asked && groupKilled && candidateKilled;
    }
    // Signal the candidate before its original group. A group kill can legitimately make
    // the separately tracked pid disappear before the direct proof checks it. If the outer
    // leader identity is unavailable, only use the group fallback while the candidate is
    // still stopped; after release, signal the known leader pid directly instead.
    const groupKilled = identity
      ? await killKnownGroup(identity, signal)
      : candidateIdentity
        ? signalUnfencedLeader(signal)
        : signalUnfencedGroup(signal);
    return groupKilled && candidateKilled;
  };

  // Under the budget, a process the supervisor never tracked (#461) can still hold the
  // candidate's output after the supervisor has exited, and the close event this function waits
  // for would then never come -- the timeout cannot help, it signals only what is tracked. So once
  // the supervisor has exited, a run whose output stays open is treated as a descendant that
  // outlived it: its process group is reaped, and if the output is still held after that, the
  // holder is out of reach, containment is recorded as lost and the output is closed here.
  let untrackedHolder = false;
  let drainWatch: NodeJS.Timeout | undefined;
  const drainAfterSupervisor = async (): Promise<void> => {
    if (closeSeen) return;
    untrackedHolder = true;
    await reapProcessGroup(child.pid, identity);
    await new Promise((resolveDelay) => {
      drainWatch = setTimeout(resolveDelay, STDIO_DRAIN_GRACE_MS);
    });
    if (closeSeen) return;
    markContainmentLost("a process the supervisor did not track still held the candidate's output after the supervisor exited");
    child.stdout?.destroy();
    child.stderr?.destroy();
    (child.stdio[SUPERVISOR_REPORT_FD] as Readable | null)?.destroy();
  };
  child.on("exit", () => {
    leaderExited = true;
    settleLeaderExit();
    if (!supervisedBudget) return;
    drainWatch = setTimeout(() => void drainAfterSupervisor(), STDIO_DRAIN_GRACE_MS);
  });

  const maxBytes = command.maxOutputBytes;
  let outBytes = 0;
  let truncated = false;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const collect = (chunks: string[]) => (buf: Buffer) => {
    if (truncated) return;
    outBytes += buf.length;
    if (outBytes > maxBytes) {
      truncated = true;
      chunks.push(buf.toString("utf8").slice(0, Math.max(0, maxBytes - (outBytes - buf.length))));
      void killKnownTargets("SIGKILL").then((killed) => {
        if (!killed) markContainmentLost("output-limit cleanup could not signal every observed candidate");
      });
      return;
    }
    chunks.push(buf.toString("utf8"));
  };

  child.stdout?.on("data", collect(stdoutChunks));
  child.stderr?.on("data", collect(stderrChunks));

  let peakRssMb: number | null = null;
  let memoryLimitExceeded = false;
  let sampling = false;
  let inFlightRssSample: Promise<void> | null = null;

  const sampleRss = (): Promise<void> => {
    if (sampling) return inFlightRssSample ?? Promise.resolve();
    if (closed) return Promise.resolve();

    sampling = true;
    const sample = (async () => {
      try {
        const rss = await groupRssMb(child.pid);
        if (rss === null) return;

        peakRssMb = Math.max(peakRssMb ?? 0, rss);
        if (rss <= command.maxMemoryMb || memoryLimitExceeded) return;

        // RSS is the Darwin memory boundary, so crossing it is a resource-limit breach,
        // not a generic command failure. Reap the group and the separately tracked candidate.
        memoryLimitExceeded = true;
        const killed = await killKnownTargets("SIGKILL");
        if (!killed && !closed) markContainmentLost("memory-limit cleanup could not signal every observed candidate");
      } catch {
        // A missing sample remains null and the PASS gate below refuses to claim observation.
      }
    })();
    inFlightRssSample = sample;
    void sample.then(() => {
      sampling = false;
      if (inFlightRssSample === sample) inFlightRssSample = null;
    });
    return sample;
  };

  const timer = setTimeout(() => {
    timedOut = true;
    void killKnownTargets("SIGTERM").then((killed) => {
      if (!killed) markContainmentLost("timeout cleanup could not signal every observed candidate");
      if (closed) return;
      escalation = setTimeout(() => {
        void killKnownTargets("SIGKILL").then((forced) => {
          if (!forced) markContainmentLost("timeout escalation could not signal every observed candidate");
        });
      }, 5_000);
      escalation.unref();
    });
  }, command.timeoutSeconds * 1000);

  identity = await identityAttempt;

  // Sample immediately so a short command has evidence too, then retain the peak for the
  // whole process-group lifetime. A command that cannot be sampled is not eligible to pass.
  await sampleRss();
  const memoryPoll = setInterval(() => {
    void sampleRss();
  }, RSS_SAMPLE_INTERVAL_MS);
  memoryPoll.unref();

  const exit = await exitPromise;

  closed = true;
  clearTimeout(timer);
  if (escalation) clearTimeout(escalation);
  if (drainWatch) clearTimeout(drainWatch);
  clearInterval(memoryPoll);
  clearInterval(candidatePoll);
  if (inFlightRssSample) await inFlightRssSample;
  // A command we stopped ourselves never reaches the point where it reports a candidate, so
  // its absence is explained by the kill rather than by an escape. Both branches below have
  // to know that: exempting only the first left `childContainmentReason` unset, which made
  // the second one fire instead and report the same false conclusion by a different name.
  const killedByOurOwnLimit = memoryLimitExceeded || timedOut || exit.signal === "SIGXCPU";
  await observeCandidate();
  // Under the budget, a supervisor that cannot read the kernel child list refuses before it starts
  // any candidate: it reported that outcome and ended with it, and no candidate pid was ever
  // reported. Nothing ran, so the missing candidate is explained rather than an escape.
  const refusedBeforeCandidate =
    supervisedBudget &&
    !candidateReportSeen &&
    supervisorEndedAsReported(supervisorReport, exit) &&
    exit.code === PROCESS_LIMIT_UNAVAILABLE_EXIT &&
    stderrChunks.join("").includes(`${PROCESS_LIMIT_UNAVAILABLE}:`);
  if (!candidateReportSeen) {
    // A missing candidate report normally means a self-detaching process got away before we
    // could follow it. It means something different when *we* killed the wrapper: a command
    // stopped for exceeding its memory budget or its CPU time never reaches the point where
    // it reports a candidate, and calling that an escape reports our own enforcement as a
    // containment failure — which is how a successful memory kill came back as
    // SANDBOX_CHILD_CLEANUP_FAILED with SANDBOX_RESOURCE_LIMIT_EXCEEDED hidden behind it.
    //
    // Containment is still proven, not assumed: the process-group reap immediately below is
    // unchanged and is what would catch anything that actually survived.
    if (!killedByOurOwnLimit && !refusedBeforeCandidate) {
      markContainmentLost(
        "candidate identity was not observed; an orphaned self-detaching process could not be followed",
      );
    }
    settleCandidateObservation();
  }
  await candidateObservation;
  const observedCandidate = candidateIdentity as ProcessIdentity | null;
  if (observedCandidate) {
    if (!(await reapKnownProcess(observedCandidate))) {
      markContainmentLost(`candidate pid ${observedCandidate.pid} survived wrapper cleanup`);
    }
  } else if (!childContainmentReason && !killedByOurOwnLimit && !refusedBeforeCandidate) {
    markContainmentLost("candidate identity was not captured, so containment could not be proved");
  }
  // Under the budget the supervisor is the only process that knows the candidate's descendants,
  // so a supervisor that did not end with one of its own reported outcomes -- one the candidate
  // killed, or one that crashed -- may have left tracked descendants running. Nothing here can
  // reach them; containment is unproven and the run cannot pass. (Under no-spawn the candidate is
  // the only process there can be, and it is reaped by identity above.)
  if (supervisedBudget && observedCandidate !== null && !supervisorEndedAsReported(supervisorReport, exit)) {
    markContainmentLost(
      "the supervisor did not end with one of its own reported outcomes, so the candidate's descendants were not proven stopped",
    );
  }
  // A process still in the launched group once its leader has exited outlived the command. It is
  // reaped, and the command does not pass: its exit status cannot speak for a process still running.
  let groupOutlivedLeader = false;
  if (!(await processGroupReaped(child.pid, identity?.startedAt ?? null))) {
    // A normal command can exit while a same-group background child remains. Reap that
    // group before returning; merely recording isolationLost would leave the child running.
    groupOutlivedLeader = true;
    const reaped = await reapProcessGroup(child.pid, identity);
    if (!reaped) markContainmentLost("the launched process group could not be reaped and verified");
  }
  rmSync(scratch, { recursive: true, force: true });

  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");
  const endedAt = new Date().toISOString();

  const resourceUnavailable = exit.code === 125 && stderr.includes("ACP_RESOURCE_LIMIT_UNAVAILABLE:");
  const childCleanupUnavailable = stderr.includes("ACP_CHILD_CLEANUP_UNAVAILABLE:");
  if (childCleanupUnavailable) {
    childContainmentReason ??= "the trusted resource wrapper reported that candidate cleanup was unavailable";
  }
  // The supervisor's own refusals under the budget, each read with its exit status. All three are
  // nonzero, so each is a FAIL below whatever the reason code says.
  const supervisorReported = (marker: string, code: number): boolean =>
    supervisedBudget && exit.code === code && stderr.includes(`${marker}:`);
  const processBudgetExceeded = supervisorReported(PROCESS_LIMIT_EXCEEDED, PROCESS_LIMIT_EXCEEDED_EXIT);
  const processBudgetUnavailable = refusedBeforeCandidate;
  if (processBudgetUnavailable) {
    childContainmentReason ??= "the supervisor could not read the kernel child list, so it started no candidate and its process budget was not in force";
  }
  const descendantOutlived =
    groupOutlivedLeader ||
    untrackedHolder ||
    supervisorReported(DESCENDANT_OUTLIVED_CANDIDATE, DESCENDANT_OUTLIVED_EXIT);
  const containmentProven =
    !isolationLost && !childCleanupUnavailable && !processBudgetUnavailable && candidateIdentity !== null;
  const resourceExceeded = exit.signal === "SIGXCPU";
  // The RSS sample is the memory evidence. A leader identity is needed only to signal a
  // live group; requiring it here makes a cleanly reaped, fast command impossible to pass.
  const memoryLimitObserved = !resourceUnavailable && !hardMemoryLimit && peakRssMb !== null;
  const memoryEvidenceUnavailable =
    peakRssMb === null || (!hardMemoryLimit && !memoryLimitObserved);
  const status: SandboxOutcome["status"] =
    isolationLost || childCleanupUnavailable || resourceUnavailable || resourceExceeded || memoryLimitExceeded
      ? "ERROR"
      : timedOut
        ? "TIMEOUT"
        : exit.code === 0 && !descendantOutlived
          ? memoryEvidenceUnavailable ? "ERROR" : "PASS"
          : exit.code == null
            ? "ERROR"
            : "FAIL";

  return {
    status,
    exitCode: exit.code,
    signal: exit.signal,
    startedAt,
    endedAt,
    durationMs: Date.now() - startedMs,
    stdout,
    stderr,
    outputDigest: sha256(`${stdout}\u0000${stderr}`),
    outputTruncated: truncated,
    peakRssMb,
    enforcement: {
      worktreeIsolated: true,
      secretsStripped: true,
      networkPolicy: command.network,
      networkEnforced: mechanism === "seatbelt" && command.network === "deny",
      writeConfinement: mechanism === "seatbelt",
      readConfinement: mechanism === "seatbelt" ? "sensitive-paths" : "none",
      processGroupKill: true,
      // A hard address-space limit still needs an RSS sample for auditable peak evidence.
      resourceLimitsEnforced:
        !resourceUnavailable && peakRssMb !== null && (hardMemoryLimit || memoryLimitObserved),
      memoryLimit: resourceUnavailable ? "none" : hardMemoryLimit ? "hard" : memoryLimitObserved ? "observed" : "none",
      processLimit,
      childContainmentEnforced: containmentProven,
      childContainmentReason: containmentProven
        ? null
        : childContainmentReason ?? "candidate containment was not proven",
      mechanism,
    },
    // `isolationLost` is a real escape and stays first — nothing outranks a child that got
    // out. `childCleanupUnavailable` is weaker: it means containment could not be *observed*,
    // which is what happens when a command is killed by its own memory cap fast enough that
    // no candidate identity is ever captured. Reporting that as the headline reason masks the
    // cause with a symptom of it — the run is refused either way, but the operator is told
    // "we could not watch the child" instead of "it exceeded its memory limit". Containment
    // is still recorded as unproven in `enforcement`, so nothing is hidden by this ordering.
    //
    // The demotion is narrow on purpose: only an *exceeded* limit outranks it, because that
    // is the event that explains why the child could not be observed. A descendant that could
    // not be fenced while limits were merely unavailable is still reported as a cleanup
    // failure, which is what it is.
    reasonCode: isolationLost
      ? ReasonCode.SANDBOX_CHILD_CLEANUP_FAILED
      : resourceExceeded || memoryLimitExceeded || processBudgetExceeded
        ? ReasonCode.SANDBOX_RESOURCE_LIMIT_EXCEEDED
        : childCleanupUnavailable
          ? ReasonCode.SANDBOX_CHILD_CLEANUP_FAILED
          : resourceUnavailable || processBudgetUnavailable
            ? ReasonCode.SANDBOX_RESOURCE_LIMIT_UNAVAILABLE
          : exit.code === 0 && memoryEvidenceUnavailable
            ? ReasonCode.SANDBOX_RESOURCE_LIMIT_UNAVAILABLE
          : timedOut
            ? ReasonCode.VERIFICATION_TIMEOUT
          : descendantOutlived
            ? ReasonCode.VERIFICATION_COMMAND_FAILED
            : truncated
              ? ReasonCode.VERIFICATION_OUTPUT_TRUNCATED
              : null,
  };
};

/**
 * The environment is constructed, never inherited. HOME and TMPDIR point into the
 * scratch root so a candidate cannot read ~/.gitconfig, ~/.npmrc, ~/.claude or any
 * other credential store through a tool's normal lookup path.
 */
export const buildSandboxEnvironment = (
  command: VerificationCommand,
  scratch: string,
  extra: Record<string, string> | undefined,
  worktreePath?: string,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    // The fixed system list plus this runtime and, when there is one, the worktree — not
    // `verificationExecutableSearchPath`'s default, which starts from the daemon's own
    // `process.env.PATH`. Resolution may consult the daemon's PATH to decide whether a
    // declared executable is allowlisted; the child must not *inherit* it, or a
    // user-writable directory on the daemon's PATH becomes a directory the candidate can
    // resolve binaries out of. This lane widened it while claiming tighter confinement.
    // It never selects the declared executable: that is exec'd by absolute path
    // (`verificationLaunchArgv`, #1102). It serves only what the command itself looks up.
    PATH: [
      dirname(process.execPath),
      ...(worktreePath ? [worktreePath] : []),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(delimiter),
    HOME: scratch,
    TMPDIR: scratch,
    LANG: "C.UTF-8",
    LC_ALL: "C",
    CI: "true",
    npm_config_cache: join(scratch, "npm-cache"),
    npm_config_update_notifier: "false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };

  for (const name of command.envAllowlist) {
    const accepts = SAFE_COMMAND_ENV.get(name);
    const value = extra?.[name];
    if (!accepts || value === undefined) continue;
    if (looksLikeCredential(value) || !accepts(value)) continue;
    env[name] = value;
  }
  return env;
};

// A harmless name cannot turn an authority-shaped value into sandbox input. The shapes are the shared
// list (core/credential-shapes.ts), found anywhere in the value: a superset of the whole-value
// shapes this filter used to keep for itself.
const looksLikeCredential = (value: string): boolean => hasCredentialShape(value, "text");

/**
 * Named locations a candidate command must never read. Seatbelt retains allow-default
 * reads for dyld and the Node toolchain, so these absolute denies—not HOME redirection
 * alone—protect provider, GitHub, Buzz and Telegram authority stores.
 */
export const sensitiveReadPaths = (extra: readonly string[]): string[] => {
  // A candidate can call os.userInfo().homedir(), which reads the passwd entry rather
  // than HOME. Cover that account home as well as an explicitly configured daemon HOME.
  const homes = [...new Set([homedir(), process.env["HOME"]].filter((home): home is string => Boolean(home)))];
  const homePaths = homes.flatMap((home) => [
    `${home}/.ssh`,
    `${home}/.aws`,
    `${home}/.gnupg`,
    `${home}/.config/gh`,
    `${home}/.config/git/credentials`,
    `${home}/.config/gcloud`,
    `${home}/.claude`,
    `${home}/.codex`,
    `${home}/.buzz`,
    `${home}/.agent-control-plane`,
    `${home}/.npmrc`,
    `${home}/.netrc`,
    `${home}/.gitconfig`,
    `${home}/.git-credentials`,
    `${home}/.docker/config.json`,
    `${home}/Library/Keychains`,
    `${home}/Library/Application Support/Code`,
    `${home}/Library/Application Support/GitHub CLI`,
  ]);
  // seatbelt matches resolved paths, so an unresolved symlinked path (a temp dir under
  // /var/folders, say) would silently match nothing and the deny would be a no-op.
  return [...homePaths, ...extra].filter(Boolean).map(resolveIfPossible);
};

const resolveIfPossible = (path: string): string => {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
};

/**
 * Seatbelt profile.
 *
 * Seatbelt remains allow-default so dyld and the Node toolchain can start. The named
 * sensitive paths above are explicitly denied; §33.3 requires the candidate not to reach
 * provider, GitHub, Buzz or Telegram secrets, and redirecting HOME only defeats *lookup by
 * convention* — an absolute path to the owner's credential store would still have worked.
 */
const seatbeltProfile = (
  command: VerificationCommand,
  worktreePath: string,
  scratch: string,
  denyReadPaths: readonly string[],
): string => {
  const lines = ["(version 1)", "(allow default)"];
  const runtimeExecutable = realpathSync(process.execPath);
  if (command.network === "deny") lines.push("(deny network*)");
  // A deny path below an allowed root would stop the command from reading its own inputs,
  // so that narrow case is omitted. An encompassing deny remains in force; the explicit
  // read allows below carve out only the current worktree and scratch subtree.
  for (const path of sensitiveReadPaths(denyReadPaths)) {
    if (isWithin(worktreePath, path) || isWithin(scratch, path)) continue;
    lines.push(`(deny file-read* (subpath ${quote(path)}))`);
    // Node resolves a module by lstat-ing each ancestor before it opens the file. Keep
    // directory metadata traversal possible for an encompassing deny. Data reads are
    // limited to worktree/scratch subtrees and the one pinned runtime binary below.
    for (const allowedRoot of [worktreePath, scratch, runtimeExecutable]) {
      if (!isWithin(path, allowedRoot)) continue;
      for (const metadataPath of metadataTraversalPaths(path, allowedRoot)) {
        lines.push(`(allow file-read-metadata (literal ${quote(metadataPath)}))`);
      }
    }
  }

  lines.push(
    // A pinned Node can live inside the denied ACP state root. CoreFoundation must
    // inspect its executable path when npm sets process.title; denying the metadata
    // makes CFBundleGetMainBundle return null and older libuv versions segfault.
    // Permit this one binary and ancestor metadata, never sibling file contents.
    `(allow file-read* (literal ${quote(runtimeExecutable)}))`,
    `(allow file-read* (subpath ${quote(worktreePath)}))`,
    `(allow file-read* (subpath ${quote(scratch)}))`,
    "(deny file-write*)",
    `(allow file-write* (subpath ${quote(worktreePath)}))`,
    `(allow file-write* (subpath ${quote(scratch)}))`,
    "(allow file-write* (subpath \"/dev\"))",
    "(allow file-write-data (literal \"/dev/null\"))",
  );
  return lines.join("\n");
};

/** Exact directory metadata needed to traverse from an encompassing deny to an allowed root. */
const metadataTraversalPaths = (enclosingPath: string, allowedRoot: string): string[] => {
  const paths = [enclosingPath];
  let cursor = dirname(allowedRoot);
  while (cursor !== enclosingPath && isWithin(enclosingPath, cursor)) {
    paths.push(cursor);
    cursor = dirname(cursor);
  }
  return [...new Set(paths)];
};

/** Shared shape for a command that was refused rather than run unconfined. */
const unconfined = (
  command: VerificationCommand,
  startedMs: number,
  startedAt: string,
  mechanism: SandboxEnforcement["mechanism"],
  reason: string,
): SandboxOutcome => refused(
  command,
  startedMs,
  startedAt,
  mechanism,
  ReasonCode.SANDBOX_NETWORK_DENIED,
  reason,
);

const refused = (
  command: VerificationCommand,
  startedMs: number,
  startedAt: string,
  mechanism: SandboxEnforcement["mechanism"],
  reasonCode: ReasonCode,
  reason: string,
): SandboxOutcome => ({
  status: "ERROR",
  exitCode: null,
  signal: null,
  startedAt,
  endedAt: new Date().toISOString(),
  durationMs: Date.now() - startedMs,
  stdout: "",
  stderr: reason,
  outputDigest: sha256(""),
  outputTruncated: false,
  peakRssMb: null,
  enforcement: {
    worktreeIsolated: true,
    secretsStripped: true,
    networkPolicy: command.network,
    networkEnforced: false,
    writeConfinement: false,
    readConfinement: "none",
    processGroupKill: true,
    resourceLimitsEnforced: false,
    memoryLimit: "none",
    childContainmentEnforced: false,
    childContainmentReason: "candidate was refused before a sandbox process was launched",
    mechanism,
  },
  reasonCode,
});

const quote = (value: string): string => `"${value.replace(/(["\\])/g, "\\$1")}"`;

interface ProcessIdentity {
  pid: number;
  startedAt: string;
}

const processIdentity = async (pid: number | undefined): Promise<ProcessIdentity | null> => {
  if (!pid) return null;
  try {
    const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: PROCESS_PROBE_TIMEOUT_MS,
    });
    const startedAt = stdout.trim();
    return startedAt ? { pid, startedAt } : null;
  } catch {
    return null;
  }
};

/** Signals only the process group whose leader still has the identity we observed. */
const killKnownGroup = async (
  identity: ProcessIdentity | null,
  signal: NodeJS.Signals,
): Promise<boolean> => {
  if (!identity) return false;
  const current = await processIdentity(identity.pid);
  // A leader that is already gone — exited on its own, or killed by the very limit this
  // cleanup is enforcing — is the outcome cleanup exists to produce, not a failure to
  // contain. A recycled pid means the same thing: our target no longer exists, and
  // signalling it would hit an unrelated process. `signalKnownProcess` already treats both
  // as success; this returning false is why a memory breach on a loaded machine reported
  // SANDBOX_CHILD_CLEANUP_FAILED and hid SANDBOX_RESOURCE_LIMIT_EXCEEDED behind it.
  if (!current || current.startedAt !== identity.startedAt) return true;
  try {
    process.kill(-identity.pid, signal);
    return true;
  } catch (error) {
    // ESRCH is the same "already gone" answer, arriving as an exception.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};

/** Signals one observed candidate pid without relying on its mutable process group. */
const signalKnownProcess = async (
  identity: ProcessIdentity,
  signal: NodeJS.Signals,
): Promise<boolean> => {
  const current = await processIdentity(identity.pid);
  if (!current) {
    // A group signal may have reaped the candidate in the race between the two cleanup
    // operations. That is success; only an independently live pid means the direct signal
    // was not proven.
    try {
      process.kill(identity.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
  if (current.startedAt !== identity.startedAt) return true;
  try {
    process.kill(identity.pid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};

/** Kill and verify a candidate that may have orphaned itself from the launcher's group. */
const reapKnownProcess = async (identity: ProcessIdentity): Promise<boolean> => {
  const current = await processIdentity(identity.pid);
  if (!current || current.startedAt !== identity.startedAt) return true;
  try {
    process.kill(identity.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const remaining = await processIdentity(identity.pid);
    if (!remaining || remaining.startedAt !== identity.startedAt) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return false;
};

const processGroupMembers = async (pid: number | undefined): Promise<number[] | null> => {
  if (!pid) return null;
  try {
    const { stdout } = await exec("ps", ["-o", "pid=", "-g", String(pid)], {
      encoding: "utf8",
      timeout: PROCESS_PROBE_TIMEOUT_MS,
    });
    return stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((value) => Number.isFinite(value));
  } catch (err) {
    const failure = err as { code?: number; stdout?: string };
    if (failure.code === 1 && (failure.stdout ?? "").trim().length === 0) return [];
    return null;
  }
};

/** Kill and verify a launched group that survived its leader's normal exit. */
const reapProcessGroup = async (
  pid: number | undefined,
  identity: ProcessIdentity | null,
): Promise<boolean> => {
  if (!pid || !identity) return false;
  const members = await processGroupMembers(pid);
  if (members === null || members.length === 0) return members !== null;

  const currentLeader = await processIdentity(pid);
  if (currentLeader && currentLeader.startedAt !== identity.startedAt) return false;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") return false;
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const remaining = await processGroupMembers(pid);
    if (remaining === null) return false;
    if (remaining.length === 0) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return false;
};

/**
 * A close event alone is not enough: an unreaped process group makes PASS impossible.
 *
 * The group is named by its leader's pid, and `startedAt` fences a reused pid — while the
 * leader is still the process we launched, the group is by definition not reaped. A leader
 * we never managed to snapshot is *not* evidence of a leak: a command that exits in
 * milliseconds is gone before `ps` can describe it, so the group listing is the evidence.
 *
 * `ps -g` exits 1 with no output when nothing matches, which is exactly the answer "this
 * group is empty". Any other failure leaves containment unproven, and CP-HI-08 makes that
 * a refusal rather than an assumption.
 */
const processGroupReaped = async (
  pid: number | undefined,
  startedAt: string | null,
): Promise<boolean> => {
  if (!pid) return false;
  if (startedAt !== null) {
    const current = await processIdentity(pid);
    if (current && current.startedAt === startedAt) return false;
  }
  try {
    const { stdout } = await exec("ps", ["-o", "pid=", "-g", String(pid)], {
      encoding: "utf8",
      timeout: PROCESS_PROBE_TIMEOUT_MS,
    });
    return stdout.trim().length === 0;
  } catch (err) {
    const failure = err as { code?: number; stdout?: string };
    return failure.code === 1 && (failure.stdout ?? "").trim().length === 0;
  }
};

/** Summed resident set size of the entire candidate process group, in MB. */
const groupRssMb = async (pid: number | undefined): Promise<number | null> => {
  if (!pid) return null;
  try {
    const { stdout } = await exec("ps", ["-o", "rss=", "-g", String(pid)], {
      encoding: "utf8",
      timeout: PROCESS_PROBE_TIMEOUT_MS,
    });
    const rssPages = stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((value) => Number.isFinite(value));
    if (rssPages.length === 0) return null;
    return rssPages.reduce((total, value) => total + value, 0) / 1024;
  } catch {
    return null;
  }
};

type TargetResolution =
  | { allowed: true; worktree: string; cwd: string }
  | { allowed: false; reasonCode: ReasonCode; reason: string };

/** Canonical path checks stop committed symlinks from retargeting a verification command. */
const resolveCommandTargets = (
  command: VerificationCommand,
  worktreePath: string,
): TargetResolution => {
  try {
    const worktree = realpathSync(worktreePath);
    const cwd = realpathSync(resolve(worktree, command.cwd));
    if (!isWithin(worktree, cwd)) {
      return {
        allowed: false,
        reasonCode: ReasonCode.SANDBOX_PATH_OUTSIDE_WORKTREE,
        reason: "verification cwd resolves outside the disposable worktree",
      };
    }

    for (const [index, arg] of command.argv.entries()) {
      // argv[0] has already been resolved against the executable allowlist and its
      // permitted roots. It is allowed to be an absolute toolchain path; all other
      // explicit paths remain confined to the disposable worktree.
      if (index === 0) continue;
      const explicitPath = isAbsolute(arg) || arg.startsWith("./") || arg.startsWith("../");
      const localTarget = !arg.startsWith("-") && existsSync(resolve(cwd, arg));
      if (!explicitPath && !localTarget) continue;
      const target = realpathSync(isAbsolute(arg) ? arg : resolve(cwd, arg));
      if (!isWithin(worktree, target)) {
        return {
          allowed: false,
          reasonCode: ReasonCode.SANDBOX_PATH_OUTSIDE_WORKTREE,
          reason: `verification target '${arg}' resolves outside the disposable worktree`,
        };
      }
    }
    return { allowed: true, worktree, cwd };
  } catch (error) {
    return {
      allowed: false,
      reasonCode: ReasonCode.SANDBOX_PATH_OUTSIDE_WORKTREE,
      reason: `unable to resolve verification target: ${(error as Error).message}`,
    };
  }
};

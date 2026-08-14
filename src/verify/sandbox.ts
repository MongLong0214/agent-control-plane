import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "../core/digest.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  isVerificationCommandRefused,
  verificationExecutableRefusalMessage,
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
}

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
// A harmless name cannot turn an authority-shaped value into sandbox input.
const CREDENTIAL_VALUE_SHAPES: readonly RegExp[] = [
  /^gh[pousr]_[A-Za-z0-9]{16,}$/,
  /^sk-[A-Za-z0-9_-]{20,}$/,
  /^nsec1[a-z0-9]{20,}$/,
  /^xox[baprs]-/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^[A-Za-z0-9+/]{60,}={0,2}$/,
];
const RESOURCE_WRAPPER = "/usr/bin/python3";

// Production always enforces the process-count limit. The only supported way to turn it
// off is the scoped test seam below, which lets the descendant-fencing proof create the
// child that RLIMIT_NPROC normally prevents.
let enforceProcessCountLimit = true;

/*
 * The wrapper is trusted control-plane code. It lowers both soft and hard limits before
 * handing control to candidate code, so candidate code cannot raise them again. The
 * process-group cleanup below is the containment control, not argv inspection. The
 * process-count limit is applied in the forked candidate child: the supervisor must be
 * allowed to fork that child, while the candidate and every descendant must receive the
 * hard refusal when they try to fork again.
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
import ctypes, os, resource, signal, struct, sys, time

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
except Exception as error:
    print("ACP_RESOURCE_LIMIT_UNAVAILABLE:" + str(error), file=sys.stderr)
    sys.exit(125)

try:
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
    libproc.proc_listchildpids.argtypes = [ctypes.c_int32, ctypes.c_void_p, ctypes.c_int]
    libproc.proc_listchildpids.restype = ctypes.c_int
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

def fence_descendants(root_pid):
    known = {}
    scan_available = True

    def scan_tree():
        nonlocal scan_available
        scanned = set()
        pending = [root_pid] + list(known)
        while pending:
            parent = pending.pop()
            if parent in scanned:
                continue
            if parent != root_pid and not is_alive(parent):
                scanned.add(parent)
                continue
            children = child_pids(parent)
            if children is None:
                scan_available = False
                return
            scanned.add(parent)
            for pid in children:
                if pid in known or pid in (os.getpid(), root_pid):
                    continue
                try:
                    known[pid] = os.getpgid(pid)
                except OSError:
                    continue
                pending.append(pid)

    while True:
        scan_tree()
        waited, status = os.waitpid(root_pid, os.WNOHANG)
        if waited == root_pid:
            break
        time.sleep(0.001)

    # The candidate can exit just as it creates a detached child. Give the kernel child
    # list a few more turns before the child is reparented out of the candidate tree.
    for _ in range(20):
        scan_tree()
        time.sleep(0.001)

    if not scan_available:
        return False, status

    for pid, pgid in known.items():
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
        if not any(is_alive(pid) for pid in known):
            return True, status
        time.sleep(0.025)
    return False, status

def report_candidate(pid):
    try:
        report_path = os.path.join(os.environ["TMPDIR"], "acp-candidate.pid")
        with open(report_path, "x", encoding="ascii") as report:
            report.write(str(pid) + "\n")
        return True
    except OSError:
        return False

candidate_pid = os.fork()
if candidate_pid == 0:
    try:
        if int(sys.argv[3]) == 1:
            hard_limit(resource.RLIMIT_NPROC, 1)
    except Exception as error:
        print("ACP_RESOURCE_LIMIT_UNAVAILABLE:" + str(error), file=sys.stderr)
        os._exit(125)
    # The outer supervisor must record this exact pid before candidate code can exec.
    # A candidate cannot skip this stop without first becoming a different process.
    os.kill(os.getpid(), signal.SIGSTOP)
    os.execvpe(sys.argv[4], sys.argv[4:], os.environ)

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
    sys.exit(126)

reaped, candidate_status = fence_descendants(candidate_pid)
if not reaped:
    print("ACP_CHILD_CLEANUP_UNAVAILABLE: descendant process remained", file=sys.stderr)
    sys.exit(126)
if os.WIFEXITED(candidate_status):
    sys.exit(os.WEXITSTATUS(candidate_status))
if os.WIFSIGNALED(candidate_status):
    os.kill(os.getpid(), os.WTERMSIG(candidate_status))
    sys.exit(128 + os.WTERMSIG(candidate_status))
sys.exit(125)
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

/** Test-only scope for the independent descendant-fencing regression. */
export const __testing = Object.freeze({
  withProcessCountLimitDisabled: async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = enforceProcessCountLimit;
    enforceProcessCountLimit = false;
    try {
      return await operation();
    } finally {
      enforceProcessCountLimit = previous;
    }
  },
});

const hardAddressSpaceAvailable = (): boolean => memoryLimitForPlatform() === "hard";

const RSS_SAMPLE_INTERVAL_MS = 100;

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
  const scratch = mkdtempSync(join(tmpdir(), "acp-sbx-"));

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
  const resourceArgs = [
    "-c",
    RESOURCE_WRAPPER_PROGRAM,
    String(command.maxCpuSeconds ?? command.timeoutSeconds),
    String(hardMemoryLimit ? command.maxMemoryMb * 1024 * 1024 : 0),
    enforceProcessCountLimit ? "1" : "0",
    ...command.argv,
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
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.on("error", () => resolveExit({ code: null, signal: null }));
      child.on("close", (code, signal) => resolveExit({ code, signal }));
    },
  );
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

  const killKnownTargets = async (signal: NodeJS.Signals): Promise<boolean> => {
    const candidateKilled = candidateIdentity
      ? await signalKnownProcess(candidateIdentity, signal)
      : true;
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
  clearInterval(memoryPoll);
  clearInterval(candidatePoll);
  if (inFlightRssSample) await inFlightRssSample;
  // A command we stopped ourselves never reaches the point where it reports a candidate, so
  // its absence is explained by the kill rather than by an escape. Both branches below have
  // to know that: exempting only the first left `childContainmentReason` unset, which made
  // the second one fire instead and report the same false conclusion by a different name.
  const killedByOurOwnLimit = memoryLimitExceeded || timedOut || exit.signal === "SIGXCPU";
  await observeCandidate();
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
    if (!killedByOurOwnLimit) {
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
  } else if (!childContainmentReason && !killedByOurOwnLimit) {
    markContainmentLost("candidate identity was not captured, so containment could not be proved");
  }
  if (!(await processGroupReaped(child.pid, identity?.startedAt ?? null))) {
    // A normal command can exit while a same-group background child remains. Reap that
    // group before returning; merely recording isolationLost would leave the child running.
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
        : exit.code === 0
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
      childContainmentEnforced: !isolationLost && !childCleanupUnavailable && candidateIdentity !== null,
      childContainmentReason:
        !isolationLost && !childCleanupUnavailable && candidateIdentity !== null
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
      : resourceExceeded || memoryLimitExceeded
        ? ReasonCode.SANDBOX_RESOURCE_LIMIT_EXCEEDED
        : childCleanupUnavailable
          ? ReasonCode.SANDBOX_CHILD_CLEANUP_FAILED
          : resourceUnavailable
            ? ReasonCode.SANDBOX_RESOURCE_LIMIT_UNAVAILABLE
          : exit.code === 0 && memoryEvidenceUnavailable
            ? ReasonCode.SANDBOX_RESOURCE_LIMIT_UNAVAILABLE
          : timedOut
            ? ReasonCode.VERIFICATION_TIMEOUT
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

const looksLikeCredential = (value: string): boolean =>
  CREDENTIAL_VALUE_SHAPES.some((pattern) => pattern.test(value.trim()));

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
  if (command.network === "deny") lines.push("(deny network*)");
  // A deny path below an allowed root would stop the command from reading its own inputs,
  // so that narrow case is omitted. An encompassing deny remains in force; the explicit
  // read allows below carve out only the current worktree and scratch subtree.
  for (const path of sensitiveReadPaths(denyReadPaths)) {
    if (isWithin(worktreePath, path) || isWithin(scratch, path)) continue;
    lines.push(`(deny file-read* (subpath ${quote(path)}))`);
    // Node resolves a module by lstat-ing each ancestor before it opens the file. Keep
    // directory metadata traversal possible for an encompassing deny, but grant data
    // reads only through the explicit worktree/scratch subpath rules below.
    for (const allowedRoot of [worktreePath, scratch]) {
      if (!isWithin(path, allowedRoot)) continue;
      for (const metadataPath of metadataTraversalPaths(path, allowedRoot)) {
        lines.push(`(allow file-read-metadata (literal ${quote(metadataPath)}))`);
      }
    }
  }

  lines.push(
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
    const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
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
    const { stdout } = await exec("ps", ["-o", "pid=", "-g", String(pid)], { encoding: "utf8" });
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
    const { stdout } = await exec("ps", ["-o", "pid=", "-g", String(pid)], { encoding: "utf8" });
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
    const { stdout } = await exec("ps", ["-o", "rss=", "-g", String(pid)], { encoding: "utf8" });
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

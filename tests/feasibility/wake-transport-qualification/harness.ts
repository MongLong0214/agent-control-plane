/**
 * U6 wake-transport qualification: does the *production* wake frame, written to a running
 * Claude Code session's unix-domain-socket inbox, reach that session's real model input and
 * start a turn -- on the build this deployment actually runs?
 *
 * This is the C0 feasibility measurement re-run as a qualification, and it differs from
 * `../native-session-inbox/harness.ts` in three ways that were each a gap rather than a
 * preference:
 *
 *  1. **It measures an interactive invocation.** C0 measured `--print --input-format
 *     stream-json`. `isInteractiveClaudeInvocation` (src/registry/canonical-self-claim.ts)
 *     refuses exactly `-p`, `--print`, `--output-format` and `--input-format`, so the process
 *     that is allowed to hold the canonical claim is precisely the shape C0 never measured. A
 *     qualification of the headless shape is a qualification of a process that could not be
 *     the CTO. Both shapes are measured here; the interactive one is the load-bearing row.
 *
 *  2. **It sends `ROLE_WAKE_FRAME` itself**, imported from the module the pin lives in, rather
 *     than a constant of its own that merely looks like it. A harness with its own frame
 *     constant can go green while production sends different bytes.
 *
 *  3. **It preserves the raw capture.** C0 removed its temp root on exit, so the run left no
 *     artefact and the pinned version rested on a memory of a measurement. Every run here
 *     copies the provider capture and the session log out of the temp root before that root is
 *     removed, into `evidence/local/` under this repository, and `writeReceipt` ties them to
 *     the exact command, binary digest, CLI version and host that produced them.
 *
 * What the isolation buys is unchanged and still bounded. `ANTHROPIC_BASE_URL` points model
 * traffic at a loopback fake and the credential is a dummy in a temp `HOME`, so no real-account
 * inference is possible; that is a claim about provider traffic, not a network namespace.
 *
 * The acceptance criterion is C0's and not a weaker one: the wake must appear in a request body
 * the CLI sent to be inferred on, *and* it must have caused a request that would not otherwise
 * have happened. A row that only proved the bytes reached the socket would pass while the
 * runtime dropped them on the floor.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { arch, homedir, platform, release } from "node:os";
import { delimiter, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { startFakeAnthropic, type FakeAnthropic } from "../native-session-inbox/fake-anthropic.ts";
import { ROLE_WAKE_FRAME, ROLE_WAKE_TOKEN } from "../../../src/mcp/role-conversation.ts";

/** The repository this harness writes its durable artefacts under. Never anywhere else. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Where a *qualification* run leaves its raw capture — the directory `rawCapturePath` names in the
 * committed receipt. Git-ignored, so it survives the run without being a claim.
 *
 * Only `qualify()` may write here. An ordinary `pnpm test` runs the same probe and used to write
 * to this same directory, which meant the receipt's pointers stopped being evidence the moment
 * anyone ran the suite: a reader following one got a capture from a different run, with nothing
 * saying so (#837). The receipt's own summary numbers were never affected — they are values in
 * committed JSON — but a pointer that claims more durability than it has is worse than no pointer.
 */
export const RAW_CAPTURE_DIR = "evidence/local/u6-wake-transport-qualification";

/**
 * Where the *suite's* probe leaves its capture. Deliberately a directory no receipt ever names.
 *
 * Separate constant rather than a temp dir, because the capture is still worth keeping after a
 * failing test run — it is the whole diagnostic — and because a name beside the qualification
 * one makes the split visible to whoever reads either.
 */
export const SUITE_CAPTURE_DIR = "evidence/local/u6-wake-transport-probe";

/** The committed receipt this qualification produces, and the one the pin row reads back. */
export const RECEIPT_PATH = "evidence/u6-wake-transport-qualification.json";

/** This harness's own name in the receipt, so a reader knows which instrument took the reading. */
export const QUALIFICATION_ID = "acp.role-wake-transport/u6";

/**
 * A dummy credential, and never a real one: `HOME` and `CLAUDE_CONFIG_DIR` are both redirected
 * into the temp root, so the CLI has no reachable keychain, OAuth store or settings tree, and the
 * only endpoint it can spend this on is the loopback fake.
 */
const DUMMY_API_KEY = "sk-ant-u6-qualification-dummy-not-a-real-credential";

/** A closed port: anything that honours the proxy environment fails at connect. */
const BLACKHOLE_PROXY = "http://127.0.0.1:9";

/** How long a killed child gets to be reaped before the run is failed rather than hung. */
const CHILD_EXIT_GRACE_MS = 10_000;

/**
 * Escape sequences, stripped only to decide when the TUI is ready and to store a readable log.
 *
 * Nothing is *measured* off this text -- the measurement is the provider capture. A terminal
 * rendering is a picture of a screen, and a session that printed the wake and did nothing with it
 * would look identical to one that acted on it.
 */
const ANSI = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

/** The prompt-line hint the interactive client prints once it is accepting keystrokes. */
const TUI_READY = /for shortcuts/;

export type ProbeShape = "interactive" | "headless";

export interface ClaudeImage {
  /** The real file behind whatever `claude` on PATH points at -- never the symlink. */
  readonly path: string;
  readonly sha256: string;
  /** Exactly what `--version` printed, unparsed. */
  readonly versionOutput: string;
  /** The leading token of that output, which is the build number the pin compares. */
  readonly version: string;
}

export interface ProbeRun {
  readonly shape: ProbeShape;
  /** Whether this run wrote `ROLE_WAKE_FRAME` to the session's inbox. False is the control. */
  readonly injected: boolean;
  /** The exact argv, home-redacted, that the client was started with. */
  readonly command: readonly string[];
  /** Model requests seen before the injection point, in both arms. */
  readonly baselineModelRequests: number;
  readonly modelRequests: number;
  readonly wakeCarryingModelRequests: number;
  /** Whether a model request arrived that the baseline had not already produced. */
  readonly followUpAfterInjection: boolean;
  /**
   * The ceiling on the post-injection wait -- not the span either arm was observed for.
   *
   * The control has nothing to stop early for and sleeps the whole ceiling. The injection arm
   * returns the moment it sees the follow-up request it is waiting for, so its observed span is
   * this or less, and the instrument does not record which. Equal values across two arms state an
   * equal maximum window and nothing more; they are not a statement that the arms were watched
   * for the same length of time.
   */
  readonly settleCeilingMs: number;
  /** Repository-relative, and still on disk after this run resolved. */
  readonly rawCapturePath: string;
  readonly rawSessionLogPath: string;
  /**
   * Whether the temp root this run owned is gone, stat'd after teardown rather than asserted
   * from the fact that `rmSync` was called. Assigned in the `finally`, so it is already true
   * of the object by the time the caller has it.
   */
  tempRootRemoved: boolean;
}

export interface QualificationReceipt {
  readonly qualification: string;
  readonly producedAt: string;
  /**
   * `git rev-parse HEAD` at the moment the receipt was built -- when, not what.
   *
   * It is *not* a binding to the instrument. The harness can be, and on 2026-09-07 was, an
   * uncommitted working tree while HEAD pointed at an unrelated commit, so this field can name a
   * tree that contains no harness at all. Whether the source that took a reading is identified is
   * a separate question, and `sourceBinding` is where a receipt answers it.
   */
  readonly headSha: string;

  /**
   * Whether the source that produced this reading is identified, stated rather than assumed.
   *
   * Optional because the instrument does not compute it: a receipt describes one run, and a
   * regenerated file is a different run whose binding has to be established for itself. A digest
   * taken after the fact is evidence of preservation since, never of what executed.
   */
  readonly sourceBinding?: {
    readonly status: "UNKNOWN" | "BOUND";
    readonly [key: string]: unknown;
  };

  /** Custody of the artefacts this receipt points at, and of losses in the same work. */
  readonly evidenceCustody?: { readonly [key: string]: unknown };

  /** Claims corrected after the fact, with what was changed and why. Observations are never here. */
  readonly corrections?: { readonly [key: string]: unknown };
  readonly client: {
    readonly name: string;
    readonly version: string;
    readonly versionOutput: string;
    readonly imagePath: string;
    readonly imageSha256: string;
  };
  readonly host: { readonly platform: string; readonly arch: string; readonly release: string };
  readonly frame: {
    readonly symbol: string;
    readonly token: string;
    readonly utf8: string;
    readonly byteLength: number;
    readonly hex: string;
    readonly sha256: string;
  };
  readonly runs: readonly ProbeRun[];
  readonly verdict: "qualified" | "not-qualified";
  readonly limits: readonly string[];
  readonly findings: readonly { readonly id: string; readonly statement: string; readonly options: readonly string[] }[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(150);
  }
  return predicate();
};

/**
 * Replaces this account's home prefix with `~`.
 *
 * The receipt is committed, so a path under someone's home in it is a username published to
 * every reader of the repository. The digest above is what identifies the binary anyway; the
 * path is orientation, not identity.
 */
export const redactHome = (value: string): string => {
  const home = homedir();
  return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
};

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const onPath = (name: string): string | null => {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

/**
 * Resolves the installed client to the file that actually executes, and digests it.
 *
 * `realpathSync` on purpose: the entry on PATH is a symlink into a versioned directory, and a
 * receipt that recorded the symlink would name a pointer that moves on the next update while
 * claiming to identify a build. `--version` is probed from a scratch cwd with a scratch `HOME`
 * so the probe cannot read or write the operator's real configuration (#795).
 */
export const resolveClaudeImage = (): ClaudeImage | null => {
  const entry = onPath("claude");
  if (entry === null) return null;
  let path: string;
  try {
    path = realpathSync(entry);
  } catch {
    return null;
  }
  const scratch = mkdtempSync("/private/tmp/acp-u6q-ver-");
  try {
    const versionOutput = execFileSync(path, ["--version"], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, CLAUDE_CONFIG_DIR: join(scratch, "cfg") },
    }).trim();
    const version = versionOutput.split(/\s+/)[0] ?? "";
    return { path, sha256: sha256File(path), versionOutput, version };
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/** The interactive arm needs a pty, and the interpreter that allocates one has to be present. */
export const resolvePtyAllocator = (): { readonly python: string; readonly script: string } | null => {
  const python = onPath("python3");
  if (python === null) return null;
  const script = fileURLToPath(new URL("./pty-session.py", import.meta.url));
  return existsSync(script) ? { python, script } : null;
};

/** Why the interactive measurement cannot be taken here, or null when it can. */
export const interactiveBlocker = (): string | null => {
  if (resolveClaudeImage() === null) return "no `claude` on PATH to measure";
  if (resolvePtyAllocator() === null) return "no python3 to allocate a pty for an interactive start";
  return null;
};

const strip = (raw: string): string => raw.replace(ANSI, "").replace(/\r/g, "\n");

/**
 * Writes exactly `ROLE_WAKE_FRAME` to the session inbox and closes.
 *
 * No auth line. macOS authenticates the peer from credentials on the socket itself, and the
 * socket's directory is 0700, so only this uid can reach it -- the token path exists for
 * platforms without that and is deliberately unused and unstored.
 */
const writeWakeFrame = async (socketPath: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(socketPath, () => {
      socket.write(ROLE_WAKE_FRAME);
      socket.end();
    });
    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
};

/**
 * Signals through the `ChildProcess` handle, never `process.kill(pid)`: a pid is reused the moment
 * the kernel reaps it, so a numeric signal sent a tick too late lands on a stranger.
 *
 * SIGTERM before SIGKILL, and that order is load-bearing for the interactive shape. The client
 * there runs on a pty under a relay, in a session of its own, so SIGKILL on the relay leaves the
 * client alive and still writing into the temp root this run is about to remove -- measured once
 * as `ENOTEMPTY` on a directory that had just been emptied. SIGTERM gives the relay the chance to
 * take its child down with it; SIGKILL stays as the bound on a relay that will not.
 */
const terminateChild = async (child: ChildProcessWithoutNullStreams | undefined): Promise<boolean> => {
  if (child === undefined) return true;
  if (child.exitCode !== null || child.signalCode !== null) return true;

  const exited = (withinMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      // `exit` lands on a later tick, so this synchronous re-check and the listener cannot
      // straddle it: either the child is already gone or the listener sees it go.
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), withinMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  // Closing stdin first: the relay treats EOF as "stop reading from the caller", and a client
  // that is watching its own input is told the same way a terminal would tell it.
  try {
    child.stdin.end();
  } catch {
    // A stream already torn down needs no closing, and failing here would mask the signal below.
  }
  child.kill("SIGTERM");
  if (await exited(CHILD_EXIT_GRACE_MS)) return true;
  const reaped = exited(CHILD_EXIT_GRACE_MS);
  child.kill("SIGKILL");
  return reaped;
};

/**
 * Removes the run's own temp root, retrying only the one failure a still-dying client causes.
 *
 * `rmSync` walks and unlinks; a process that writes a new file into a directory between the walk
 * and the rmdir makes that rmdir fail with `ENOTEMPTY`. Bounded and re-thrown at the end, because
 * a root that genuinely cannot be removed is a leak the caller has to hear about.
 */
const removeTempRoot = (root: string): void => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
};

export interface ProbeOptions {
  readonly shape: ProbeShape;
  /** Whether to write the frame. Omit for the control arm, which spends the whole ceiling. */
  readonly inject: boolean;
  /**
   * Ceiling on the post-injection wait. The control spends all of it; the injection arm stops
   * early on its follow-up request. Shared by both arms so the control's window is never the
   * shorter one -- which is the property that makes its absence readable, not equal observation.
   */
  readonly settleCeilingMs?: number;
  /**
   * Which directory this run's durable capture goes in — `RAW_CAPTURE_DIR` for a qualification,
   * `SUITE_CAPTURE_DIR` for the suite.
   *
   * Required, with no default, and that is the point. A default is what let the suite and the
   * qualification write to one directory for as long as both existed; whichever value a default
   * carried, the other caller would be the one silently writing somewhere it did not mean to.
   * Making it a decision at each call site is the guard (#837).
   */
  readonly captureDir: string;
}

/**
 * Runs one disposable session end to end and reports what the fake provider was asked.
 *
 * The two arms differ in exactly one input -- whether the frame is written -- so a difference
 * in the capture is attributable to the frame and to nothing else.
 */
export const runQualificationProbe = async (options: ProbeOptions): Promise<ProbeRun> => {
  const settleCeilingMs = options.settleCeilingMs ?? 20_000;
  const image = resolveClaudeImage();
  if (image === null) throw new Error("no `claude` image on PATH to qualify");

  // Short root on purpose: a unix socket path is capped near 104 bytes, and a deep path fails
  // to bind rather than erroring anywhere legible.
  const root = mkdtempSync("/private/tmp/acp-u6q-");
  chmodSync(root, 0o700);

  const configDir = join(root, "cfg");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const workDir = join(root, "w");
  mkdirSync(workDir, { recursive: true, mode: 0o700 });

  // The runtime refuses to bind unless this directory is owner-only; mkdir honours umask, so
  // the mode is set after the fact rather than trusted from the argument.
  const socketDir = join(root, "s");
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o700);
  const socketPath = join(socketDir, "i.sock");

  const capturePath = join(root, "capture.jsonl");
  writeFileSync(capturePath, "");
  const sessionLogPath = join(root, "session.log");

  const settingsPath = join(root, "settings.json");
  // One key. A disposable session opting in to peer delivery, and nothing else.
  writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: "accept" }));

  // Pre-provisioned answers, not answered dialogs. An interactive start stops on the onboarding,
  // workspace-trust and custom-API-key prompts, and driving those from the harness would be a
  // robot pressing approval dialogs. Writing the answers into a throwaway config before launch
  // grants nothing that was not already true of this temp root: the "credential" being approved
  // is the harness dummy above, and the directory being trusted is an empty one this run made.
  // The headless shape needs none of this and gets it anyway, so the two arms differ only in
  // the flags that decide interactivity.
  const configJson = `${JSON.stringify(
    {
      hasCompletedOnboarding: true,
      theme: "dark",
      customApiKeyResponses: { approved: [DUMMY_API_KEY.trim().slice(-20)], rejected: [] },
      projects: { [workDir]: { hasTrustDialogAccepted: true, allowedTools: [], history: [] } },
    },
    null,
    2,
  )}\n`;
  writeFileSync(join(configDir, ".claude.json"), configJson);
  writeFileSync(join(root, ".claude.json"), configJson);

  let fake: FakeAnthropic | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let terminal = "";
  let stderr = "";
  let failure: unknown;
  let run: ProbeRun | undefined;

  const durableDir = join(REPO_ROOT, options.captureDir, `${options.shape}-${options.inject ? "injection" : "control"}`);
  const durableCapture = join(durableDir, "capture.jsonl");
  const durableLog = join(durableDir, "session.log");

  try {
    fake = await startFakeAnthropic(capturePath);

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      // HOME too, not just CLAUDE_CONFIG_DIR: the OAuth store and the real settings tree live
      // under HOME and an isolated config dir alone does not move them.
      HOME: root,
      TMPDIR: root,
      CLAUDE_CONFIG_DIR: configDir,
      TERM: "xterm-256color",
      ANTHROPIC_BASE_URL: fake.baseUrl,
      ANTHROPIC_API_KEY: DUMMY_API_KEY,
      HTTPS_PROXY: BLACKHOLE_PROXY,
      HTTP_PROXY: BLACKHOLE_PROXY,
      NO_PROXY: "127.0.0.1,localhost",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_BUG_COMMAND: "1",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };

    const shared = [
      "--settings",
      settingsPath,
      // Per-invocation settings and no other source: not the operator's, not a project's.
      "--setting-sources",
      "",
      "--messaging-socket-path",
      socketPath,
      "--model",
      "claude-sonnet-4-5",
    ];
    // The interactive argv carries none of `-p`, `--print`, `--output-format`, `--input-format`,
    // which is exactly the predicate `isInteractiveClaudeInvocation` applies.
    const args =
      options.shape === "interactive"
        ? shared
        : ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...shared];
    const command = [image.path, ...args];

    if (options.shape === "interactive") {
      const pty = resolvePtyAllocator();
      if (pty === null) throw new Error("no python3 to allocate a pty for an interactive start");
      child = spawn(pty.python, [pty.script, ...command], {
        env,
        cwd: workDir,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } else {
      child = spawn(image.path, args, { env, cwd: workDir, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    }
    child.stdout.on("data", (chunk: Buffer) => {
      terminal += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const bound = await waitFor(() => existsSync(socketPath), 60_000);
    if (!bound) throw new Error(`the session inbox never appeared\n${stderr}`);

    const captured = () =>
      readFileSync(capturePath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { url: string; body: string });
    const modelRequests = () => captured().filter((request) => request.url.includes("/v1/messages"));

    // One ordinary turn first, so the run has a baseline that predates the frame. The interactive
    // arm types it; the headless arm writes a stream-json frame and holds stdin open, which is
    // what keeps that session alive after the turn completes.
    if (options.shape === "interactive") {
      const ready = await waitFor(() => TUI_READY.test(strip(terminal)), 60_000);
      if (!ready) throw new Error(`the interactive client never reached its prompt\n${strip(terminal).slice(-2000)}`);
      await sleep(1_500);
      child.stdin.write("ping");
      await sleep(600);
      child.stdin.write(String.fromCharCode(13));
    } else {
      child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: "ping" } })}\n`);
    }

    const baselineSeen = await waitFor(() => modelRequests().length > 0, 120_000);
    if (!baselineSeen) throw new Error(`no baseline model request reached the fake endpoint\n${stderr}`);
    const baselineModelRequests = modelRequests().length;

    if (options.inject) {
      await writeWakeFrame(socketPath);
      // Returns as soon as the follow-up appears, so this arm's observed span is at most the
      // ceiling and in practice less. The ceiling is what the two arms share; the observed span
      // is not, and nothing here records it.
      await waitFor(() => modelRequests().length > baselineModelRequests, settleCeilingMs);
    } else {
      // The control has nothing to stop early for, so it spends the whole ceiling. That makes its
      // window an upper bound on the injection arm's: an absence measured over a window no shorter
      // than the presence cannot be explained away as having looked for less time. It does not
      // make the two observations equal in length, and no row should say that it does.
      await sleep(settleCeilingMs);
    }

    const final = modelRequests();
    mkdirSync(durableDir, { recursive: true });
    copyFileSync(capturePath, durableCapture);
    writeFileSync(sessionLogPath, `${strip(terminal)}\n--- stderr ---\n${stderr}`);
    copyFileSync(sessionLogPath, durableLog);

    return (run = {
      shape: options.shape,
      injected: options.inject,
      command: command.map(redactHome),
      baselineModelRequests,
      modelRequests: final.length,
      wakeCarryingModelRequests: final.filter((request) => request.body.includes(ROLE_WAKE_TOKEN)).length,
      followUpAfterInjection: final.length > baselineModelRequests,
      settleCeilingMs,
      rawCapturePath: relative(REPO_ROOT, durableCapture),
      rawSessionLogPath: relative(REPO_ROOT, durableLog),
      // Filled in by the `finally` below, which runs before this promise settles.
      tempRootRemoved: false,
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Order is load-bearing. The child goes first and is waited for -- a live one recreates the
    // socket under a root about to be removed. The server owns the capture file inside that
    // root, so it closes next. Only then is the root gone, and by then the capture has already
    // been copied out to the durable directory, which is the whole point of this harness.
    const reaped = await terminateChild(child);
    await fake?.close();
    removeTempRoot(root);
    if (run) run.tempRootRemoved = !existsSync(root);
    if (!reaped && failure === undefined) {
      throw new Error(`the qualification child did not exit within ${CHILD_EXIT_GRACE_MS}ms`);
    }
  }
};

/** Whether one arm met the acceptance criterion it was run for. */
export const armPassed = (run: ProbeRun): boolean =>
  run.injected
    ? run.wakeCarryingModelRequests > 0 && run.followUpAfterInjection
    : run.wakeCarryingModelRequests === 0 && !run.followUpAfterInjection;

/**
 * Ties every run to the one command, image, build and host that produced it, and writes it where
 * a later reader can check the pin against something other than a memory.
 *
 * The verdict is computed from the runs rather than passed in: a receipt whose verdict a caller
 * could set would be a place to record a conclusion, and this file exists because a conclusion
 * without a reading is what the pin already had.
 */
export const buildReceipt = (input: {
  readonly image: ClaudeImage;
  readonly headSha: string;
  readonly runs: readonly ProbeRun[];
  readonly limits: readonly string[];
  readonly findings: QualificationReceipt["findings"];
}): QualificationReceipt => {
  const frameBytes = Buffer.from(ROLE_WAKE_FRAME, "utf8");
  const interactive = input.runs.filter((run) => run.shape === "interactive");
  const qualified =
    input.runs.length > 0 &&
    interactive.some((run) => run.injected) &&
    interactive.some((run) => !run.injected) &&
    input.runs.every(armPassed);
  return {
    qualification: QUALIFICATION_ID,
    producedAt: new Date().toISOString(),
    headSha: input.headSha,
    client: {
      name: "claude-code",
      version: input.image.version,
      versionOutput: input.image.versionOutput,
      imagePath: redactHome(input.image.path),
      imageSha256: input.image.sha256,
    },
    host: { platform: platform(), arch: arch(), release: release() },
    frame: {
      symbol: "ROLE_WAKE_FRAME (src/mcp/role-conversation.ts)",
      token: ROLE_WAKE_TOKEN,
      utf8: ROLE_WAKE_FRAME,
      byteLength: frameBytes.byteLength,
      hex: frameBytes.toString("hex"),
      sha256: createHash("sha256").update(frameBytes).digest("hex"),
    },
    runs: input.runs,
    verdict: qualified ? "qualified" : "not-qualified",
    limits: input.limits,
    findings: input.findings,
  };
};

export const writeReceipt = (receipt: QualificationReceipt, repoRelativePath: string): string => {
  const path = join(REPO_ROOT, repoRelativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return path;
};

export const readReceipt = (repoRelativePath: string): QualificationReceipt | null => {
  const path = join(REPO_ROOT, repoRelativePath);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as QualificationReceipt;
};

/**
 * What this qualification does not establish, recorded next to what it does.
 *
 * A receipt that listed only its positive findings would be read as a broader guarantee than the
 * run supports, and the pin's whole problem was a conclusion travelling without its reading.
 */
const LIMITS: readonly string[] = [
  "One host and one arch. The receipt records which; it says nothing about any other.",
  "Provider isolation is an ANTHROPIC_BASE_URL override plus a dummy credential, not a network namespace. It bounds where inference went, not everything the process could do.",
  "The runtime does not hand the token to the model bare: it renders it inside a peer-message preamble of its own before it reaches model input. What is qualified is that the token arrives and starts a turn, not that it arrives unadorned. The preserved capture shows the surrounding text.",
  "The endpoint-directory policy is untouched by this slice, so registration through registerEndpoint is still refused for a socket outside the daemon state directory. See the finding of that name.",
  "Interactive start required pre-provisioned answers to the onboarding, workspace-trust and custom-API-key prompts in a throwaway config. A session whose operator answered them differently is outside this reading.",
  "settleCeilingMs is a ceiling on the post-injection wait, not a duration either arm was observed for. The control spends the whole ceiling; the injection arm returns on its first follow-up request. Two arms sharing a ceiling were watched for at most the same time, not for the same time, and the actual spans are not recorded here.",
  "This file does not identify the instrument that produced it. headSha is git rev-parse HEAD at receipt-build time, which can name a tree that contains no harness -- the harness may be uncommitted while the reading is taken. Unless a sourceBinding block below says otherwise, the source of this reading is UNKNOWN, and a digest computed after the fact would attest preservation since, not what executed.",
];

/**
 * Findings this slice is required to report rather than act on.
 *
 * Written into the receipt because that is the artefact that outlives the run; a finding recorded
 * only in a hand-off message is one that has to be remembered rather than read.
 */
const FINDINGS: QualificationReceipt["findings"] = [
  {
    id: "endpoint-directory-policy",
    statement:
      "registerEndpoint requires dirname(endpoint) === endpointDir, and the composition root passes the daemon's state directory. A client started the way the deployment starts it binds its inbox at /tmp/cc-socks/<pid>.sock, which is never in that directory, so registration is refused before the version pin is even reached. That policy was a later integration decision rather than a C0 result, so its basis has to be re-argued on its own terms and not folded into this version qualification.",
    options: [
      "Start the client with --messaging-socket-path pointing inside the state directory. This run measured exactly that shape: the interactive client bound where it was told, under a 0700 directory it did not create, and the wake landed. It needs nothing from the daemon and changes no check.",
      "Re-argue what the composition root passes as endpointDir, and pass a directory the client's own default satisfies. That is a change to a security policy and belongs in its own slice with its own reading.",
      "Leave both alone and accept that registration is unreachable in the deployed launch shape, which is the status quo and should be said out loud rather than discovered.",
    ],
  },
  {
    id: "wake-flag-is-not-a-published-interface",
    statement:
      "--messaging-socket-path is accepted by the measured build but does not appear in its --help. That is consistent with what the pin already says about this route -- a version-pinned local runtime contract rather than a supported public interface -- and it is the reason the pin is exact rather than a floor.",
    options: [
      "Keep the pin exact and re-run this qualification on every client bump, which is what the constant's comment already promises.",
    ],
  },
];

/**
 * Takes the whole reading and writes the receipt: both shapes, both arms, one artefact.
 *
 * Lives here rather than in the script that invokes it so that it is inside the typechecked and
 * linted tree; `scripts/` is outside both, and an unchecked producer of the file the pin is
 * verified against would be the weakest link in the chain.
 */
export const qualify = async (): Promise<{ readonly receipt: QualificationReceipt; readonly path: string }> => {
  const image = resolveClaudeImage();
  if (image === null) throw new Error("no `claude` image on PATH to qualify");
  const blocker = interactiveBlocker();
  if (blocker !== null) throw new Error(`cannot take the interactive reading: ${blocker}`);

  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();

  // Serial, not concurrent. Each arm starts a real client that binds a socket and talks to a
  // loopback server; two of them at once would be measuring a machine under a load the deployment
  // never puts it under, and the settle ceilings would no longer bound comparable windows.
  const runs: ProbeRun[] = [];
  for (const shape of ["interactive", "headless"] as const) {
    for (const inject of [true, false]) {
      runs.push(await runQualificationProbe({ shape, inject, captureDir: RAW_CAPTURE_DIR }));
    }
  }

  const receipt = buildReceipt({ image, headSha, runs, limits: LIMITS, findings: FINDINGS });
  return { receipt, path: writeReceipt(receipt, RECEIPT_PATH) };
};

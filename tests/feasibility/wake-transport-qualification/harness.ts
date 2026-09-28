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
 *     removed, into `evidence/local/` under this repository, and `recordReading` ties them to
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
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { arch, homedir, platform, release } from "node:os";
import { basename, delimiter, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { startFakeAnthropic, type FakeAnthropic } from "../native-session-inbox/fake-anthropic.ts";
import { isInteractiveClaudeInvocation } from "../../../src/registry/canonical-self-claim.ts";
import {
  ROLE_WAKE_FRAME,
  ROLE_WAKE_TOKEN,
  type WakeTransportClient,
  isWakeTransportQualified,
} from "../../../src/mcp/role-conversation.ts";

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
 *
 * `qualify()` writes beneath a subdirectory named for the build it measured, the same name its
 * reading gets (`readingFileName` without the extension). With one reading that made no
 * difference; with several, an unscoped directory would let qualifying one build overwrite the
 * captures another build's committed reading points at — #837's stale pointer again, arriving
 * through the qualification rather than the suite. Every committed reading names the scoped paths:
 * the 2.1.268 reading, which predated this and named the unscoped ones, was re-taken on 2026-09-28,
 * and nothing writes to the unscoped paths any more.
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

/**
 * The committed readings, one file per measured build, each named `<name>@<version>.json`.
 *
 * A directory of files rather than one file holding an array, because the question that decides
 * the shape is what qualifying a *second* build may do to the first, and the answer has to be
 * "nothing":
 *
 *   - Qualifying a build opens exactly one path. The other readings are never read, parsed and
 *     rewritten on the way, so a crash mid-write, a malformed neighbour, or two operators each
 *     qualifying a different build cannot lose or reformat a reading nobody meant to touch. In one
 *     array file, "leave the other readings alone" would be a property of a read-modify-write that
 *     has to be correct every time; here it is a property of which file gets written.
 *   - Two branches that each add a build add two files, which merge cleanly. Two appends to one
 *     array meet at the same closing bracket and conflict.
 *   - The 2.1.268 reading moved in as a rename of identical bytes, so the migration restates
 *     nothing about a measurement it did not take.
 *
 * The file name is derived from the reading's own `client` and never chosen, and
 * `qualificationDisagreements` refuses a file whose name disagrees with its content. That is what
 * makes "one reading per build" a fact about the directory rather than a convention: names are
 * unique within it, and a name is a function of the build.
 */
export const RECEIPT_DIR = "evidence/u6-wake-transport-qualification";

/** The client every reading here measures. The instrument resolves a `claude` binary and nothing else. */
export const MEASURED_CLIENT_NAME = "claude-code";

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
 * Escape sequences, deleted to store a readable log and to show a terminal tail when a run fails.
 *
 * Deleted, not applied, so this text is not the screen: it is a picture with the moves left out, and
 * a client that repaints by difference leaves words in it that were never drawn -- 2.1.283's status
 * line reads `shortuts` here and `shortcuts` on a terminal. That is acceptable because nothing in
 * this file decides anything on it. It is the diagnostic a failed arm prints; the measurement is the
 * provider capture, and a session that printed the wake and did nothing with it would look identical
 * to one that acted on it.
 */
const ANSI = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

export type ProbeShape = "interactive" | "headless";

/** The build a reading names: what `buildReceipt` writes into `client`. */
export interface ClaudeImage {
  /**
   * The real file behind the launcher when the image was held -- never the symlink. Orientation,
   * not identity: the updater re-points the launcher and deletes old versions, so this path can name
   * another file, or none, by the time anyone reads it. `sha256` is the identity.
   */
  readonly path: string;
  readonly sha256: string;
  /** Exactly what `--version` printed, unparsed. */
  readonly versionOutput: string;
  /** The leading token of that output, which is the build number the pin compares. */
  readonly version: string;
}

/**
 * One file, held so that the bytes a run digests are the bytes it executes for as long as it runs.
 *
 * The hold is a hard link, made in a directory of the run's own (0700), to the inode the path named
 * at the moment it was taken. A hard link rather than the path itself, because the updater owns the
 * path: it re-points the launcher, renames a new file over a version, and deletes old ones while
 * sessions still run them (measured 2026-09-28: a live session on 2.1.278, its version file gone).
 * None of those reaches a link in a directory nothing else writes -- the inode stays, under a name
 * only this run uses. A hard link rather than a copy, because a copy is a new inode and macOS
 * assesses every new inode from scratch (#817); a link is the inode that has already run.
 *
 * What the hold does not stop is a write into that inode in place, which reaches every name it has.
 * `confirmHeld` is what catches that, and it is why the inode's size and modification time are
 * kept here beside the digest.
 */
export interface HeldImage {
  /** Where the file was found, realpath'd. See `ClaudeImage.path`. */
  readonly path: string;
  /** The hard link. The only name the file is read or executed by once it has been held. */
  readonly executable: string;
  /** The digest of the held inode, read through `executable`. */
  readonly sha256: string;
  readonly inode: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number };
  /** Removes the link and its directory. The file it was found at is never touched. */
  readonly release: () => void;
}

/** A held client image and the version it printed through the same link. */
export interface PinnedClaudeImage extends ClaudeImage, HeldImage {}

export interface ProbeRun {
  readonly shape: ProbeShape;
  /** Whether this run wrote `ROLE_WAKE_FRAME` to the session's inbox. False is the control. */
  readonly injected: boolean;
  /**
   * The exact argv, home-redacted, that the client was started with. Its first element is the held
   * link this arm executed (`HeldImage.executable`), not the path the image was found at, which the
   * receipt keeps as `client.imagePath`. The link is removed with the run.
   */
  readonly command: readonly string[];
  /**
   * The digest of the file this arm executed, read after its measurement through the name it was
   * started by, by `confirmHeld` -- which throws, failing the arm, if that name no longer holds the
   * inode and bytes that were digested before it ran. `buildReceipt` refuses an arm whose digest is
   * not the one the receipt names.
   *
   * Optional in the *type* because a committed reading is parsed JSON and the readings written
   * before this field existed carried no such key. It is not optional in a committed reading:
   * `qualificationDisagreements` refuses one whose arm does not carry it, so absence is a failure
   * rather than a third answer. Every run `runQualificationProbe` returns carries it.
   */
  readonly imageSha256?: string;
  /**
   * What this arm observed, and what every count below is derived from (`ArmObservations`).
   *
   * Optional in the *type* because a committed reading is parsed JSON and the readings written
   * before this field existed carry no such key. It is not optional in a committed reading:
   * `qualificationShortfalls` refuses an arm without it, because without it the four counts are
   * assertions the file makes about itself and there is nothing to check them against.
   */
  readonly observations?: ArmObservations;
  /**
   * Model requests the capture already held when this arm's frame was written -- the turns the
   * follow-up is measured against. Derived from the boundary the arm recorded in `observations`
   * (`InjectionBoundary`), never from which request carries the prompt: that reconstruction counted
   * a wake-carrying turn that *preceded* the frame as the follow-up it caused.
   */
  readonly baselineModelRequests: number;
  readonly modelRequests: number;
  readonly wakeCarryingModelRequests: number;
  /** Whether a model request arrived after the recorded boundary -- after the frame, when one was written. */
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
    /**
     * Which client this reading was taken from. `daemon-binary` and `pinned-launcher` speak for
     * the build this deployment executes; `path` speaks only for whatever the installer last
     * pointed at, which is a different file and moves on its own.
     *
     * Optional because the receipt is written by the operator script and only read back by the
     * suite (`bd2dc5e5`), so every receipt produced before this field existed lacks it. Absent
     * means "not recorded" -- a third answer, not a quiet `path`.
     */
    readonly qualificationSource?: "daemon-binary" | "pinned-launcher" | "path" | null;
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
 * The launcher this deployment actually starts its canonical session through.
 *
 * `~/.agent-control-plane/claude-pinned/claude` is the deployment's own pointer at the qualified
 * build: the canonical session's argv[0] is that path, and `canonical-self-claim.ts` compares a
 * claimant's executing image against a pinned realpath rather than against whatever PATH resolves.
 * PATH is not part of that contract and moves on its own -- the installer re-points it on every
 * release.
 */
const deploymentLauncher = (): string | null => {
  // `ACP_CLAUDE_BINARY` first, because that is what the daemon hands a client it spawns, and
  // `r-wakepin266` records a host where it named a build the pin refused. Measured here on
  // 2026-09-15 the two agree -- the daemon carries
  // `~/.local/share/claude/versions/2.1.268` and `claude-pinned/claude` resolves to the same file
  // -- but agreeing today is not the same fact as being one pointer, and reading only the symlink
  // would answer about the operator-launched session while saying nothing about a daemon-spawned
  // one.
  const configured = process.env["ACP_CLAUDE_BINARY"];
  if (configured !== undefined && configured.length > 0 && existsSync(configured)) return configured;
  const home = process.env["HOME"];
  if (home === undefined || home.length === 0) return null;
  const launcher = join(home, ".agent-control-plane", "claude-pinned", "claude");
  return existsSync(launcher) ? launcher : null;
};

/**
 * Which of the two this harness read. A receipt that does not say cannot be told apart from one
 * taken against a deployment that was not there.
 */
export const qualificationSource = (): "daemon-binary" | "pinned-launcher" | "path" | null => {
  const configured = process.env["ACP_CLAUDE_BINARY"];
  if (configured !== undefined && configured.length > 0 && existsSync(configured)) return "daemon-binary";
  const home = process.env["HOME"];
  if (home !== undefined && home.length > 0
    && existsSync(join(home, ".agent-control-plane", "claude-pinned", "claude"))) {
    return "pinned-launcher";
  }
  return onPath("claude") === null ? null : "path";
};

/**
 * The launcher this harness measures through: the deployment's pinned launcher first, PATH second.
 *
 * Until 2026-09-15 this read PATH alone, and that is a different build from the one the deployment
 * runs: the canonical session starts through `claude-pinned/claude`, while PATH is re-pointed by the
 * installer on every release. On this host the two had drifted three versions apart, so the
 * qualification evidence was measured against a build **nothing in this deployment executes**. The
 * test asserting the two agree was right to fail, and relaxing that assertion would have left the
 * harness pointed at the wrong file.
 *
 * PATH stays as the fallback so a checkout with no deployment beside it can still qualify something.
 * This names an entry and nothing more; `pinClaudeImage` is what turns it into an image.
 */
export const claudeEntry = (): string | null => deploymentLauncher() ?? onPath("claude");

/** Size, modification time and identity of a held inode, read without following a link. */
const inodeOf = (path: string): HeldImage["inode"] => {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
};

const sameInode = (left: HeldImage["inode"], right: HeldImage["inode"]): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;

/**
 * Holds the file `entry` resolves to, and digests it through the hold. See `HeldImage`.
 *
 * The digest is bracketed by two reads of the inode, and a change between them is a refusal: a
 * digest of a file that was being written is a digest of nothing in particular. `parent` is where
 * the hold's directory is made, and a hard link cannot cross a filesystem, so it has to be on the
 * same one as the image -- a refusal otherwise, never a fallback to the path or to a copy.
 */
export const holdImage = (entry: string, parent = "/private/tmp"): HeldImage => {
  const path = realpathSync(entry);
  const directory = mkdtempSync(join(parent, "acp-u6q-img-"));
  const release = (): void => rmSync(directory, { recursive: true, force: true });
  try {
    chmodSync(directory, 0o700);
    const held = join(directory, basename(path));
    linkSync(path, held);
    const inode = inodeOf(held);
    const sha256 = sha256File(held);
    if (!sameInode(inode, inodeOf(held))) throw new Error(`${path} changed while it was being digested`);
    return {
      path,
      // The link and never `path`: every later read and every arm's exec goes through this name.
      executable: held,
      sha256,
      inode,
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
};

/**
 * The digest of a held image, read again through the name the arms execute; a throw, naming what
 * changed, when that name no longer holds the inode and bytes that were digested.
 *
 * This is where "the arms executed what the reading names" is established. The hold rules out
 * everything the updater does to the path; what is left is a write into the held inode itself, and
 * this reads the inode's identity, size and modification time and then its bytes. Each arm calls it
 * after its measurement, and a throw there fails the arm, so no reading is written.
 *
 * What it cannot see: a rewrite in place that is undone, bytes and modification time both, between
 * an arm's exec and this read. Nothing that updates this client does that; something that set out
 * to would have to be running as this user, where it could as easily edit the harness.
 */
export const confirmHeld = (image: HeldImage): string => {
  const now = inodeOf(image.executable);
  if (now.dev !== image.inode.dev || now.ino !== image.inode.ino) {
    throw new Error(`${image.executable} no longer names the inode that was held`);
  }
  if (now.size !== image.inode.size || now.mtimeMs !== image.inode.mtimeMs) {
    throw new Error(`the held image ${image.executable} was rewritten in place after it was digested`);
  }
  const sha256 = sha256File(image.executable);
  if (sha256 !== image.sha256) {
    throw new Error(`the held image ${image.executable} digests to ${sha256}, not the ${image.sha256} it was held at`);
  }
  return sha256;
};

/**
 * Holds the client this harness measures, and asks it its version through the hold.
 *
 * One call per run, and every arm is handed the result: a second resolution is a second chance for
 * the updater to have moved the launcher, and before 2026-09-28 each of the four arms resolved it
 * again, so a reading could name the image of the first resolution while its arms ran another.
 * `--version` is read through the same link and the digest confirmed after it, so the version, the
 * digest and every arm's exec are all of one inode.
 *
 * `--version` is probed from a scratch cwd with a scratch `HOME` so the probe cannot read or write
 * the operator's real configuration (#795).
 */
export const pinClaudeImage = (entry: string | null = claudeEntry(), parent = "/private/tmp"): PinnedClaudeImage => {
  if (entry === null) throw new Error("no `claude` image to qualify: no deployment launcher and none on PATH");
  const held = holdImage(entry, parent);
  const scratch = mkdtempSync(join(parent, "acp-u6q-ver-"));
  try {
    const versionOutput = execFileSync(held.executable, ["--version"], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, CLAUDE_CONFIG_DIR: join(scratch, "cfg") },
    }).trim();
    confirmHeld(held);
    return { ...held, versionOutput, version: versionOutput.split(/\s+/)[0] ?? "" };
  } catch (error) {
    held.release();
    throw error;
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
  if (claudeEntry() === null) return "no `claude` on PATH to measure";
  if (resolvePtyAllocator() === null) return "no python3 to allocate a pty for an interactive start";
  return null;
};

/** The terminal text with the escapes deleted. Diagnosis only; see `ANSI` and `terminalOutput`. */
const strip = (raw: string): string => raw.replace(ANSI, "").replace(/\r/g, "\n");

/**
 * The client's stdout, kept as the bytes that arrived and decoded only when something reads it.
 *
 * **For diagnosis, not for deciding.** It fills the session log a failed arm prints and the file
 * every run copies out beside its capture. Nothing in this file measures anything off it, and
 * nothing may: the measurement is the provider capture.
 *
 * Bytes rather than text per read, because a read ends wherever the pipe was drained and not on a
 * character boundary -- of eleven client starts captured on 2026-09-28, three split a three-byte
 * glyph (`─`, `←`) across two reads, and `chunk.toString()` turns each half into U+FFFD. Those
 * eleven captures are not in the tree: five were committed as `first-screens/` and were deleted
 * with the screen model they were fixtures for, so the reading above is checkable at 972b4736 and
 * nowhere later. A concatenation has no read boundary left to split, so the only mangled glyph
 * possible is one the client had not finished writing.
 *
 * Exported for one row that feeds it a glyph split across two reads. Nothing else may import it:
 * what it returns is not evidence about anything, and a caller that measured off it would be
 * measuring the terminal again.
 */
export const terminalOutput = (): { readonly push: (chunk: Buffer) => void; readonly text: () => string } => {
  const chunks: Buffer[] = [];
  return {
    push: (chunk) => {
      chunks.push(chunk);
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
};

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

/**
 * The prompt the interactive arm is started with, and the one the headless arm sends.
 *
 * The run needs one ordinary turn before the wake frame, so that the frame's effect is a difference
 * against something. The interactive arm gets that turn as a *positional argument* -- `claude
 * [options] [prompt]`, the CLI's own usage -- which is why nothing in this harness types, and why
 * nothing in it has to decide when a client is ready to be typed into. Deciding that meant
 * rendering the client's terminal output, and a renderer is a terminal emulator held to a terminal
 * emulator's accuracy: six false-ready or false-refuse defects were reproduced against it in three
 * review rounds, and being wrong one way types into a client that is not listening while being
 * wrong the other way makes every future build unqualifiable.
 *
 * A word that is none of the CLI's subcommands, so it is parsed as the prompt operand rather than
 * dispatched as a command.
 */
export const BASELINE_PROMPT = "ping";

/**
 * The argv each arm starts the client with, after the executable.
 *
 * Extracted from the probe so that the interactivity claim can be *checked* rather than read off
 * this comment. It is load-bearing: `isInteractiveClaudeInvocation`
 * (src/registry/canonical-self-claim.ts) refuses `-p`, `--print`, `--output-format` and
 * `--input-format`, so the process that is allowed to hold the canonical claim has exactly the
 * interactive shape, and a qualification of any other shape qualifies a process that could not be
 * the holder. A test calls that predicate on what this returns, for both shapes.
 *
 * The prompt is a positional argument, which that predicate is indifferent to -- it refuses flags,
 * and an operand is not a flag. The headless shape keeps all four refused flags, so it doubles as
 * the control showing the predicate can still say no.
 */
export const probeArgv = (
  shape: ProbeShape,
  paths: { readonly settingsPath: string; readonly socketPath: string },
): readonly string[] => {
  const shared = [
    "--settings",
    paths.settingsPath,
    // Per-invocation settings and no other source: not the operator's, not a project's.
    "--setting-sources",
    "",
    "--messaging-socket-path",
    paths.socketPath,
    "--model",
    "claude-sonnet-4-5",
  ];
  return shape === "interactive"
    ? [...shared, BASELINE_PROMPT]
    : ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...shared];
};

/**
 * What one arm executes, as one value: the process that is started, the argv it is started with,
 * and the client invocation the reading records.
 *
 * One value because the two used to be two expressions -- `spawn(image.executable, args)` beside
 * `const command = [image.executable, ...args]` -- and two expressions can disagree. A reading's
 * `command` is the only description of what ran that anybody reads afterwards, so a change that
 * moved one and not the other would produce a reading describing an invocation that never
 * happened, with every number in it still looking like a pass.
 *
 * `executable` and `argv` are what `spawn` is given; `command` is the client invocation. For the
 * headless shape they are the same thing split in two. For the interactive shape the process that
 * is started is the pty allocator, and `command` is the tail of its argv -- so the recorded
 * invocation is literally a slice of what was executed, which is what a test can check.
 */
export interface SpawnPlan {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly command: readonly string[];
}

/**
 * How one arm is started, decided in one place a test can call.
 *
 * The interactive shape needs a pty: the client's interactive mode wants a terminal on stdout, and
 * the allocator is a small python script that gives it one. The allocator is passed in rather than
 * resolved here so a row can ask for both shapes' plans without a python3 on the host.
 *
 * `image` is narrowed to the one field an arm may execute -- the held hard link. The path the
 * launcher resolved to is deliberately not in scope here: it is the thing an arm must not run
 * (`HeldImage`), and the narrowest way to say that is to make it unreachable.
 */
export const spawnPlanFor = (
  shape: ProbeShape,
  image: { readonly executable: string },
  paths: { readonly settingsPath: string; readonly socketPath: string },
  pty: { readonly python: string; readonly script: string } | null,
): SpawnPlan => {
  const command: readonly [string, ...string[]] = [image.executable, ...probeArgv(shape, paths)];
  if (shape !== "interactive") return { executable: command[0], argv: command.slice(1), command };
  if (pty === null) throw new Error("no python3 to allocate a pty for an interactive start");
  return { executable: pty.python, argv: [pty.script, ...command], command };
};

/** The one endpoint a request has to have been sent to for this harness to call it a turn. */
const MESSAGES_ENDPOINT = "/v1/messages";

/**
 * The endpoint a captured request was sent to: its target without the query string.
 *
 * The capture stores the request target as it arrived, and every build measured here sends
 * `/v1/messages?beta=true`, so the endpoint is what precedes the first `?` or `#`.
 */
const requestEndpoint = (url: string): string => url.split(/[?#]/)[0] ?? url;

/** One line of the fake provider's capture: a request as it arrived, before anything judged it. */
interface CapturedRequest {
  /** When the provider received it, from the provider's own clock. */
  readonly at: string;
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

/**
 * Every request the fake provider recorded, whatever it was.
 *
 * The capture is the loopback fake provider's append-only JSONL
 * (`../native-session-inbox/fake-anthropic.ts`): one JSON object per line, every request it
 * received, whatever its method and path.
 */
const capturedRequests = (capture: string): readonly CapturedRequest[] =>
  capture
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CapturedRequest);

/**
 * The captured requests that asked for inference: a POST, to the messages endpoint itself.
 *
 * One definition, used for the baseline, for the follow-up and for the wake count alike, so that
 * "a turn began" means the same thing everywhere in this file. Both conditions are load-bearing
 * and neither is incidental:
 *
 * - **The endpoint is compared, not searched for.** The earlier form was
 *   `url.includes("/v1/messages")`, which also matches `/v1/messages/count_tokens` -- a request
 *   *about* a turn rather than a turn, and one a client can send before it has asked for any
 *   inference at all.
 * - **The method must be POST.** This provider answers a GET to the same path with a 404, so a
 *   non-POST request got no completion and began no turn; counting one would let a request the
 *   client's turn machinery never made stand in for a turn it never took.
 *
 * Neither condition says *which* turn this is -- see `baselineTurnObserved` for that. This is the
 * count the follow-up is read from (`followUpAfterInjection`), so what it admits sets what an
 * "extra request after the frame" can be.
 *
 * No capture taken on this host holds a count-tokens or a non-POST request -- checked across the
 * four arms of each committed reading -- so this changes no number that exists; it stops the
 * filter from meaning something other than its name on the first build that sends one.
 */
const isModelRequest = (request: { readonly method: string; readonly url: string }): boolean =>
  request.method === "POST" && requestEndpoint(request.url) === MESSAGES_ENDPOINT;

export const modelRequestsIn = (capture: string): readonly CapturedRequest[] =>
  capturedRequests(capture).filter(isModelRequest);

/** One piece of text a request asked the model to read, and where in the request it came from. */
export interface ModelInputText {
  /** `system` for the request's system blocks; otherwise the role of the message it arrived in. */
  readonly from: string;
  readonly text: string;
}

/**
 * Every piece of text a request put in front of the model: its system blocks and its messages'
 * text, each labelled with where it came from. Empty for a body that is not a request of that
 * shape.
 *
 * This is the whole of what "the model was asked this" means here, and it is deliberately not the
 * whole request. A request body also carries fields the model never reads -- `metadata.user_id`,
 * `model`, sampling parameters -- and a token sitting in one of those was put there by the client
 * for the provider's benefit, not handed to the model. The two are different facts and this
 * harness exists to establish the second.
 *
 * The measured builds send `system` as a list of text blocks and
 * `messages: [{ role: "user", content: [{ type: "text", text }, ...] }]`. A string `system` and a
 * string `content` are accepted too, since the first is the documented alternative and the second
 * is the shape of the frame the headless arm writes on stdin, which a build is free to forward
 * unchanged. Anything else -- an unparseable body, no `messages`, a block that is not text --
 * contributes nothing rather than throwing: this reads a foreign process's output, and a shape it
 * does not recognise is a text it has not seen, not a crash.
 *
 * Parsed, never searched as a string. Serialized JSON escapes what it likes -- a client may write
 * `\u0041` for `A` or split nothing at all -- so a substring test over the raw body answers a
 * question about one encoding of the text rather than about the text.
 */
export const modelInputTexts = (body: string): readonly ModelInputText[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const request = (parsed ?? {}) as { system?: unknown; messages?: unknown };
  const texts: ModelInputText[] = [];
  const collect = (from: string, content: unknown): void => {
    if (typeof content === "string") {
      texts.push({ from, text: content });
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
      if (type === "text" && typeof text === "string") texts.push({ from, text });
    }
  };
  collect("system", request.system);
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown };
      collect(typeof role === "string" ? role : "", content);
    }
  }
  return texts;
};

/**
 * The text of every user message in a request body, flattened; empty for a body that is not one.
 *
 * The user's own messages and nothing else: the prompt an arm was started with arrives as a user
 * text block beside the system reminders, and the model's own words echoed back in an assistant
 * turn are not evidence that this arm's prompt was accepted.
 */
const userMessageTexts = (body: string): readonly string[] =>
  modelInputTexts(body)
    .filter(({ from }) => from === "user")
    .map(({ text }) => text);

/**
 * Whether the arm's *own prompt* was turned into a turn: a model request carrying it as a user
 * message.
 *
 * This is the harness's only evidence that the prompt it started the client with was accepted, and
 * it is deliberately the same kind of evidence the wake itself is judged by -- a request body the
 * CLI sent, never a screen, a sleep, or the fact that the argument was passed.
 *
 * Being *some* model request is not enough, and that was a real defect here rather than a
 * hypothetical: any inference the client makes for its own reasons would have satisfied it, and
 * then the arm proceeds with a baseline that is not the prompt's turn while
 * `followUpAfterInjection` compares the wake against that wrong number. So the third condition,
 * beyond POST and the endpoint, is the body: a user message whose text *is* the prompt.
 *
 * Equality after trimming, not containment, because that is what every capture taken on this host
 * shows -- the prompt arrives as a text block of its own, beside the system reminders, in all
 * twelve arms of the three committed readings. It is the strongest test that holds on the real
 * data, and a build that stopped sending it that way would fail the arm rather than qualify on a
 * turn nobody checked. That direction is the right one: a refusal is visible and costs a re-take,
 * an acceptance that was never checked is a reading that means nothing.
 */
export const baselineTurnObserved = (capture: string, prompt: string): boolean =>
  modelRequestsIn(capture).some((request) => userMessageTexts(request.body).some((text) => text.trim() === prompt));

/**
 * The turns that carried the wake into the model's input: a model request whose *model input*
 * holds `ROLE_WAKE_TOKEN`.
 *
 * Three decisions, and each one was a defect first.
 *
 * - **Containment, not equality**, and this is the one place the two counts differ deliberately.
 *   The baseline asks whether a prompt this harness chose and passed became a turn, and it arrives
 *   as a text block of its own, so equality is available and is the strongest test. The wake asks
 *   whether the frame's text reached the model at all, and the runtime composes where it goes:
 *   every capture here shows the token embedded in prose the client wrote around it ("Another
 *   Claude session sent a message:\nACP-ROLE-WAKE ..."), so equality would report a delivery that
 *   happened as one that did not.
 * - **Model input, not the whole request.** The previous form searched the serialized body, which
 *   is wrong in both directions and was reproduced in both: a follow-up whose only messages say
 *   `ping`, with the token in `metadata.user_id`, was counted as a delivery -- the client put it
 *   there and the model never saw it -- while a token JSON-escaped inside real model input was
 *   missed, because the escape is in the encoding and not in the text.
 * - **The same places in both arms**, which is what makes the control's claim mean anything. The
 *   control arm's criterion is that this count is *zero*, so every place searched here is a place
 *   the control asserts the token was not: the request's system blocks and every message's text.
 *   A token outside them is not a delivery, in either arm -- not because it is harmless, but
 *   because this harness measures what reached the model input, and no part of the request outside
 *   those places is model input. What lands elsewhere is visible in the preserved raw capture, and
 *   a build that put the wake somewhere the model never reads would fail its injection arm here
 *   rather than qualify.
 */
export const wakeCarryingTurnsIn = (capture: string): readonly CapturedRequest[] =>
  modelRequestsIn(capture).filter((request) =>
    modelInputTexts(request.body).some(({ text }) => text.includes(ROLE_WAKE_TOKEN)),
  );

/**
 * A model-input text a committed reading carries **verbatim**, because the rule reads its content.
 *
 * Two kinds of text qualify and no others: one that contains `ROLE_WAKE_TOKEN`, and one whose
 * trimmed value is the prompt the arm was started with. Those are the two things every count here
 * is read from, and the prose the client composes around our token is the thing an injection arm
 * exists to show, so it travels in full.
 */
export interface KeptText {
  readonly from: string;
  readonly text: string;
}

/**
 * A model-input text a committed reading **accounts for without publishing**: where it came from,
 * how long it was, and the digest of it.
 *
 * Why anything is withheld at all: this repository is public, and most of what a request puts in
 * front of the model is the client's own system prompt -- vendor product text we were not given to
 * republish, and the kind of provider and model detail that does not belong in a public artefact.
 * It is also most of the bytes. What a reader can do with what is left is stated where the rule is
 * (`qualificationShortfalls`) and in the receipt's limits, and it is deliberately narrow: recompute
 * the counts over the kept texts, and see that every other text is accounted for by a length and a
 * digest. Recomputing over the *contents* of a withheld text needs the raw capture, which only an
 * operator has, and which `rawCaptureSha256` names.
 *
 * `length` is in UTF-8 bytes -- the same bytes the digest is over -- so a holder of the capture can
 * check both without guessing an encoding.
 */
export interface WithheldText {
  readonly from: string;
  readonly withheld: "not this arm's evidence";
  readonly length: number;
  readonly sha256: string;
}

/** A model-input text as a reading records it: kept because the rule reads it, or accounted for. */
export type ObservedText = KeptText | WithheldText;

/**
 * Whether a model-input text is one this arm's counts are read from.
 *
 * Three conditions, and the request is one of them. The counts are derived only from turns --
 * POSTs to the messages endpoint itself (`isModelRequest`) -- so a text in any other request
 * contributes to no count whatever it contains. Of a turn's model input, the wake count reads any
 * text containing the token, wherever the runtime put it, and the baseline reads a *user* text
 * whose trimmed value is the prompt. A text that answers none of those contributes to no count,
 * which is exactly why withholding it costs the measurement nothing -- and why withholding one that
 * answers any of them would gut it.
 *
 * The request used to be missing from this, and both reviewers reproduced the same defect through
 * it: a `/v1/messages/count_tokens` request, or a GET, carrying the wake token -- or a system
 * prompt with the token quoted inside it -- had its text kept **verbatim** in every arm while no
 * count read a word of it. This repository is public and the text is the client's, so that is the
 * same safety defect the withholding rule was written to prevent, one layer up.
 */
export const isArmEvidence = (
  request: { readonly method: string; readonly url: string },
  entry: ModelInputText,
  prompt: string = BASELINE_PROMPT,
): boolean =>
  isModelRequest(request) &&
  (entry.text.includes(ROLE_WAKE_TOKEN) || (entry.from === "user" && entry.text.trim() === prompt));

/**
 * One withheld text's record -- and a **refusal** to withhold what the counts are read from.
 *
 * A withholding rule that can hide the measured thing is worse than none: the control arm's claim
 * is that no text the model was given carried the token, and if a token-carrying text could be
 * recorded as "not evidence" then that zero would be a statement about what was published rather
 * than about what was measured. So the writer classifies, and being asked to withhold evidence is a
 * failure of the run rather than a silent skip. The production path never asks it to -- the
 * classification below routes evidence to `KeptText` -- which is the point: a later change to that
 * classification stops the arm instead of quietly shrinking what the reading shows.
 *
 * It takes the request for the same reason `isArmEvidence` does: "is this text evidence" has no
 * answer without knowing which request put it in front of the model.
 */
export const withholdText = (
  request: { readonly method: string; readonly url: string },
  entry: ModelInputText,
  prompt: string = BASELINE_PROMPT,
): WithheldText => {
  if (isArmEvidence(request, entry, prompt)) {
    throw new Error(
      "a model-input text carrying the wake token, or equal to the arm's prompt, cannot be withheld: it is what the counts are read from",
    );
  }
  return {
    from: entry.from,
    withheld: "not this arm's evidence",
    length: Buffer.byteLength(entry.text, "utf8"),
    sha256: createHash("sha256").update(Buffer.from(entry.text, "utf8")).digest("hex"),
  };
};

/** One text, classified: kept if a count of this request is read from it, accounted for if not. */
const observedText = (
  request: { readonly method: string; readonly url: string },
  entry: ModelInputText,
  prompt: string,
): ObservedText =>
  isArmEvidence(request, entry, prompt) ? { from: entry.from, text: entry.text } : withholdText(request, entry, prompt);

/** One request as a committed reading records it: what was asked, and what the model was given. */
export interface ObservedRequest {
  readonly at: string;
  readonly method: string;
  readonly url: string;
  /**
   * Every text this request put in front of the model, labelled -- see `modelInputTexts` -- and
   * each one either kept verbatim or accounted for by its length and digest (`observedText`).
   */
  readonly texts: readonly ObservedText[];
}

/**
 * Where the frame was written, as the arm observed it rather than as a reader reconstructs it.
 *
 * `requestsBefore` is how many requests the capture held at the moment this arm wrote its frame --
 * an index into `ArmObservations.requests`, which is the same append-only sequence read later: the
 * fake provider appends a line per request and never rewrites one, so request *n* of the capture
 * read at the end is request *n* of the capture read here. Everything before that index existed
 * before the frame; everything from it existed only after.
 *
 * This exists because the alternative was measured and is wrong. The counts were briefly derived
 * by *finding* the baseline -- taking the position of the turn carrying the arm's prompt -- which
 * answers "where is the prompt in the sequence" and not "what had happened when the frame was
 * written". A session that sends its prompt, then a turn carrying the wake token, and then ignores
 * the injected frame entirely was admitted by that derivation in all four arms: the token-carrying
 * turn sat after the prompt's turn, so it was read as a follow-up caused by a frame it preceded.
 * A recorded boundary cannot be read that way -- that turn is before it, and the arm fails.
 *
 * `frameWritten` is stated rather than implied by the count. The control arm writes no frame, and
 * its `requestsBefore` is the point at which the injection arm would have written one; without the
 * flag, "no frame" and "a frame at position 0" would be the same record. It is set only after
 * `writeWakeFrame` returns, so it says the frame was written and not that one was intended.
 */
export interface InjectionBoundary {
  /** Whether a frame was written at this point at all. The control arm records `false`. */
  readonly frameWritten: boolean;
  /** How many requests the capture already held when it was. */
  readonly requestsBefore: number;
}

/**
 * What one arm observed, committed beside the counts it is summarised by.
 *
 * The counts in a reading used to be free-standing integers: the file stated how many turns it saw
 * and how many carried the wake, and the raw captures they were read from are under
 * `evidence/local/`, which is gitignored. Nothing a reader of the repository could see tied a
 * number to an observation, so the acceptance rule recomputed a verdict from integers that were
 * themselves assertions.
 *
 * This is the part of that gap a file can close: the observations the rule actually reads travel
 * with the reading, and the counts are derived from them rather than believed. What it does **not**
 * establish is that a live client produced them -- a fabricated observation list is as derivable as
 * a measured one. That is a different problem, tracked separately, and no sentence here should be
 * read as claiming otherwise.
 */
export interface ArmObservations {
  /**
   * The digest of the capture these were read from -- the same bytes `rawCapturePath` names.
   *
   * A binding to the local artefact, not a proof of one: the file is outside the repository, so a
   * reader who does not have it cannot check the digest, and one who does learns only that their
   * copy is the copy these observations were taken from.
   */
  readonly rawCaptureSha256: string;
  /**
   * Where in `requests` the frame was written, recorded by the arm that wrote it.
   *
   * Optional in the *type* because a committed reading is parsed JSON and the readings written
   * before this field existed carry no such key. It is not optional in a committed reading:
   * `qualificationShortfalls` refuses an arm whose observations do not carry it, because without it
   * "before the frame" and "after the frame" are inferred from the content of the requests rather
   * than read from an observation -- which is exactly the inference that admitted a build that
   * ignored the wake.
   */
  readonly boundary?: InjectionBoundary;
  readonly requests: readonly ObservedRequest[];
}

/**
 * Whether an observed text is published though no count is read from it.
 *
 * The other half of the withholding rule, and the half a reader can check: a record shows verbatim
 * only what the counts are read from, so a text that is neither the prompt nor a carrier of the wake
 * token has no business being in a committed file. The instrument classifies that way
 * (`observedText`), which is a property of the code; this is the property of the artefact, and it is
 * what keeps a reading taken by some other instrument -- or edited afterwards -- from publishing the
 * client's system prompt into a public repository on the strength of everything else agreeing.
 *
 * The prompt is this harness's own constant, the same default `countsFrom` derives against, because
 * an arm that was started with some other prompt is not one these rules admit.
 */
const isPublishedWithoutBeingRead = (request: ObservedRequest, entry: ObservedText): boolean =>
  entry !== null &&
  typeof entry === "object" &&
  "text" in entry &&
  typeof entry.text === "string" &&
  !isArmEvidence(
    { method: `${request?.method}`, url: `${request?.url}` },
    { from: `${entry.from}`, text: entry.text },
  );

/**
 * Whether an observed text is neither shown nor accounted for -- content a record dropped.
 *
 * Read from parsed JSON, so neither shape is guaranteed: a kept text needs a string `text`, and a
 * withheld one needs a length that is a count and a digest that is a digest. An entry with neither
 * is a hole, and a hole is what this refuses on behalf of a reader who cannot see it.
 */
const isUnaccountedFor = (entry: ObservedText): boolean => {
  if (entry === null || typeof entry !== "object") return true;
  if ("text" in entry) return typeof entry.text !== "string";
  return !Number.isInteger(entry.length) || entry.length < 0 || !/^[0-9a-f]{64}$/.test(`${entry.sha256}`);
};

/** The counts a reading states, as this file derives them from what an arm observed. */
export interface ArmCounts {
  readonly baselineModelRequests: number;
  readonly modelRequests: number;
  readonly wakeCarryingModelRequests: number;
  readonly followUpAfterInjection: boolean;
}

/**
 * An absolute path under somebody's home directory, in any of the spellings this host produces.
 *
 * `redactHome` replaces the prefix of a string that *is* a path; a system prompt is prose that can
 * carry one in the middle, and macOS spells the same directory `/Users/x`,
 * `/private/var/.../Users/x` and `/System/Volumes/Data/Users/x`. This matches the segment they all
 * contain, so the check below is about the account being published rather than about one prefix.
 */
const HOME_PATH = /\/(?:Users|home)\/[^/\s"']+/;

/**
 * Everything the acceptance rule reads from one arm's capture, redacted and bound to that capture.
 *
 * Redaction is `redactHome` on every string, and then a **refusal** if a home path survived
 * anywhere -- not a second redaction pass. A receipt is committed, so a path under an account's
 * home in one is a username published to every reader of the repository; a shape this does not know
 * how to redact has to stop the run rather than be committed on the assumption that redaction was
 * complete. Measured across the twelve arms of the three committed readings: no capture contains
 * one, so this refuses nothing that exists today.
 *
 * The digest is of the bytes passed in, and the caller writes those same bytes to the durable
 * capture, so the digest names a file rather than a file-like thing that was read twice.
 *
 * What travels verbatim is only what the counts are read from (`observedText`); every other text is
 * recorded as a length and a digest. That is a publication decision, not a measurement one -- the
 * counts below are the same either way, because a text that is neither the prompt nor a carrier of
 * the token is counted nowhere -- and it is what keeps a public receipt from republishing the
 * client's system prompt. `prompt` is the arm's own prompt, so the classification is made against
 * the same value the counts are.
 *
 * `boundary` is required and has no default: it is the one fact here that cannot be read off the
 * capture (`InjectionBoundary`), and a default would be this function inventing the observation the
 * counts are split by. A boundary outside the requests observed splits nothing, so it is refused
 * here rather than silently clamped -- the arm fails and no reading is written.
 */
export const observationsFrom = (
  capture: string,
  boundary: InjectionBoundary,
  prompt: string = BASELINE_PROMPT,
): ArmObservations => {
  const clean = (value: string): string => {
    const redacted = redactHome(value);
    if (HOME_PATH.test(redacted)) {
      throw new Error("a captured request carries a home-directory path that redactHome did not reach");
    }
    return redacted;
  };
  const requests = capturedRequests(capture).map((request) => {
    // Classified against the request it arrived in, redacted as it will be recorded: a text is
    // evidence only when a count of *this* request is read from it, and a text in a request no
    // count is derived from is withheld whatever it contains.
    const at = { method: clean(request.method), url: clean(request.url) };
    return {
      at: clean(request.at ?? ""),
      ...at,
      texts: modelInputTexts(request.body).map(({ from, text }) =>
        observedText(at, { from: clean(from), text: clean(text) }, prompt),
      ),
    };
  });
  if (!Number.isInteger(boundary.requestsBefore) || boundary.requestsBefore < 0 || boundary.requestsBefore > requests.length) {
    throw new Error(
      `the injection boundary is at request ${boundary.requestsBefore} of a capture holding ${requests.length}: ` +
        "a boundary outside the requests observed divides them into nothing a count can be read from",
    );
  }
  return {
    rawCaptureSha256: createHash("sha256").update(Buffer.from(capture, "utf8")).digest("hex"),
    // Copied field by field, never spread: what a caller hands in is an argument, and what is
    // written into a committed reading is these two facts and no others it happened to carry.
    boundary: { frameWritten: boundary.frameWritten, requestsBefore: boundary.requestsBefore },
    requests,
  };
};

/**
 * The texts of one observed request a reader can read: the ones kept verbatim.
 *
 * Only the kept texts have content, and reading the counts off them is not a narrowing: a withheld
 * text is one the writer established no count is read from (`withholdText` refuses the rest), so it
 * was counted nowhere before it was withheld either. Read from parsed JSON, so an entry can be any
 * shape; one with no string `text` is a withheld entry as far as this is concerned, and
 * `qualificationShortfalls` is where a record that neither keeps nor accounts for a text is refused.
 */
const keptTexts = (request: ObservedRequest): readonly KeptText[] => {
  const entries = Array.isArray(request?.texts) ? request.texts : [];
  return entries.flatMap((entry) =>
    entry !== null && typeof entry === "object" && "text" in entry && typeof entry.text === "string"
      ? [{ from: `${entry.from}`, text: entry.text }]
      : [],
  );
};

/** Whether one observed request is a turn, by the same rule the live capture is read with. */
const isObservedTurn = (request: ObservedRequest): boolean =>
  isModelRequest({ method: `${request?.method}`, url: `${request?.url}` });

/**
 * How many of an arm's observed requests preceded its recorded boundary.
 *
 * Read from parsed JSON, so the boundary can be missing or be something that is not a count. Then
 * the whole sequence is "before": no follow-up can be claimed out of a record that does not say
 * where the frame went, which fails an injection arm rather than admitting it.
 * `qualificationShortfalls` refuses such a record outright -- this is only what the counts say
 * while it is being refused, and it is deliberately the direction that refuses.
 */
const requestsBeforeBoundary = (observations: ArmObservations): number => {
  const requests = Array.isArray(observations?.requests) ? observations.requests : [];
  const at = (observations?.boundary ?? {}).requestsBefore;
  if (typeof at !== "number" || !Number.isInteger(at) || at < 0) return requests.length;
  return Math.min(at, requests.length);
};

/**
 * Whether the arm's own prompt started a turn *before* the frame was written.
 *
 * The baseline is a position now rather than a search (`countsFrom`), so nothing in the counts
 * alone says the turns before the boundary include the one this arm's prompt started. The probe
 * refuses to write a reading without it (`baselineTurnObserved`); this is the same question asked
 * of a committed file, where the prompt's user text is one of the two things kept verbatim.
 *
 * `from === "user"`, because the model's own words echoed back in an assistant turn are not
 * evidence that the prompt was accepted -- the same condition `baselineTurnObserved` applies to the
 * live capture.
 */
export const baselineTurnBeforeBoundary = (
  observations: ArmObservations,
  prompt: string = BASELINE_PROMPT,
): boolean => {
  const requests = Array.isArray(observations?.requests) ? observations.requests : [];
  return requests
    .slice(0, requestsBeforeBoundary(observations))
    .filter(isObservedTurn)
    .some((turn) => keptTexts(turn).some(({ from, text }) => from === "user" && text.trim() === prompt));
};

/**
 * The four counts a reading states, derived from what the arm observed.
 *
 * One calculation for the producer and the reader, in the same sense the verdict is: the probe
 * records what this returns, and `qualificationShortfalls` derives it again from the committed
 * observations and reports a difference. So a number in a reading is a claim about an observation
 * beside it, not a free-standing integer.
 *
 * **The baseline is the recorded boundary**, not the position of the prompt's turn. The difference
 * is not a refinement; it is the defect this function had and it admitted a build that ignores the
 * wake. Taking the prompt's position asks where the prompt is in the sequence, and the question the
 * counts have to answer is what had already happened when the frame was written. A session that
 * emits its prompt, then a turn carrying the wake token, and then ignores the injected frame was
 * admitted in all four arms by the positional reading -- the token-carrying turn came after the
 * prompt's turn, so it was counted as the follow-up the frame caused, though it preceded the frame.
 * Against a boundary the arm *recorded*, that turn is before the frame, no follow-up exists, and
 * the injection arms fail. See `InjectionBoundary`.
 *
 * `followUpAfterInjection` is read from the same split rather than from `modelRequests >
 * baselineModelRequests`: the requests are one append-ordered sequence, so the two agree by
 * construction, and `qualificationShortfalls` checks that a reading's stated pair agrees too.
 */
export const countsFrom = (observations: ArmObservations): ArmCounts => {
  const requests = Array.isArray(observations?.requests) ? observations.requests : [];
  const before = requestsBeforeBoundary(observations);
  const turns = requests.filter(isObservedTurn);
  return {
    baselineModelRequests: requests.slice(0, before).filter(isObservedTurn).length,
    modelRequests: turns.length,
    wakeCarryingModelRequests: turns.filter((turn) =>
      keptTexts(turn).some(({ text }) => text.includes(ROLE_WAKE_TOKEN)),
    ).length,
    followUpAfterInjection: requests.slice(before).some(isObservedTurn),
  };
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
  /**
   * The image this arm executes, held once by the caller for every arm it runs. Required, and the
   * probe resolves nothing itself: an arm that looked the client up again could start a different
   * build from the one the reading names (`pinClaudeImage`).
   */
  readonly image: HeldImage;
  /**
   * Ceiling on the wait for the arm's own prompt to become a turn. The live default is generous
   * because a cold client start is slow; a row that is measuring the refusal passes a short one.
   */
  readonly baselineCeilingMs?: number;
  /**
   * How the arm's process is started. `spawn`, unless a row is driving this probe where no client
   * is installed.
   *
   * The one boundary that has to be injectable for the probe's own decisions to be observable
   * offline: what it starts, and what it refuses to proceed without. Everything else stays real
   * when a row supplies this -- the temp root, the fake provider, the socket, the frame, the
   * teardown -- so what a row measures is this function's behaviour and not a model of it.
   *
   * `qualify()` never passes it, so nothing a committed reading rests on comes through here. A
   * receipt produced with an injected starter would be a receipt of a process nobody spawned, and
   * the way that is prevented is that the one producer does not offer it.
   */
  readonly startProcess?: (
    executable: string,
    argv: readonly string[],
    options: { readonly env: NodeJS.ProcessEnv; readonly cwd: string; readonly stdio: readonly ["pipe", "pipe", "pipe"] },
  ) => ChildProcessWithoutNullStreams;
}

/**
 * Runs one disposable session end to end and reports what the fake provider was asked.
 *
 * The two arms differ in exactly one input -- whether the frame is written -- so a difference
 * in the capture is attributable to the frame and to nothing else.
 */
export const runQualificationProbe = async (options: ProbeOptions): Promise<ProbeRun> => {
  const settleCeilingMs = options.settleCeilingMs ?? 20_000;
  const { image } = options;

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
  const terminal = terminalOutput();
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

    // One decision, one value: what is spawned and what the reading records come from the same
    // `spawnPlanFor` call, so the recorded `command` cannot describe an invocation other than the
    // one below. Both shapes' argv, and the interactive one's positional prompt, are `probeArgv`'s
    // -- the same value a test hands to `isInteractiveClaudeInvocation`.
    const plan = spawnPlanFor(
      options.shape,
      image,
      { settingsPath, socketPath },
      options.shape === "interactive" ? resolvePtyAllocator() : null,
    );
    const command = plan.command;

    // `plan.executable` and `plan.argv`, unchanged and unaccompanied: the plan is the one decision
    // about what runs, and anything added here would be an invocation the reading does not record.
    const startProcess = options.startProcess ?? spawn;
    child = startProcess(plan.executable, plan.argv, {
      env,
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    child.stdout.on("data", (chunk: Buffer) => {
      terminal.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const bound = await waitFor(() => existsSync(socketPath), 60_000);
    if (!bound) throw new Error(`the session inbox never appeared\n${stderr}`);

    const modelRequests = () => modelRequestsIn(readFileSync(capturePath, "utf8"));

    // One ordinary turn first, so the run has a baseline that predates the frame. The interactive
    // arm was *started* with it as its positional prompt (`probeArgv`), so there is nothing to type
    // here and no screen to model; the headless arm writes a stream-json frame and holds stdin
    // open, which is what keeps that session alive after the turn completes.
    if (options.shape === "headless") {
      child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: BASELINE_PROMPT } })}\n`);
    }

    // Observed, never assumed, and observed as *this prompt's* turn. Passing the prompt is not
    // evidence the client accepted it; the evidence is a request it sent to be inferred on carrying
    // that prompt as a user message, which is the same kind of evidence the wake is judged by. Some
    // other inference the client made for its own reasons is not this arm's baseline, and admitting
    // one would leave `followUpAfterInjection` comparing the wake against a number that never
    // counted the prompt. No such request inside the bound fails the arm, and with it the run, so no
    // reading is written. There is deliberately no second way to start this turn: a fallback to
    // typing would fire on exactly the build where the argument stopped being accepted, and hide
    // that it had.
    const baselineSeen = await waitFor(
      () => baselineTurnObserved(readFileSync(capturePath, "utf8"), BASELINE_PROMPT),
      options.baselineCeilingMs ?? 120_000,
    );
    if (!baselineSeen) {
      throw new Error(
        `the client sent no model request carrying ${JSON.stringify(BASELINE_PROMPT)}, the prompt it was started with\n${stderr}\n` +
          `--- terminal tail, escapes deleted rather than applied; diagnosis only ---\n${strip(terminal.text()).slice(-2000)}`,
      );
    }
    // One read, and both numbers come out of it. Two reads can straddle a request that arrived
    // between them, and then the boundary this arm records would not be the boundary its baseline
    // was counted at. `requestsBefore` counts *every* captured request, not only the turns: it is
    // an index into the sequence `observationsFrom` records, which is that same sequence.
    const atBoundary = readFileSync(capturePath, "utf8");
    const requestsBefore = capturedRequests(atBoundary).length;
    const baselineModelRequests = modelRequestsIn(atBoundary).length;
    // Set after `writeWakeFrame` returns, never before, so the record says a frame was written and
    // not that one was meant to be. A throw from the write fails the arm, and with it the run.
    let frameWritten = false;

    if (options.inject) {
      await writeWakeFrame(socketPath);
      frameWritten = true;
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

    // One read of the capture, and every count this arm records is derived from it. Two reads can
    // straddle a request that arrived between them, and the counts would then be counts of two
    // different captures -- a difference small enough to be invisible and large enough to make a
    // reading's own numbers disagree with each other.
    const finalCapture = readFileSync(capturePath, "utf8");
    // Read after the measurement, through the name this arm was started by. A throw here fails the
    // arm, and with it the run, before anything is recorded (see `confirmHeld`).
    const imageSha256 = confirmHeld(image);
    // Built before anything is written: a capture carrying a path this harness cannot redact fails
    // the arm here rather than reaching a committed file.
    // The boundary travels with the observations because it is the one fact about them that cannot
    // be read back off the capture: which requests existed before the frame. Derived instead -- by
    // taking the prompt's position -- it admitted a session that ignored the wake entirely.
    const observations = observationsFrom(finalCapture, { frameWritten, requestsBefore });
    const counts = countsFrom(observations);
    mkdirSync(durableDir, { recursive: true });
    // The snapshot, not a second copy of the file: `observations.rawCaptureSha256` is the digest of
    // these exact bytes, and copying the path again could pick up a request that arrived since.
    writeFileSync(durableCapture, finalCapture);
    writeFileSync(sessionLogPath, `${strip(terminal.text())}\n--- stderr ---\n${stderr}`);
    copyFileSync(sessionLogPath, durableLog);

    return (run = {
      shape: options.shape,
      injected: options.inject,
      command: command.map(redactHome),
      imageSha256,
      observations,
      // Derived from the observations committed beside them, by the same calculation the reader
      // derives them with. `baselineModelRequests` above is what the arm waited for; the number
      // recorded is the one a reader can check.
      ...counts,
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

/** The four arms one qualification is made of. Exactly one of each, and nothing else. */
const REQUIRED_ARMS: readonly { readonly shape: ProbeShape; readonly injected: boolean }[] = [
  { shape: "interactive", injected: true },
  { shape: "interactive", injected: false },
  { shape: "headless", injected: true },
  { shape: "headless", injected: false },
];

/** How an arm is named in a sentence about it. */
const armLabel = (arm: { readonly shape: ProbeShape; readonly injected: boolean }): string =>
  `${arm.shape} ${arm.injected ? "injection" : "control"}`;

/**
 * Every reason a set of observations does not qualify the build that produced it. Empty is the
 * verdict "qualified", and there is no other way to reach it.
 *
 * **One calculation, used by the producer and by the reader.** `buildReceipt` computes a receipt's
 * verdict with it; `qualificationDisagreements` recomputes it from a committed reading's own runs
 * instead of reading the `verdict` the file carries. That the two used to be different code was the
 * defect, not an inefficiency: reproduced on in-memory copies of all three committed readings, a
 * reading with both headless arms deleted, with its headless injection arm failing, with every
 * baseline count zeroed, or with `--output-format=json` added to a purported *interactive* command,
 * passed every offline check -- because the reader asked the file what its verdict was. The file
 * was the authority on whether the file was admissible.
 *
 * What it requires, and why each one is more than bookkeeping:
 *
 * - **Exactly one of each of the four arms.** The ceremony's claim is a comparison -- injection
 *   against control, in both shapes. Two of one and none of another is not that comparison, and a
 *   receipt built from it would state a verdict no arm supports.
 * - **Each arm meeting its own criterion** (`armPassed`): the wake arrives and starts a turn in the
 *   injection arms, and neither happens in the controls.
 * - **A positive baseline in every arm.** A zero baseline means nothing was observed to have
 *   started before the frame, so `followUpAfterInjection` compared the wake against a turn that
 *   never happened.
 * - **Counts that are consistent with each other.** Totals no smaller than the baseline, a wake
 *   count no larger than the total, and `followUpAfterInjection` saying exactly what the two counts
 *   say. A file whose summary disagrees with its own numbers is being read for its summary.
 * - **Each arm's argv being the shape it claims**, judged by the production predicate
 *   (`isInteractiveClaudeInvocation`): accepted for an interactive arm, refused for a headless one.
 *   A qualification of an argv the predicate refuses qualifies a process that could never hold the
 *   canonical claim, and that is the whole reason the interactive shape is measured at all.
 * - **Counts that come from the observations committed with them.** Every number above used to be
 *   an integer the file stated about itself, with the captures it was read from under
 *   `evidence/local/`, which is gitignored -- so nothing a reader could see tied a count to an
 *   observation. Each arm now carries what it observed (`ArmObservations`), the four counts are
 *   re-derived from it here by the calculation the probe recorded them with (`countsFrom`), and a
 *   difference is a shortfall. An arm with no observations is refused: absence is the case that was
 *   slipping through.
 * - **A boundary that was observed, not reconstructed.** Each arm records where in its own request
 *   sequence the frame was written (`InjectionBoundary`), and the baseline and the follow-up are
 *   read off that split on both sides. Deriving the boundary instead -- from the position of the
 *   turn carrying the arm's prompt -- admitted a session whose wake-carrying turn preceded the
 *   frame it then ignored, in all four arms. An arm with no recorded boundary is refused, as is one
 *   whose boundary contradicts whether the arm says it injected, or that shows no turn carrying its
 *   own prompt before that point.
 * - **Every observed text shown or accounted for.** A committed observation carries verbatim only
 *   the texts the counts are read from -- of a *turn*, the arm's prompt as a user message and
 *   anything carrying the wake token -- because this repository is public and the rest of what a
 *   request puts in front of the model is the client's own system prompt. A text in a request no
 *   count is derived from is withheld whatever it contains: judging it on content alone published
 *   the client's text out of a count-tokens request and a GET. Every other text travels as its
 *   length and its SHA-256, and a text that is neither shown nor accounted for that way is a
 *   shortfall. So what a reader of the
 *   repository can do is exactly this: recompute the four counts over the kept texts, see that
 *   nothing else was dropped rather than withheld, and see that nothing was published that no count
 *   is read from. Recomputing over a withheld text's *contents*
 *   needs the raw capture, which is under `evidence/local/` and is not committed; `rawCaptureSha256`
 *   names it for the operator who has it. The instrument refuses to withhold evidence
 *   (`withholdText`), which is what keeps the kept set from being the whole of the claim -- but that
 *   is a property of the code that wrote the file, not something the file demonstrates.
 *
 * What this does **not** establish, and this is the part to read twice: that a live client produced
 * any of it. Deriving a count from a committed observation removes the count as a free-standing
 * claim; it does not attest the ceremony. A reading written from nothing, with observations made to
 * agree with its counts, is admitted here exactly as one taken from four real sessions. The same is
 * true of every other rule above -- each is a statement inside the file being judged, and agreement
 * among them is internal consistency. Whether the arms ever ran is a question this calculation
 * cannot ask, and no rule that lives inside the artefact can.
 */
export const qualificationShortfalls = (runs: readonly ProbeRun[]): readonly string[] => {
  const shortfalls: string[] = [];
  if (runs.length !== REQUIRED_ARMS.length) {
    shortfalls.push(`the reading holds ${runs.length} arms, and a qualification is made of exactly ${REQUIRED_ARMS.length}`);
  }
  for (const required of REQUIRED_ARMS) {
    const found = runs.filter((run) => run.shape === required.shape && run.injected === required.injected).length;
    if (found !== 1) {
      shortfalls.push(`the reading holds ${found} ${armLabel(required)} arms, not the one a qualification is made of`);
    }
  }
  runs.forEach((run, index) => {
    const where = `arm ${index + 1} (${armLabel(run)})`;
    // Read from parsed JSON, so a field can be absent or not a number however the type reads here.
    // A comparison against `undefined` is false, which would let a missing count pass every rule
    // below it; the counts are established as counts first, and the rules run only on what is one.
    const counts: readonly (readonly [string, number])[] = [
      ["baselineModelRequests", run.baselineModelRequests],
      ["modelRequests", run.modelRequests],
      ["wakeCarryingModelRequests", run.wakeCarryingModelRequests],
    ];
    const missing = counts.filter(([, value]) => !Number.isInteger(value) || value < 0);
    for (const [field] of missing) shortfalls.push(`${where} does not record ${field} as a count`);
    if (typeof run.followUpAfterInjection !== "boolean" || typeof run.injected !== "boolean") {
      shortfalls.push(`${where} does not say whether it was injected and whether a follow-up arrived`);
    } else if (missing.length === 0) {
      if (!armPassed(run)) shortfalls.push(`${where} did not meet the criterion for its own arm`);
      if (run.baselineModelRequests < 1) {
        shortfalls.push(`${where} recorded no baseline turn, so its follow-up was measured against a turn that never happened`);
      }
      if (run.modelRequests < run.baselineModelRequests) {
        shortfalls.push(`${where} recorded ${run.modelRequests} turns in all and ${run.baselineModelRequests} before the injection point`);
      }
      if (run.wakeCarryingModelRequests > run.modelRequests) {
        shortfalls.push(`${where} recorded ${run.wakeCarryingModelRequests} wake-carrying turns out of ${run.modelRequests} turns`);
      }
      if (run.followUpAfterInjection !== run.modelRequests > run.baselineModelRequests) {
        shortfalls.push(
          `${where} says a follow-up ${run.followUpAfterInjection ? "arrived" : "did not arrive"}, which its own counts ` +
            `(${run.baselineModelRequests} before, ${run.modelRequests} in all) do not say`,
        );
      }
    }
    // The counts above are checked against each other; these are checked against something other
    // than themselves. A reading with no observations is refused rather than admitted on its own
    // integers -- absence is exactly the case that was slipping through before.
    const observations = run.observations;
    if (
      observations === undefined ||
      typeof observations.rawCaptureSha256 !== "string" ||
      !Array.isArray(observations.requests)
    ) {
      shortfalls.push(`${where} carries no observations, so its counts are claims this file makes about itself`);
    } else {
      if (!/^[0-9a-f]{64}$/.test(observations.rawCaptureSha256)) {
        shortfalls.push(`${where} does not bind its observations to the digest of a raw capture`);
      }
      // Where the frame went, read rather than reconstructed. Without this an arm's "before" and
      // "after" are inferred from which request carries a prompt, and a session whose wake-carrying
      // turn *precedes* the frame it then ignores is admitted as one the frame woke -- reproduced
      // against the real probe, in all four arms. So a record that does not say is refused here,
      // and one that says something its own arm contradicts is refused too.
      const boundary = observations.boundary;
      if (
        boundary === undefined ||
        typeof boundary.frameWritten !== "boolean" ||
        !Number.isInteger(boundary.requestsBefore) ||
        boundary.requestsBefore < 0 ||
        boundary.requestsBefore > observations.requests.length
      ) {
        shortfalls.push(
          `${where} does not record where in the requests it observed the frame was written, so which of them ` +
            `preceded it is a guess`,
        );
      } else {
        if (boundary.frameWritten !== run.injected) {
          shortfalls.push(
            `${where} is recorded as ${run.injected ? "an injection" : "a control"} arm, and its observations say a ` +
              `frame ${boundary.frameWritten ? "was" : "was not"} written`,
          );
        }
        // The baseline is a position now, so nothing in the counts says the turns before the
        // boundary include the one this arm's prompt started. The probe will not proceed without it
        // (`baselineTurnObserved`); this asks the same question of the committed file.
        if (!baselineTurnBeforeBoundary(observations)) {
          shortfalls.push(
            `${where} shows no turn carrying the prompt it was started with before that point, so its baseline ` +
              `counts turns that are not the prompt's`,
          );
        }
      }
      // Every text is either readable here or accounted for by a length and a digest. Without
      // this, a record could drop content by writing an entry with neither -- the counts would be
      // derived over what was left and nothing a reader could see would say anything was missing.
      // What it establishes is bounded: that the record accounts for what it does not show. Whether
      // a withheld text says what its digest says needs the raw capture, which is not committed.
      const unaccounted = observations.requests.reduce(
        (total, request) => total + (Array.isArray(request?.texts) ? request.texts : []).filter(isUnaccountedFor).length,
        0,
      );
      if (unaccounted > 0) {
        shortfalls.push(
          `${where} carries ${unaccounted} model-input text(s) it neither records nor accounts for by a length and digest`,
        );
      }
      // And nothing verbatim that no count is read from. These readings are committed to a public
      // repository, and most of a request's model input is the client's own system prompt; the
      // instrument withholds it, and this refuses a reading that does not -- which is what makes the
      // rule a property of the artefact rather than of the code that happened to write it.
      const published = observations.requests.reduce(
        (total, request) =>
          total +
          (Array.isArray(request?.texts) ? request.texts : []).filter((entry: ObservedText) =>
            isPublishedWithoutBeingRead(request, entry),
          ).length,
        0,
      );
      if (published > 0) {
        shortfalls.push(
          `${where} carries ${published} model-input text(s) verbatim that none of its counts are read from`,
        );
      }
      const stated: ArmCounts = {
        baselineModelRequests: run.baselineModelRequests,
        modelRequests: run.modelRequests,
        wakeCarryingModelRequests: run.wakeCarryingModelRequests,
        followUpAfterInjection: run.followUpAfterInjection,
      };
      // Derived from the observations, never read from the run: a reading whose numbers checked
      // themselves is the state this rule exists to end.
      const derived = countsFrom(observations);
      for (const field of [
        "baselineModelRequests",
        "modelRequests",
        "wakeCarryingModelRequests",
        "followUpAfterInjection",
      ] as const) {
        if (stated[field] !== derived[field]) {
          shortfalls.push(
            `${where} states ${field} as ${JSON.stringify(stated[field])}, and its own observations give ` +
              `${JSON.stringify(derived[field])}`,
          );
        }
      }
    }
    if (!Array.isArray(run.command) || run.command.some((argument) => typeof argument !== "string")) {
      shortfalls.push(`${where} does not record the argv it was started with`);
    } else if (isInteractiveClaudeInvocation(run.command) !== (run.shape === "interactive")) {
      shortfalls.push(
        run.shape === "interactive"
          ? `${where} was started with an argv the canonical-claim predicate refuses, so it did not measure a session that could hold the claim`
          : `${where} was started with an argv the canonical-claim predicate accepts, so it is not the headless arm it is recorded as`,
      );
    }
  });
  return shortfalls;
};

/** The verdict those observations support. There is no input that can make it say otherwise. */
export const verdictFor = (runs: readonly ProbeRun[]): QualificationReceipt["verdict"] =>
  qualificationShortfalls(runs).length === 0 ? "qualified" : "not-qualified";

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
  // The one claim a reading rests on is that its arms ran the image it names. An arm that ran
  // anything else -- or that cannot say what it ran -- has no place in it, and the refusal is a
  // throw rather than a `not-qualified` verdict, because a reading of the wrong image is not a
  // reading of this one at all.
  input.runs.forEach((run, index) => {
    if (run.imageSha256 !== input.image.sha256) {
      throw new Error(
        `arm ${index + 1} (${run.shape}, ${run.injected ? "injection" : "control"}) executed an image whose digest is ` +
          `${run.imageSha256 ?? "not recorded"}, not the ${input.image.sha256} this reading would name`,
      );
    }
  });
  const frameBytes = Buffer.from(ROLE_WAKE_FRAME, "utf8");
  return {
    qualification: QUALIFICATION_ID,
    producedAt: new Date().toISOString(),
    headSha: input.headSha,
    client: {
      name: MEASURED_CLIENT_NAME,
      version: input.image.version,
      versionOutput: input.image.versionOutput,
      imagePath: redactHome(input.image.path),
      imageSha256: input.image.sha256,
      // Which of the two the harness read. A receipt that does not say cannot be told apart from
      // one taken where no deployment was present, and the two claim different things: only
      // only `daemon-binary` and `pinned-launcher` are evidence about the build it executes.
      qualificationSource: qualificationSource(),
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
    // The one calculation, the same one `qualificationDisagreements` recomputes from this file
    // later. Nothing a caller passes reaches it: the verdict is a reading of the runs or it is
    // nothing.
    verdict: verdictFor(input.runs),
    limits: input.limits,
    findings: input.findings,
  };
};

/**
 * What a name or a version may be for it to become part of a file name.
 *
 * No path separator, no `@` (the separator between the two), and no leading `.` or `-`, so neither
 * part can walk out of `RECEIPT_DIR` or be read as a flag. The version comes from a client's own
 * `--version` output, which is not this harness's to trust with a path.
 */
const FILE_NAME_PART = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** The one file a build's reading lives in. Refuses a part that cannot be named safely. */
export const readingFileName = (client: WakeTransportClient): string => {
  for (const part of [client.name, client.version]) {
    if (typeof part !== "string" || !FILE_NAME_PART.test(part)) {
      throw new Error(`a reading cannot be named after ${JSON.stringify(part)}`);
    }
  }
  return `${client.name}@${client.version}.json`;
};

/** One committed reading and the file it was read from. */
export interface RecordedReading {
  readonly file: string;
  readonly reading: QualificationReceipt;
}

/**
 * Adds this build's reading, or replaces the one it already had, and touches no other file.
 *
 * Written beside its final name and renamed into place, so an interrupted write leaves the build's
 * previous reading (or none) rather than half a file. The temporary name does not end in `.json`,
 * so `readReadings` never mistakes one for a reading.
 */
export const recordReading = (
  reading: QualificationReceipt,
  directory: string = join(REPO_ROOT, RECEIPT_DIR),
): string => {
  const path = join(directory, readingFileName(reading.client));
  mkdirSync(directory, { recursive: true });
  const pending = `${path}.${process.pid}.pending`;
  writeFileSync(pending, `${JSON.stringify(reading, null, 2)}\n`);
  renameSync(pending, path);
  return path;
};

/** Every committed reading, in file-name order. An absent directory is no readings, not an error. */
export const readReadings = (directory: string = join(REPO_ROOT, RECEIPT_DIR)): RecordedReading[] => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      reading: JSON.parse(readFileSync(join(directory, file), "utf8")) as QualificationReceipt,
    }));
};

/**
 * Every way the qualified set and the committed readings disagree, one sentence each; empty when
 * they agree.
 *
 * Each rule is a failure, never a warning, because each is a build the wake transport would admit
 * or refuse on the strength of something other than a measurement:
 *
 *   - **Every member has a reading.** A member with none is a build admitted on no reading at all —
 *     the C0 state this whole file exists to end, and the one this slice most has to prevent now
 *     that adding a member is a one-line edit.
 *   - **No member rests on a reading whose verdict is not `qualified`.** A measurement that failed
 *     is still a measurement, and it is the one thing that must not make its build a member.
 *   - **Every reading is of a member.** A reading outside the set is a build that was measured and
 *     never admitted, or a member removed with its reading left behind; either way the set and the
 *     evidence have stopped describing the same deployment. Together with the rule above, this
 *     means a reading whose verdict is not `qualified` cannot be committed at all — the same
 *     property the single receipt had when its verdict was required to be `qualified`.
 *   - **A file holds the reading its name says**, and a member is listed once. Those two are what
 *     make "one reading per build" true rather than conventional.
 *   - **Every arm of every reading executed the image that reading names.** `buildReceipt` refuses
 *     an arm on another digest while a reading is being *produced*, which says nothing about a
 *     reading that reaches the repository some other way. Measured on 2026-09-28: the committed
 *     readings carried no per-arm digest at all and this check passed on them, so a reading whose
 *     arms ran on another build was indistinguishable from one whose arms ran on the build it
 *     names -- the exact substitution the hold and the per-arm digest exist to catch.
 *
 * Membership is `isWakeTransportQualified` — the equality registration refuses on — so this cannot
 * pass on a looser notion of "the same build" than the one production applies.
 */
export const qualificationDisagreements = (
  members: readonly WakeTransportClient[],
  readings: readonly RecordedReading[],
): string[] => {
  const label = (client: WakeTransportClient): string => `${client.name}/${client.version}`;
  const problems: string[] = [];
  for (const { file, reading } of readings) {
    let expected: string;
    try {
      expected = readingFileName(reading.client);
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`);
      continue;
    }
    if (file !== expected) {
      problems.push(`${file} holds the reading of ${label(reading.client)}, whose file is ${expected}`);
    }
  }
  for (const { file, reading } of readings) {
    // One comparison for both failures, because an arm that does not say which image it executed is
    // not an arm that said the right one. Absence is the case that was slipping through -- the
    // readings on disk had no per-arm digest and nothing failed -- so it is refused here rather
    // than skipped, and the two are told apart only in what the sentence says.
    reading.runs.forEach((run, index) => {
      if (run.imageSha256 === reading.client.imageSha256) return;
      const arm = `arm ${index + 1} (${run.shape}, ${run.injected ? "injection" : "control"})`;
      problems.push(
        run.imageSha256 === undefined
          ? `${file}: ${arm} does not say which image it executed, so nothing ties it to the ${reading.client.imageSha256} this reading names`
          : `${file}: ${arm} executed ${run.imageSha256}, not the ${reading.client.imageSha256} this reading names`,
      );
    });
  }
  members.forEach((member, index) => {
    if (members.findIndex((other) => isWakeTransportQualified(other, [member])) !== index) {
      problems.push(`${label(member)} is listed in the qualified set more than once`);
    }
    const own = readings.filter(({ reading }) => isWakeTransportQualified(reading.client, [member]));
    if (own.length === 0) {
      problems.push(`${label(member)} is a qualified member with no reading`);
    }
    for (const { file, reading } of own) {
      // Recomputed from the runs, never read from the file. `reading.verdict` used to be the
      // authority here, which made the artefact the judge of its own admissibility: a reading with
      // its headless arms deleted, or with an arm that failed, or with an interactive command the
      // production predicate refuses, was admitted because the field still said "qualified".
      for (const shortfall of qualificationShortfalls(reading.runs)) {
        problems.push(`${label(member)} is a qualified member resting on ${file}, whose own runs do not qualify it: ${shortfall}`);
      }
    }
  });
  for (const { file, reading } of readings) {
    // The stored verdict is an output that is checked, not an input that decides. It stays in the
    // file because a reader opening one should see what it concluded, but a file whose conclusion
    // and whose observations disagree is reported rather than believed -- in either direction.
    const recomputed = verdictFor(reading.runs);
    if (reading.verdict !== recomputed) {
      problems.push(
        `${file} states the verdict ${JSON.stringify(reading.verdict)}, and its own runs recompute to ${recomputed}`,
      );
    }
  }
  for (const { file, reading } of readings) {
    if (!isWakeTransportQualified(reading.client, members)) {
      problems.push(`${file} is a reading of ${label(reading.client)}, which is not a qualified member`);
    }
  }
  return problems;
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
  "A wake-carrying turn is one whose model input -- the request's system blocks and its messages' text -- contains the token. A token elsewhere in the request, such as a metadata field the client fills in for the provider, is not counted in either arm: it is not what the model was asked. So the control's zero and the injection arm's positive count are the same question asked of the same places.",
  "The endpoint-directory policy is untouched by this slice, so registration through registerEndpoint is still refused for a socket outside the daemon state directory. See the finding of that name.",
  "Interactive start required pre-provisioned answers to the onboarding, workspace-trust and custom-API-key prompts in a throwaway config. A session whose operator answered them differently is outside this reading.",
  "The interactive arm's baseline turn is started by a positional prompt in its argv, not typed at the client's prompt. What is read here is that the wake frame reaches the model input of an interactively-invoked session and starts a turn; nothing here observes the client's terminal, so this says nothing about whether that session would have accepted a keystroke at the moment the frame arrived.",
  "Each arm's baseline is a model request carrying the prompt as a user message whose text, trimmed, equals it. That is what every capture on this host shows, and a build that sent the same prompt in another shape would fail the arm rather than qualify on an unchecked turn. What is established is that this prompt started a turn, not that the client would have started one from any other input.",
  "settleCeilingMs is a ceiling on the post-injection wait, not a duration either arm was observed for. The control spends the whole ceiling; the injection arm returns on its first follow-up request. Two arms sharing a ceiling were watched for at most the same time, not for the same time, and the actual spans are not recorded here.",
  "Every arm executed one hard link, in a directory private to the run, to the inode digested as imageSha256 -- the command's first element names that link, which is removed with the run, and imagePath names where the inode was found. Each arm re-read the link's identity, size, modification time and digest after its measurement and would have failed the run on a difference. A rewrite of that inode in place, undone before the re-read, would not have been seen.",
  "The verdict in this file is recomputed from the runs in it, by the one calculation the instrument writes it with, and a reader that admits this reading recomputes it again rather than reading the field. That establishes internal consistency and nothing more: every fact it checks is a statement inside this file. A file written from nothing, with all its fields made to agree, satisfies it. Whether the arms it describes ever ran is a question the raw captures and session logs it points at answer, and this check does not ask them.",
  "Each arm carries the observations its counts are derived from -- every captured request's time, method and URL, and the point in that sequence at which the frame was written -- and both the instrument and the reader derive the four counts from them rather than reading integers. The boundary is recorded by the arm that wrote the frame, not inferred from which request carries the prompt: inferring it counted a wake-carrying turn that preceded the frame as the follow-up the frame caused. What that removes is a count that stood on nothing; what it does not do is attest that a live client produced the observations, or that the recorded boundary is where the frame really went. An observation list written by hand derives exactly as well as a measured one, and this file cannot tell them apart.",
  "Of each request's model input, this file carries verbatim only what the counts are read from, and only out of the requests those counts are derived from -- the turns. In a turn: the arm's prompt as a user message, and any text containing the wake token. A text in any other request is withheld whatever it contains, because no count of this arm reads it. Every other text -- most of it the client's own system prompt, which is not ours to publish -- is recorded as its kind, its length in UTF-8 bytes and its SHA-256. So a reader of the repository can recompute the four counts over the texts that are here and see that every other text is accounted for by a digest; a reader cannot see what a withheld text said. Recomputing the counts over their contents needs the raw capture named by rawCaptureSha256, which is not committed. The instrument refuses to withhold a text a count of its own request is read from, so the kept texts are the evidence and not a selection from it -- but that is a property of the code that wrote this file, not a fact this file establishes. What is checked of the file itself is the other direction: a reading carrying a verbatim text that none of its counts are read from is refused rather than admitted.",
  "The observations are bound to each arm's raw capture by that capture's SHA-256. The capture itself is under evidence/local/, which is not committed, so a reader without that file cannot check the digest, and a reader with it learns only that the copy in hand is the one these observations were read from.",
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
 * Takes the whole reading of one build and records it: both shapes, both arms, one file.
 *
 * One build per call — whichever `pinClaudeImage` holds, so an operator points it at a
 * specific build through `ACP_CLAUDE_BINARY`. Its reading is added, or replaces that build's
 * earlier one; every other build's reading is left exactly as it was. Moving the build into
 * `WAKE_TRANSPORT_QUALIFIED_CLIENTS` stays a separate, deliberate edit.
 *
 * Lives here rather than in the script that invokes it so that it is inside the typechecked and
 * linted tree; `scripts/` is outside both, and an unchecked producer of the file the pin is
 * verified against would be the weakest link in the chain.
 */
export const qualify = async (): Promise<{ readonly receipt: QualificationReceipt; readonly path: string }> => {
  const blocker = interactiveBlocker();
  if (blocker !== null) throw new Error(`cannot take the interactive reading: ${blocker}`);
  // Held once, here, and handed to every arm; released only after the reading is written, so the
  // one inode is what the version, the digest and all four execs are of.
  const image = pinClaudeImage();
  try {
    // Named before any arm runs: a version that cannot become a file name is refused here, not
    // after four real client starts, and the same name scopes this build's raw captures.
    const readingName = readingFileName({ name: MEASURED_CLIENT_NAME, version: image.version });
    const captureDir = join(RAW_CAPTURE_DIR, readingName.slice(0, -".json".length));

    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();

    // Serial, not concurrent. Each arm starts a real client that binds a socket and talks to a
    // loopback server; two of them at once would be measuring a machine under a load the
    // deployment never puts it under, and the settle ceilings would no longer bound comparable
    // windows.
    const runs: ProbeRun[] = [];
    for (const shape of ["interactive", "headless"] as const) {
      for (const inject of [true, false]) {
        runs.push(await runQualificationProbe({ shape, inject, captureDir, image }));
      }
    }

    const receipt = buildReceipt({ image, headSha, runs, limits: LIMITS, findings: FINDINGS });
    return { receipt, path: recordReading(receipt) };
  } finally {
    image.release();
  }
};

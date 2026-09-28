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
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import { startFakeAnthropic, type FakeAnthropic } from "../native-session-inbox/fake-anthropic.ts";
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
 * Deleted, not applied, so this text is not the screen: a renderer that repaints by difference
 * leaves words in it that were never drawn (see `interactiveReadiness`), which is why readiness
 * does not read it. Nothing is *measured* off this text either -- the measurement is the provider
 * capture. A terminal rendering is a picture of a screen, and a session that printed the wake and
 * did nothing with it would look identical to one that acted on it.
 */
const ANSI = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

/**
 * The pty's size. `pty-session.py` fixes it with `TIOCSWINSZ`, and the screen model below has to
 * be the same size: the client addresses the screen with absolute cursor moves, and a model of
 * another size puts them on other cells. A test reads both.
 */
export const PTY_ROWS = 40;
export const PTY_COLS = 120;

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
   * Optional only because the readings committed before this field existed do not carry it; every
   * run `runQualificationProbe` returns does.
   */
  readonly imageSha256?: string;
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

export const strip = (raw: string): string => raw.replace(ANSI, "").replace(/\r/g, "\n");

/**
 * The client's stdout as text, decoded as one stream rather than read by read.
 *
 * A read ends wherever the pipe happened to be drained, not on a character boundary: of eleven
 * first screens captured on 2026-09-28, three split a three-byte glyph (`─`, `←`) across two reads.
 * `chunk.toString()` turns each half into U+FFFD -- two or three cells where the terminal drew
 * one -- and a split on the input row would move the modelled caret off the cell the client parks
 * its cursor on, so readiness would never fire. `StringDecoder` holds an incomplete sequence back
 * until the rest of it arrives.
 */
export const terminalTranscript = (): { readonly push: (chunk: Buffer) => void; readonly text: () => string } => {
  const decoder = new StringDecoder("utf8");
  let text = "";
  return {
    push: (chunk) => {
      text += decoder.write(chunk);
    },
    text: () => text,
  };
};

interface Cell {
  glyph: string;
  readonly inverse: boolean;
}

const blankCell = (): Cell => ({ glyph: " ", inverse: false });
const blankRow = (): Cell[] => Array.from({ length: PTY_COLS }, blankCell);
const blankGrid = (): Cell[][] => Array.from({ length: PTY_ROWS }, blankRow);

/**
 * How many cells a code point takes. Approximate on purpose: the common wide ranges (CJK, Hangul,
 * full-width forms, the two main emoji blocks) and the zero-width marks, not a Unicode table.
 * Every glyph the measured builds draw on their input row is narrow, and a width this gets wrong
 * only shifts cells written after it on the same row by relative moves -- on the input row that
 * fails closed, because the park is absolute and would miss the caret.
 */
const cellWidth = (codePoint: number): 0 | 1 | 2 => {
  if ((codePoint >= 0x0300 && codePoint <= 0x036f) || (codePoint >= 0x200b && codePoint <= 0x200f)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0x20d0 && codePoint <= 0x20ff)) {
    return 0;
  }
  if ((codePoint >= 0x1100 && codePoint <= 0x115f) || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3) || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6) || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
    || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) || (codePoint >= 0x20000 && codePoint <= 0x3fffd)) {
    return 2;
  }
  return 1;
};

interface RenderedScreen {
  readonly grid: readonly (readonly Cell[])[];
  readonly row: number;
  readonly col: number;
  readonly fullScreen: boolean;
  readonly cursorHidden: boolean;
  /**
   * Every sequence in the stream this model did not apply, named as it appeared, in the order first
   * seen. The grid is claimed to be the terminal's only while this is empty.
   */
  readonly unmodelled: readonly string[];
}

/**
 * A sequence as a reader can find it in the session log: ESC spelled out, every other control as
 * `\xNN`, and a long string cut, since an image or a clipboard payload can run to kilobytes.
 */
const nameSequence = (raw: string): string => {
  const shown = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, (control) =>
    control === "\u001b" ? "ESC" : `\\x${control.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return shown.length > 40 ? `${shown.slice(0, 39)}…` : shown;
};

/**
 * DEC private modes whose setting changes neither what a cell holds nor where the cursor is: what
 * the keys and the mouse send (1, 9, 66, 1000-1007, 1015, 1016), focus reports (1004), bracketed
 * paste (2004), cursor blink (12), synchronized output (2026, which defers painting and leaves the
 * grid as it would be) and palette notifications (2031). 25, 47, 1047, 1048, 1049 and 7 are
 * applied rather than listed. A mode that is not here and not applied is unmodelled.
 */
const INERT_PRIVATE_MODES: ReadonlySet<number> = new Set([
  1, 9, 12, 66, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1015, 1016, 2004, 2026, 2031,
]);

/**
 * CSI sequences that ask or tell the terminal something without drawing, keyed by marker,
 * intermediates and final: device attributes (`c`, `>c`, `=c`), status reports (`n`, `?n`), the
 * version query (`>q`), key-modifier and keyboard-protocol negotiation (`>m`, `>n`, `>u`, `<u`,
 * `=u`, `?u`), pointer and title modes (`>p`, `>t`, `>T`), cursor shape (` q`) and mode queries
 * (`$p`, `?$p`).
 */
const INERT_CSI: ReadonlySet<string> = new Set([
  "c", ">c", "=c", "n", "?n", ">q", ">m", ">n", ">u", "<u", "=u", "?u", ">p", ">t", ">T", " q", "$p", "?$p",
]);

/**
 * Window operations (`CSI Ps t`) that only report or push and pop the title. The rest move, resize
 * or refresh the window, and resizing is a different grid.
 */
const INERT_WINDOW_OPERATIONS: ReadonlySet<number> = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23]);

/**
 * Operating-system commands that change no cell: titles (0-2), the palette and dynamic colours
 * (4, 10-19, 104, 105, 110-119), the working directory (7), hyperlinks (8), notifications (9, 777),
 * the pointer shape (22), the clipboard (52) and shell-integration marks (133, 633). Anything else,
 * inline images among them, is unmodelled.
 */
const INERT_OSC: ReadonlySet<number> = new Set([
  0, 1, 2, 4, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 22, 52, 104, 105, 110, 111, 112, 113, 114, 115,
  116, 117, 118, 119, 133, 633, 777,
]);

/** Controls that are applied (BS, HT, LF, VT, FF, CR) or that a terminal ignores (NUL, BEL, DEL). */
const KNOWN_CONTROLS: ReadonlySet<number> = new Set([0x00, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x7f]);

/**
 * Applies a terminal stream to a `PTY_ROWS` x `PTY_COLS` grid, and names every part of it that it
 * did not apply.
 *
 * Closed, not best-effort. Each sequence falls in exactly one of three sets:
 *
 *   - **Applied.** Printing and autowrap; absolute and relative cursor moves, with CUU, CUD, CNL
 *     and CPL stopping at a scroll margin as a terminal's do; saving and restoring the cursor with
 *     the inverse attribute it carries (DECSC/DECRC, `CSI s`/`CSI u`, mode 1048); the alternate
 *     screen (47, 1047, 1049); erasing (ED, EL, ECH); the scroll region (DECSTBM) and everything
 *     that moves lines within it -- a line feed in any of its forms (LF, VT, FF, IND, NEL) and a
 *     reverse index (RI) at a margin, insert and delete line (IL, DL), scroll up and down (SU, SD);
 *     insert and delete character (ICH, DCH); and inverse video (SGR 7, 27, 0), the one attribute
 *     readiness reads.
 *   - **Inert.** Sequences that by definition change no cell and do not move the cursor: queries
 *     and reports, input and keyboard modes, synchronized output, cursor visibility and shape,
 *     titles, colours, hyperlinks, the clipboard, and character-set designations, which change a
 *     glyph and never its width. Each is named in one of the lists above, with its reason.
 *   - **Unmodelled.** Everything else, including every sequence this file has never heard of. It is
 *     recorded by name in `unmodelled`, and from then on the grid is not claimed to be the
 *     terminal's: readiness refuses for the rest of the stream, because a sequence that moved cells
 *     leaves them moved and nothing later says which.
 *
 * The third set is what makes the first two worth trusting. Until 2026-09-28 an unknown final fell
 * through a `default: break`: an insert-line was dropped, the model kept a caret on a row the
 * terminal had moved, and readiness fired on a screen that was wrong without saying so. An
 * allow-list and not a deny-list, because a deny-list fires only on the sequences its author
 * thought of, which is the same defect with a smaller surface.
 *
 * An escape sequence still incomplete at the end of the stream is left unapplied until the rest of
 * it arrives. At that instant a terminal has not applied it either.
 */
const renderScreen = (stream: string): RenderedScreen => {
  const main = blankGrid();
  let alternate = blankGrid();
  let grid = main;
  let fullScreen = false;
  let cursorHidden = false;
  let row = 0;
  let col = 0;
  // A glyph written into the last column leaves the cursor there, and only the next glyph wraps.
  // Without this, a full-width rule followed by `CR` + one-row-down lands a row too low.
  let wrapPending = false;
  let inverse = false;
  // The scroll region, 0-based and inclusive: the whole screen until DECSTBM says otherwise.
  let top = 0;
  let bottom = PTY_ROWS - 1;
  let saved = { row: 0, col: 0, inverse: false };
  const unmodelled: string[] = [];

  const refuse = (raw: string): void => {
    const name = nameSequence(raw);
    if (!unmodelled.includes(name)) unmodelled.push(name);
  };

  const moveTo = (toRow: number, toCol: number): void => {
    row = Math.min(PTY_ROWS - 1, Math.max(0, toRow));
    col = Math.min(PTY_COLS - 1, Math.max(0, toCol));
    wrapPending = false;
  };
  // A vertical move that starts inside the region stops at its margin; one that starts outside
  // stops at the edge of the screen.
  const up = (count: number): void => moveTo(Math.max(row >= top ? top : 0, row - count), col);
  const down = (count: number): void => moveTo(Math.min(row <= bottom ? bottom : PTY_ROWS - 1, row + count), col);

  const blankRows = (count: number): Cell[][] => Array.from({ length: count }, blankRow);
  // The region's lines move up: the top ones leave it and blank ones enter at the bottom margin.
  const scrollUp = (count: number): void => {
    const span = Math.min(count, bottom - top + 1);
    grid.splice(top, span);
    grid.splice(bottom - span + 1, 0, ...blankRows(span));
  };
  const scrollDown = (count: number): void => {
    const span = Math.min(count, bottom - top + 1);
    grid.splice(bottom - span + 1, span);
    grid.splice(top, 0, ...blankRows(span));
  };
  // IL and DL act only on a cursor inside the region, move the lines from the cursor down to the
  // bottom margin, and leave the cursor in the first column.
  const insertLines = (count: number): void => {
    if (row < top || row > bottom) return;
    const span = Math.min(count, bottom - row + 1);
    grid.splice(bottom - span + 1, span);
    grid.splice(row, 0, ...blankRows(span));
    moveTo(row, 0);
  };
  const deleteLines = (count: number): void => {
    if (row < top || row > bottom) return;
    const span = Math.min(count, bottom - row + 1);
    grid.splice(row, span);
    grid.splice(bottom - span + 1, 0, ...blankRows(span));
    moveTo(row, 0);
  };
  // ICH and DCH move the rest of the cursor's line right or left; the cursor stays where it is.
  const insertCells = (count: number): void => {
    const line = grid[row];
    if (line === undefined) return;
    const span = Math.min(count, PTY_COLS - col);
    line.splice(PTY_COLS - span, span);
    line.splice(col, 0, ...Array.from({ length: span }, blankCell));
    wrapPending = false;
  };
  const deleteCells = (count: number): void => {
    const line = grid[row];
    if (line === undefined) return;
    const span = Math.min(count, PTY_COLS - col);
    line.splice(col, span);
    line.push(...Array.from({ length: span }, blankCell));
    wrapPending = false;
  };
  const lineFeed = (): void => {
    if (row === bottom) scrollUp(1);
    else if (row < PTY_ROWS - 1) row += 1;
  };
  const reverseIndex = (): void => {
    if (row === top) scrollDown(1);
    else if (row > 0) row -= 1;
  };
  const erase = (onRow: number, from: number, to: number): void => {
    const line = grid[onRow];
    if (line === undefined) return;
    for (let at = Math.max(0, from); at < Math.min(PTY_COLS, to); at += 1) line[at] = blankCell();
  };
  // The attribute goes with the position: a restore that kept the current inverse would paint
  // the next blank as a caret the client never drew.
  const saveCursor = (): void => {
    saved = { row, col, inverse };
  };
  const restoreCursor = (): void => {
    moveTo(saved.row, saved.col);
    inverse = saved.inverse;
  };
  // 1049 saves the cursor and clears the alternate screen on the way in and restores the cursor
  // on the way out; 1047 clears it on the way out; 47 does neither.
  const useScreen = (wanted: boolean, mode: number): void => {
    if (wanted === fullScreen) return;
    if (wanted) {
      if (mode === 1049) {
        saveCursor();
        alternate = blankGrid();
      }
      grid = alternate;
    } else {
      if (mode === 1047) alternate = blankGrid();
      grid = main;
      if (mode === 1049) restoreCursor();
    }
    fullScreen = wanted;
  };
  const put = (glyph: string, width: 0 | 1 | 2): void => {
    if (width === 0) {
      const previous = grid[row]?.[wrapPending ? col : Math.max(0, col - 1)];
      if (previous !== undefined) previous.glyph += glyph;
      return;
    }
    if (wrapPending || (width === 2 && col === PTY_COLS - 1)) {
      col = 0;
      lineFeed();
      wrapPending = false;
    }
    const line = grid[row];
    if (line === undefined) return;
    line[col] = { glyph, inverse };
    if (width === 2 && col + 1 < PTY_COLS) line[col + 1] = { glyph: "", inverse };
    if (col + width >= PTY_COLS) {
      col = PTY_COLS - 1;
      wrapPending = true;
    } else {
      col += width;
    }
  };

  const sgr = (tokens: readonly string[]): void => {
    if (tokens.length === 0) inverse = false;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index] ?? "";
      // `38:5:174` carries its own arguments; only the `;` form spends the tokens after it.
      if (token.includes(":")) continue;
      const code = token === "" ? 0 : Number(token);
      if (code === 0 || code === 27) inverse = false;
      else if (code === 7) inverse = true;
      else if (code === 38 || code === 48 || code === 58) {
        const kind = tokens[index + 1];
        index += kind === "5" ? 2 : kind === "2" ? 4 : 0;
      }
    }
  };

  const csi = (raw: string, body: string, final: string): void => {
    // Marker, parameters, intermediates, in that order and nothing else. A body of any other shape
    // is one a terminal would read in some way this model cannot know.
    const shape = /^([<=>?]?)([0-9:;]*)([ -/]*)$/.exec(body);
    if (shape === null) {
      refuse(raw);
      return;
    }
    const marker = shape[1] ?? "";
    const parameters = shape[2] ?? "";
    const intermediates = shape[3] ?? "";
    const tokens = parameters.length === 0 ? [] : parameters.split(";");
    if (marker === "" && intermediates === "" && final === "m") {
      sgr(tokens);
      return;
    }
    // Colon sub-parameters mean something to SGR alone.
    if (tokens.some((token) => !/^\d*$/.test(token))) {
      refuse(raw);
      return;
    }
    const count = (index: number): number => {
      const value = Number.parseInt(tokens[index] ?? "", 10);
      return Number.isNaN(value) || value < 1 ? 1 : value;
    };
    const mode = Number.parseInt(tokens[0] ?? "", 10) || 0;

    if (marker === "?" && intermediates === "" && (final === "h" || final === "l")) {
      const set = final === "h";
      for (const token of tokens) {
        const privateMode = Number(token);
        if (privateMode === 25) cursorHidden = !set;
        else if (privateMode === 47 || privateMode === 1047 || privateMode === 1049) useScreen(set, privateMode);
        else if (privateMode === 1048) {
          if (set) saveCursor();
          else restoreCursor();
        } else if (privateMode === 7 && set) {
          // Autowrap on is the power-on state and what `put` does. Only turning it off is a change
          // this model would miss, and that is unmodelled below.
        } else if (!INERT_PRIVATE_MODES.has(privateMode)) {
          refuse(`\u001b[?${token}${final}`);
        }
      }
      return;
    }
    if (INERT_CSI.has(`${marker}${intermediates}${final}`)) return;
    if (marker !== "" || intermediates !== "") {
      refuse(raw);
      return;
    }

    switch (final) {
      case "A": up(count(0)); break;
      case "B": case "e": down(count(0)); break;
      case "C": case "a": moveTo(row, col + count(0)); break;
      case "D": moveTo(row, col - count(0)); break;
      case "E": down(count(0)); col = 0; break;
      case "F": up(count(0)); col = 0; break;
      case "G": case "`": moveTo(row, count(0) - 1); break;
      case "d": moveTo(count(0) - 1, col); break;
      case "H": case "f": moveTo(count(0) - 1, count(1) - 1); break;
      case "J":
        if (mode === 0) {
          erase(row, col, PTY_COLS);
          for (let below = row + 1; below < PTY_ROWS; below += 1) erase(below, 0, PTY_COLS);
        } else if (mode === 1) {
          for (let above = 0; above < row; above += 1) erase(above, 0, PTY_COLS);
          erase(row, 0, col + 1);
        } else if (mode === 2) {
          for (let every = 0; every < PTY_ROWS; every += 1) erase(every, 0, PTY_COLS);
        } else if (mode !== 3) {
          // 3 erases the scrollback, which is not on the screen.
          refuse(raw);
        }
        break;
      case "K":
        if (mode === 0) erase(row, col, PTY_COLS);
        else if (mode === 1) erase(row, 0, col + 1);
        else if (mode === 2) erase(row, 0, PTY_COLS);
        else refuse(raw);
        break;
      case "X": erase(row, col, col + count(0)); break;
      case "@": insertCells(count(0)); break;
      case "P": deleteCells(count(0)); break;
      case "L": insertLines(count(0)); break;
      case "M": deleteLines(count(0)); break;
      case "S": scrollUp(count(0)); break;
      // With five parameters this final is mouse highlight tracking, not a scroll.
      case "T": if (tokens.length <= 1) scrollDown(count(0)); else refuse(raw); break;
      case "r": {
        if (tokens.length > 2) {
          refuse(raw);
          break;
        }
        const first = Number.parseInt(tokens[0] ?? "", 10);
        const last = Number.parseInt(tokens[1] ?? "", 10);
        const newTop = (Number.isNaN(first) || first < 1 ? 1 : first) - 1;
        const newBottom = Math.min(PTY_ROWS, Number.isNaN(last) || last < 1 ? PTY_ROWS : last) - 1;
        // A region under two lines is ignored by the terminal, cursor and all, and so here.
        if (newTop < newBottom) {
          top = newTop;
          bottom = newBottom;
          moveTo(0, 0);
        }
        break;
      }
      // With parameters these are left and right margins, which this model does not keep.
      case "s": if (tokens.length === 0) saveCursor(); else refuse(raw); break;
      case "u": if (tokens.length === 0) restoreCursor(); else refuse(raw); break;
      case "t": if (!INERT_WINDOW_OPERATIONS.has(mode)) refuse(raw); break;
      default: refuse(raw); break;
    }
  };

  for (let at = 0; at < stream.length;) {
    const char = stream.charAt(at);
    if (char === "\u001b") {
      const next = stream.charAt(at + 1);
      if (next === "") break;
      if (next === "[") {
        let end = at + 2;
        while (end < stream.length && !/[@-~]/.test(stream.charAt(end))) end += 1;
        if (end >= stream.length) break;
        csi(stream.slice(at, end + 1), stream.slice(at + 2, end), stream.charAt(end));
        at = end + 1;
        continue;
      }
      if ("]P_^X".includes(next)) {
        let end = at + 2;
        while (end < stream.length && stream.charAt(end) !== "\u0007"
          && !(stream.charAt(end) === "\u001b" && stream.charAt(end + 1) === "\\")) end += 1;
        if (end >= stream.length) break;
        const after = stream.charAt(end) === "\u0007" ? end + 1 : end + 2;
        const content = stream.slice(at + 2, end);
        const raw = stream.slice(at, after);
        if (next === "]") {
          const command = /^(\d+)(?:;|$)/.exec(content)?.[1];
          if (command === undefined || !INERT_OSC.has(Number(command))) refuse(raw);
        } else if (next === "P") {
          // Only the two queries: every other device-control string -- sixel above all -- draws.
          if (!content.startsWith("$q") && !content.startsWith("+q")) refuse(raw);
        } else if (next === "_") {
          // Application program commands carry the kitty graphics protocol, which places images.
          refuse(raw);
        }
        // Privacy messages and start-of-string are read and discarded by the terminal.
        at = after;
        continue;
      }
      // ESC, any intermediates (0x20-0x2F), one final (0x30-0x7E).
      let end = at + 1;
      while (end < stream.length && /[ -/]/.test(stream.charAt(end))) end += 1;
      if (end >= stream.length) break;
      const raw = stream.slice(at, end + 1);
      const intermediates = stream.slice(at + 1, end);
      const final = stream.charAt(end);
      if (!/[0-~]/.test(final)) {
        // Not an escape sequence at all. The byte after it is left for the loop to read again.
        refuse(stream.slice(at, end));
        at = end;
        continue;
      }
      if (intermediates === "") {
        if (final === "7") saveCursor();
        else if (final === "8") restoreCursor();
        else if (final === "D") {
          lineFeed();
          wrapPending = false;
        } else if (final === "E") {
          lineFeed();
          col = 0;
          wrapPending = false;
        } else if (final === "M") {
          reverseIndex();
          wrapPending = false;
        } else if (final !== "=" && final !== ">" && final !== "\\") {
          // `=` and `>` are keypad modes, and `\` is a string terminator with no string open.
          refuse(raw);
        }
      } else if (intermediates.length !== 1 || !"()*+-./".includes(intermediates)) {
        // One intermediate from that set designates a character set, which changes a glyph and
        // never its width. Everything else here -- DECALN's `ESC # 8`, line sizes, `ESC % G` -- is
        // not modelled.
        refuse(raw);
      }
      at = end + 1;
      continue;
    }
    if (char === "\r") {
      col = 0;
      wrapPending = false;
    } else if (char === "\n" || char === "\u000b" || char === "\u000c") {
      lineFeed();
      wrapPending = false;
    } else if (char === "\b") {
      moveTo(row, col - 1);
    } else if (char === "\t") {
      moveTo(row, (Math.floor(col / 8) + 1) * 8);
    }
    const codePoint = stream.codePointAt(at) ?? 0;
    const glyph = String.fromCodePoint(codePoint);
    at += glyph.length;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
      // A C1 control is one a UTF-8 terminal may act on: U+009B is CSI.
      if (!KNOWN_CONTROLS.has(codePoint)) refuse(glyph);
      continue;
    }
    put(glyph, cellWidth(codePoint));
  }

  return { grid, row, col, fullScreen, cursorHidden, unmodelled };
};

export interface InteractiveReadiness {
  /** The decision: `cursorOnCaret`, on a screen the model applied every sequence of. */
  readonly ready: boolean;
  readonly cursorOnCaret: boolean;
  /**
   * Every sequence the screen model did not apply, named as it appeared. Non-empty means the
   * rendered screen may not be the terminal's, and readiness refuses whatever the cursor is over.
   */
  readonly unmodelled: readonly string[];
  /** 1-based, as the terminal's own cursor moves number them, so a report reads against the log. */
  readonly cursor: { readonly row: number; readonly column: number };
  readonly underCursor: string;
  /** Every inverse-video blank on screen. None, or one away from the cursor, is a diagnosis. */
  readonly carets: readonly { readonly row: number; readonly column: number }[];
  /** Context for a report, and deliberately not decision inputs. */
  readonly fullScreen: boolean;
  readonly terminalCursorHidden: boolean;
  /** The rendered rows, trailing blanks trimmed. */
  readonly screen: readonly string[];
}

/**
 * Whether the interactive client is at an empty prompt that will take typing, read off the
 * *rendered* screen by one structural fact: the cursor has come to rest on a caret the client drew.
 *
 * Why that fact. The client does not use the terminal's cursor for its input. It hides it
 * (`CSI ?25l`), paints the cell where the next keystroke will land in inverse video, and ends every
 * frame by moving the real cursor back onto that cell. Measured on 2.1.268, 2.1.281, 2.1.282 and
 * 2.1.283 (`first-screens/`): the input row is `❯ ` then an inverse blank, and every frame closes
 * with `CSI 40;1H CSI 38;3H`, which is that blank. The caret is drawn by a focused, editable input
 * -- on these screens by nothing else -- and the park is the renderer's last write of a complete
 * frame, so "the cursor rests on an inverse blank" says that a frame finished and that in it an
 * empty input owns the keyboard. That is the precondition of the next thing the probe does, which
 * is to type into it.
 *
 * Why not the prose. This was `/for shortcuts/` over `strip()` output, and 2.1.283 never satisfied
 * it -- not because the hint changed, but because the renderer repaints by difference. Going from
 * "(shift+tab to cycle)" to "? for shortcuts" it skips the `c` already on screen with `CSI 34G`,
 * and deleting escapes instead of applying them reads `shortuts`. The screen said `shortcuts` the
 * whole time. A phrase match over `strip()` is at the mercy of which cells the previous frame
 * happened to share, and the wording is one more way to lose it.
 *
 * Why not the prompt glyph. `❯` is also the pointer of the client's menus: the workspace-trust
 * dialog draws `❯ No, exit` and parks the cursor on it
 * (`first-screens/claude-code@2.1.283.workspace-trust.json`). Typing there answers a dialog, which
 * pre-provisioning the config exists to avoid. The pointer is drawn in colour, not inverse, so it
 * is not a caret.
 *
 * Why the whole screen has to have been applied. The cell under the cursor is only the terminal's
 * cell if every sequence before it was applied as a terminal would apply it. An insert-line the
 * model dropped leaves an inverse blank on a row the terminal has moved, and a park on that row
 * then reads as ready while the terminal's cursor rests on something else. So a stream carrying
 * any sequence `renderScreen` does not apply is not ready, whatever the cursor is over, and
 * `describeReadiness` names the sequence.
 *
 * What would make this stale: the client showing the terminal's cursor instead of drawing one,
 * drawing its caret in something other than inverse video, ending a frame with the cursor anywhere
 * but the caret, or drawing its screen with a sequence the model does not apply. Each fails closed
 * -- readiness never fires -- and `describeReadiness` says which of the facts below were seen. There
 * is no prose fallback, on purpose: a fallback fires on exactly the build where this stopped
 * describing the client, and hides that it did.
 */
export const interactiveReadiness = (stream: string): InteractiveReadiness => {
  const rendered = renderScreen(stream);
  const under = rendered.grid[rendered.row]?.[rendered.col];
  const cursorOnCaret = under !== undefined && under.inverse && under.glyph === " ";
  const ready = cursorOnCaret && rendered.unmodelled.length === 0;
  const carets: { row: number; column: number }[] = [];
  rendered.grid.forEach((line, rowIndex) => {
    line.forEach((cell, colIndex) => {
      if (cell.inverse && cell.glyph === " ") carets.push({ row: rowIndex + 1, column: colIndex + 1 });
    });
  });
  return {
    ready,
    cursorOnCaret,
    unmodelled: rendered.unmodelled,
    cursor: { row: rendered.row + 1, column: rendered.col + 1 },
    underCursor: under?.glyph ?? "",
    carets,
    fullScreen: rendered.fullScreen,
    terminalCursorHidden: rendered.cursorHidden,
    screen: rendered.grid.map((line) => line.map((cell) => cell.glyph).join("").trimEnd()),
  };
};

/** What a wait that never saw a prompt reports: the signal looked for, and each part of it as seen. */
export const describeReadiness = (reading: InteractiveReadiness): string => {
  const at = (cell: { readonly row: number; readonly column: number }): string => `row ${cell.row}, column ${cell.column}`;
  const drawn = reading.screen
    .map((line, index) => ({ line, row: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, row }) => `${String(row).padStart(2)}| ${line}`);
  return [
    "looked for: the cursor at rest on a caret the client drew (an inverse-video blank cell), on a screen the model applied in full",
    `  cursor on a caret: ${reading.cursorOnCaret ? "yes" : "no"}`,
    `  every sequence applied: ${reading.unmodelled.length === 0 ? "yes" : `no -- not modelled: ${reading.unmodelled.join(", ")}`}`,
    `  cursor: ${at(reading.cursor)}, over ${JSON.stringify(reading.underCursor)}`,
    `  carets drawn: ${reading.carets.length === 0 ? "none" : reading.carets.map(at).join("; ")}`,
    "seen, as context rather than as inputs to the decision:",
    `  full-screen buffer entered: ${reading.fullScreen ? "yes" : "no"}`,
    `  terminal cursor hidden: ${reading.terminalCursorHidden ? "yes" : "no"}`,
    "--- rendered screen, non-blank rows ---",
    ...(drawn.length === 0 ? ["(blank)"] : drawn),
  ].join("\n");
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
  const terminal = terminalTranscript();
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
    const command = [image.executable, ...args];

    if (options.shape === "interactive") {
      const pty = resolvePtyAllocator();
      if (pty === null) throw new Error("no python3 to allocate a pty for an interactive start");
      child = spawn(pty.python, [pty.script, ...command], {
        env,
        cwd: workDir,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } else {
      child = spawn(image.executable, args, { env, cwd: workDir, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    }
    child.stdout.on("data", (chunk: Buffer) => {
      terminal.push(chunk);
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
      const ready = await waitFor(() => interactiveReadiness(terminal.text()).ready, 60_000);
      if (!ready) {
        throw new Error(
          `the interactive client never reached its prompt\n${describeReadiness(interactiveReadiness(terminal.text()))}\n` +
            `--- terminal tail, escapes deleted rather than applied ---\n${strip(terminal.text()).slice(-2000)}`,
        );
      }
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
    // Read after the measurement, through the name this arm was started by. A throw here fails the
    // arm, and with it the run, before anything is recorded (see `confirmHeld`).
    const imageSha256 = confirmHeld(image);
    mkdirSync(durableDir, { recursive: true });
    copyFileSync(capturePath, durableCapture);
    writeFileSync(sessionLogPath, `${strip(terminal.text())}\n--- stderr ---\n${stderr}`);
    copyFileSync(sessionLogPath, durableLog);

    return (run = {
      shape: options.shape,
      injected: options.inject,
      command: command.map(redactHome),
      imageSha256,
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
    verdict: qualified ? "qualified" : "not-qualified",
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
  members.forEach((member, index) => {
    if (members.findIndex((other) => isWakeTransportQualified(other, [member])) !== index) {
      problems.push(`${label(member)} is listed in the qualified set more than once`);
    }
    const own = readings.filter(({ reading }) => isWakeTransportQualified(reading.client, [member]));
    if (own.length === 0) {
      problems.push(`${label(member)} is a qualified member with no reading`);
    }
    for (const { file, reading } of own) {
      if (reading.verdict !== "qualified") {
        problems.push(`${label(member)} is a qualified member resting on ${file}, whose verdict is ${JSON.stringify(reading.verdict)}`);
      }
    }
  });
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
  "The endpoint-directory policy is untouched by this slice, so registration through registerEndpoint is still refused for a socket outside the daemon state directory. See the finding of that name.",
  "Interactive start required pre-provisioned answers to the onboarding, workspace-trust and custom-API-key prompts in a throwaway config. A session whose operator answered them differently is outside this reading.",
  "settleCeilingMs is a ceiling on the post-injection wait, not a duration either arm was observed for. The control spends the whole ceiling; the injection arm returns on its first follow-up request. Two arms sharing a ceiling were watched for at most the same time, not for the same time, and the actual spans are not recorded here.",
  "Every arm executed one hard link, in a directory private to the run, to the inode digested as imageSha256 -- the command's first element names that link, which is removed with the run, and imagePath names where the inode was found. Each arm re-read the link's identity, size, modification time and digest after its measurement and would have failed the run on a difference. A rewrite of that inode in place, undone before the re-read, would not have been seen.",
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

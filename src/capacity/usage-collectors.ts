import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import type { Clock } from "../core/clock.ts";
import { sha256 } from "../core/digest.ts";
import type { CapacityBucket, CapacityReading } from "../runtime/provider.ts";

export type UsageProvider = "claude" | "gpt" | "grok";

export interface UsageCollector {
  collect(): Promise<CapacityReading>;
}

export interface UsageTerminalStep {
  /** Bytes sent to the interactive CLI, usually a slash command followed by carriage return. */
  input: string;
  /** Do not send the next step until this text appears in terminal output. */
  waitFor?: RegExp;
}

export interface UsageTerminalResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error: string | null;
}

export interface UsageTerminal {
  run(input: {
    binary: string;
    args: readonly string[];
    steps: readonly UsageTerminalStep[];
    timeoutMs: number;
    environment: NodeJS.ProcessEnv;
  }): Promise<UsageTerminalResult>;
}

export interface UsageCollectorOptions {
  clock: Clock;
  binary: string;
  timeoutMs?: number;
  terminal?: UsageTerminal;
  /** Provider-specific dedicated credential configuration, never a daemon env dump. */
  providerCredentialDir?: string;
}

const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * macOS ships `expect(1)`, which creates a real pseudo-terminal without introducing a
 * native node-pty dependency. The collector sends only /usage and any documented
 * non-authority navigation needed to reveal it; it never auto-accepts a trust prompt or
 * an approval dialog.
 */
export class ExpectUsageTerminal implements UsageTerminal {
  async run(input: {
    binary: string;
    args: readonly string[];
    steps: readonly UsageTerminalStep[];
    timeoutMs: number;
    environment: NodeJS.ProcessEnv;
  }): Promise<UsageTerminalResult> {
    if (!existsSync("/usr/bin/expect")) {
      return {
        stdout: "",
        stderr: "pty launcher /usr/bin/expect is unavailable",
        exitCode: null,
        timedOut: false,
        error: "pty launcher unavailable",
      };
    }
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("/usr/bin/expect", ["-f", "-", "--", input.binary, ...input.args], {
          env: input.environment,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        resolve({
          stdout: "",
          stderr: error instanceof Error ? error.message : "could not start pty",
          exitCode: null,
          timedOut: false,
          error: "could not start pty",
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const stop = (signal: NodeJS.Signals = "SIGTERM"): void => {
        try {
          process.kill(-(child.pid ?? 0), signal);
        } catch {
          child.kill(signal);
        }
      };
      const finish = (result: UsageTerminalResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const advanceFromOutput = (): void => {
        const clean = stripTerminal(stdout);
        if (looksLikeTrustOrApprovalPrompt(clean)) {
          stop();
          finish({
            stdout,
            stderr,
            exitCode: null,
            timedOut: false,
            error: "interactive CLI requested trust or approval; collector refuses to approve it",
          });
          return;
        }
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        stop("SIGKILL");
        finish({ stdout, stderr, exitCode: null, timedOut, error: "interactive /usage timed out" });
      }, input.timeoutMs);

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
        advanceFromOutput();
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
        advanceFromOutput();
      });
      child.on("error", (error) => {
        stderr += error.message;
        finish({ stdout, stderr, exitCode: null, timedOut, error: error.message });
      });
      child.on("close", (exitCode) => finish({ stdout, stderr, exitCode, timedOut, error: null }));

      child.stdin?.end(expectProgram(input.steps, input.timeoutMs));
    });
  }
}

const tclString = (value: string): string => JSON.stringify(value);

/** Build a fixed, narrow Expect program; provider argv remains an argv list, never shell. */
const expectProgram = (steps: readonly UsageTerminalStep[], timeoutMs: number): string => {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const lines = [
    "log_user 1",
    // The pty size is pinned because it is otherwise ambient — inherited from whatever
    // terminal launched the daemon, and under launchd there is none. Measured on claude
    // 2.1.233 (#570): at the default width one reset line arrives truncated to `ets …
    // (Asia/Soul)` while another on the same screen reads `Resets … (Asia/Seoul)` intact.
    // Width does not buy same-line layout — the label, bar and reset stay on separate lines
    // at 200 columns too — so the only thing it changes is character fidelity, and wider is
    // strictly better there. The spaces it costs are already irrelevant: the parser matches
    // against a space-stripped copy because a TUI supplies no reliable ones at any width.
    "set stty_init \"rows 60 cols 200\"",
    "set timeout 10",
    // `spawn` does not support a `--` sentinel. `argv` is supplied by Node as a Tcl
    // list, not interpolated shell text, so this remains an argument-vector launch.
    "eval spawn -noecho $argv",
    "after 100",
  ];
  for (const step of steps) {
    lines.push(`send -- ${tclString(step.input)}`);
    if (step.waitFor) {
      lines.push(
        `set timeout ${seconds}`,
        "expect {",
        `  -re ${tclString(`${step.waitFor.ignoreCase ? "(?i)" : ""}${step.waitFor.source}`)} { }`,
        "  timeout { exit 124 }",
        "  eof { exit 125 }",
        "}",
      );
    }
  }
  lines.push(
    `set timeout ${seconds}`,
    "expect {",
    "  -re {.+} { set timeout 2; exp_continue }",
    // A quiet terminal after it has emitted usage data is the normal completion
    // condition for a long-lived interactive CLI. The outer timer still fails a
    // CLI which never emits anything at all.
    "  timeout { exit 0 }",
    "  eof { }",
    "}",
    "exit 0",
  );
  return `${lines.join("\n")}\n`;
};

const terminalEnvironment = (
  provider: UsageProvider,
  credentialDir?: string,
): NodeJS.ProcessEnv => ({
  PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  ...(process.env["HOME"] ? { HOME: process.env["HOME"] } : {}),
  ...(process.env["USER"] ? { USER: process.env["USER"] } : {}),
  TERM: "xterm-256color",
  LANG: "C.UTF-8",
  LC_ALL: "C",
  ...(provider === "claude" && credentialDir
    ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: credentialDir }
    : {}),
  ...(provider === "gpt" && credentialDir ? { CODEX_HOME: credentialDir } : {}),
});

const CAPABILITIES: Readonly<Record<UsageProvider, readonly string[]>> = {
  gpt: ["ceo", "blind-review", "worker", "luna-worker"],
  claude: ["cto", "ceo", "blind-review", "worker"],
  // Grok's only production role is optional diversity. It must never advertise a
  // critical continuity capability merely because its usage command happened to work.
  grok: ["adversarial-review"],
};

const CLI: Readonly<Record<UsageProvider, { args: readonly string[]; steps: readonly UsageTerminalStep[] }>> = {
  claude: {
    args: ["--no-chrome", "--safe-mode"],
    // The empty first step sends nothing and waits. `expectProgram` spawns, pauses 100 ms and
    // then writes the next step, which is far sooner than this TUI can accept input — the
    // keystrokes are dropped and the capture is the startup banner and nothing else. Measured
    // against claude 2.1.233:
    //
    //   send at 100 ms          22 lines, 0 containing a percentage   (banner only)
    //   send after the banner   49 lines, 4 containing a percentage   (the usage screen)
    //
    // A `waitFor` on the `/usage` step itself cannot express this: `expectProgram` emits the
    // `send` first and the `expect` after it, so a step's `waitFor` gates the *next* step, not
    // its own write. An input-less step is how that gap is spelled, and it is what
    // `UsageTerminalStep.waitFor` already documents — "do not send the next step until this
    // text appears".
    steps: [{ input: "", waitFor: /Claude Code/ }, { input: "/usage\r" }],
  },
  gpt: {
    args: ["--no-alt-screen"],
    // Codex opens a non-destructive chooser before the actual account page. Waiting for
    // its prompt avoids a blind fixed-delay Enter that could accept a future confirmation.
    steps: [
      { input: "/usage\r", waitFor: /show usage|press enter to confirm/i },
      { input: "\r" },
    ],
  },
  grok: {
    args: ["--no-alt-screen", "--no-memory", "--no-subagents", "--disable-web-search"],
    steps: [{ input: "/usage\r" }],
  },
};

abstract class BaseUsageCollector implements UsageCollector {
  protected abstract readonly provider: UsageProvider;

  private readonly terminal: UsageTerminal;
  private readonly timeoutMs: number;

  constructor(private readonly options: UsageCollectorOptions) {
    this.terminal = options.terminal ?? new ExpectUsageTerminal();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async collect(): Promise<CapacityReading> {
    const observedAt = this.options.clock.nowIso();
    const cli = CLI[this.provider];
    let result: UsageTerminalResult;
    try {
      result = await this.terminal.run({
        binary: this.options.binary,
        args: cli.args,
        steps: cli.steps,
        timeoutMs: this.timeoutMs,
        environment: terminalEnvironment(this.provider, this.options.providerCredentialDir),
      });
    } catch (error) {
      const rawOutputDigest = sha256("");
      return failedReading(
        this.provider,
        observedAt,
        `interactive-/usage:${this.provider};raw-output-digest:${rawOutputDigest}`,
        rawOutputDigest,
        error instanceof Error ? error.message : "interactive /usage collector threw a non-error value",
      );
    }
    const raw = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
    const rawOutputDigest = sha256(raw);
    const source = `interactive-/usage:${this.provider};raw-output-digest:${rawOutputDigest}`;
    if (result.error || result.timedOut) {
      return failedReading(this.provider, observedAt, source, rawOutputDigest, result.error ?? "interactive /usage timed out");
    }
    const parsed = parseUsageOutput(this.provider, raw, observedAt, rawOutputDigest);
    return parsed.ok
      ? {
          provider: this.provider,
          sensorHealth: "HEALTHY",
          runtimeHealth: "UNKNOWN",
          observedAt,
          buckets: parsed.buckets,
          source,
          rawOutputDigest,
        }
      : failedReading(this.provider, observedAt, source, rawOutputDigest, parsed.error);
  }
}

export class ClaudeUsageCollector extends BaseUsageCollector {
  protected readonly provider = "claude" as const;
}

export class CodexUsageCollector extends BaseUsageCollector {
  protected readonly provider = "gpt" as const;
}

export class GrokUsageCollector extends BaseUsageCollector {
  protected readonly provider = "grok" as const;
}

const failedReading = (
  provider: UsageProvider,
  observedAt: string,
  source: string,
  rawOutputDigest: string,
  error: string,
): CapacityReading => ({
  provider,
  sensorHealth: "ERROR",
  runtimeHealth: "UNKNOWN",
  observedAt,
  buckets: [],
  source,
  rawOutputDigest,
  error,
});

type ParsedUsage = { ok: true; buckets: CapacityBucket[] } | { ok: false; error: string };

/**
 * Parse only explicit numeric remaining-quota statements. Token-activity charts and
 * plan prose are useful to a human but are not a routable capacity measurement.
 */
export const parseUsageOutput = (
  provider: UsageProvider,
  raw: string,
  observedAt: string,
  rawOutputDigest = sha256(raw),
): ParsedUsage => {
  void rawOutputDigest; // Bound into the reading source by the caller; never retain raw output.
  const clean = stripTerminal(raw);
  if (looksLikeTrustOrApprovalPrompt(clean)) {
    return { ok: false, error: "interactive CLI requested trust or approval" };
  }

  /**
   * Quota is read from the **current** frame, not from everything the terminal ever emitted.
   *
   * A TUI repaints. The capture holds every frame, so the same window arrives several times —
   * and not identically: measured on claude 2.1.233, one repaint kept its spaces while another
   * lost characters, so `Current week (all models)` normalised to `currentweek-allmodels` in
   * one frame and `current-week-ll-model` in another. The duplicate-window refusal then fired
   * on what was really one screen read three times (#564).
   *
   * The boundary is in the stream already: each repaint starts by homing the cursor, and the
   * raw capture keeps those sequences (`ESC[H` x5 for three paints of this screen). It is
   * `stripTerminal` that removes them, before anything can use them — the structure was being
   * discarded a step too early rather than never being there.
   *
   * So the split happens on the raw text and only the last frame is read. Refusals still see
   * the whole stream above: a trust prompt in an earlier frame is a failed observation no
   * matter which frame is current, and narrowing that check would trade a safety property for
   * a parsing convenience.
   *
   * Input with no frame markers — an injected fixture, a plain pipe — yields a single segment
   * and is read whole, unchanged.
   */
  const frames = raw.split(/\u001B\[H/);
  // The most complete paint, and among equally complete ones the most recent.
  //
  // Reading only the last frame assumed the final paint is a whole screen. It is not: the
  // collector stops after two seconds of quiet, so a home followed by a partial repaint is a
  // complete observation in which the tightest window is simply absent, and a trailing home
  // leaves an empty frame that read as "the binary never launched". Reading *every* frame is
  // the opposite error — a damaged repaint spells one window two ways, which is the duplicate
  // refusal #573 was written for. Completeness picks the paint that lost the least, and the
  // recency tie-break keeps a stale frame from beating an equally complete current one.
  const readings = frames.map((frame) => {
    const frameLines = stripTerminal(frame)
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    return { lines: frameLines, parsed: parseFrameBuckets(frameLines, provider, observedAt) };
  });
  const invalid = readings.find((reading) => !reading.parsed.ok);
  // An impossible percentage is a refusal about the reading, not about one frame: quietly
  // using the frames around it would turn a malformed source into a partial success.
  if (invalid && !invalid.parsed.ok) return invalid.parsed;

  let chosen = readings[readings.length - 1] ?? { lines: [] as string[], parsed: { ok: true as const, buckets: [] } };
  for (const reading of readings) {
    if (!reading.parsed.ok || !chosen.parsed.ok) continue;
    if (reading.parsed.buckets.length > chosen.parsed.buckets.length) chosen = reading;
  }
  const lines = chosen.lines;
  const buckets = chosen.parsed.ok ? chosen.parsed.buckets : [];

  if (buckets.length === 0) {
    // Three different failures used to arrive as this one sentence: a binary that never
    // launched, a trust prompt that went unrecognised, and a real usage screen in an
    // unexpected shape. On 2026-08-17 all three providers reported it at once and the
    // cause was none of the things the sentence describes — `resolveExecutable` returns the
    // bare name when PATH does not contain the CLI, so nothing ever started, and the empty
    // stream reached this line as if it were output. A whole causal chain was built on the
    // wrong reading of it (#564, #568).
    //
    // The distinguishing fact is whether anything was said at all. Line and character
    // counts only: `docs/capacity-source.md` keeps raw terminal output out of the record and
    // retains a digest instead, so the shape is reportable and the content is not.
    if (lines.length === 0) {
      return {
        ok: false,
        error:
          "interactive CLI produced no output; the binary may not have launched " +
          "(a CLI outside the daemon's PATH resolves to a bare name and never starts)",
      };
    }
    return {
      ok: false,
      error:
        `interactive /usage output contains no explicit remaining-quota percentage ` +
        `(${lines.length} line(s) read); it was neither a quota screen nor a recognised prompt`,
    };
  }
  const ids = new Set<string>();
  if (buckets.some((bucket) => ids.has(bucket.id) || (ids.add(bucket.id), false))) {
    return { ok: false, error: "interactive /usage output contains duplicate quota-window labels" };
  }
  return { ok: true, buckets };
};

const normaliseBucketId = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "usage-window";

const normaliseResetAt = (text: string, observedAt: string): string | null => {
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2}))\b/.exec(text)?.[1];
  if (iso && Number.isFinite(new Date(iso).getTime())) return new Date(iso).toISOString();
  const relative = /\breset(?:s|ting)?\s+in\s+(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?)?)?\s*)?/i.exec(text);
  if (relative && (relative[1] || relative[2])) {
    const milliseconds = (Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0)) * 60_000;
    const base = new Date(observedAt).getTime();
    if (Number.isFinite(base) && milliseconds > 0) return new Date(base + milliseconds).toISOString();
  }
  // A source may report a usable remaining percentage without a machine-readable reset.
  // Keep that fact, but do not manufacture a horizon for the dynamic reserve.
  return null;
};

/**
 * One repaint's worth of lines, reduced to the buckets it states. Extracted so every frame can
 * be read, and so the caller can keep the smallest reading of each window rather than the last.
 */
const parseFrameBuckets = (
  lines: readonly string[],
  provider: keyof typeof CAPABILITIES,
  observedAt: string,
): { ok: true; buckets: CapacityBucket[] } | { ok: false; error: string } => {
  // Whitespace is not a reliable separator here. A TUI positions text with cursor moves and
  // `stripTerminal` deletes those, so at some widths `Current week` arrives as `Currentweek`
  // and `62% used` as `62%used`. Matching is done against a space-stripped copy for the same
  // reason the trust guard is (#569); the original line is kept for the reset horizon.
  const squeezed = lines.map((line) => line.replace(/\s+/g, ""));

  /**
   * A stated percentage plus the word that says which side of the quota it names.
   *
   * The trailing boundary is `(?![a-z])` rather than `\b`. Squeezing removed the spaces, so
   * `41% used 80% remaining` arrives as `41%used80%remaining`, where `\b` fails between `d`
   * and `8` — the first, tighter figure was skipped and the second was reported. A boundary
   * that only refuses letters keeps `usedup` out while letting a digit follow.
   */
  const SENSE = /(?<value>\d{1,3}(?:\.\d+)?)%(?<sense>used|remaining|left|available)(?![a-z])/gi;

  /**
   * The window a percentage belongs to is not always on its line. Measured on claude 2.1.233,
   * at both the default width and a pinned 200 columns, the CLI emits the label, the bar and
   * the reset as three separate lines (#570):
   *
   *     Currentweek(allmodels)
   *     [bar]41%used
   *     ResetsAug18at9am(Asia/Seoul)
   *
   * So a label is looked for on the line itself first — that is the older single-line form and
   * still the one the tests pin — and only then backwards.
   */
  const windowFor = (index: number): string | null => {
    const inline = /^(?<window>[A-Za-z0-9][A-Za-z0-9 ._()-]{0,80}?)\s*(?:limit|quota|usage)?\s*[:\u2014-]\s*(?=\d)/i.exec(lines[index]!);
    if (inline?.groups?.["window"]) return inline.groups["window"];
    for (let back = index - 1; back >= 0 && back >= index - 3; back -= 1) {
      const candidate = squeezed[back]!;
      // A line that already carries a percentage belonged to a window too. Returning null here
      // discarded the figure entirely, and the discarded one is often the tighter: a redraw
      // that used \r leaves the stale bar above the fresh one, and a nested window sits under
      // its parent. The caller carries the last window forward instead, which attributes the
      // figure to a window that may be the parent — and then keeps the smaller of the two.
      // Mis-labelling a real constraint is recoverable; dropping it is not.
      if (new RegExp(SENSE.source, "i").test(candidate)) return null;
      if (/[A-Za-z]{3}/.test(candidate) && !/%/.test(candidate)) return lines[back]!;
    }
    return null;
  };

  const named: CapacityBucket[] = [];
  const carriedBuckets: CapacityBucket[] = [];
  let carried: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const own = windowFor(index);
    if (own) carried = own;
    const window = own ?? carried;
    if (!window) continue;

    SENSE.lastIndex = 0;
    let match: RegExpExecArray | null;
    // Every stated figure on the line, not the first. One line can carry both senses of the
    // same window, and taking whichever came first is a coin flip on which one is reported.
    while ((match = SENSE.exec(squeezed[index]!)) !== null) {
      if (!match.groups) continue;
      const stated = Number(match.groups["value"]);
      if (!Number.isFinite(stated) || stated < 0 || stated > 100) {
        return { ok: false, error: `usage window '${window}' has an invalid percentage` };
      }
      // #570 — `used` is accepted and subtracted. The invariant refuses a chart, a plan label
      // or a bare percentage; all three share a missing denominator. Here the window is named
      // in the reading, so `100 - used` is arithmetic on a stated quantity. Applying a stricter
      // rule to `used` than to `remaining` treats the same evidence differently over one word.
      const measuredAs = /^used$/i.test(match.groups["sense"] ?? "") ? "used" as const : "remaining" as const;
      const remainingPercent = measuredAs === "used" ? 100 - stated : stated;

      const resetText = [lines[index] ?? "", lines[index + 1] ?? "", lines[index + 2] ?? ""]
        .find((value) => /\breset(?:s|ting)?\b/i.test(value) || /reset/i.test(value.replace(/\s+/g, ""))) ?? "";
      (own ? named : carriedBuckets).push({
        id: normaliseBucketId(window),
        remainingPercent,
        resetAt: normaliseResetAt(resetText, observedAt),
        capabilities: [...CAPABILITIES[provider]],
        measuredAs,
      });
    }
  }

  // A figure with no label of its own is the same window measured again — a redraw that used
  // \r leaves the stale bar above the fresh one, and a nested window sits under its parent.
  // Dropping it discarded a real constraint, often the tighter one; folding it in by minimum
  // keeps it. Two figures that each named themselves are a different thing and still refuse
  // below, because a screen that labels one window twice with two numbers is ambiguous in a
  // way this cannot resolve.
  for (const extra of carriedBuckets) {
    const target = named.find((bucket) => bucket.id === extra.id);
    if (!target) {
      named.push(extra);
      continue;
    }
    if ((extra.remainingPercent ?? -1) < (target.remainingPercent ?? -1)) {
      named[named.indexOf(target)] = extra;
    }
  }
  return { ok: true, buckets: named };
};

export const stripTerminal = (value: string): string =>
  value
    // CSI plus OSC title/hyperlink controls used by all three TUIs.
    .replace(/\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[()][0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

/**
 * Trust and approval prompts, matched against text with **all whitespace removed**.
 *
 * `stripTerminal` deletes CSI sequences rather than replacing them, which is right for the
 * quota parser — a TUI that splits `42%` around a cursor move must not become `4 2%`. The
 * consequence is that a TUI positioning each word with its own CHA sequence renders
 * `Quick safety check` as `Quicksafetycheck` here. The previous patterns spelled those
 * spaces literally, so on a real terminal they could not match: this guard was unreachable
 * in production for the entire time it has existed.
 *
 * It looked covered. `usage-collectors.test.ts` injected `"Quick safety check: Is this a
 * project you trust?"` — already-rendered text, with the spaces a terminal would not leave.
 * The fixture asserted an input the production path cannot produce, which is why a passing
 * suite said nothing about the guard.
 *
 * So the subject is normalised instead of the pattern: strip whitespace from the candidate
 * and write the patterns without it. Spaced and unspaced text both match.
 *
 * A false positive here refuses a capacity reading, which is the safe direction — an ERROR
 * is the absence of a reading, and `docs/capacity-source.md` already says an absence never
 * beats an existing observation.
 */
const TRUST_OR_APPROVAL_PROMPT =
  /(?:doyoutrust|yes,?proceed|yes,?itrust|quicksafetycheck|allow.*?(?:run|modify|execute)|approve.*?(?:command|tool))/i;

const looksLikeTrustOrApprovalPrompt = (value: string): boolean =>
  TRUST_OR_APPROVAL_PROMPT.test(value.replace(/\s+/g, ""));

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
  /** Injected in tests. Production runs the provider CLI's own non-interactive usage command. */
  nonInteractive?: NonInteractiveUsageProbe;
}

/**
 * A provider CLI asked for its own account usage without a terminal. The CLI reads and refreshes
 * the subscription credential itself, so nothing here handles a token — the same reason a
 * reviewer's credential tree stays inside the tool that owns it.
 */
export interface NonInteractiveUsageProbe {
  run(input: { binary: string; timeoutMs: number }): Promise<{ stdout: string; stderr: string; code: number | null }>;
}

const DEFAULT_TIMEOUT_MS = 45_000;
/** The non-interactive read is a local command with no model turn; it answered in ~2s measured. */
const NON_INTERACTIVE_TIMEOUT_MS = 20_000;

/**
 * `claude -p "/usage"` prints the account windows and spends nothing: measured `num_turns: 0`,
 * `total_cost_usd: 0`, `output_tokens: 0`, two seconds. `/usage` is a local slash command the
 * CLI marks non-interactive, so this is the tool's own contract rather than its rendering.
 *
 * `--safe-mode` keeps the credential path and skips hooks. `--bare` must never be used here: it
 * refuses the keychain and returns a session-cost stub with no windows, which is a silent wrong
 * answer rather than a failure.
 */
export const CLAUDE_NON_INTERACTIVE_ARGS = [
  "-p",
  "--output-format",
  "json",
  "--safe-mode",
  "--max-turns",
  "1",
  "/usage",
] as const;

export class SpawnNonInteractiveUsageProbe implements NonInteractiveUsageProbe {
  constructor(private readonly args: readonly string[]) {}

  async run(input: { binary: string; timeoutMs: number }): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve) => {
      const child = spawn(input.binary, [...this.args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: stderr || error.message, code: null });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
    });
  }
}

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

  private readonly probe: NonInteractiveUsageProbe;
  private readonly probeTimeoutMs: number;

  constructor(private readonly claudeOptions: UsageCollectorOptions) {
    super(claudeOptions);
    this.probe = claudeOptions.nonInteractive ?? new SpawnNonInteractiveUsageProbe(CLAUDE_NON_INTERACTIVE_ARGS);
    this.probeTimeoutMs = claudeOptions.timeoutMs ?? NON_INTERACTIVE_TIMEOUT_MS;
  }

  /**
   * Read the account windows from the CLI's own non-interactive command rather than from a
   * repainted terminal. The pseudo-terminal path re-derived a rendered frame, and four
   * adversarial rounds of that parser produced fifteen defects, most of them reporting more
   * remaining quota than the screen stated — the direction that dispatches work the quota
   * cannot pay for.
   *
   * There is no fallback to the terminal on failure. A fallback would mean the safer source
   * silently handing back to the one it replaced, and an unreadable quota already has a correct
   * answer: refuse, and let admission treat the provider as unroutable.
   */
  override async collect(): Promise<CapacityReading> {
    // An explicitly configured terminal selects the pseudo-terminal path — for a host whose CLI
    // predates the non-interactive command. Selected by configuration, never by failure: a
    // fallback on error would hand a quota read back to the source this replaced, at exactly the
    // moment the safer one could not answer.
    if (this.claudeOptions.terminal) return super.collect();

    const observedAt = this.claudeOptions.clock.nowIso();
    let outcome: { stdout: string; stderr: string; code: number | null };
    try {
      outcome = await this.probe.run({ binary: this.claudeOptions.binary, timeoutMs: this.probeTimeoutMs });
    } catch (error) {
      const digest = sha256("");
      return failedReading(
        this.provider,
        observedAt,
        `non-interactive-/usage:${this.provider};raw-output-digest:${digest}`,
        digest,
        error instanceof Error ? error.message : "non-interactive /usage collector threw a non-error value",
      );
    }
    const raw = `${outcome.stdout}${outcome.stderr ? `\n${outcome.stderr}` : ""}`;
    const digest = sha256(raw);
    const source = `non-interactive-/usage:${this.provider};raw-output-digest:${digest}`;

    // The envelope, not the prose, says whether the command ran. `is_error` and a non-zero exit
    // are different failures — a refused trust prompt exits zero with an error envelope.
    let envelope: { is_error?: unknown; result?: unknown } | null = null;
    try {
      envelope = JSON.parse(outcome.stdout) as { is_error?: unknown; result?: unknown };
    } catch {
      envelope = null;
    }
    if (!envelope || typeof envelope.result !== "string") {
      return failedReading(
        this.provider,
        observedAt,
        source,
        digest,
        outcome.code === 0
          ? "non-interactive /usage returned no JSON envelope; the CLI's output contract may have changed"
          : `non-interactive /usage exited ${outcome.code ?? "on a signal"} without a JSON envelope`,
      );
    }
    if (envelope.is_error === true) {
      return failedReading(this.provider, observedAt, source, digest, "non-interactive /usage reported an error envelope");
    }

    const parsed = parseNonInteractiveUsage(this.provider, envelope.result, observedAt);
    return parsed.ok
      ? {
          provider: this.provider,
          sensorHealth: "HEALTHY",
          runtimeHealth: "UNKNOWN",
          observedAt,
          buckets: parsed.buckets,
          source,
          rawOutputDigest: digest,
        }
      : failedReading(this.provider, observedAt, source, digest, parsed.error);
  }
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
  // Every frame contributes, and the smallest reading of a window wins.
  //
  // Reading only the last frame assumed the final paint is a whole screen. It is not: the
  // collector stops after two seconds of quiet, so a home plus a partial repaint is a complete
  // observation whose tightest window is simply absent.
  //
  // Picking the frame with the most windows was the wrong repair and was measured to be wrong
  // in the original direction: a complete earlier paint outvotes a shorter current one that
  // just moved a shared window down, so a week bar repainted to 95% used still reported 95
  // remaining. Bucket count is not completeness, and a split or damaged paint can hold more
  // ids than the intact one.
  //
  // The union costs a damaged repaint's misspelled window appearing beside the real one. That
  // cannot grant work: `isRoutableFor` requires *every* applicable bucket to clear the floor,
  // so an extra bucket can only withhold. Over-reporting is the failure that dispatches work
  // the quota cannot pay for, so the reading is assembled from whichever frame stated the
  // least remaining for each window.
  let lines: string[] = [];
  const lowest = new Map<string, CapacityBucket>();
  for (const frame of frames) {
    const frameLines = stripTerminal(frame)
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (frameLines.length > lines.length) lines = frameLines;

    const parsed = parseFrameBuckets(frameLines, provider, observedAt);
    // An impossible percentage is a statement about the source, not about one paint: using the
    // frames around it would turn a malformed screen into a partial success.
    if (!parsed.ok) return parsed;

    // A window labelled twice folds to its lowest reading like any other repeated window.
    // Refusing the whole observation was fail-closed but cost a readable screen; skipping only
    // the ambiguous paint was worse than either, and measured to be so: when the ambiguous
    // paint is the one saying the week is spent, dropping it accepts a stale high reading from
    // another paint. `X% used` and `(100-X)% remaining` agree by construction, so a pair that
    // disagrees is a screen contradicting itself, and the lower number is the reading that
    // cannot admit work the quota will not cover.
    for (const bucket of parsed.buckets) {
      const seen = lowest.get(bucket.id);
      // A null remaining is "stated but unusable", which admission already treats as
      // unroutable. It must not be beaten by a number, so it sorts below every reading.
      const rank = (candidate: CapacityBucket): number => candidate.remainingPercent ?? -1;
      if (!seen || rank(bucket) < rank(seen)) lowest.set(bucket.id, bucket);
    }
  }
  const buckets: CapacityBucket[] = [...lowest.values()];

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
   * There is no trailing boundary at all. `\b` failed between `d` and `8` in the squeezed
   * `41%used80%remaining`, skipping the tighter figure and reporting the looser one. Refusing a
   * following letter fixed that and broke `59% remaining UTC`, which squeezes to
   * `59%remainingUTC` — the figure vanished and the stale one before it stood.
   *
   * Squeezing destroys the word boundaries that would separate `remainingUTC` from `leftover`,
   * so no rule here can tell them apart. Both are unobserved shapes, and they fail in opposite
   * directions: dropping a real figure leaves a staler, higher one standing, while reading a
   * spurious one can only add another candidate to a fold that keeps the minimum. So the
   * permissive reading is the safe one.
   */
  const SENSE = /(?<value>\d{1,3}(?:\.\d+)?)%(?<sense>used|remaining|left|available)/gi;

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
    // A line that carries words of its own before its figure names its own window, separator
    // or not. `Fable 12% remaining` under a parent, and `Token activity last 12 months 40%
    // used` starting a new section, are both this shape — and treating them as unlabelled made
    // the first vanish into its parent and the second lend the parent's name to whatever came
    // next. Bar glyphs are not words, so a redrawn bar keeps borrowing.
    // Not on a reset line. `Resets Aug 18 at 9am — 3% left` reads as a window called "Resets
    // Aug 18 at 9am" under this rule, and a horizon is not a quota window. The separator form
    // above is unaffected: `5-hour limit: 62% remaining — resets in 1h 15m` names itself
    // explicitly and is the measured single-line shape.
    //
    // The word-boundary spelling misses the live one. `ResetsAug18at9am(Asia/Seoul)` has no
    // boundary between `s` and `A`, so `\breset\b` does not see it and that horizon became a
    // quota window at whatever percentage trailed it. Matched without boundaries instead.
    if (/reset/i.test(squeezed[index]!)) return null;
    // Whitespace optional, and read from the original line so the name keeps its spaces.
    // Requiring a space made the only new same-line form the one that dies exactly when the
    // spaces do — and this parser exists because a TUI supplies no reliable ones at any width.
    // Reading the squeezed copy instead would name the same window two ways depending on which
    // paint kept its spaces, which is the misspelling problem in a new place.
    const labelled = /^(?<window>[A-Za-z][A-Za-z0-9 ._()-]{0,80}?)\s*(?=\d{1,3}(?:\.\d+)?%)/.exec(lines[index]!);
    const label = labelled?.groups?.["window"]?.trim();
    if (label && /[A-Za-z]{3}/.test(label)) return label;
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
  // A figure with no words of its own borrows the window in force. That is a redraw's stale
  // bar and its successors, which is why the borrow is not limited to one line: a bar redrawn
  // three times leaves three figures, and dropping all but the first reports the *stalest* of
  // them. Restricting the borrow by position was measured to do exactly that — 80 remaining
  // for a window at 59, in the direction that dispatches work the quota cannot pay for.
  //
  // What ends a borrow is a line naming itself, which `windowFor` now recognises without a
  // separator. A run of unlabelled figures under a real window can still walk that window
  // down, and that is accepted: it withholds work rather than granting it.
  let carried: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const own = windowFor(index);
    if (own) carried = own;
    // Does this line say anything of its own besides its figures? Bar glyphs and the sense
    // tokens themselves do not count, so a redrawn bar stays borrowable while a promo, a
    // heading or a reset does not. A line with its own words that could not be turned into a
    // window name ends the borrow without starting one: it is somebody else's content, and
    // letting the previous window reach past it is how an unrelated percentage replaced a
    // real figure.
    // A reset is a horizon, not a quota statement, so it may not borrow the window above it —
    // `Resets Aug 18 at 9am — 3% left` would otherwise become a real constraint of 3. A line
    // that named itself is unaffected: `5-hour limit: 62% remaining — resets in 1h 15m` is the
    // measured single-line shape and states both. This guard was removed once as unreachable,
    // which it was only because the borrow used to end before the figure was taken.
    const window = own ?? (/reset/i.test(squeezed[index]!) ? null : carried);

    // Every stated figure on the line, not the first. One line can carry both senses of the
    // same window, and taking whichever came first is a coin flip on which one is reported.
    const figures: Array<{ value: number; sense: string }> = [];
    SENSE.lastIndex = 0;
    let found: RegExpExecArray | null;
    while ((found = SENSE.exec(squeezed[index]!)) !== null) {
      if (!found.groups) continue;
      figures.push({ value: Number(found.groups["value"]), sense: found.groups["sense"] ?? "" });
    }

    for (const figure of figures) {
      if (!window) continue;
      const value = figure.value;
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        return { ok: false, error: `usage window '${window}' has an invalid percentage` };
      }
      // #570 — `used` is accepted and subtracted. The invariant refuses a chart, a plan label
      // or a bare percentage; all three share a missing denominator. Here the window is named
      // in the reading, so `100 - used` is arithmetic on a stated quantity. Applying a stricter
      // rule to `used` than to `remaining` treats the same evidence differently over one word.
      const measuredAs = /^used$/i.test(figure.sense) ? "used" as const : "remaining" as const;
      const remainingPercent = measuredAs === "used" ? 100 - value : value;

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

    // Now decide whether the borrow survives this line — after its own figures were taken, not
    // before. Deciding first drops the figure on the line that ends the borrow, and that line
    // is often the freshest: a repaint whose bar and horizon share a row (`41%used
    // (Asia/Seoul)`), or a figure with a unit after it (`59% remaining 15min`), left the
    // *stale* number standing. Bar glyphs and the sense tokens themselves are not words.
    const bare = squeezed[index]!.replace(new RegExp(SENSE.source, "gi"), "");
    if (!own && /[A-Za-z]{3}/.test(bare)) carried = null;
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

/**
 * The account windows as `claude -p "/usage"` prints them, which is a formatter's output rather
 * than a repainted frame:
 *
 *     Current session: 12% used · resets Aug 18 at 7:49pm (Asia/Seoul)
 *     Current week (all models): 64% used · resets Aug 21 at 4:59am (Asia/Seoul)
 *
 * Matched strictly, one window per line. The interactive parser had to be permissive because it
 * was re-deriving a screen; this input is one line per window with a stated label, so anything
 * that does not match this shape is a changed contract and must refuse rather than guess.
 */
const NON_INTERACTIVE_WINDOW =
  /^(?<window>[^:]{1,80}):\s*(?<value>\d{1,3}(?:\.\d+)?)%\s*used(?:\s*[\u00B7·|-]\s*resets\s+(?<reset>.+?))?\s*$/;

/** `Aug 21 at 4:59am (Asia/Seoul)` — a wall-clock time in a named zone, with the year implied. */
const RESET_WALL_CLOCK =
  /^(?<month>[A-Za-z]{3,9})\s+(?<day>\d{1,2})\s+at\s+(?<hour>\d{1,2}):(?<minute>\d{2})\s*(?<meridiem>am|pm)?\s*(?:\((?<zone>[A-Za-z_]+\/[A-Za-z_]+)\))?$/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** What a UTC instant is offset by in a named zone, so a wall-clock time there can be resolved. */
const zoneOffsetMs = (zone: string, instantMs: number): number | null => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instantMs));
    const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
    const asUtc = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
    return Number.isFinite(asUtc) ? asUtc - instantMs : null;
  } catch {
    // An unknown zone is not a reason to invent a horizon.
    return null;
  }
};

/**
 * The year is not printed, so it is inferred as the next occurrence at or after the observation.
 * Without a resolvable horizon every bucket holds its whole window in reserve, which withholds
 * worker fan-out entirely — so this is worth resolving properly rather than returning null.
 */
export const parseResetWallClock = (text: string, observedAt: string): string | null => {
  const match = RESET_WALL_CLOCK.exec(text.trim());
  if (!match?.groups) return null;
  const month = MONTHS.indexOf(match.groups["month"]!.slice(0, 3).toLowerCase());
  const day = Number(match.groups["day"]);
  let hour = Number(match.groups["hour"]);
  const minute = Number(match.groups["minute"]);
  const meridiem = match.groups["meridiem"]?.toLowerCase();
  const zone = match.groups["zone"];
  const base = Date.parse(observedAt);
  if (month < 0 || !Number.isFinite(day) || !Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(base)) {
    return null;
  }
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  for (const year of [new Date(base).getUTCFullYear(), new Date(base).getUTCFullYear() + 1]) {
    const wall = Date.UTC(year, month, day, hour, minute);
    if (!Number.isFinite(wall)) continue;
    let instant = wall;
    if (zone) {
      // Two passes: the offset is looked up at the guessed instant, then confirmed at the
      // corrected one. A single pass is wrong across a DST boundary, which Asia/Seoul does not
      // observe but other operators' zones do.
      const first = zoneOffsetMs(zone, wall);
      if (first === null) return null;
      const second = zoneOffsetMs(zone, wall - first);
      if (second === null) return null;
      instant = wall - second;
    }
    if (instant >= base) return new Date(instant).toISOString();
  }
  return null;
};

/**
 * The non-interactive reading. Refuses rather than guessing: this is a stated contract, so a
 * shape it does not produce means the contract changed and the reading is not evidence.
 */
export const parseNonInteractiveUsage = (
  provider: UsageProvider,
  text: string,
  observedAt: string,
): { ok: true; buckets: CapacityBucket[] } | { ok: false; error: string } => {
  const buckets: CapacityBucket[] = [];
  const ids = new Set<string>();
  for (const line of text.split("\n").map((value) => value.trim()).filter(Boolean)) {
    const match = NON_INTERACTIVE_WINDOW.exec(line);
    if (!match?.groups) continue;
    const stated = Number(match.groups["value"]);
    const window = match.groups["window"]!.trim();
    if (!Number.isFinite(stated) || stated < 0 || stated > 100) {
      return { ok: false, error: `usage window '${window}' has an invalid percentage` };
    }
    const id = normaliseBucketId(window);
    // One line per window is the whole point of this surface. A repeated label means the shape
    // is not what it is taken to be, and guessing which line is current would reintroduce the
    // ambiguity this source exists to remove.
    if (ids.has(id)) return { ok: false, error: "non-interactive /usage repeated a quota-window label" };
    ids.add(id);
    buckets.push({
      id,
      remainingPercent: 100 - stated,
      resetAt: match.groups["reset"] ? parseResetWallClock(match.groups["reset"], observedAt) : null,
      capabilities: [...CAPABILITIES[provider]],
      measuredAs: "used",
    });
  }
  if (buckets.length === 0) {
    return {
      ok: false,
      error:
        `non-interactive /usage stated no quota window (${text.split("\n").filter(Boolean).length} line(s) read); ` +
        "it was neither a usage report nor a recognised refusal",
    };
  }
  return { ok: true, buckets };
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

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, linkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ManualClock } from "../../src/core/clock.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import {
  ClaudeCliAdapter,
  CodexCliAdapter,
  GrokCliAdapter,
} from "../../src/runtime/cli-adapters.ts";
import {
  CLAUDE_NON_INTERACTIVE_ARGS,
  ClaudeUsageCollector,
  parseNonInteractiveUsage,
  parseResetWallClock,
  CodexUsageCollector,
  SpawnCodexRateLimitProbe,
  type CodexRateLimitProbe,
  GrokUsageCollector,
  grokBearer,
  parseCodexRateLimits,
  parseGrokBilling,
  type GrokBillingProbe,
  parseUsageOutput,
  ExpectUsageTerminal,
  type UsageTerminal,
  nonInteractiveEnvironment,
} from "../../src/capacity/usage-collectors.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const clock = () => new ManualClock("2026-08-13T00:00:00.000Z");

/**
 * The real production Codex binary's short name (`resolveExecutable`'s default for `gpt`,
 * `cli-adapters.ts:1666`) — never the stub script this suite spawns, which runs under `node`
 * and never carries this name. A live Codex process on the same host competes for CPU with
 * this test's own real `/usr/bin/expect` pty, and a fixed navigation timeout is not something
 * that competition reliably survives (#644): this deployment's CEO runtime is itself a Codex
 * session, so the collision is structural here rather than incidental.
 *
 * `pgrep -x` matches the short command name regardless of which vendored path launched it —
 * measured: `ps -o comm=` reports the full vendor-store path, but `pgrep -x codex` still finds
 * it. `pgrep` exits 1 with empty stdout when nothing matches, which is "none running", not a
 * failure to ask, so that exit is swallowed rather than thrown.
 */
const hostCodexPids = (): readonly string[] => {
  try {
    return execFileSync("pgrep", ["-x", "codex"], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

/** Captured from the live Codex `/usage` view on this machine, reduced to its stable text. */
const CODEX_ACTIVITY_ONLY = `
/usage daily
Token activity last 12 months
Lifetime 46.8B · Peak 2.4B · Streak 26d
daily · weekly · cumulative
`;

const terminal = (stdout: string, error: string | null = null): UsageTerminal => ({
  async run() {
    return { stdout, stderr: "", exitCode: 0, timedOut: false, error };
  },
});

describe("non-interactive account usage (#582)", () => {
  const envelope = (result: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ is_error: false, num_turns: 0, total_cost_usd: 0, result, ...extra });

  const probeReturning = (outcome: { stdout: string; stderr?: string; code?: number | null }) => ({
    run: async () => ({ stdout: outcome.stdout, stderr: outcome.stderr ?? "", code: outcome.code ?? 0 }),
  });

  // Captured from `claude -p --output-format json --safe-mode --max-turns 1 "/usage"` on the
  // deployment host: num_turns 0, total_cost_usd 0, output_tokens 0, two seconds.
  const LIVE_RESULT = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Current session: 12% used · resets Aug 18 at 7:49pm (Asia/Seoul)",
    "Current week (all models): 64% used · resets Aug 21 at 4:59am (Asia/Seoul)",
    "Current week (Fable): 18% used · resets Aug 21 at 4:59am (Asia/Seoul)",
    "",
    "What's contributing to your limits usage?",
  ].join("\n");

  it("reads every account window, and the horizon each one states", async () => {
    const reading = await new ClaudeUsageCollector({
      clock: clock(),
      binary: "claude",
      nonInteractive: probeReturning({ stdout: envelope(LIVE_RESULT) }),
    }).collect();

    expect(reading.sensorHealth, reading.error ?? "").toBe("HEALTHY");
    expect(reading.source).toMatch(/^non-interactive-\/usage:claude;/u);
    expect(reading.buckets.map((bucket) => [bucket.id, bucket.remainingPercent, bucket.resetAt])).toEqual([
      ["current-session", 88, "2026-08-18T10:49:00.000Z"],
      ["current-week-all-models", 36, "2026-08-20T19:59:00.000Z"],
      ["current-week-fable", 82, "2026-08-20T19:59:00.000Z"],
    ]);
    // Stated as used, subtracted here. Without a resolved horizon every bucket would hold its
    // whole window in reserve and no worker would ever be admitted.
    expect(reading.buckets.every((bucket) => bucket.measuredAs === "used")).toBe(true);
  });

  it("refuses a window-shaped line it cannot read, and steps over prose that merely quotes one", () => {
    // Two opposite hazards, one boundary. Skipping an unreadable *window* loses a constraint and
    // lets the survivors route alone. Refusing on any line that mentions a percentage makes a
    // tip fatal — and a refused reading is no capacity, which is no dispatch, so a parser can
    // shut the daemon down over a sentence. A window states its figure immediately after a
    // label separator; prose does not.
    const now = clock().nowIso();
    const live = [
      "Current session: 12% used · resets Aug 18 at 7:49pm (Asia/Seoul)",
      "Current week (all models): 95% used",
    ];

    for (const prose of [
      "You're at 12% used overall",
      "Tip: stop at 20% remaining to leave headroom",
      "Error: could not refresh (12% used cached)",
      "You have 5% remaining before you hit the limit",
    ]) {
      const parsed = parseNonInteractiveUsage("claude", [...live, prose].join("\n"), now);
      expect(parsed.ok, prose).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.buckets.map((bucket) => bucket.remainingPercent), prose).toEqual([88, 5]);
    }

    // Window-shaped and unreadable. An unknown sense word is the case that matters: the line is
    // unmistakably a window, and stepping over it drops the constraint while its siblings route.
    for (const unreadable of ["Current month: 95% consumed", "Current month: 95% utilised", "Current month: 140% used"]) {
      expect(parseNonInteractiveUsage("claude", [...live, unreadable].join("\n"), now).ok, unreadable).toBe(false);
    }
  });

  it("takes the lowest figure when one line states more than one quota", () => {
    // The label bound the first figure and the rest was discarded, so a line stating 99% used
    // and 10% used reported 90 remaining — inventing headroom, the same direction as the lazy
    // label that read `99% used` as a window named "9".
    const now = clock().nowIso();
    for (const [line, expected] of [
      ["Current session: 99% used · Current week: 10% used", 1],
      ["Current week: 12% used and 30% remaining", 30],
      ["Current week: 70% used and 5% remaining", 5],
      ["Current week: 5% remaining 99% used", 1],
    ] as const) {
      const parsed = parseNonInteractiveUsage("claude", line, now);
      expect(parsed.ok, line).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.buckets[0]?.remainingPercent, line).toBe(expected);
    }
  });

  it("reads a window whose separator or label is not the shape first assumed", async () => {
    // Every one of these was silently dropped, leaving the session to route alone. The em dash
    // is the separator this file's own interactive fixtures use; the colon inside the label is
    // a zone offset; the capital is the TUI's own spelling.
    for (const [name, week, expected] of [
      ["em dash", "Current week (all models): 95% used — resets Aug 21 at 4:59am (Asia/Seoul)", 5],
      ["colon in label", "Current week (UTC+09:00): 99% used · resets Aug 21 at 4:59am (Asia/Seoul)", 1],
      ["capital USED", "Current week: 99% USED", 1],
      ["em dash as the label separator", "Current week (all models) — 99% used", 1],
    ] as const) {
      const reading = await new ClaudeUsageCollector({
        clock: clock(),
        binary: "claude",
        nonInteractive: probeReturning({ stdout: envelope(["Current session: 12% used", week].join("\n")) }),
      }).collect();
      expect(reading.sensorHealth, name).toBe("HEALTHY");
      expect(Math.min(...reading.buckets.map((bucket) => bucket.remainingPercent ?? 100)), name).toBe(expected);
    }
  });

  it("refuses an unfinished or badly exited run even when a whole envelope is buffered", async () => {
    // A complete JSON object can already be in the buffer when the timer fires. Filing that as
    // a reading reports a quota from a process that did not finish saying it — and the exit
    // code was ignored entirely once `result` was a string.
    const healthy = envelope("Current session: 1% used · resets Aug 18 at 7:49pm (Asia/Seoul)");
    for (const [name, outcome] of [
      ["killed on the timer", { stdout: healthy, code: null, timedOut: true }],
      ["non-zero exit", { stdout: healthy, code: 1 }],
      ["died on a signal", { stdout: healthy, code: null }],
    ] as const) {
      const reading = await new ClaudeUsageCollector({
        clock: clock(),
        binary: "claude",
        nonInteractive: { run: async () => ({ stderr: "", ...outcome }) },
      }).collect();
      expect(reading.sensorHealth, name).toBe("ERROR");
      expect(reading.buckets, name).toEqual([]);
    }
  });

  it("treats anything but an explicit success flag as a failure", async () => {
    const result = "Current session: 1% used";
    for (const flag of ["true", 1, undefined, null, 0]) {
      const stdout = JSON.stringify(flag === undefined ? { result } : { is_error: flag, result });
      const reading = await new ClaudeUsageCollector({
        clock: clock(),
        binary: "claude",
        nonInteractive: probeReturning({ stdout }),
      }).collect();
      expect(reading.sensorHealth, String(flag)).toBe("ERROR");
    }
  });

  it("resolves a horizon in the zone's own year, and refuses a date that is not one", () => {
    // The year was taken from UTC. Near midnight UTC the zone is in a different one, and a
    // horizon two hours away resolved a year out — which holds the whole window in reserve and
    // withholds every worker while the percentages look fine.
    expect(parseResetWallClock("Dec 31 at 11:00pm (America/Los_Angeles)", "2026-01-01T05:00:00.000Z")).toBe(
      "2026-01-01T07:00:00.000Z",
    );
    // `Date.UTC` rolls a day that does not exist rather than rejecting it, so Feb 31 became
    // March 3 and was reported as a real horizon.
    expect(parseResetWallClock("Feb 31 at 4:59am (Asia/Seoul)", "2026-08-13T00:00:00.000Z")).toBeNull();
    expect(parseResetWallClock("Feb 29 at 4:59am (Asia/Seoul)", "2026-01-01T00:00:00.000Z")).toBeNull();
    expect(parseResetWallClock("Aug 21 at 4:99am (Asia/Seoul)", "2026-08-13T00:00:00.000Z")).toBeNull();
    expect(parseResetWallClock("Aug 21 at 4:59am (Asia/Seoul)", "2026-08-13T00:00:00.000Z")).toBe(
      "2026-08-20T19:59:00.000Z",
    );
    // The CLI prints both forms for the same reset. Successive calls seconds apart gave
    // `4:59am` and then `5am`, and requiring `:MM` turned the second into no horizon at all —
    // so a window whose percentage never moved lost and regained its reserve every few minutes.
    expect(parseResetWallClock("Aug 21 at 5am (Asia/Seoul)", "2026-08-13T00:00:00.000Z")).toBe(
      "2026-08-20T20:00:00.000Z",
    );
    expect(parseResetWallClock("Aug 19 at 12am (Asia/Seoul)", "2026-08-13T00:00:00.000Z")).toBe(
      "2026-08-18T15:00:00.000Z",
    );
  });

  it("refuses rather than guessing when the output contract changes", async () => {
    const clockAt = clock();
    const cases: Array<[string, { stdout: string; code?: number | null }]> = [
      ["not JSON at all", { stdout: "Current session: 12% used" }],
      ["an envelope with no result", { stdout: JSON.stringify({ is_error: false }) }],
      // Carrying text that WOULD parse: an errored invocation whose result still looks like a
      // usage report is the dangerous shape, because ignoring the flag reads it as quota.
      [
        "an error envelope with parseable text",
        { stdout: JSON.stringify({ is_error: true, result: "Current session: 12% used" }) },
      ],
      ["a result with no window", { stdout: envelope("You are logged in. Nothing else to report.") }],
      ["a non-zero exit and no envelope", { stdout: "", code: 1 }],
    ];
    for (const [name, outcome] of cases) {
      const reading = await new ClaudeUsageCollector({
        clock: clockAt,
        binary: "claude",
        nonInteractive: probeReturning(outcome),
      }).collect();
      expect(reading.sensorHealth, name).toBe("ERROR");
      expect(reading.buckets, name).toEqual([]);
    }
  });

  it("refuses a repeated window label instead of choosing between two numbers", async () => {
    const reading = await new ClaudeUsageCollector({
      clock: clock(),
      binary: "claude",
      nonInteractive: probeReturning({
        stdout: envelope(["Current session: 12% used", "Current session: 90% used"].join("\n")),
      }),
    }).collect();

    // One line per window is what this surface is for. Two lines for one label means the shape
    // is not what it is taken to be, and picking one would reintroduce exactly the ambiguity
    // that made the terminal parser wrong fifteen times.
    expect(reading.sensorHealth).toBe("ERROR");
    expect(reading.error).toContain("repeated a quota-window label");
  });

  it("never reads a quota by handling the subscription credential itself", () => {
    // The command carries no token and sets no credential path: the CLI reads and refreshes its
    // own. `--bare` is the one flag that would break this — it refuses the keychain and returns
    // a session-cost stub with no windows, which is a silent wrong answer rather than a failure.
    const args = CLAUDE_NON_INTERACTIVE_ARGS as readonly string[];
    expect(args).toContain("--safe-mode");
    expect(args).toContain("/usage");
    expect(args).not.toContain("--bare");
    expect(args.join(" ")).not.toMatch(/token|key|credential/iu);
  });
});

describe("Codex account rate limits (#582)", () => {
  // Captured live from `codex app-server --stdio` → account/rateLimits/read on this host.
  const LIVE = {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1787196559 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      planType: "pro",
      rateLimitReachedType: "rate_limit_reached",
    },
  };

  const probeReturning = (payload: unknown): CodexRateLimitProbe => ({ read: async () => payload });

  it("states an exhausted account as exhausted, with the window it names", async () => {
    const reading = await new CodexUsageCollector({
      clock: clock(),
      binary: "codex",
      codexRateLimits: probeReturning(LIVE),
    }).collect();

    expect(reading.sensorHealth, reading.error ?? "").toBe("HEALTHY");
    expect(reading.source).toMatch(/^account-rate-limits:gpt;/u);
    expect(reading.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([["7d", 0]]);
  });

  it("reads the snapshot whether or not it is nested", async () => {
    // This build nests it under `rateLimits`; earlier shapes state it at the top level.
    const flat = await new CodexUsageCollector({
      clock: clock(),
      binary: "codex",
      codexRateLimits: probeReturning(LIVE.rateLimits),
    }).collect();
    expect(flat.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([["7d", 0]]);
  });

  it("lets a stated block outrank the percentage printed beside it", async () => {
    // The account can report a healthy-looking percentage and a reached limit in one payload.
    // Reading only the number dispatches into a block the account has already declared.
    const reading = await new CodexUsageCollector({
      clock: clock(),
      binary: "codex",
      codexRateLimits: probeReturning({
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1787196559 },
        rateLimitReachedType: "workspace_owner_credits_depleted",
      }),
    }).collect();

    expect(reading.sensorHealth, reading.error ?? "").toBe("HEALTHY");
    expect(reading.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([["5h", 0]]);
  });

  it("treats an absent window as unknown rather than as unlimited", async () => {
    // `primary: null` is what the app-server returns when the last turn carried no limit
    // information — this machine's freshest session file has exactly that. Reading it as full
    // quota is the failure this source replaces.
    for (const payload of [{ primary: null }, {}, null, { primary: { usedPercent: "n/a" } }]) {
      const reading = await new CodexUsageCollector({
        clock: clock(),
        binary: "codex",
        codexRateLimits: probeReturning(payload),
      }).collect();
      expect(reading.sensorHealth, JSON.stringify(payload)).toBe("ERROR");
      expect(reading.buckets).toEqual([]);
    }
  });

  it("pins CODEX_HOME in the environment it spawns, not merely in what it passes along", async () => {
    // The earlier version of this test injected a fake probe and asserted the *collector*
    // handed the pinned home to it. That says nothing about whether the spawn uses it, and
    // mutating the env construction left it green. This drives the real probe.
    const root = tempDir("acp-codex-home-");
    const binary = join(root, "codex-home-echo.mjs");
    writeFileSync(
      binary,
      `#!${process.execPath}\n` +
        `process.stdout.write(JSON.stringify({ id: 0, result: {} }) + "\\n");\n` +
        `process.stdin.on("data", () => {\n` +
        `  process.stdout.write(JSON.stringify({ id: 1, result: { primary: { usedPercent: 0, windowDurationMins: 60, resetsAt: 1 }, seen: process.env.CODEX_HOME } }) + "\\n");\n` +
        `});\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    chmodSync(binary, 0o700);

    const previous = process.env["CODEX_HOME"];
    process.env["CODEX_HOME"] = "/inherited/wrong/home";
    let seen: unknown;
    try {
      seen = await new SpawnCodexRateLimitProbe().read({
        binary,
        timeoutMs: 8_000,
        codexHome: "/pinned/codex/home",
      });
    } finally {
      if (previous === undefined) delete process.env["CODEX_HOME"];
      else process.env["CODEX_HOME"] = previous;
    }

    expect((seen as { seen?: string }).seen).toBe("/pinned/codex/home");
  });

  it("notices a process that died even while a descendant still holds its pipe", async () => {
    // `exit` fires when the process ends; `close` waits for the pipes, which a detached
    // grandchild can hold open indefinitely. Listening on `close` turns a dead server into a
    // full-timeout wait — the same shape as the hang this probe exists to avoid, arrived at
    // from the other side.
    const root = tempDir("acp-codex-orphan-");
    const binary = join(root, "codex-orphan.mjs");
    writeFileSync(
      binary,
      `#!${process.execPath}\n` +
        `import { spawn } from "node:child_process";\n` +
        `spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", "inherit", "ignore"], detached: true }).unref();\n` +
        `process.exit(0);\n`,
    );
    chmodSync(binary, 0o700);

    const started = Date.now();
    const reading = await new CodexUsageCollector({ clock: clock(), binary, timeoutMs: 8_000 }).collect();
    const elapsed = Date.now() - started;

    expect(reading.sensorHealth).toBe("ERROR");
    // Fast, and named for what happened — not the timeout's message.
    expect(elapsed).toBeLessThan(4_000);
    expect(reading.error).toContain("exited before answering");
  }, 20_000);

  it("does not wait for a server that never exits", async () => {
    // The measured hang: the answer arrives in about two seconds and the process then lives on.
    // Awaiting exit or close is an unbounded wait inside `Daemon.start()`.
    const root = tempDir("acp-codex-live-");
    const binary = join(root, "codex-forever.mjs");
    writeFileSync(
      binary,
      `#!${process.execPath}\n` +
        `process.stdout.write(JSON.stringify({ id: 0, result: {} }) + "\\n");\n` +
        `process.stdin.on("data", () => {\n` +
        `  process.stdout.write(JSON.stringify({ id: 1, result: { primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1787196559 } } }) + "\\n");\n` +
        `});\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    chmodSync(binary, 0o700);

    const started = Date.now();
    const reading = await new CodexUsageCollector({ clock: clock(), binary, timeoutMs: 8_000 }).collect();
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(reading.sensorHealth, reading.error ?? "").toBe("HEALTHY");
    expect(reading.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([["7d", 60]]);
  }, 20_000);
});

describe("Grok subscription billing (#582)", () => {
  // Captured live from cli-chat-proxy.grok.com/v1/billing?format=credits on this host.
  const LIVE = {
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-12T06:08:19.603673+00:00",
        end: "2026-08-19T06:08:19.603673+00:00",
      },
      creditUsagePercent: 51.0,
      productUsage: [
        { product: "GrokBuild", usagePercent: 50.0 },
        { product: "GrokChat", usagePercent: 1.0 },
      ],
    },
  };

  const probeReturning = (payload: unknown): GrokBillingProbe => ({ read: async () => payload });

  it("reads the credit window and each product's share of it", async () => {
    const reading = await new GrokUsageCollector({
      clock: clock(),
      binary: "grok",
      grokBilling: probeReturning(LIVE),
    }).collect();

    expect(reading.sensorHealth, reading.error ?? "").toBe("HEALTHY");
    expect(reading.source).toMatch(/^account-billing:grok;/u);
    expect(reading.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([
      ["credits", 49],
      ["grokbuild", 50],
      ["grokchat", 99],
    ]);
    // Grok's capability set is unchanged by the new source: optional diversity only, never a
    // critical continuity role (ADR-0007).
    expect(reading.buckets.every((bucket) => bucket.capabilities.join() === "adversarial-review")).toBe(true);
    expect(reading.buckets[0]?.resetAt).toBe("2026-08-19T06:08:19.603Z");
  });

  it("refuses rather than guessing when the account states no usable percentage", async () => {
    for (const payload of [null, {}, { config: {} }, { config: { creditUsagePercent: "n/a" } }, { config: { creditUsagePercent: 140 } }]) {
      const reading = await new GrokUsageCollector({
        clock: clock(),
        binary: "grok",
        grokBilling: probeReturning(payload),
      }).collect();
      expect(reading.sensorHealth, JSON.stringify(payload)).toBe("ERROR");
      expect(reading.buckets).toEqual([]);
    }
  });

  it("drops a product whose share is not a usable percentage", async () => {
    // A malformed product must not become a bucket. Every applicable bucket has to clear the
    // floor, so a nonsense one either withholds all Grok work or, read as zero used, quietly
    // adds headroom that was never stated.
    const reading = await new GrokUsageCollector({
      clock: clock(),
      binary: "grok",
      grokBilling: probeReturning({
        config: {
          creditUsagePercent: 10,
          currentPeriod: { end: "2026-08-19T06:08:19.603673+00:00" },
          productUsage: [
            { product: "GrokBuild", usagePercent: 20 },
            { product: "Broken", usagePercent: "n/a" },
            { product: "AlsoBroken", usagePercent: 140 },
            { product: 42, usagePercent: 5 },
          ],
        },
      }),
    }).collect();

    expect(reading.sensorHealth, reading.error ?? "").toBe("HEALTHY");
    expect(reading.buckets.map((bucket) => bucket.id)).toEqual(["credits", "grokbuild"]);
  });

  it("keeps the borrowed credential out of everything it records", async () => {
    // This is the one provider whose quota cannot be read through its own CLI, so ACP holds the
    // subscription's bearer for the length of one request. Nothing about that may survive into
    // a reading, a source string or a digest.
    const secret = "xai-secret-token-value-that-must-not-appear-anywhere";
    const reading = await new GrokUsageCollector({
      clock: clock(),
      binary: "grok",
      grokBilling: {
        read: async () => ({ config: { ...LIVE.config, echoedToken: secret } }),
      },
    }).collect();

    const recorded = JSON.stringify(reading);
    expect(recorded).not.toContain(secret);
    expect(recorded).not.toContain("Bearer");
  });

  it("reports a missing credential through the real probe, not an injected one", async () => {
    // Every other test here injects a probe, which means the shipped one — the part that reads
    // the auth file and makes the request — is never entered. This drives it, stopping before
    // the network: no credential, no call. The same tests that pass with a fake probe would
    // pass if the real one threw on its first line.
    const reading = await new GrokUsageCollector({
      clock: clock(),
      binary: "grok",
      grokAuthPath: join(tempDir("acp-grok-noauth-"), "absent.json"),
    }).collect();

    expect(reading.sensorHealth).toBe("ERROR");
    expect(reading.error).toContain("no usable credential");
    expect(reading.buckets).toEqual([]);
  });

  it("reaches the request once it has a credential, and refuses before it otherwise", async () => {
    const root = tempDir("acp-grok-auth-");
    const authPath = join(root, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
          key: "x".repeat(882),
          create_time: "2026-08-01T00:00:00.000Z",
          auth_mode: "oidc",
        },
      }),
      { mode: 0o600 },
    );

    // Reaching the network is the proof it got a bearer: without one it refuses before calling.
    const reading = await new GrokUsageCollector({
      clock: clock(),
      binary: "grok",
      timeoutMs: 1,
      grokAuthPath: authPath,
    }).collect();

    expect(reading.sensorHealth).toBe("ERROR");
    expect(reading.error, reading.error ?? "").not.toContain("no usable credential");
    // And whatever fetch said about it, the credential is not in what gets recorded.
    expect(JSON.stringify(reading)).not.toContain("x".repeat(40));
  }, 20_000);

  it("says plainly that an expired credential is the CLI's to renew", async () => {
    const reading = await new GrokUsageCollector({
      clock: clock(),
      binary: "grok",
      grokBilling: {
        read: async () => {
          throw new Error("grok billing refused the stored credential; it has expired and only the CLI can renew it");
        },
      },
    }).collect();

    // Measured at six hours, and it expired mid-session while this was being written. Nothing
    // here writes a refreshed token back: that file belongs to the CLI, and racing it would be
    // a second writer to a credential store.
    expect(reading.sensorHealth).toBe("ERROR");
    expect(reading.error).toContain("only the CLI can renew it");
  });
});

describe("capacity review findings (#582)", () => {
  it("refuses an absent percentage instead of reading it as a full window", () => {
    // `Number()` maps null, "", [] and false to 0, and a zero used-percentage is a *full*
    // window. Every one of these reported complete headroom on an account that had stated
    // nothing — and on Codex those buckets carry ceo and worker.
    for (const absent of [null, "", [], false, {}, "n/a"]) {
      expect(parseGrokBilling({ config: { creditUsagePercent: absent } }).ok, JSON.stringify(absent)).toBe(false);
      expect(
        parseCodexRateLimits("gpt", { primary: { usedPercent: absent, windowDurationMins: 10080, resetsAt: 1 } }).ok,
        JSON.stringify(absent),
      ).toBe(false);
    }
    // A real zero is a real statement and must still be read.
    const zero = parseGrokBilling({ config: { creditUsagePercent: 0 } });
    expect(zero.ok).toBe(true);
    if (!zero.ok) return;
    expect(zero.buckets[0]?.remainingPercent).toBe(100);
  });

  it("folds two windows of one duration to the lower reading", () => {
    // Keeping the first discarded a spent secondary behind a healthy primary. Every Codex
    // bucket carries every Codex capability, so the healthy one alone admitted work.
    const parsed = parseCodexRateLimits("gpt", {
      primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1 },
      secondary: { usedPercent: 95, windowDurationMins: 10080, resetsAt: 1 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([["7d", 5]]);
  });

  it("folds product names that normalise together, keeping the tightest", () => {
    // `Grok-Build`, `Grok Build` and `grok_build` are one id. The first won, so the 90% and
    // 99% used rows vanished behind a 10% one.
    const parsed = parseGrokBilling({
      config: {
        creditUsagePercent: 10,
        productUsage: [
          { product: "Grok-Build", usagePercent: 10 },
          { product: "Grok Build", usagePercent: 90 },
          { product: "grok_build", usagePercent: 99 },
        ],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([
      ["credits", 90],
      ["grok-build", 1],
    ]);
  });

  it("reads the credential only from a file shaped like the CLI's own auth store", () => {
    const root = tempDir("acp-grok-auth-guard-");
    const write = (name: string, body: unknown): string => {
      const at = join(root, name);
      writeFileSync(at, JSON.stringify(body), { mode: 0o600 });
      return at;
    };
    const scope = (id: string, key: string, createdAt: string): Record<string, unknown> => ({
      [`https://auth.x.ai::${id}`]: { key, create_time: createdAt, auth_mode: "oidc" },
    });

    // The live shape: one scope entry keyed by the issuer.
    const credential = "x".repeat(40);
    expect(grokBearer(write("one.json", scope("a", credential, "2026-08-01T00:00:00.000Z")))).toBe(credential);

    // Several scopes is normal — the CLI's own migration leaves a legacy entry behind — and
    // refusing on that was a dead sensor for a file the CLI writes and calls healthy. The live
    // credential is the most recently created.
    const newest = "b".repeat(40);
    expect(
      grokBearer(
        write("two.json", {
          ...scope("a", "a".repeat(40), "2026-01-01T00:00:00.000Z"),
          ...scope("b", newest, "2026-08-01T00:00:00.000Z"),
        }),
      ),
    ).toBe(newest);

    // Undated or tied entries leave no way to say which is current.
    expect(grokBearer(write("undated.json", { ...scope("a", "a".repeat(40), "nonsense"), ...scope("b", "b".repeat(40), "2026-08-01T00:00:00.000Z") }))).toBeNull();

    // A foreign secrets store, reached three ways. The first two are about the path; the third
    // is not — a hard link *is* the file, so only what the file says can refuse it.
    // Nested the way a real secrets store is, so what refuses it is the file's *shape* rather
    // than a stricter check further down. A flat `{ key: … }` is rejected for the wrong reason.
    const foreign = write("other-secrets.json", {
      "signing-material": { key: "exfiltrated-other-secret-value-XXXXXXXX", create_time: "2026-08-01T00:00:00.000Z" },
    });
    const symlinked = join(root, "sym.json");
    symlinkSync(foreign, symlinked);
    expect(grokBearer(symlinked)).toBeNull();
    const hardLinked = join(root, "hard.json");
    linkSync(foreign, hardLinked);
    expect(grokBearer(hardLinked)).toBeNull();
    expect(grokBearer(foreign)).toBeNull();

    // Non-files, including the one that used to block outside every timer this code has.
    expect(grokBearer(root)).toBeNull();
    expect(grokBearer("/dev/null")).toBeNull();
    const fifo = join(root, "fifo.json");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    expect(grokBearer(fifo)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);

    // A value carrying CR/LF is quoted back verbatim by fetch's error, which is recorded in the
    // reading, mirrored to disk, and served over the operator socket.
    expect(grokBearer(write("crlf.json", scope("a", "xai-secret\r\nX-Inject: 1 aaaaaaaaaaaaaaaaaaaa", "2026-08-01T00:00:00.000Z")))).toBeNull();
  });

  it("answers a Codex stream whose ids are strings, and ignores an id it did not ask for", async () => {
    // JSON-RPC ids may be strings. Comparing with === to a number meant a stack echoing "0"
    // never received the read, and one echoing "1" was never answered — both spent the whole
    // timeout looking like an unresponsive server.
    const root = tempDir("acp-codex-strid-");
    const binary = join(root, "codex-string-ids.mjs");
    writeFileSync(
      binary,
      `#!${process.execPath}\n` +
        // The handshake and a generous window in one burst, before the read is sent. Those
        // bytes cannot be the answer to a request that did not exist when they were written.
        `process.stdout.write(JSON.stringify({ id: "0", result: {} }) + "\\n" + JSON.stringify({ id: 1, result: { primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1 } } }) + "\\n");\n` +
        `process.stdin.on("data", () => {\n` +
        `  process.stdout.write(JSON.stringify({ id: "1", result: { primary: { usedPercent: 95, windowDurationMins: 10080, resetsAt: 1 } } }) + "\\n");\n` +
        `});\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    chmodSync(binary, 0o700);

    const started = Date.now();
    const reading = await new CodexUsageCollector({ clock: clock(), binary, timeoutMs: 6_000 }).collect();

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(reading.sensorHealth, reading.error ?? "").toBe("HEALTHY");
    // The stray id:1 arrived alongside the handshake and stated 99 remaining. The answer is
    // the one that came back after asking.
    expect(reading.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([["7d", 5]]);
  }, 20_000);
});

describe("interactive provider usage collectors", () => {
  it("normalises explicit quota windows, reset horizons, capabilities, and raw-output digest", async () => {
    // Through Codex: Claude reads its account non-interactively now, and this pins the
    // terminal parser that Codex and Grok still use.
    const collector = new CodexUsageCollector({
      clock: clock(),
      binary: "unused-by-injected-terminal",
      terminal: terminal(`
5-hour limit: 62% remaining — resets in 1h 15m
weekly quota: 41% left — resets at 2026-08-18T00:00:00Z
`),
    });

    const reading = await collector.collect();

    expect(reading).toMatchObject({
      provider: "gpt",
      sensorHealth: "HEALTHY",
      runtimeHealth: "UNKNOWN",
      observedAt: "2026-08-13T00:00:00.000Z",
      source: expect.stringMatching(/^interactive-\/usage:gpt;raw-output-digest:sha256:[a-f0-9]{64}$/),
      rawOutputDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(reading.buckets).toEqual([
      expect.objectContaining({
        id: "5-hour",
        remainingPercent: 62,
        resetAt: "2026-08-13T01:15:00.000Z",
        capabilities: expect.arrayContaining(["ceo", "blind-review"]),
      }),
      expect.objectContaining({
        id: "weekly",
        remainingPercent: 41,
        resetAt: "2026-08-18T00:00:00.000Z",
      }),
    ]);
  });

  it("rejects activity-only Codex output instead of converting token charts into quota", async () => {
    const reading = await new CodexUsageCollector({
      clock: clock(),
      binary: "unused-by-injected-terminal",
      terminal: terminal(CODEX_ACTIVITY_ONLY),
    }).collect();

    expect(reading, JSON.stringify(reading)).toMatchObject({
      provider: "gpt",
      sensorHealth: "ERROR",
      buckets: [],
      error: expect.stringContaining("no explicit remaining-quota percentage"),
    });
  });

  /**
   * The prompts arrive from a terminal, not from a string literal.
   *
   * This test used to inject `"Quick safety check: Is this a project you trust?"` — text as
   * a reader sees it, with the spaces a TUI does not put there. A TUI positions each word
   * with its own CSI sequence, and `stripTerminal` deletes those rather than replacing them,
   * so the guard actually receives `Quicksafetycheck...`. The old fixture asserted an input
   * the production path cannot produce, and passed for as long as the guard was unreachable.
   *
   * So the prompts below carry the cursor moves, and the assertion is that the refusal
   * survives them.
   */
  const CHA = (column: number) => `[${column}G`;

  it("refuses live trust prompts from Claude and Grok rather than approving them", async () => {
    const claude = await new CodexUsageCollector({
      clock: clock(),
      binary: "unused-by-injected-terminal",
      terminal: terminal(
        `${CHA(3)}Quick${CHA(9)}safety${CHA(16)}check:${CHA(23)}Is this a project you trust?${CHA(3)}1. Yes, I trust this folder`,
      ),
    }).collect();
    const grok = await new GrokUsageCollector({
      clock: clock(),
      binary: "unused-by-injected-terminal",
      terminal: terminal(`${CHA(3)}Do${CHA(6)}you${CHA(10)}trust${CHA(16)}the contents of this directory?`),
    }).collect();

    for (const reading of [claude, grok]) {
      expect(reading.sensorHealth).toBe("ERROR");
      expect(reading.buckets).toEqual([]);
      expect(reading.error).toContain("trust or approval");
    }
  });

  it("still refuses a trust prompt that arrives with its spaces intact", async () => {
    // The other half. The patterns carry no spaces now, so a stream that *does* keep them —
    // a plain pipe rather than a TUI — would stop matching if the candidate were not
    // normalised too. Without this, fixing the terminal case would have broken the case the
    // original fixture was written for, and nothing would have said so.
    const claude = await new CodexUsageCollector({
      clock: clock(),
      binary: "unused-by-injected-terminal",
      terminal: terminal("Quick safety check: Is this a project you trust? 1. Yes, I trust this folder"),
    }).collect();

    expect(claude.sensorHealth).toBe("ERROR");
    expect(claude.error).toContain("trust or approval");
  });

  it("tells a CLI that never launched apart from one that showed the wrong screen", () => {
    // The distinction #564 needed and did not have: three causes arrived as one sentence,
    // and the one that was actually happening — a binary outside the daemon's PATH, so
    // nothing started — reads nothing like "output contains no percentage".
    const silent = parseUsageOutput("claude", "", clock().nowIso());
    expect(silent.ok).toBe(false);
    if (silent.ok) return;
    expect(silent.error).toContain("produced no output");
    expect(silent.error).toContain("PATH");

    const wrongScreen = parseUsageOutput("claude", "Welcome back\nToken activity: 40%", clock().nowIso());
    expect(wrongScreen.ok).toBe(false);
    if (wrongScreen.ok) return;
    expect(wrongScreen.error).toContain("no explicit remaining-quota percentage");
    expect(wrongScreen.error).toContain("2 line(s)");
  });

  /**
   * The layout measured on claude 2.1.233, at the default width and at a pinned 200 columns
   * alike: the label, the bar-and-percentage and the reset arrive as three separate lines,
   * and the TUI supplies no spaces of its own (#570). Reproduced here verbatim rather than
   * tidied, because a tidied fixture is what let the trust guard sit unreachable for months.
   */
  const LIVE_USAGE_SHAPE = [
    "Currentsession",
    "\u2588 8%used",
    "Resets3:00am(Asia/Seoul)",
    "Currentweek(allmodels)",
    "\u2588\u2588\u2588 41%used",
    "ResetsAug18at9am(Asia/Seoul)",
    "+5%weeklylimitspromothroughAug20",
    "Currentweek(Fable)",
    "\u2588 12%used",
  ].join("\n");

  it("reads every window on the screen, associating names across lines", () => {
    const parsed = parseUsageOutput("claude", LIVE_USAGE_SHAPE, clock().nowIso());
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    if (!parsed.ok) return;

    // Three windows, not one. A single bucket would silently pick a quota and ignore the
    // others, which admission cannot detect — it requires every applicable window.
    expect(parsed.buckets.map((b) => b.id)).toEqual([
      "currentsession",
      "currentweek-allmodels",
      "currentweek-fable",
    ]);
  });

  it("derives remaining from used and records which side it came from", () => {
    const parsed = parseUsageOutput("claude", LIVE_USAGE_SHAPE, clock().nowIso());
    if (!parsed.ok) throw new Error(parsed.error);

    expect(parsed.buckets.map((b) => b.remainingPercent)).toEqual([92, 59, 88]);
    expect(parsed.buckets.every((b) => b.measuredAs === "used")).toBe(true);
    // The reset stays null, and that is the current honest answer rather than an oversight.
    // The screen states it as an absolute local time — `Resets3:00am(Asia/Seoul)` — and
    // `normaliseResetAt` reads ISO timestamps and relative "resets in 1h 15m" only. Left
    // unparsed on purpose: `docs/capacity-source.md` says a usable percentage with no
    // machine-readable reset keeps `resetAt: null` and the worker reserve protects that
    // window until a real horizon is observed. Guessing a zone-qualified wall-clock time
    // would put a wrong horizon in evidence, which is worse than none.
    expect(parsed.buckets[0]?.resetAt).toBeNull();
  });

  it("does not turn the promo line into a window", () => {
    // `+5%weeklylimitspromothroughAug20` carries a percentage and no sense word. Treating it
    // as quota would invent a window that modifies a denominator rather than stating one.
    const parsed = parseUsageOutput("claude", LIVE_USAGE_SHAPE, clock().nowIso());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.buckets.map((b) => b.id).some((id) => id.includes("promo"))).toBe(false);
  });

  it("still refuses a percentage with no window above it", () => {
    // The invariant that survives: a bare percentage is rejected rather than guessed, and
    // accepting `used` does not weaken it.
    const parsed = parseUsageOutput("claude", "\u2588 40%used", clock().nowIso());
    expect(parsed.ok).toBe(false);
  });

  it("assembles a repaint from whichever paint stated the least, not from one chosen paint", () => {
    // This replaces an assertion that the reported ids are exactly the last paint's. Choosing a
    // single frame — the last, or the one with the most windows — was measured to over-report:
    // a complete earlier paint outvotes a shorter current one that just moved a shared window
    // down, and a damaged paint can hold more ids than the intact one. Over-reporting is the
    // failure that dispatches work the quota cannot pay for.
    //
    // The union's cost is that a damaged repaint's misspelling appears beside the real window.
    // That cannot grant work: `isRoutableFor` requires *every* applicable bucket to clear the
    // floor, so an extra bucket can only withhold. The trade is a noisier reported set for a
    // decision that cannot be too generous.
    const ESC = String.fromCharCode(27);
    const HOME = ESC + "[H";
    const now = clock().nowIso();

    const damaged = ["Current session", "8%used", "Current week (ll model)", "41%used"].join("\n");
    const current = ["Currentsession", "8%used", "Currentweek(allmodels)", "41%used"].join("\n");
    const parsed = parseUsageOutput("claude", HOME + damaged + HOME + current, now);
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    if (!parsed.ok) return;
    // Both spellings of both windows survive, which is the union's accepted cost. Asserting a
    // maximum alone does not lock that — the last paint on its own already satisfies it.
    expect(parsed.buckets.map((bucket) => bucket.id).sort()).toEqual([
      "current-session",
      "current-week-ll-model",
      "currentsession",
      "currentweek-allmodels",
    ]);
    expect(parsed.buckets.filter((bucket) => bucket.remainingPercent === 59)).toHaveLength(2);

    // The case a single-frame rule gets wrong in the dangerous direction: the earlier paint is
    // complete and the later one is partial, but the later one is what says the week is spent.
    const moved =
      HOME + ["Currentsession", "8%used", "Currentweek(allmodels)", "5%used", "Currentweek(Fable)", "12%used"].join("\n") +
      HOME + ["Currentsession", "8%used", "Currentweek(allmodels)", "95%used"].join("\n");
    const lowered = parseUsageOutput("claude", moved, now);
    expect(lowered.ok, lowered.ok ? "" : lowered.error).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.buckets.find((bucket) => bucket.id === "currentweek-allmodels")?.remainingPercent).toBe(5);

    // One damaged paint must not take the whole observation down with it. A window labelled
    // twice in a single paint is ambiguous, so that paint is skipped — not the reading.
    const ambiguous =
      HOME + ["Currentsession", "8%used", "Currentweek(allmodels)", "41%used 59% remaining"].join("\n") +
      HOME + ["Currentsession", "8%used", "Currentweek(allmodels)", "95%used"].join("\n");
    const survived = parseUsageOutput("claude", ambiguous, now);
    expect(survived.ok, survived.ok ? "" : survived.error).toBe(true);
    if (!survived.ok) return;
    expect(survived.buckets.find((bucket) => bucket.id === "currentweek-allmodels")?.remainingPercent).toBe(5);
  });

  it("prefers the lowest reading of a window even when the later paint states more", () => {
    // Minimum across paints, not the most recent one. A repaint caught mid-draw states a
    // prefix of the real figure — `95%used` half-drawn is `9%used`, which reads as 91
    // remaining instead of 5. Taking the later paint believes the half-drawn number; taking
    // the lowest cannot, and the direction of that error is the one that dispatches work the
    // quota cannot pay for.
    const ESC = String.fromCharCode(27);
    const HOME = ESC + "[H";
    const midDraw =
      HOME + ["Currentweek(allmodels)", "95%used"].join("\n") +
      HOME + ["Currentweek(allmodels)", "9%used"].join("\n");
    const parsed = parseUsageOutput("claude", midDraw, clock().nowIso());
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.buckets.find((bucket) => bucket.id === "currentweek-allmodels")?.remainingPercent).toBe(5);
  });

  it("ends a borrow at a line with words of its own, and keeps it across a redrawn bar", () => {
    // A figure with no words of its own borrows the window in force — that is a redraw's stale
    // bar and its successors. Bounding that borrow by position was measured to report the
    // *stalest* of a three-times-redrawn bar: 80 remaining for a window at 59, in the direction
    // that dispatches work the quota cannot pay for. So the borrow is unbounded in length, and
    // what ends it is content rather than distance.
    const now = clock().nowIso();
    const CR = String.fromCharCode(13);

    // Three redraws of one bar. Every figure belongs to the window above it.
    const redrawn = parseUsageOutput(
      "claude",
      "Currentweek(allmodels)\n0%used" + CR + "20%used" + CR + "41%used",
      now,
    );
    expect(redrawn.ok, redrawn.ok ? "" : redrawn.error).toBe(true);
    if (!redrawn.ok) return;
    expect(redrawn.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([
      ["currentweek-allmodels", 59],
    ]);

    // A promo has words of its own and cannot be named, so it ends the borrow and the figure
    // below it belongs to nothing.
    const promo = parseUsageOutput(
      "claude",
      ["Currentweek(allmodels)", "41%used", "+5%weeklylimitspromothroughAug20", "3% remaining"].join("\n"),
      now,
    );
    expect(promo.ok, promo.ok ? "" : promo.error).toBe(true);
    if (!promo.ok) return;
    expect(promo.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([
      ["currentweek-allmodels", 59],
    ]);

    // A section heading that states its own percentage names itself, so the figure under it is
    // that section's, not the week's.
    const sectioned = parseUsageOutput(
      "claude",
      ["Currentweek(allmodels)", "41%used", "Token activity last 12 months 40% used", "3% remaining"].join("\n"),
      now,
    );
    expect(sectioned.ok, sectioned.ok ? "" : sectioned.error).toBe(true);
    if (!sectioned.ok) return;
    // Asserted in full rather than by lookup: naming the section makes it a window, and the
    // figure under it becomes that window's. Stated so it is visible — it lands at 3, which is
    // above the exhaustion floor of 2, so it moves the provider to CONSERVE and does not make
    // any role unroutable.
    expect(sectioned.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([
      ["currentweek-allmodels", 59],
      ["token-activity-last-12-months", 3],
    ]);

    // A reset is a horizon. It neither borrows nor names a window, even carrying a sense word.
    const reset = parseUsageOutput(
      "claude",
      ["Currentweek(allmodels)", "41%used", "Resets Aug18 at 9am 3% left", "Currentweek(Fable)", "12%used"].join("\n"),
      now,
    );
    expect(reset.ok, reset.ok ? "" : reset.error).toBe(true);
    if (!reset.ok) return;
    expect(reset.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([
      ["currentweek-allmodels", 59],
      ["currentweek-fable", 88],
    ]);

    // Accepted, and stated rather than left to be discovered: an unbroken run of *unlabelled*
    // figures under a real window walks that window down to the last of them. Nothing observed
    // draws that shape, and it withholds work rather than granting it — the one direction this
    // parser is allowed to be wrong in.
    const walked = parseUsageOutput(
      "claude",
      ["Currentweek(allmodels)", "41%used", "90% remaining", "3% remaining"].join("\n"),
      now,
    );
    expect(walked.ok, walked.ok ? "" : walked.error).toBe(true);
    if (!walked.ok) return;
    expect(walked.buckets[0]?.remainingPercent).toBe(3);
  });

  it("takes the figure on the line that ends a borrow, and not the stale one before it", () => {
    // Deciding whether a borrow survives BEFORE taking the line's own figures drops the figure
    // on that very line — and that line is often the freshest. Every case here left the stale
    // number standing, which is the over-reporting direction this whole change exists to close.
    const now = clock().nowIso();
    const CR = String.fromCharCode(13);

    // A repaint whose bar and horizon share a row. `(Asia/Seoul)` is the live horizon spelling.
    const withHorizon = parseUsageOutput(
      "claude",
      "Currentweek(allmodels)\n0%used" + CR + "41%used (Asia/Seoul)",
      now,
    );
    expect(withHorizon.ok, withHorizon.ok ? "" : withHorizon.error).toBe(true);
    if (!withHorizon.ok) return;
    expect(withHorizon.buckets[0]?.remainingPercent).toBe(59);

    // A unit after the figure. `min`, `hrs` and `UTC` are three letters; `am` and `pm` are two,
    // which is why those never showed the fault.
    for (const trailer of ["15min", "2hrs", "UTC"]) {
      const united = parseUsageOutput(
        "claude",
        ["Currentweek(allmodels)", "80% remaining", `59% remaining ${trailer}`].join("\n"),
        now,
      );
      expect(united.ok, united.ok ? "" : united.error).toBe(true);
      if (!united.ok) return;
      expect(united.buckets[0]?.remainingPercent, trailer).toBe(59);
    }
  });

  it("does not turn a horizon into a quota window, in the spelling the CLI actually uses", () => {
    // The exclusion was a word-boundary match, and the live reset has no boundary to find:
    // `ResetsAug18at9am(Asia/Seoul)`. A horizon that trailed a percentage therefore became a
    // window — every claude bucket advertises every capability, so that one lands on all four.
    const now = clock().nowIso();
    const glued = parseUsageOutput("claude", "ResetsAug18at9am 3% left", now);
    expect(glued.ok).toBe(false);

    const inSitu = parseUsageOutput(
      "claude",
      ["Currentweek(allmodels)", "41%used", "Resets Aug18 at 9am 3% left", "Currentweek(Fable)", "12%used"].join("\n"),
      now,
    );
    expect(inSitu.ok, inSitu.ok ? "" : inSitu.error).toBe(true);
    if (!inSitu.ok) return;
    expect(inSitu.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([
      ["currentweek-allmodels", 59],
      ["currentweek-fable", 88],
    ]);
  });

  it("names a window whose figure is glued to it, because the spaces are what vanish", () => {
    // The label form was added for `Fable 12% remaining` nested under its parent, and it
    // required whitespace — so the one new same-line shape died exactly when the spaces did,
    // and the child's constraint disappeared instead of being read.
    const glued = parseUsageOutput(
      "claude",
      ["Current week", "all models 41% remaining", "Fable12%remaining"].join("\n"),
      clock().nowIso(),
    );
    expect(glued.ok, glued.ok ? "" : glued.error).toBe(true);
    if (!glued.ok) return;
    // The name keeps its spaces where the paint had them, so one window is not two ids.
    expect(glued.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([
      ["all-models", 41],
      ["fable", 12],
    ]);
  });

  it("keeps the empty-stream cause distinct from a screen that stated no quota", () => {
    // #564: those two failures used to arrive as one sentence, and a whole causal chain was
    // built on the wrong one. A trailing home leaves an empty final frame, so a rule that read
    // only the last frame reported "the binary may not have launched" about a screen that had
    // just printed two lines.
    const ESC = String.fromCharCode(27);
    const trailing = parseUsageOutput("claude", "Welcome back\nToken activity: 40%" + ESC + "[H", clock().nowIso());
    expect(trailing.ok).toBe(false);
    if (trailing.ok) return;
    expect(trailing.error).toContain("no explicit remaining-quota percentage");
    expect(trailing.error).not.toContain("may not have launched");
  });

  it("keeps a window the last paint dropped, and every reading that would lower it", () => {
    // Every case below was measured against the merged parser and produced a remaining percent
    // HIGHER than the screen stated. That is the only direction that matters: `isRoutableFor`
    // admits a role when every applicable bucket clears the floor, so over-reporting dispatches
    // work the quota cannot pay for, while under-reporting only withholds it.
    const ESC = String.fromCharCode(27);
    const HOME = ESC + "[H";
    const CR = String.fromCharCode(13);
    const now = clock().nowIso();

    // The collector stops after two seconds of quiet, so a home plus a partial repaint is a
    // complete observation. Reading only the last frame lost the week window entirely and left
    // the session bucket at 92 to route on its own.
    const partial = HOME + "Currentsession\n8%used\nCurrentweek(allmodels)\n95%used" + HOME + "Currentsession\n8%used";
    const dropped = parseUsageOutput("claude", partial, now);
    expect(dropped.ok, dropped.ok ? "" : dropped.error).toBe(true);
    if (!dropped.ok) return;
    expect(dropped.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([
      ["currentsession", 92],
      ["currentweek-allmodels", 5],
    ]);

    // A trailing home leaves an empty final frame. That read as "the binary may not have
    // launched", which is a false cause for a stream that had just stated a quota.
    const trailing = parseUsageOutput("claude", "Currentweek(allmodels)\n41%used" + HOME, now);
    expect(trailing.ok, trailing.ok ? "" : trailing.error).toBe(true);
    if (!trailing.ok) return;
    expect(trailing.buckets[0]?.remainingPercent).toBe(59);

    // A TUI redrawing a bar in place emits the stale figure, CR, then the fresh one. Because
    // `stripTerminal` turns CR into a newline, both survive as lines — and the first won.
    const redrawn = parseUsageOutput("claude", "Currentweek(allmodels)\n0%used" + CR + "41%used", now);
    expect(redrawn.ok, redrawn.ok ? "" : redrawn.error).toBe(true);
    if (!redrawn.ok) return;
    expect(redrawn.buckets[0]?.remainingPercent).toBe(59);

    // A window nested under its parent was dropped, so routing saw the parent's 41 and never
    // the child's 12 — the tighter constraint, and the one that should govern.
    const nested = parseUsageOutput("claude", "Current week\nall models 41% remaining\nFable 12% remaining", now);
    expect(nested.ok, nested.ok ? "" : nested.error).toBe(true);
    if (!nested.ok) return;
    // Both are real windows and both are kept, because a line with words of its own names
    // itself. Admission needs every applicable bucket to clear the floor, so the child's 12
    // governs — which is the constraint that used to be dropped entirely.
    expect(nested.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([
      ["all-models", 41],
      ["fable", 12],
    ]);

    // Two labels then two figures: the nearer label took the other window's number and the
    // second figure was discarded, reporting 88 for a bar that said 41% used.
    const interleaved = parseUsageOutput("claude", "Currentweek(Fable)\nCurrentweek(allmodels)\n12%used\n41%used", now);
    expect(interleaved.ok, interleaved.ok ? "" : interleaved.error).toBe(true);
    if (!interleaved.ok) return;
    expect(interleaved.buckets.map((bucket) => bucket.remainingPercent)).toEqual([59]);
  });

  it("takes the lower figure when a line states both senses of one window", () => {
    // Squeezing removed the spaces, so `41% used 80% remaining` arrived as one token and the
    // old word boundary skipped `used` — reporting 80 for a window with 59 left.
    //
    // This refused, at first. Refusing was measured to be worse than folding: when the
    // ambiguous paint is the one saying a window is spent, refusing it — or skipping only that
    // paint — lets a stale high reading from another paint stand. `X% used` and
    // `(100-X)% remaining` agree by construction, so a disagreeing pair is a screen
    // contradicting itself, and the lower number is the one that cannot admit work the quota
    // will not cover.
    const contradictory = parseUsageOutput("claude", "weekly: 41% used 80% remaining", clock().nowIso());
    expect(contradictory.ok, contradictory.ok ? "" : contradictory.error).toBe(true);
    if (!contradictory.ok) return;
    expect(contradictory.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([["weekly", 59]]);

    // The ambiguous paint is the only one that says the week is spent. Discarding it accepts
    // the other paint's 92.
    const ESC = String.fromCharCode(27);
    const HOME = ESC + "[H";
    const outvoted = parseUsageOutput(
      "claude",
      HOME + "Currentweek(allmodels)\n95%used 5%remaining" + HOME + "Currentweek(allmodels)\n8%used",
      clock().nowIso(),
    );
    expect(outvoted.ok, outvoted.ok ? "" : outvoted.error).toBe(true);
    if (!outvoted.ok) return;
    expect(outvoted.buckets[0]?.remainingPercent).toBe(5);
  });

  it("refuses a figure that may be the tail of a wrapped bar, without refusing a promo", () => {
    // A bar that wraps mid-number leaves `████4` above `1%used`. Reading the second line alone
    // reports 99 remaining for a window at 59 — inventing headroom, which is the direction that
    // dispatches work the quota cannot cover. The pty is pinned to 200 columns, but the parser
    // takes no width and accepts any capture handed to it.
    const now = clock().nowIso();
    for (const wrapped of [
      ["Currentweek(allmodels)", "\u2588\u2588\u25884", "1%used"],
      ["Currentweek(allmodels)", "\u2588\u2588\u258841", "0%used"],
    ]) {
      const parsed = parseUsageOutput("claude", wrapped.join("\n"), now);
      expect(parsed.ok, wrapped.join(" / ")).toBe(false);
    }

    // The tell is a letterless line — a bar is glyphs and digits. A promo that happens to end
    // in a digit carries words, and refusing on that would kill a whole reading over marketing.
    const promo = parseUsageOutput(
      "claude",
      ["Currentweek(allmodels)", "41%used", "+5%weeklylimitspromothroughAug20", "3% remaining"].join("\n"),
      now,
    );
    expect(promo.ok, promo.ok ? "" : promo.error).toBe(true);
    if (!promo.ok) return;
    expect(promo.buckets.map((bucket) => bucket.remainingPercent)).toEqual([59]);

    // An intact bar on one line is untouched.
    const intact = parseUsageOutput("claude", ["Currentweek(allmodels)", "\u2588\u2588\u2588 41%used"].join("\n"), now);
    expect(intact.ok, intact.ok ? "" : intact.error).toBe(true);
    if (!intact.ok) return;
    expect(intact.buckets[0]?.remainingPercent).toBe(59);
  });

  it("still refuses a trust prompt raised in an earlier frame", () => {
    // The refusal has to see the whole stream. A prompt that appeared and was repainted over
    // is still a failed observation — narrowing the check to the current frame would trade a
    // safety property for a parsing convenience.
    const ESC = "\u001B";
    const stream = `${ESC}[HQuick safety check: Is this a project you trust?${ESC}[HCurrentsession\n\u2588 8%used`;
    const parsed = parseUsageOutput("claude", stream, clock().nowIso());
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("trust or approval");
  });

  it("mutation: removing remaining/left makes a percentage non-routable", () => {
    expect(parseUsageOutput("gpt", "5-hour limit: 62% remaining — resets in 1h", clock().nowIso()).ok).toBe(true);
    // The point is `consumed` is not `remaining`, so this asserts the refusal and its reason
    // rather than the whole sentence — the sentence now also reports how much was read, which
    // is what separates this case from a CLI that never launched.
    const consumed = parseUsageOutput("gpt", "5-hour limit: 62% consumed — resets in 1h", clock().nowIso());
    expect(consumed.ok).toBe(false);
    if (consumed.ok) return;
    expect(consumed.error).toContain("no explicit remaining-quota percentage");
    expect(consumed.error).toContain("1 line(s)");
  });

  it("mutation: an impossible percentage refuses; a repeated label takes its lowest figure", () => {
    // An impossible percentage is still fatal: nothing about the screen is evidence.
    expect(parseUsageOutput("claude", "rolling: 101% remaining", clock().nowIso()).ok).toBe(false);

    // A label stated twice used to refuse the whole observation. That was fail-closed for a
    // single screen but not for a stream: a paint is discarded together with the constraint it
    // was the only one to state, and another paint's stale higher reading then stands. Folding
    // to the lowest keeps the tighter figure, and no fold can raise a window.
    const repeated = parseUsageOutput("claude", "\nrolling: 40% remaining\nrolling: 30% remaining\n", clock().nowIso());
    expect(repeated.ok, repeated.ok ? "" : repeated.error).toBe(true);
    if (!repeated.ok) return;
    expect(repeated.buckets.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([["rolling", 30]]);
  });

  it("waits for the CLI to be ready before typing, through a real pseudo-terminal", async () => {
    // Reproduces what claude 2.1.233 does: the TUI drops anything typed before it has drawn.
    // `expectProgram` writes the first step 100 ms after spawn, so without an input-less
    // waiting step the capture is the banner and nothing else — which is exactly what every
    // probe on the deployment host recorded (#564).
    const root = tempDir("acp-usage-ready-");
    const binary = join(root, "claude-ready-stub.mjs");
    writeFileSync(binary, `#!${process.execPath}
let ready = false;
process.stdin.on("data", (chunk) => {
  // Anything typed before the banner is dropped on the floor, as a TUI would.
  if (!ready) return;
  if (chunk.toString("utf8").includes("/usage")) {
    process.stdout.write("5-hour limit: 77% remaining — resets in 2h\\n");
  }
});
setTimeout(() => { ready = true; process.stdout.write("Claude Code v2.1.233\\n"); }, 900);
setInterval(() => {}, 1_000);
`);
    chmodSync(binary, 0o700);

    // Explicitly through the terminal path, which Claude now takes only when one is configured
    // — a host whose CLI predates the non-interactive command still needs the readiness wait.
    const reading = await new ClaudeUsageCollector({
      clock: clock(),
      binary,
      timeoutMs: 8_000,
      terminal: new ExpectUsageTerminal(),
    }).collect();

    expect(reading.sensorHealth, reading.error ?? "").toBe("HEALTHY");
    expect(reading.buckets.map((b) => b.remainingPercent)).toEqual([77]);
  });

  it("uses a real pseudo-terminal to enter Codex /usage and navigate only its usage chooser", async () => {
    const root = tempDir("acp-usage-pty-");
    const binary = join(root, "codex-usage-stub.mjs");
    writeFileSync(binary, `#!${process.execPath}
let received = "";
let opened = false;
process.stdin.on("data", (chunk) => {
  received += chunk.toString("utf8");
  if (!opened && received.includes("/usage")) {
    opened = true;
    process.stdout.write("Show usage\\n");
    return;
  }
  if (opened && /\\r|\\n/.test(received.slice(received.indexOf("/usage") + 6))) {
    process.stdout.write("5-hour limit: 77% remaining — resets in 2h\\n");
  }
});
setInterval(() => {}, 1_000);
`);
    chmodSync(binary, 0o700);

    const realTerminal = new ExpectUsageTerminal();
    let captured = "";
    const before = hostCodexPids();
    const reading = await new CodexUsageCollector({
      clock: clock(),
      binary,
      timeoutMs: 5_000,
      terminal: {
        async run(input) {
          const result = await realTerminal.run(input);
          captured = `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`;
          return result;
        },
      },
    }).collect();

    // A real Codex process seen on this host, either before the pty ran or still there once it
    // finished, is named before the assertion below runs — not after a bare `toMatchObject`
    // failure sends the next person hunting through their own diff for a cause that is not in
    // it (#644). Checked only when the reading itself already failed: a Codex process merely
    // being present is not evidence of anything when the test passed anyway.
    if (reading.sensorHealth !== "HEALTHY") {
      const concurrent = before.length > 0 ? before : hostCodexPids();
      if (concurrent.length > 0) {
        throw new Error(
          `another Codex session is active on this host (pid ${concurrent.join(", ")}); this ` +
            "test drives a real pseudo-terminal and its fixed navigation timing cannot be " +
            "trusted while a real Codex CLI process is competing for the machine — see #644. " +
            `Underlying reading: ${JSON.stringify(reading)}\n${captured}`,
        );
      }
    }

    expect(reading, `${JSON.stringify(reading)}\n${captured}`).toMatchObject({
      sensorHealth: "HEALTHY",
      buckets: [expect.objectContaining({ id: "5-hour", remainingPercent: 77 })],
    });
    // If the collector stops sending /usage or blindly removes Codex's bounded second
    // navigation step, this real PTY fixture times out or yields no routable bucket — and,
    // absent a concurrent Codex process, still reports that failure directly above.
  });

  it("turns a collector exception into an ERROR reading rather than throwing or reusing quota", async () => {
    const reading = await new CodexUsageCollector({
      clock: clock(),
      binary: "unused",
      terminal: { async run() { throw new Error("pty crashed"); } },
    }).collect();

    expect(reading).toMatchObject({ sensorHealth: "ERROR", runtimeHealth: "UNKNOWN", buckets: [], error: "pty crashed" });
  });

  it("real adapters ignore healthy quota files and return the live collector reading", async () => {
    const root = tempDir("acp-adapter-capacity-source-");
    const providers = [
      {
        provider: "claude" as const,
        file: "claude.json",
        collector: (options: ConstructorParameters<typeof ClaudeUsageCollector>[0]) => new ClaudeUsageCollector(options),
        adapter: (options: ConstructorParameters<typeof ClaudeCliAdapter>[0]) => new ClaudeCliAdapter(options),
      },
      {
        provider: "gpt" as const,
        file: "gpt.json",
        collector: (options: ConstructorParameters<typeof CodexUsageCollector>[0]) => new CodexUsageCollector(options),
        adapter: (options: ConstructorParameters<typeof CodexCliAdapter>[0]) => new CodexCliAdapter(options),
      },
      {
        provider: "grok" as const,
        file: "grok.json",
        collector: (options: ConstructorParameters<typeof GrokUsageCollector>[0]) => new GrokUsageCollector(options),
        adapter: (options: ConstructorParameters<typeof GrokCliAdapter>[0]) => new GrokCliAdapter(options),
      },
    ];

    for (const { provider, file, collector, adapter } of providers) {
      const capacityFile = join(root, file);
      writeFileSync(capacityFile, JSON.stringify({
        observedAt: clock().nowIso(),
        runtimeHealth: "HEALTHY",
        buckets: [{
          id: "human-maintained-file-only",
          remainingPercent: 99,
          resetAt: null,
          capabilities: ["blind-review"],
        }],
      }));
      const reading = await adapter({
        clock: clock(),
        capacityFile,
        // The real adapter is exercised; only the terminal transport is deterministic so
        // this regression does not depend on a provider login or a live quota page.
        binary: "/usr/bin/true",
        usageCollector: collector({
          clock: clock(),
          binary: "/usr/bin/true",
          terminal: terminal("/usage\nToken activity only; no explicit remaining quota\n"),
        }),
      }).probeCapacity();

      expect(reading.sensorHealth, `${provider}: ${JSON.stringify(reading)}`).toBe("ERROR");
      expect(reading.source).toMatch(new RegExp(`^interactive-/usage:${provider};`));
      expect(reading.source).not.toContain(capacityFile);
      expect(reading.buckets).toEqual([]);
      // A revert to readCapacityFile makes the first assertion receive HEALTHY and
      // makes the source/file-only bucket expose the human-maintained contents.
    }
  });

  it("registers Grok as optional adversarial capacity, never a required-role runtime", async () => {
    const packetRoot = tempDir("acp-grok-optional-");
    const adapter = new GrokCliAdapter({
      clock: clock(),
      capacityFile: join(packetRoot, "grok.json"),
      binary: "grok-not-invoked-by-required-role-test",
    });

    expect(adapter.optionalAdversarialOnly).toBe(true);
    await expect(adapter.startSession({
      model: "grok",
      workdir: packetRoot,
      purpose: "blind-review",
    })).rejects.toThrow(/optional adversarial review/);
    const requiredRole = await adapter.invoke({
      prompt: "Perform a required control-plane role.",
      workdir: packetRoot,
      timeoutMs: 1_000,
      readOnly: true,
      correlationId: "grok-required-role-refusal",
    });
    expect(requiredRole).toMatchObject({ ok: false, isolationAttested: false });
    expect(requiredRole.error).toContain("optional adversarial-review only");
    // Removing either refusal lets a third provider silently become required-role
    // capacity, which violates the collector-only diversity contract.
  });

  it("installs all three live collectors in the production default registry", () => {
    const root = tempDir("acp-default-provider-collectors-");
    const cp = new ControlPlane({
      databasePath: join(root, "state.sqlite"),
      worktreeRoot: join(root, "worktrees"),
      capacityDir: join(root, "capacity"),
      secretsDir: join(root, "secrets"),
      clock: clock(),
    });
    try {
      expect(cp.providers.list().map((adapter) => adapter.provider).sort()).toEqual(["claude", "gpt", "grok"]);
      expect(cp.providers.require("grok").optionalAdversarialOnly).toBe(true);
    } finally {
      cp.close();
    }
    // Deleting Grok from the composition root turns this into a two-provider registry;
    // merely defining a collector elsewhere is not enough to satisfy P0-11.
  });
});

describe("the non-interactive usage probe's environment", () => {
  it("passes USER through, because without it the CLI answers with a cost summary", () => {
    // Measured 2026-08-19 against the real binary. With PATH, HOME, LANG and LC_ALL the answer
    // is five lines of cost and duration — which parse as no quota window at all, so the
    // provider reports ERROR while its quota is perfectly fine. Adding TMPDIR, LOGNAME, SHELL
    // or TERM changes nothing; USER is the one that does.
    const before = process.env["USER"];
    process.env["USER"] = "isaac";
    try {
      expect(nonInteractiveEnvironment()["USER"]).toBe("isaac");
    } finally {
      if (before === undefined) delete process.env["USER"];
      else process.env["USER"] = before;
    }
  });

  it("carries nothing the daemon holds that a quota read has no use for", () => {
    // #564 — the daemon's own environment carries ACP_OPERATOR_TOKEN, and
    // CLAUDE_SECURESTORAGE_CONFIG_DIR is the variable that once made a probe read the wrong
    // credential store. The allowlist is the point; widening it for USER must not widen it further.
    const before = { ...process.env };
    process.env["ACP_OPERATOR_TOKEN"] = "secret";
    process.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] = "/elsewhere";
    try {
      const passed = Object.keys(nonInteractiveEnvironment());
      expect(passed.sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "USER"].filter(
        (name) => name === "HOME" || name === "LANG" || name === "LC_ALL" || name === "PATH" ||
          process.env[name] !== undefined,
      ).sort());
      expect(passed).not.toContain("ACP_OPERATOR_TOKEN");
      expect(passed).not.toContain("CLAUDE_SECURESTORAGE_CONFIG_DIR");
    } finally {
      process.env = before;
    }
  });
});

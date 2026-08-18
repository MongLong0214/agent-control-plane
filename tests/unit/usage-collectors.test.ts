import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ManualClock } from "../../src/core/clock.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import {
  ClaudeCliAdapter,
  CodexCliAdapter,
  GrokCliAdapter,
} from "../../src/runtime/cli-adapters.ts";
import {
  ClaudeUsageCollector,
  CodexUsageCollector,
  GrokUsageCollector,
  parseUsageOutput,
  ExpectUsageTerminal,
  type UsageTerminal,
} from "../../src/capacity/usage-collectors.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const clock = () => new ManualClock("2026-08-13T00:00:00.000Z");

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

describe("interactive provider usage collectors", () => {
  it("normalises explicit quota windows, reset horizons, capabilities, and raw-output digest", async () => {
    const collector = new ClaudeUsageCollector({
      clock: clock(),
      binary: "unused-by-injected-terminal",
      terminal: terminal(`
5-hour limit: 62% remaining — resets in 1h 15m
weekly quota: 41% left — resets at 2026-08-18T00:00:00Z
`),
    });

    const reading = await collector.collect();

    expect(reading).toMatchObject({
      provider: "claude",
      sensorHealth: "HEALTHY",
      runtimeHealth: "UNKNOWN",
      observedAt: "2026-08-13T00:00:00.000Z",
      source: expect.stringMatching(/^interactive-\/usage:claude;raw-output-digest:sha256:[a-f0-9]{64}$/),
      rawOutputDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(reading.buckets).toEqual([
      expect.objectContaining({
        id: "5-hour",
        remainingPercent: 62,
        resetAt: "2026-08-13T01:15:00.000Z",
        capabilities: expect.arrayContaining(["cto", "blind-review"]),
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
    const claude = await new ClaudeUsageCollector({
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
    const claude = await new ClaudeUsageCollector({
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

  it("reads the current frame when the TUI has repainted", () => {
    // A repaint is not a second screen. Measured on claude 2.1.233: the same three windows
    // arrive three times, and not identically — one paint keeps its spaces, another loses
    // characters, so `Current week (all models)` normalises two different ways and the
    // duplicate-window refusal fires on one screen read twice (#564).
    const ESC = "\u001B";
    const damaged = ["Current session", "\u2588 8%used", "Current week (ll model)", "\u2588 41%used"].join("\n");
    const current = ["Currentsession", "\u2588 8%used", "Currentweek(allmodels)", "\u2588 41%used"].join("\n");
    const repainted = `${ESC}[H${damaged}${ESC}[H${current}`;

    // Without frame awareness this is four windows, two of them the same quota under
    // different ids — which is what the deployment recorded as a duplicate refusal.
    const parsed = parseUsageOutput("claude", repainted, clock().nowIso());
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.buckets.map((b) => b.id)).toEqual(["currentsession", "currentweek-allmodels"]);
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

  it("mutation: malformed and duplicate windows refuse collection", () => {
    expect(parseUsageOutput("claude", "rolling: 101% remaining", clock().nowIso()).ok).toBe(false);
    expect(parseUsageOutput("claude", `
rolling: 40% remaining
rolling: 30% remaining
`, clock().nowIso())).toEqual({
      ok: false,
      error: "interactive /usage output contains duplicate quota-window labels",
    });
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

    expect(reading, `${JSON.stringify(reading)}\n${captured}`).toMatchObject({
      sensorHealth: "HEALTHY",
      buckets: [expect.objectContaining({ id: "5-hour", remainingPercent: 77 })],
    });
    // If the collector stops sending /usage or blindly removes Codex's bounded second
    // navigation step, this real PTY fixture times out or yields no routable bucket.
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

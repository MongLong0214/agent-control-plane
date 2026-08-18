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
    expect(sectioned.buckets.find((bucket) => bucket.id === "currentweek-allmodels")?.remainingPercent).toBe(59);

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

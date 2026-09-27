import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ControlPlane } from "../../src/app/control-plane.ts";
import { type Clock, ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import type { Finding } from "../../src/doctor/doctor.ts";
import { ClaudeCliAdapter, CodexCliAdapter, GrokCliAdapter } from "../../src/runtime/cli-adapters.ts";
import { ProviderRegistry } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * #954 — the daemon followed a pinned provider CLI path and never read it back.
 *
 * Measured on this host: the daemon started at 01:59:50Z holding
 * `~/.local/share/claude/versions/2.1.278`, the provider's own updater repointed the stable name
 * about a minute later and pruned that directory, and every capacity probe after it spawned a path
 * that was not there. What the deployment reported was `sensorHealth: ERROR`,
 * `runtimeHealth: UNAVAILABLE`, `buckets: []` and a bound CTO role revoked every ~3 minutes for
 * eight generations. Nothing anywhere said *the pinned binary is gone*.
 *
 * The check below is the readback. It stats the path the adapter will actually hand to `execve`,
 * and the two things it must not do are what these rows are mostly about: it must not canonicalise
 * the pin (the operator has to be told which pin is broken, not where it happened to land last),
 * and it must not block (a daemon parked on a missing thing is parked behind the very operator
 * step that would fix it — #950, #958, and the packet-reviewer scope check's own reasoning).
 */

/** A production adapter that carries a pin, which `ScriptedAdapter` deliberately does not. */
class PinnedAdapter extends TestProductionAdapter {
  readonly executablePath: string;

  constructor(clock: Clock, provider: string, executablePath: string) {
    super(clock, provider);
    this.executablePath = executablePath;
  }
}

/**
 * The exact shape this host was in: a stable name that is a symlink, and a versioned target the
 * provider's updater has since pruned.
 */
const prunedVersionPin = (): string => {
  const root = tempDir("acp-pin-");
  const target = join(root, "versions", "2.1.278", "claude");
  mkdirSync(join(root, "versions", "2.1.278"), { recursive: true });
  writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  mkdirSync(join(root, "bin"), { recursive: true });
  const stable = join(root, "bin", "claude");
  symlinkSync(target, stable);
  rmSync(join(root, "versions", "2.1.278"), { recursive: true, force: true });
  return stable;
};

/** A live stable name whose target is present but has lost its execute bit. */
const symlinkedPinWithoutExecuteBit = (): { stable: string; target: string } => {
  const root = tempDir("acp-pin-");
  const target = join(root, "versions", "2.1.283", "claude");
  mkdirSync(join(root, "versions", "2.1.283"), { recursive: true });
  writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  chmodSync(target, 0o644);
  mkdirSync(join(root, "bin"), { recursive: true });
  const stable = join(root, "bin", "claude");
  symlinkSync(target, stable);
  return { stable, target };
};

const healthyPin = (): string => {
  const root = tempDir("acp-pin-");
  const binary = join(root, "claude");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(binary, 0o755);
  return binary;
};

/**
 * Sets the `ACP_*_BINARY` pins for the body and puts every one of them back afterwards, including
 * the ones that were unset. The composed case reads these through `ControlPlane`, and the repair
 * message reads them again to decide whether a setting owns the pin in hand.
 */
const withPins = async (pins: Record<string, string>, body: () => Promise<void>): Promise<void> => {
  const before: Record<string, string | undefined> = {};
  for (const [variable, value] of Object.entries(pins)) {
    before[variable] = process.env[variable];
    process.env[variable] = value;
  }
  try {
    await body();
  } finally {
    for (const [variable, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[variable];
      else process.env[variable] = value;
    }
  }
};

const executableAt = (directory: string, name: string): string => {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
};

const pinFindings = async (
  register: (harness: ReturnType<typeof makeHarness>) => void,
): Promise<Finding[]> => {
  const harness = makeHarness();
  register(harness);
  const report = await harness.cp.doctor.run("system");
  return report.findings.filter((finding) => finding.code === ReasonCode.PROVIDER_EXECUTABLE_UNUSABLE);
};

describe("the doctor reads the pin it will spawn", () => {
  it("reports a stable name whose versioned target the updater pruned", async () => {
    const stable = prunedVersionPin();

    const findings = await pinFindings((harness) => {
      harness.cp.providers.register(new PinnedAdapter(harness.clock, "pinned", stable));
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.observedEvidence).toMatchObject({
      provider: "pinned",
      path: stable,
      condition: "ABSENT",
    });
  });

  it("does not canonicalise: the evidence names the pin, not what it resolved to", async () => {
    // The operator's next step is on the pin. A check that reported the realpath would name a
    // versioned file the updater owns and the operator never set, and on the pruned case there is
    // no realpath to report at all. The distinguishing fixture is a *live* symlink: a
    // canonicalising check would answer with `target`, and both paths exist so neither is missing.
    const { stable, target } = symlinkedPinWithoutExecuteBit();

    const findings = await pinFindings((harness) => {
      harness.cp.providers.register(new PinnedAdapter(harness.clock, "pinned", stable));
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.observedEvidence).toMatchObject({ path: stable, condition: "NOT_EXECUTABLE" });
    expect(findings[0]?.observedEvidence["path"]).not.toBe(target);
  });

  it("separates a directory at the pin from a pin that is not there", async () => {
    // Two different operator actions. A directory means the pin points at an installation root
    // rather than its executable; absent means the installation is gone.
    const root = tempDir("acp-pin-");
    const directory = join(root, "claude");
    mkdirSync(directory, { recursive: true });

    const findings = await pinFindings((harness) => {
      harness.cp.providers.register(new PinnedAdapter(harness.clock, "pinned", directory));
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.observedEvidence).toMatchObject({ path: directory, condition: "NOT_A_FILE" });
  });

  it("says nothing about a usable pin, and nothing about an adapter that has none", async () => {
    // `ScriptedAdapter` and every other non-CLI adapter spawn nothing, so the accessor is optional
    // and its absence is not a finding. The harness registers exactly such an adapter already.
    expect(
      await pinFindings((harness) => {
        harness.cp.providers.register(new PinnedAdapter(harness.clock, "pinned", healthyPin()));
      }),
    ).toEqual([]);

    expect(await pinFindings(() => {})).toEqual([]);
  });

  it("is the pin the real CLI adapters resolved, carried through the registry's wrapper", () => {
    // Every other row here drives a test double, so without this one the three shipped adapters
    // could all answer `undefined` and the suite would stay green while the check went silent on
    // the only deployment it exists for. The registry compounds that: `production()` hands out
    // `CapacityObservedAdapter`, so the wrapper has to carry the pin too or the doctor asks the
    // wrong object.
    const pin = healthyPin();
    const harness = makeHarness();
    for (const adapter of [
      new ClaudeCliAdapter({ clock: harness.clock, capacityFile: join(harness.root, "claude.json"), binary: pin }),
      new CodexCliAdapter({ clock: harness.clock, capacityFile: join(harness.root, "codex.json"), binary: pin }),
      new GrokCliAdapter({ clock: harness.clock, capacityFile: join(harness.root, "grok.json"), binary: pin }),
    ]) {
      // The pin itself, uncanonicalised. This asserted `realpathSync(pin)` until #998 landed, and
      // the merge turned it red: `resolveExecutable` now returns `resolve(...)` at both sites, so a
      // symlinked or `/var`-style path is anchored and left alone rather than resolved to its
      // target. That is the contract this accessor hands out and the reason the doctor may stat it.
      expect(adapter.executablePath).toBe(pin);
    }

    const registry = new ProviderRegistry();
    registry.attachCapacity({ refresh: async () => undefined });
    registry.register(new PinnedAdapter(harness.clock, "pinned", pin));
    expect(registry.production().map((adapter) => adapter.executablePath)).toEqual([pin]);
  });

  it("names the environment variable each provider's pin is actually read from", async () => {
    // `ACP_` + the upper-cased provider id + `_BINARY` is the right answer for two of these three,
    // which is exactly what makes deriving the name read as correct. `CodexCliAdapter.provider` is
    // `"gpt"`, and the variable `ControlPlane` reads its pin from is `ACP_CODEX_BINARY`
    // (`control-plane.ts:753`). `ACP_GPT_BINARY` occurs nowhere in this repository, so a derived
    // name would send an operator to repoint a setting nothing consumes — the send-someone-to-the-
    // wrong-place failure this whole check exists to prevent, reintroduced inside it.
    //
    // The provider ids come from the shipped adapter classes, not from literals typed here. A test
    // that spells its own ids agrees with itself when one of them changes, and this defect reached
    // a green suite because the only provider exercised was the one the transformation gets right.
    const harness = makeHarness();
    const pin = healthyPin();
    const expected = [
      {
        provider: new ClaudeCliAdapter({ clock: harness.clock, capacityFile: join(harness.root, "claude.json"), binary: pin })
          .provider,
        variable: "ACP_CLAUDE_BINARY",
      },
      {
        provider: new CodexCliAdapter({ clock: harness.clock, capacityFile: join(harness.root, "codex.json"), binary: pin })
          .provider,
        variable: "ACP_CODEX_BINARY",
      },
      {
        provider: new GrokCliAdapter({ clock: harness.clock, capacityFile: join(harness.root, "grok.json"), binary: pin })
          .provider,
        variable: "ACP_GROK_BINARY",
      },
    ];

    for (const { provider, variable } of expected) {
      const broken = prunedVersionPin();
      // The variable has to actually hold this pin, because that is the condition on naming it.
      await withPins({ [variable]: broken }, async () => {
        const findings = await pinFindings((each) => {
          each.cp.providers.register(new PinnedAdapter(each.clock, provider, broken));
        });

        expect(findings).toHaveLength(1);
        // The positive clause, not a bare `toContain(variable)`. The message for a pin the
        // variable does *not* match also mentions the variable — "it is not the current value of
        // ACP_CODEX_BINARY" — so a bare containment assertion passes on the message that names no
        // setting to change at all. Measured: the
        // `a-pin-repair-names-the-variable-it-is-read-from` mutant survived that assertion.
        expect(findings[0]?.recommendedAction).toContain(
          `change ${variable}, whose current value is this pin`,
        );
        expect(findings[0]?.recommendedAction).not.toContain("ACP_GPT_BINARY");
      });
    }

  });

  it("names no variable at all for a provider the map does not know", async () => {
    // Naming none leaves the operator the path and the reinstall; naming a guessed one costs them
    // the trip. The fallback inside the message is the place that can re-enter the original defect
    // — it is the one remaining expression that could be made to derive a name from the provider
    // id — so this asserts positively what the sentence has to say, and then that no
    // provider-shaped variable name appears anywhere in it.
    //
    // The earlier version of this check was `not.toMatch(/ACP_[A-Z]+_BINARY at one/)`. The phrase
    // "at one" belonged to the pre-repair message and no longer occurs anywhere, so that assertion
    // passed for every mutant and for every message: it could not fail for its claim.
    const unmapped = await pinFindings((each) => {
      each.cp.providers.register(new PinnedAdapter(each.clock, "pinned", prunedVersionPin()));
    });

    expect(unmapped).toHaveLength(1);
    const action = unmapped[0]?.recommendedAction ?? "";
    expect(action).toContain("change whichever setting supplies this pin");
    expect(action).toContain("any ACP_*_BINARY variable");
    expect(action).not.toContain("whose current value is this pin");
    // `ACP_*_BINARY` does not match this: `*` is not `[A-Z]`. A derived name would.
    expect(action).not.toMatch(/ACP_[A-Z]+_BINARY/);
  });

  it("names the pin's setting only when that setting's value is the pin in hand", async () => {
    // `control-plane.ts:753` spreads `...overrides.gpt` *after* `binary: process.env[...]`, so a
    // deployment's `adapterOptions` wins over the environment. Telling that operator to repoint
    // `ACP_CODEX_BINARY` names a setting whose value nothing reads — the same
    // sends-you-to-the-wrong-place defect as `ACP_GPT_BINARY`, one layer out. The adapter cannot
    // report where its `binary` came from, so the check compares the variable's current value
    // against the pin instead of assuming the variable produced it.
    const broken = prunedVersionPin();
    const somewhereElse = healthyPin();

    await withPins({ ACP_CLAUDE_BINARY: broken }, async () => {
      const matching = await pinFindings((each) => {
        each.cp.providers.register(new PinnedAdapter(each.clock, "claude", broken));
      });
      const action = matching[0]?.recommendedAction ?? "";
      // Equality is all this fixture establishes, and all the sentence may claim: the adapter here
      // is hand-built and never reads the variable, exactly as a deployment supplying
      // `adapterOptions.claude.binary` with the same path would not. So the message says the
      // variable's current value *is* this pin, and says `adapterOptions` are what win where they
      // exist — not that the variable supplied it.
      expect(action).toContain("change ACP_CLAUDE_BINARY, whose current value is this pin");
      expect(action).toContain("adapterOptions");
      expect(action).not.toContain("ACP_CLAUDE_BINARY supplied");
    });

    await withPins({ ACP_CLAUDE_BINARY: somewhereElse }, async () => {
      const configured = await pinFindings((each) => {
        each.cp.providers.register(new PinnedAdapter(each.clock, "claude", broken));
      });
      expect(configured).toHaveLength(1);
      expect(configured[0]?.recommendedAction).not.toContain("change ACP_CLAUDE_BINARY");
      expect(configured[0]?.recommendedAction).toContain("adapterOptions");
    });
  });

  it("says a restore at the pin needs no restart, and that only a repin does", async () => {
    // Since #998 the pin is the name an updater maintains, not the version behind it, so the
    // retained pin is resolved again at every spawn: restoring a file at that path is live without
    // a restart. Asserting a restart unconditionally told the operator to take a step they did not
    // need for the repair they were most likely to make.
    const findings = await pinFindings((each) => {
      each.cp.providers.register(new PinnedAdapter(each.clock, "pinned", prunedVersionPin()));
    });

    expect(findings[0]?.recommendedAction).toContain("needs no restart");
    expect(findings[0]?.recommendedAction).toContain(
      "restart the daemon, which resolves the pin once at construction",
    );
  });

  it("calls a bare-name pin not-on-PATH instead of statting it against the daemon's cwd", async () => {
    // `resolveExecutable`'s last return is a bare name by contract: nothing of that name was on the
    // daemon's PATH when the adapter was built. Statting it asks the wrong question — it resolves
    // against the daemon's working directory, so a directory named like the provider there answers
    // it while the spawn still searches PATH — and it produced `condition: "ABSENT"` with an action
    // reading "restore an executable file at claude".
    const findings = await pinFindings((each) => {
      each.cp.providers.register(new PinnedAdapter(each.clock, "pinned", "claude"));
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.observedEvidence).toMatchObject({ path: "claude", condition: "NOT_ON_PATH" });
    expect(findings[0]?.observedEvidence).not.toHaveProperty("error");
    const action = findings[0]?.recommendedAction ?? "";
    expect(action).not.toContain("needs no restart");
    // The set a spawn actually searches is `agentPath()` — the node binary's directory plus
    // /usr/bin, /bin, /usr/sbin and /sbin — not the daemon's PATH, which on this host includes
    // /opt/homebrew/bin and /usr/local/bin. "Install it on the daemon's PATH" is a repair an
    // operator can complete without the CLI becoming reachable.
    expect(action).toContain("/usr/sbin");
    expect(action).toContain("/opt/homebrew/bin");
    // And the condition is a reading taken once at construction, never re-measured, so the message
    // must not state it as a fact about the daemon's whole life.
    expect(action).toContain("ran once");
    expect(action).not.toContain("has ever started");
  });

  it("finds the pruned pin on the shipped composition, where claude is registered per role", async () => {
    // The case this slice exists for, entered where production enters it. `production()` is
    // `list().filter(a => a.isProduction && !hasRoleScoped(a.provider))`, and both
    // `ClaudeCliAdapter`s are registered with `registerForRole` (`control-plane.ts:726`, `:740`
    // carry `roles:`; `:458` routes anything with `roles` there), so a check reading `production()`
    // cannot see claude — the one provider whose pin died on the host. Every other case in this
    // file registers unscoped, which is a registry shape the deployment does not have, and that is
    // how the first version of this check passed a green suite while being silent on the
    // deployment. This one composes through `ControlPlane` with the default adapters and the
    // `ACP_*_BINARY` pins.
    const root = tempDir("acp-pin-composed-");
    const claudePin = prunedVersionPin();
    const codexPin = executableAt(join(root, "pinned"), "codex");
    const grokPin = executableAt(join(root, "pinned"), "grok");

    await withPins(
      { ACP_CLAUDE_BINARY: claudePin, ACP_CODEX_BINARY: codexPin, ACP_GROK_BINARY: grokPin },
      async () => {
        const cp = new ControlPlane({
          databasePath: join(root, "state.sqlite"),
          worktreeRoot: join(root, "worktrees"),
          capacityDir: join(root, "capacity"),
          secretsDir: join(root, "secrets"),
          clock: new ManualClock("2026-09-26T02:05:00.000Z"),
        });
        try {
          // The shape, asserted rather than assumed: claude is in the provider set and out of the
          // shared production inventory.
          expect(cp.providers.list().map((adapter) => adapter.provider).sort()).toEqual([
            "claude",
            "gpt",
            "grok",
          ]);
          expect(cp.providers.production().map((adapter) => adapter.provider)).not.toContain("claude");

          const report = await cp.doctor.run("capacity");
          const findings = report.findings.filter(
            (finding) => finding.code === ReasonCode.PROVIDER_EXECUTABLE_UNUSABLE,
          );
          // Exactly one, although claude is registered twice: `list()` collapses to one
          // representative adapter per provider, so two role-scoped instances of one provider are
          // not two findings. A duplicate per provider would be its own defect.
          expect(findings).toHaveLength(1);
          expect(findings[0]?.scope).toBe("provider:claude");
          expect(findings[0]?.observedEvidence).toMatchObject({
            provider: "claude",
            path: claudePin,
            condition: "ABSENT",
          });
          expect(findings[0]?.recommendedAction).toContain(
            "change ACP_CLAUDE_BINARY, whose current value is this pin",
          );
          expect(findings[0]?.blocking).toBe(false);
        } finally {
          cp.close();
        }
      },
    );
  });

  it("never blocks", async () => {
    // A blocking finding for a missing binary parks the daemon behind the operator step that
    // would restore it, and the daemon is where the operator reads the finding from.
    const findings = await pinFindings((harness) => {
      harness.cp.providers.register(new PinnedAdapter(harness.clock, "pinned", prunedVersionPin()));
    });

    expect(findings.map((finding) => finding.blocking)).toEqual([false]);
    expect(findings.map((finding) => finding.severity)).toEqual(["ERROR"]);
  });

  it("is reached by the daemon's own start path, on the report that start writes", async () => {
    // The readback has to happen at boot, which is the moment a pin resolved by an installer that
    // ran at some other time is first followed. `Daemon.start()` -> `reconcile()` ->
    // `runSystemDoctorCheck()` -> `doctor.run("system")` is that path; this asserts it rather than
    // assuming it, and it asserts it on what the startup pass recorded, not on a second run.
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const stable = prunedVersionPin();
    harness.cp.providers.register(new PinnedAdapter(harness.clock, "pinned", stable));

    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-pin-daemon-") });
    const started = await daemon.start();
    await daemon.stop();

    expect(started.allowed).toBe(true);
    const reports = harness.cp.audit
      .all()
      .filter((row) => row.kind === "DOCTOR_REPORT")
      .map((row) => row.evidence as { findings?: { code: string; blocking: boolean }[] });
    expect(reports.length).toBeGreaterThan(0);
    const codes = reports.flatMap((evidence) => evidence.findings ?? []);
    expect(codes.filter((finding) => finding.code === ReasonCode.PROVIDER_EXECUTABLE_UNUSABLE))
      .not.toEqual([]);
    expect(
      codes.filter(
        (finding) => finding.code === ReasonCode.PROVIDER_EXECUTABLE_UNUSABLE && finding.blocking,
      ),
    ).toEqual([]);
  });
});

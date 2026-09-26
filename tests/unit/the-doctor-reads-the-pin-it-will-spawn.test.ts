import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { Clock } from "../../src/core/clock.ts";
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
      expect(adapter.executablePath).toBe(realpathSync(pin));
    }

    const registry = new ProviderRegistry();
    registry.attachCapacity({ refresh: async () => undefined });
    registry.register(new PinnedAdapter(harness.clock, "pinned", pin));
    expect(registry.production().map((adapter) => adapter.executablePath)).toEqual([pin]);
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

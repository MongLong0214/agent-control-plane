import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = fileURLToPath(new URL("../../scripts/probe-daemon-startup.ts", import.meta.url));
const fixtureRoot = mkdtempSync(join(tmpdir(), "acp-daemon-probe-test-"));
const fakeBin = join(fixtureRoot, "bin");
const providerTouch = join(fixtureRoot, "provider-was-invoked");

mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
for (const provider of ["claude", "codex", "grok"]) {
  const executable = join(fakeBin, provider);
  writeFileSync(executable, `#!/bin/sh\nprintf touched > ${JSON.stringify(providerTouch)}\nexit 1\n`);
  chmodSync(executable, 0o700);
}

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

interface StartupReport {
  mode: string;
  stages: Array<Record<string, unknown>>;
  problems: string[];
}

interface StartupObservation {
  state: string;
  decision: Record<string, unknown>;
  bootstrapDoor: { opened: boolean; closed: boolean };
}

const providerHome = (state: "absent" | "present"): string => {
  const home = join(fixtureRoot, `home-${state}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (state === "absent") return home;

  const codex = join(home, ".codex");
  const claude = join(home, ".claude");
  const grok = join(home, ".grok");
  for (const directory of [codex, claude, grok]) mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(codex, "auth.json"), JSON.stringify({ access_token: "present-path-sentinel" }), { mode: 0o600 });
  writeFileSync(join(claude, ".credentials.json"), JSON.stringify({ oauth: "present-path-sentinel" }), { mode: 0o600 });
  writeFileSync(
    join(grok, "auth.json"),
    JSON.stringify({
      "https://auth.x.ai::fixture": {
        key: "present-path-sentinel-present-path-sentinel",
        create_time: "2026-08-30T00:00:00.000Z",
      },
    }),
    { mode: 0o600 },
  );
  return home;
};

const runProbe = (home: string): StartupReport => {
  const result = spawnSync(process.execPath, ["--import", "tsx", script, "--json", "--isolated"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 190_000,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      // If the isolated collector seam is removed, Grok must still refuse before any HTTP call.
      HTTPS_PROXY: "probe-test-must-not-contact-providers",
    },
  });
  const output = `${result.stdout}${result.stderr}`;
  expect(result.error, output).toBeUndefined();
  expect(result.status, output).toBe(0);
  return JSON.parse(result.stdout) as StartupReport;
};

const startup = (stage: Record<string, unknown>, key = "startup"): StartupObservation =>
  stage[key] as StartupObservation;

const stableStartup = (observation: StartupObservation) => ({
  state: observation.state,
  decision: {
    allowed: observation.decision["allowed"],
    reasonCode: observation.decision["reasonCode"],
    doctorStatus: observation.decision["doctorStatus"],
    blockingFindings: observation.decision["blockingFindings"],
  },
  bootstrapDoor: observation.bootstrapDoor,
});

/** Excludes only retry timestamps and wait duration; every startup classification remains. */
const stableOutcome = (report: StartupReport) => report.stages.map((stage, index) => ({
  label: stage["label"],
  collectorMode: stage["collectorMode"],
  credentialAvailable: stage["credentialAvailable"],
  capacitySources: stage["capacitySources"],
  startup: index < 3 ? stableStartup(startup(stage)) : undefined,
  firstStart: index === 3 ? stableStartup(startup(stage, "firstStart")) : undefined,
  immediateRestart: index === 3 ? stableStartup(startup(stage, "immediateRestart")) : undefined,
  retryAfterBackoff: index === 3 ? stableStartup(startup(stage, "retryAfterBackoff")) : undefined,
}));

const isolatedSources = {
  claude: "daemon-startup-probe-isolated:claude",
  gpt: "daemon-startup-probe-isolated:gpt",
  grok: "daemon-startup-probe-isolated:grok",
};

describe("the daemon startup probe", () => {
  it("keeps startup outcomes independent of provider login files", () => {
    const withoutLoginPaths = runProbe(providerHome("absent"));
    const withLoginPaths = runProbe(providerHome("present"));

    expect(withoutLoginPaths.mode).toBe("isolated");
    expect(withoutLoginPaths.problems).toEqual([]);
    expect(withLoginPaths.problems).toEqual([]);
    expect(withoutLoginPaths.stages).toHaveLength(4);
    expect(withLoginPaths.stages).toHaveLength(4);
    expect(stableOutcome(withLoginPaths)).toEqual(stableOutcome(withoutLoginPaths));
    expect(existsSync(providerTouch)).toBe(false);

    for (const stage of withoutLoginPaths.stages) {
      expect(stage).not.toHaveProperty("error");
      expect(stage["capacitySources"]).toEqual(isolatedSources);
    }

    expect(withoutLoginPaths.stages[0]).toMatchObject({
      credentialAvailable: false,
      startup: {
        state: "REFUSED",
        decision: {
          allowed: false,
          reasonCode: ReasonCode.DOCTOR_ERROR,
          blockingFindings: expect.arrayContaining([
            expect.objectContaining({ code: "ROLE_COVERAGE_NO_VALID_COVERAGE" }),
            expect.objectContaining({ code: "TRUSTED_GATE_CREDENTIAL_MISSING" }),
          ]),
        },
        bootstrapDoor: { opened: false, closed: false },
      },
    });
    expect(withoutLoginPaths.stages[1]).toMatchObject({
      credentialAvailable: true,
      startup: {
        state: "BOOTSTRAP_PARKED",
        decision: {
          allowed: false,
          reasonCode: ReasonCode.DOCTOR_ERROR,
          blockingFindings: [expect.objectContaining({ code: "ROLE_COVERAGE_NO_VALID_COVERAGE" })],
        },
        bootstrapDoor: { opened: true, closed: true },
      },
    });
    expect(withoutLoginPaths.stages[2]).toMatchObject({
      credentialAvailable: true,
      startup: {
        state: "BOOTSTRAP_PARKED",
        decision: {
          allowed: false,
          reasonCode: ReasonCode.DOCTOR_ERROR,
          blockingFindings: [expect.objectContaining({ code: "ROLE_COVERAGE_NO_VALID_COVERAGE" })],
        },
        bootstrapDoor: { opened: true, closed: true },
      },
    });
    expect(withoutLoginPaths.stages[3]).toMatchObject({
      firstStart: {
        state: "REFUSED",
        decision: { allowed: false, reasonCode: ReasonCode.DOCTOR_ERROR },
        bootstrapDoor: { opened: false, closed: false },
      },
      immediateRestart: {
        state: "REFUSED",
        decision: { allowed: false, reasonCode: ReasonCode.DAEMON_BACKOFF_ACTIVE },
        bootstrapDoor: { opened: false, closed: false },
      },
      backoffWait: { retryNotBefore: expect.any(String), waitedMs: expect.any(Number) },
      retryAfterBackoff: {
        state: "BOOTSTRAP_PARKED",
        decision: {
          allowed: false,
          reasonCode: ReasonCode.DOCTOR_ERROR,
          blockingFindings: [expect.objectContaining({ code: "ROLE_COVERAGE_NO_VALID_COVERAGE" })],
        },
        bootstrapDoor: { opened: true, closed: true },
      },
    });
  });
});

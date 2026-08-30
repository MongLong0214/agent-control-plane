#!/usr/bin/env -S npx tsx
/**
 * Reports how the production-composed daemon classifies an App credential, provider capacity,
 * daemon-owned mirrors, and the retry backoff caused by a refused start.
 *
 * WHY this check exists
 *
 *   `Daemon.start()` fails closed on its single-instance lock, startup doctor, and crash-loop
 *   backoff. Production also supplies a bootstrap door: when capacity is the only missing
 *   prerequisite, startup parks behind that door instead of returning a doctor refusal.
 *
 *   The checked scenarios retain the production adapters but inject an unavailable usage
 *   collector. That keeps the result independent of provider login state and proves that a
 *   prewritten daemon mirror cannot create coverage. The GitHub prerequisite enters through the
 *   production App env/private-key files, and the daemon enters through
 *   `ControlPlane.createDaemon()` with a bootstrap door. The probe observes the park and releases
 *   it immediately; it does not claim to exercise `agentcpd.main` socket plumbing.
 *
 *   An ordinary operator run adds one clearly labelled live-collector observation. Only that
 *   stage uses the production collectors' normal credential paths and may make the Grok billing
 *   request. `--isolated` skips it and is the mode used by automated tests.
 *
 * Every state, generated App credential, and mirror write stays under a throwaway directory and
 * is removed on completion or a handled failure. An uncatchable process death may leave that
 * generated probe state under the OS temp directory; no operator credential is copied into it.
 *
 * Run: npx tsx scripts/probe-daemon-startup.ts [--json] [--isolated]
 * Exits non-zero if an isolated scenario does not reach its named startup state, if the live
 * observation reaches neither normal startup nor the capacity bootstrap park, or if a scenario
 * errors. Listening sockets are deliberately unmeasured here.
 */
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ControlPlane, defaultConfig, type ControlPlaneConfig } from "../src/app/control-plane.ts";
import { type UsageCollector, type UsageProvider, USAGE_PROVIDERS } from "../src/capacity/usage-collectors.ts";
import { ReasonCode } from "../src/core/reason-codes.ts";

const asJson = process.argv.includes("--json");
const isolatedOnly = process.argv.includes("--isolated");
const stages: Array<Record<string, unknown>> = [];
const problems: string[] = [];

const HARD_TIMEOUT_MS = 180_000;
const watchdog = setTimeout(() => {
  process.stderr.write("probe-daemon-startup: hard timeout\n");
  process.exit(2);
}, HARD_TIMEOUT_MS);
watchdog.unref();

const summarise = (findings: readonly { code: string; severity: string; blocking: boolean }[]) =>
  findings.map((finding) => `${finding.code}/${finding.severity}${finding.blocking ? "/blocking" : ""}`);

type CreatedDaemon = ReturnType<ControlPlane["createDaemon"]>;
type StartDecision = Awaited<ReturnType<CreatedDaemon["start"]>>;
type StartupState = "STARTED" | "BOOTSTRAP_PARKED" | "REFUSED";

interface StartupObservation {
  state: StartupState;
  decision: StartDecision;
  report: Record<string, unknown>;
}

const startSummary = (started: StartDecision): Record<string, unknown> => {
  const summary: Record<string, unknown> = {
    allowed: started.allowed,
    reasonCode: started.reasonCode,
  };
  if (!started.allowed) summary["message"] = started.message;

  const reconcile = started.allowed ? started.value : started.evidence["reconcile"];
  if (typeof reconcile === "object" && reconcile !== null) {
    const report = reconcile as Record<string, unknown>;
    summary["doctorStatus"] = report["doctorStatus"];
    summary["blockingFindings"] = report["blockingFindings"];
    if (report["bootstrapParked"] !== undefined) summary["bootstrapParked"] = report["bootstrapParked"];
  } else if (!started.allowed && Object.keys(started.evidence).length > 0) {
    summary["evidence"] = started.evidence;
  }
  return summary;
};

/**
 * Production supplies a socket-backed door. This probe needs only to observe that startup chose
 * the door, then release the park so the throwaway process can finish without binding a socket.
 */
const observeStartup = async (daemon: CreatedDaemon): Promise<StartupObservation> => {
  let opened = false;
  let closed = false;
  const decision = await daemon.start({
    bootstrapDoor: async () => {
      opened = true;
      await daemon.stop();
      return {
        close: async () => {
          closed = true;
        },
      };
    },
  });
  if (decision.allowed) await daemon.stop();

  const state: StartupState = decision.allowed ? "STARTED" : opened ? "BOOTSTRAP_PARKED" : "REFUSED";
  return {
    state,
    decision,
    report: {
      state,
      decision: startSummary(decision),
      bootstrapDoor: { opened, closed },
    },
  };
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const probeAppPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" });

/** Writes the same owner-provisioned App files that `TrustedCredentialStore.availability()` reads. */
const provisionAppCredential = (config: ControlPlaneConfig): void => {
  const envFile = config.githubAppEnvFile;
  if (!envFile) throw new Error("probe configuration did not name a GitHub App env file");
  const credentialsDir = dirname(envFile);
  const privateKeyPath = join(credentialsDir, "github-app.private-key.pem");
  mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
  chmodSync(credentialsDir, 0o700);
  writeFileSync(privateKeyPath, probeAppPrivateKey, { mode: 0o600 });
  chmodSync(privateKeyPath, 0o600);
  writeFileSync(
    envFile,
    [
      "GITHUB_APP_ID=4586878",
      "GITHUB_APP_INSTALLATION_ID=153553922",
      `GITHUB_APP_PRIVATE_KEY_PATH=${privateKeyPath}`,
    ].join("\n"),
    { mode: 0o600 },
  );
  chmodSync(envFile, 0o600);
};

const isolatedUsageCollector = (provider: UsageProvider): UsageCollector => ({
  collect: async () => ({
    provider,
    sensorHealth: "HEALTHY",
    runtimeHealth: "UNAVAILABLE",
    observedAt: new Date().toISOString(),
    source: `daemon-startup-probe-isolated:${provider}`,
    buckets: [],
  }),
});

const isolatedAdapterOptions = (): NonNullable<ControlPlaneConfig["adapterOptions"]> => ({
  claude: { usageCollector: isolatedUsageCollector("claude") },
  gpt: { usageCollector: isolatedUsageCollector("gpt") },
  grok: { usageCollector: isolatedUsageCollector("grok") },
});

type CollectorMode = "isolated" | "live";

/** Host credential overrides must never redirect a throwaway probe into the deployment's App key. */
const probeConfig = (root: string, collectorMode: CollectorMode): ControlPlaneConfig => {
  const config = defaultConfig(root);
  config.githubAppEnvFile = join(root, "credentials", "github-app.env");
  delete config.githubAppPrivateKeyPath;
  if (collectorMode === "isolated") config.adapterOptions = isolatedAdapterOptions();
  return config;
};

/**
 * Writes the shape the daemon owns after a sensor refresh. Production adapters do not read this
 * as quota input; the isolated collector must overwrite it with its unavailable observation.
 */
const writeCapacityMirrors = (directory: string): void => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const provider of USAGE_PROVIDERS) {
    writeFileSync(
      join(directory, `${provider}.json`),
      JSON.stringify({
        provider,
        observedAt: new Date().toISOString(),
        sensorHealth: "HEALTHY",
        runtimeHealth: "HEALTHY",
        source: "prewritten-daemon-mirror",
        buckets: [
          {
            id: `${provider}-5h`,
            remainingPercent: 90,
            resetAt: null,
            capabilities: ["ceo", "cto", "blind-review", "worker", "luna-worker", "adversarial-review"],
          },
        ],
      }),
      { mode: 0o600 },
    );
  }
};

const capacitySources = (cp: ControlPlane): Record<string, string> =>
  Object.fromEntries(cp.capacity.all().map((reading) => [reading.provider, reading.source]));

const expectStartup = (
  label: string,
  observed: StartupObservation,
  expectedStates: readonly StartupState[],
  expectedReasonCodes: readonly ReasonCode[] = [],
): void => {
  if (!expectedStates.includes(observed.state)) {
    problems.push(`${label} expected ${expectedStates.join(" or ")}, got ${JSON.stringify(observed.report)}`);
    return;
  }
  if (expectedReasonCodes.length > 0 && !expectedReasonCodes.includes(observed.decision.reasonCode)) {
    problems.push(
      `${label} expected ${expectedReasonCodes.join(" or ")}, got ${JSON.stringify(observed.report)}`,
    );
  }
};

interface ScenarioOptions {
  collectorMode: CollectorMode;
  credential: boolean;
  mirrors?: boolean;
  expectedStates: readonly StartupState[];
  expectedReasonCodes?: readonly ReasonCode[];
}

/** One scenario = one pristine state directory, so no earlier failure can leak into it. */
const scenario = async (label: string, options: ScenarioOptions): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "acp-daemon-probe-"));
  const config = probeConfig(root, options.collectorMode);
  const stage: Record<string, unknown> = {
    label,
    collectorMode: options.collectorMode,
    ownerIdentities: config.ownerIdentities?.length ?? 0,
  };
  let cp: ControlPlane | null = null;
  try {
    if (options.credential) provisionAppCredential(config);
    if (options.mirrors) writeCapacityMirrors(config.capacityDir);
    cp = new ControlPlane(config);
    stage["credentialAvailable"] = cp.credentials.available();

    const doctor = await cp.doctor.run("system");
    stage["doctorStatusBeforeStart"] = doctor.status;
    stage["doctorFindingsBeforeStart"] = summarise(doctor.findings);

    const stateDir = dirname(config.databasePath);
    const daemon = cp.createDaemon({ stateDir });
    const observed = await observeStartup(daemon);
    stage["startup"] = observed.report;
    stage["capacitySources"] = capacitySources(cp);
    expectStartup(label, observed, options.expectedStates, options.expectedReasonCodes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stage["error"] = message;
    problems.push(`${label} errored: ${message}`);
  } finally {
    cp?.close();
    rmSync(root, { recursive: true, force: true });
  }
  stages.push(stage);
};

const doctorReasons = [ReasonCode.DOCTOR_BLOCKED, ReasonCode.DOCTOR_ERROR] as const;

await scenario("isolated bare state directory", {
  collectorMode: "isolated",
  credential: false,
  expectedStates: ["REFUSED"],
  expectedReasonCodes: doctorReasons,
});

await scenario("isolated production App credential", {
  collectorMode: "isolated",
  credential: true,
  expectedStates: ["BOOTSTRAP_PARKED"],
  expectedReasonCodes: doctorReasons,
});

await scenario("isolated production App credential with prewritten daemon mirrors", {
  collectorMode: "isolated",
  credential: true,
  mirrors: true,
  expectedStates: ["BOOTSTRAP_PARKED"],
  expectedReasonCodes: doctorReasons,
});

/**
 * A refused start writes `crash-loop.json` with a `retryNotBefore`. Rebuild the production
 * composition after provisioning the App files, observe the immediate backoff, then wait until
 * the returned timestamp before asking whether startup reaches its capacity bootstrap park.
 */
{
  const root = mkdtempSync(join(tmpdir(), "acp-daemon-probe-"));
  const config = probeConfig(root, "isolated");
  const stage: Record<string, unknown> = {
    label: "isolated restart after a refused start and enforced backoff",
    collectorMode: "isolated",
  };
  let cp: ControlPlane | null = null;
  try {
    const stateDir = dirname(config.databasePath);
    cp = new ControlPlane(config);
    const unprovisionedDaemon = cp.createDaemon({ stateDir });
    const first = await observeStartup(unprovisionedDaemon);
    stage["firstStart"] = first.report;
    expectStartup("the unprovisioned first start", first, ["REFUSED"], doctorReasons);
    cp.close();
    cp = null;

    provisionAppCredential(config);
    writeCapacityMirrors(config.capacityDir);
    cp = new ControlPlane(config);
    const retryDaemon = cp.createDaemon({ stateDir });
    const immediate = await observeStartup(retryDaemon);
    stage["immediateRestart"] = immediate.report;
    expectStartup("the immediate restart", immediate, ["REFUSED"], [ReasonCode.DAEMON_BACKOFF_ACTIVE]);

    const retryNotBefore = immediate.decision.allowed
      ? null
      : typeof immediate.decision.evidence["retryNotBefore"] === "string"
        ? immediate.decision.evidence["retryNotBefore"]
        : null;
    if (!retryNotBefore) throw new Error("startup backoff did not return retryNotBefore");
    const waitStartedAt = Date.now();
    await wait(Math.max(0, Date.parse(retryNotBefore) - waitStartedAt + 25));
    stage["backoffWait"] = {
      retryNotBefore,
      waitedMs: Date.now() - waitStartedAt,
    };

    const retried = await observeStartup(retryDaemon);
    stage["retryAfterBackoff"] = retried.report;
    stage["capacitySources"] = capacitySources(cp);
    expectStartup("the retry after backoff", retried, ["BOOTSTRAP_PARKED"], doctorReasons);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stage["error"] = message;
    problems.push(`restart scenario errored: ${message}`);
  } finally {
    cp?.close();
    rmSync(root, { recursive: true, force: true });
  }
  stages.push(stage);
}

if (!isolatedOnly) {
  await scenario("operator live provider collector outcomes", {
    collectorMode: "live",
    credential: true,
    expectedStates: ["STARTED", "BOOTSTRAP_PARKED"],
  });
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ mode: isolatedOnly ? "isolated" : "operator", stages, problems }, null, 2)}\n`);
} else {
  for (const stage of stages) {
    console.log(`--- ${stage["label"]}`);
    for (const [key, value] of Object.entries(stage)) {
      if (key === "label") continue;
      console.log(`  ${key.padEnd(24)} ${JSON.stringify(value)}`);
    }
    console.log("");
  }
  if (problems.length === 0) {
    console.log(
      isolatedOnly
        ? "OK — isolated production-composed startup kept provider login paths out and daemon mirrors out of capacity"
        : "OK — isolated startup prerequisites were checked and live collector outcomes were recorded separately",
    );
  } else {
    console.log(`${problems.length} problem(s):`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
}

process.exit(problems.length === 0 ? 0 : 1);

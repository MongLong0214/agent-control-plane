#!/usr/bin/env -S npx tsx
/**
 * Answers one question with evidence instead of inference: which deployment prerequisites
 * does daemon startup enforce, and does a retry get past the backoff the probe itself caused?
 *
 * WHY this check exists
 *
 *   `Daemon.start()` fails closed on its single-instance lock, startup doctor, and a
 *   crash-loop backoff that a previous failed start armed. A throwaway state directory can
 *   exercise those decisions, but it cannot stand in for a provisioned deployment: the live
 *   collectors need provider credentials and ACP's protected scratch root, while the fallback
 *   operator observation needs an authenticated daemon socket.
 *
 *   This probe runs the real `ControlPlane.createDaemon()` startup path against throwaway
 *   state directories under the OS temp dir — never a real deployment — and records what
 *   each stage actually did. In particular, it proves that daemon-owned capacity mirrors are
 *   output, not a substitute for either supported capacity source.
 *
 * The probe's state and mirror writes stay inside its temp directories and are always
 * removed. Production collectors may still read their ordinary credential paths and use
 * ACP's protected scratch root; that dependency is why this is not a listening-state probe.
 *
 * Run: npx tsx scripts/probe-daemon-startup.ts [--json]
 * Exits non-zero if a scenario errors, a bare deployment starts, or a retry remains pinned to
 * the backoff this probe triggered. A listening state is deliberately unmeasured here.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ControlPlane, defaultConfig, type ControlPlaneConfig } from "../src/app/control-plane.ts";
import { ReasonCode } from "../src/core/reason-codes.ts";

const asJson = process.argv.includes("--json");
const stages: Array<Record<string, unknown>> = [];
const problems: string[] = [];

const HARD_TIMEOUT_MS = 180_000;
const watchdog = setTimeout(() => {
  process.stderr.write("probe-daemon-startup: hard timeout\n");
  process.exit(2);
}, HARD_TIMEOUT_MS);
watchdog.unref();

const summarise = (findings: readonly { code: string; severity: string; blocking: boolean }[]) =>
  findings.map((f) => `${f.code}/${f.severity}${f.blocking ? "/blocking" : ""}`);

type CreatedDaemon = ReturnType<ControlPlane["createDaemon"]>;
type StartDecision = Awaited<ReturnType<CreatedDaemon["start"]>>;

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
    if (report["bootstrapParked"] !== undefined) {
      summary["bootstrapParked"] = report["bootstrapParked"];
    }
  } else if (!started.allowed && Object.keys(started.evidence).length > 0) {
    summary["evidence"] = started.evidence;
  }
  return summary;
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

/** One scenario = one pristine state directory, so no earlier failure can leak into it. */
const scenario = async (
  label: string,
  prepare: (cp: ControlPlane, config: ControlPlaneConfig) => void,
  expectedReasonCodes: readonly ReasonCode[] = [],
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "acp-daemon-probe-"));
  const config = defaultConfig(root);
  const stage: Record<string, unknown> = { label, ownerIdentities: config.ownerIdentities?.length ?? 0 };
  const cp = new ControlPlane(config);
  try {
    prepare(cp, config);

    const doctor = await cp.doctor.run("system");
    stage["doctorStatus"] = doctor.status;
    stage["doctorFindings"] = summarise(doctor.findings);

    const stateDir = dirname(config.databasePath);
    const daemon = cp.createDaemon({ stateDir });
    const started = await daemon.start();
    stage["daemonStart"] = startSummary(started);
    if (expectedReasonCodes.length > 0 && (started.allowed || !expectedReasonCodes.includes(started.reasonCode))) {
      problems.push(
        `${label} expected refusal by ${expectedReasonCodes.join(" or ")}, got ${JSON.stringify(stage["daemonStart"])}`,
      );
    }

    if (started.allowed) await daemon.stop();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    stage["error"] = error;
    problems.push(`${label} errored: ${error}`);
  } finally {
    cp.close();
    rmSync(root, { recursive: true, force: true });
  }
  stages.push(stage);
};

// --------------------------------------------------------------------------

/**
 * Writes the shape doctor expects from the daemon-owned mirror. This is deliberately not
 * capacity provisioning: production adapters never read it as human quota input. It cannot
 * erase a collector failure or create role coverage; any routable result still has to come
 * from a supported live collector.
 */
const writeCapacityMirror = (directory: string, provider: string): void => {
  const capabilities = provider === "grok"
    ? ["adversarial-review"]
    : provider === "gpt"
      ? ["ceo", "blind-review", "worker", "luna-worker"]
      : ["ceo", "cto", "blind-review", "worker"];
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, `${provider}.json`),
    JSON.stringify({
      provider,
      observedAt: new Date().toISOString(),
      runtimeHealth: "HEALTHY",
      buckets: [
        {
          id: `${provider}-5h`,
          remainingPercent: 90,
          resetAt: null,
          capabilities,
        },
      ],
    }),
    { mode: 0o600 },
  );
};

await scenario(
  "bare state directory (nothing provisioned)",
  () => undefined,
  [ReasonCode.DOCTOR_BLOCKED, ReasonCode.DOCTOR_ERROR],
);

await scenario("trusted GitHub credential installed", (cp) => {
  cp.credentials.install({ token: "probe-token-not-a-real-credential", creatorIdentity: "probe-bot" });
});

await scenario("credential + prewritten daemon capacity mirrors", (cp, config) => {
  cp.credentials.install({ token: "probe-token-not-a-real-credential", creatorIdentity: "probe-bot" });
  for (const provider of cp.providers.production().map((adapter) => adapter.provider)) {
    writeCapacityMirror(config.capacityDir, provider);
  }
});

/**
 * A refused start is not free: it writes `crash-loop.json` with a `retryNotBefore`. The
 * immediate retry is product backoff and is recorded as such, but this probe caused it; the
 * recovery verdict therefore waits until the returned timestamp before it asks again.
 */
{
  const root = mkdtempSync(join(tmpdir(), "acp-daemon-probe-"));
  const config = defaultConfig(root);
  const stage: Record<string, unknown> = { label: "restart after a refused start and enforced backoff" };
  const cp = new ControlPlane(config);
  try {
    const stateDir = dirname(config.databasePath);
    const daemon = cp.createDaemon({ stateDir });
    const first = await daemon.start();
    stage["firstStart"] = startSummary(first);
    if (
      first.allowed ||
      (first.reasonCode !== ReasonCode.DOCTOR_BLOCKED && first.reasonCode !== ReasonCode.DOCTOR_ERROR)
    ) {
      problems.push(`the unprovisioned first start did not refuse on its doctor: ${JSON.stringify(stage["firstStart"])}`);
    }

    cp.credentials.install({ token: "probe-token-not-a-real-credential", creatorIdentity: "probe-bot" });
    for (const provider of cp.providers.production().map((adapter) => adapter.provider)) {
      writeCapacityMirror(config.capacityDir, provider);
    }
    const second = await daemon.start();
    stage["immediateRestart"] = startSummary(second);
    if (second.allowed || second.reasonCode !== ReasonCode.DAEMON_BACKOFF_ACTIVE) {
      problems.push(`the immediate retry did not observe startup backoff: ${JSON.stringify(stage["immediateRestart"])}`);
      if (second.allowed) await daemon.stop();
    }

    const retryNotBefore = typeof second.evidence["retryNotBefore"] === "string"
      ? second.evidence["retryNotBefore"]
      : null;
    if (!retryNotBefore) throw new Error("startup backoff did not return retryNotBefore");
    const waitStartedAt = Date.now();
    await wait(Math.max(0, Date.parse(retryNotBefore) - waitStartedAt + 25));
    stage["backoffWait"] = {
      retryNotBefore,
      waitedMs: Date.now() - waitStartedAt,
    };

    const retried = await daemon.start();
    stage["retryAfterBackoff"] = startSummary(retried);
    if (!retried.allowed && retried.reasonCode === ReasonCode.DAEMON_BACKOFF_ACTIVE) {
      problems.push(`the retry measured its own backoff instead of startup: ${JSON.stringify(stage["retryAfterBackoff"])}`);
    }
    if (retried.allowed) await daemon.stop();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    stage["error"] = error;
    problems.push(`restart scenario errored: ${error}`);
  } finally {
    cp.close();
    rmSync(root, { recursive: true, force: true });
  }
  stages.push(stage);
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ stages, problems }, null, 2)}\n`);
} else {
  for (const stage of stages) {
    console.log(`--- ${stage["label"]}`);
    for (const [key, value] of Object.entries(stage)) {
      if (key === "label") continue;
      console.log(`  ${key.padEnd(22)} ${JSON.stringify(value)}`);
    }
    console.log("");
  }
  if (problems.length === 0) {
    console.log("OK — startup prerequisites were measured without treating daemon mirrors as capacity input");
  } else {
    console.log(`${problems.length} problem(s):`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
}

process.exit(problems.length === 0 ? 0 : 1);

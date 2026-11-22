import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { systemClock } from "../core/clock.ts";
import { type Decision, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  REPOSITORY_SWEEP_BUDGET_MS,
  aggregate,
  gitHubGateFindings,
  repositoryProbeFailedFinding,
  repositoryUnreadableFinding,
  statePathFindings,
  worktreeProbeFailedFinding,
  type DoctorStatus,
  type Finding,
} from "../doctor/doctor.ts";
import { git, isClean, listWorktrees, tryRevParse } from "../git/git.ts";
import { TrustedCredentialStore } from "../github/credential-store.ts";
import { DatabaseSnapshotUnavailable, withDatabaseSnapshotAsync } from "../db/database-snapshot.ts";
import { ensurePrivateDirectory, inspectDatabaseStatePaths, inspectPrivatePath } from "../db/state-preflight.ts";
import { readCheckoutRegistrations } from "../verify/worktree.ts";
import { backoffSecondsFor, countStartupFailure, readCrashLoopFile, recordRefusalNotice, type RefusalNoticeOutcome } from "./crash-loop.ts";
import { type RefusalNoticeOptions, deliverRefusalNotice, refusalHost } from "./start-refusal-notice.ts";
import { SingleInstanceLock } from "./single-instance.ts";

/**
 * migrate-before-start — the startup verdict that is given before the control plane opens the database.
 *
 * Opening the database writes: it creates a missing file, switches a rollback-journal file to WAL, applies
 * an approved migration and retires its approval, and the control plane's constructor then appends audit
 * rows of its own (a refused reviewer-preferences file among them). A start the doctor will refuse for a
 * reason that was visible beforehand must refuse before any of that, or the official rollback to the pair
 * sealed before an approved migration refuses the database as stale (ROLLBACK_PAIR_STALE_DATABASE).
 *
 * What is judged here reads only files and read-only git, and, for the registered checkouts, a private copy
 * of the database's own files (`withDatabaseSnapshotAsync`). Nothing is opened for writing, no sidecar is
 * created, no repository index is refreshed, and a refusal is reported on stderr and in `crash-loop.json`
 * only. The caller holds `agentcpd.lock` for all of it (`takeStartLock`), so a second start learns that
 * another process holds the lock before it has read or written anything.
 */
export interface StartGateConfig {
  databasePath: string;
  worktreeRoot: string;
  secretsDir: string;
  capacityDir: string;
  githubAppEnvFile?: string;
  githubAppPrivateKeyPath?: string;
}

export interface StartGateJudgement {
  status: DoctorStatus;
  /** Every finding the gate produced, blocking or not. */
  findings: Finding[];
  /** What the gate could not judge without opening the database, and why. Judged later, by the full report. */
  notJudged: string[];
}

interface RegisteredCheckout {
  identity: string;
  checkoutPath: string;
  projectId: string | null;
  suspended: boolean;
}

const safeErrorMessage = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/[\r\n\t]/g, " ").slice(0, 500);

/**
 * The registered checkouts, read from a private copy of the database (`withDatabaseSnapshotAsync`): the main
 * file and any write-ahead log or hot journal that holds more than the file does, so a registration that
 * is still only in the log is seen. The originals are never opened for writing, and no sidecar is created
 * beside them.
 *
 * A copy that cannot be made or opened is not a reason to go on: the finding it returns blocks, because a
 * start that cannot say what it is about to open should not open it. A schema too old to register
 * checkouts has none to probe, which is not a failure.
 */
const registeredCheckouts = async (
  databasePath: string,
): Promise<{ checkouts: RegisteredCheckout[] } | { notJudged: string } | { unavailable: string }> => {
  if (!existsSync(databasePath)) return { checkouts: [] };
  try {
    return await withDatabaseSnapshotAsync(databasePath, (copy) => {
      const columns = (table: string): Set<string> =>
        new Set((copy.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name));
      const repositories = columns("repositories");
      for (const needed of ["repository_id", "identity", "checkout_path", "project_id", "created_at"]) {
        if (!repositories.has(needed)) {
          return { notJudged: "the database's schema is too old to register checkouts, so it has none to probe" };
        }
      }
      const suspended = columns("projects").has("suspended") ? "COALESCE(p.suspended, 0)" : "0";
      const rows = copy
        .prepare(
          `SELECT r.identity AS identity, r.checkout_path AS checkoutPath, r.project_id AS projectId,
                  ${suspended} AS suspended
             FROM repositories r LEFT JOIN projects p ON p.project_id = r.project_id
            ORDER BY r.created_at, r.repository_id`,
        )
        .all() as Array<{ identity: string; checkoutPath: string; projectId: string | null; suspended: number }>;
      return { checkouts: rows.map((row) => ({ ...row, suspended: row.suspended === 1 })) };
    });
  } catch (error) {
    if (error instanceof DatabaseSnapshotUnavailable) return { unavailable: error.message };
    return { unavailable: safeErrorMessage(error) };
  }
};

/**
 * `Doctor.checkRepositories` and `checkWorktrees`, reduced to the findings that can block and run with no
 * write: whether each checkout's git answers, and whether it has a HEAD. Their drift and orphan findings
 * are not blocking and are left to the full report. `git status` runs with `--no-optional-locks`, so a
 * tracked file whose stat changed does not get its index rewritten.
 */
const checkoutFindings = async (checkouts: readonly RegisteredCheckout[], worktreeRoot: string): Promise<Finding[]> => {
  const findings: Finding[] = [];
  const deadlineAt = Date.now() + REPOSITORY_SWEEP_BUDGET_MS;
  const remaining = (): number => Math.max(1, deadlineAt - Date.now());
  for (const checkout of checkouts) {
    if (deadlineAt - Date.now() <= 0) break;
    let head: string | null;
    try {
      head = await tryRevParse(checkout.checkoutPath, "HEAD", { timeoutMs: remaining() });
      if (head) {
        await isClean(checkout.checkoutPath, { timeoutMs: remaining(), readOnly: true });
        await git(checkout.checkoutPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
          allowFailure: true,
          timeoutMs: remaining(),
          readOnly: true,
        });
      }
    } catch (error) {
      findings.push(repositoryProbeFailedFinding(checkout, safeErrorMessage(error), checkout.suspended));
      continue;
    }
    if (head === null) findings.push(repositoryUnreadableFinding(checkout, checkout.suspended));
  }
  for (const checkout of checkouts) {
    try {
      await listWorktrees(checkout.checkoutPath);
      // What `WorktreeManager.orphans` reads next, with its parser: a registration under
      // `.verification-checkouts` that cannot be read or does not name its own id and path makes the
      // doctor's worktree probe fail for every repository, so it fails the gate's too.
      readCheckoutRegistrations(worktreeRoot);
    } catch (error) {
      findings.push(worktreeProbeFailedFinding(checkout, safeErrorMessage(error), checkout.suspended));
    }
  }
  return findings;
};

/**
 * Every check whose answer is a fact about files, credentials or checkouts, taken before the database is
 * opened.
 *
 * A path that does not exist yet is not insecure: the control plane creates it privately, so a first start
 * has nothing to refuse there. A path that exists is held to the same rule the doctor holds it to.
 *
 * What it leaves to the full report, because the answer is in rows the start itself settles or in
 * measurements it takes by writing: bindings, runs, workers and sessions, claims, the outbox, turns, and
 * capacity and role coverage.
 */
export const judgeStartBeforeOpening = async (config: StartGateConfig): Promise<StartGateJudgement> => {
  const findings: Finding[] = [];
  const notJudged: string[] = [];

  findings.push(
    ...statePathFindings(
      [
        ...inspectDatabaseStatePaths(config.databasePath),
        inspectPrivatePath(config.worktreeRoot, "directory"),
        inspectPrivatePath(config.secretsDir, "directory"),
        inspectPrivatePath(config.capacityDir, "directory"),
      ].filter((inspection) => inspection.secure || inspection.reason !== "path does not exist"),
    ),
  );

  const credentials = new TrustedCredentialStore(config.secretsDir, {
    ...(config.githubAppEnvFile ? { appEnvFile: config.githubAppEnvFile } : {}),
    ...(config.githubAppPrivateKeyPath ? { privateKeyPath: config.githubAppPrivateKeyPath } : {}),
  });
  findings.push(
    ...gitHubGateFindings({ credentialInstalled: credentials.available(), permissionsOk: credentials.permissionsOk() }),
  );

  const registered = await registeredCheckouts(config.databasePath);
  if ("notJudged" in registered) notJudged.push(`repository and worktree probes: ${registered.notJudged}`);
  else if ("unavailable" in registered) {
    findings.push({
      code: "START_GATE_DATABASE_UNREADABLE",
      severity: "ERROR",
      scope: "host",
      blocking: true,
      confidence: "HIGH",
      observedEvidence: { error: registered.unavailable },
      recommendedAction: "the registered checkouts could not be read without opening the database, so the start was refused before it opened it",
    });
  } else findings.push(...(await checkoutFindings(registered.checkouts, config.worktreeRoot)));

  return { status: aggregate(findings), findings, notJudged };
};

/**
 * Takes `agentcpd.lock` before anything else is judged or opened, or says why this start must end.
 *
 * The lock used to be taken by `Daemon.start`, after the control plane had opened the database and the
 * entry point had recorded its runtime in it, so a second start during an offline migration appended audit
 * rows before it was told another process held the lock. A start that finds the lock held writes nothing
 * to the database; it is counted in `crash-loop.json` as it always was, so the supervisor's backoff is the
 * same, and it is reported on stderr.
 *
 * A state directory that does not exist yet is created owner-only first: the lock lives in it, and the
 * database's own open requires it to be exactly that.
 */
export const takeStartLock = (
  databasePath: string,
  nowIso: () => string = () => systemClock.nowIso(),
): { lock: SingleInstanceLock } | { refused: StartRefusedBeforeOpening } => {
  const stateDir = dirname(databasePath);
  if (!existsSync(stateDir)) ensurePrivateDirectory(stateDir);
  const lock = new SingleInstanceLock(join(stateDir, "agentcpd.lock"));
  const acquired = lock.acquire(nowIso());
  if (acquired.allowed) return { lock };
  let failures = readCrashLoopFile(stateDir, nowIso()).failures + 1;
  try {
    failures = countStartupFailure(stateDir, nowIso()).next.failures;
  } catch {
    // The count is the supervisor's throttle; the refusal stands without it.
  }
  return {
    refused: {
      decision: deny(acquired.reasonCode, acquired.message, { ...acquired.evidence, databaseWritten: false }),
      failures,
      backoffSeconds: backoffSecondsFor(failures),
    },
  };
};

/** A start refused before the database was opened: what to print, and the backoff the supervisor reads. */
export interface StartRefusedBeforeOpening {
  decision: Decision<never>;
  failures: number;
  backoffSeconds: number;
}

/**
 * Refuses a start that must not open the database, or answers `null` to let it go on.
 *
 * A retry that arrives inside the backoff of an earlier refusal of this kind is refused again here, from
 * `crash-loop.json` alone: the daemon's own backoff refusal writes an audit row, which is a write this
 * path exists not to make. A refusal is counted in `crash-loop.json` and nowhere else.
 *
 * #1496 — a refusal that was recorded sends one notice to the CEO (`start-refusal-notice.ts`), outside the
 * database and the outbox, and writes what became of it back into `lastRefusal.notice`. The notice carries
 * the `refusalId` minted here. The backoff retry above returns before this point, so it never sends again.
 * The notice is bounded and cannot change the refusal: whatever it answers, the refusal is the same.
 */
export const refuseStartBeforeOpening = async (
  config: StartGateConfig,
  nowIso: () => string = () => systemClock.nowIso(),
  notice: RefusalNoticeOptions | null = null,
): Promise<StartRefusedBeforeOpening | null> => {
  const stateDir = dirname(config.databasePath);
  const startedAt = nowIso();

  const prior = readCrashLoopFile(stateDir, startedAt);
  if (prior.lastRefusal && prior.retryNotBefore && Date.parse(prior.retryNotBefore) > Date.parse(startedAt)) {
    const backoffSeconds = Math.ceil((Date.parse(prior.retryNotBefore) - Date.parse(startedAt)) / 1000);
    return {
      decision: deny(ReasonCode.DAEMON_BACKOFF_ACTIVE, "startup backoff is still active", {
        beforeOpen: true,
        databaseWritten: false,
        failures: prior.failures,
        retryNotBefore: prior.retryNotBefore,
        backoffSeconds,
        lastRefusal: prior.lastRefusal,
      }),
      failures: prior.failures,
      backoffSeconds: backoffSecondsFor(prior.failures),
    };
  }

  const judged = await judgeStartBeforeOpening(config);
  if (judged.status !== "BLOCKED" && judged.status !== "ERROR") return null;

  const reasonCode = judged.status === "BLOCKED" ? ReasonCode.DOCTOR_BLOCKED : ReasonCode.DOCTOR_ERROR;
  const blockingFindings = judged.findings
    .filter((finding) => finding.blocking)
    .map((finding) => ({ code: finding.code, severity: finding.severity, scope: finding.scope }));
  let recorded: { failures: number; backoffSeconds: number } | null = null;
  let recordError: string | null = null;
  const refusalId = randomUUID();
  const host = notice?.host ?? refusalHost();
  let lastRefusal: NonNullable<ReturnType<typeof readCrashLoopFile>["lastRefusal"]> | null = null;
  let retryNotBefore: string | null = null;
  try {
    lastRefusal = {
      refusalId,
      host,
      at: startedAt,
      reasonCode,
      stage: "before-open",
      doctorStatus: judged.status,
      blockingFindings,
      databaseWritten: false,
    };
    const counted = countStartupFailure(stateDir, startedAt, lastRefusal);
    recorded = { failures: counted.next.failures, backoffSeconds: counted.backoffSeconds };
    retryNotBefore = counted.next.retryNotBefore ?? null;
  } catch (error) {
    // The refusal still stands and is still reported on stderr; only its record could not be kept.
    recordError = safeErrorMessage(error);
  }
  // Only a refusal that was written down is told: the notice names a record the receiver can match it to.
  let ceoNotice: RefusalNoticeOutcome | { outcome: "not-sent"; reason: string };
  if (recorded === null || lastRefusal === null) {
    ceoNotice = { outcome: "not-sent", reason: "crash-loop.json was not written" };
  } else {
    ceoNotice = await deliverRefusalNotice(
      lastRefusal,
      { failures: recorded.failures, retryNotBefore },
      notice ?? { route: { configured: false, reason: "no CEO notice route was supplied to the start gate" } },
      nowIso,
    );
    try {
      recordRefusalNotice(stateDir, refusalId, ceoNotice);
    } catch (error) {
      ceoNotice = { outcome: "failed", at: nowIso(), reason: `${ceoNotice.outcome}, but crash-loop.json could not record it: ${safeErrorMessage(error)}` };
    }
  }
  return {
    decision: deny(reasonCode, "startup doctor refused this start before it opened the database", {
      beforeOpen: true,
      databaseWritten: false,
      refusalId,
      ceoNotice,
      doctorStatus: judged.status,
      blockingFindings,
      notJudged: judged.notJudged,
      ...(recordError ? { crashLoopRecordError: recordError } : {}),
    }),
    failures: recorded?.failures ?? prior.failures + 1,
    backoffSeconds: recorded?.backoffSeconds ?? backoffSecondsFor(prior.failures + 1),
  };
};

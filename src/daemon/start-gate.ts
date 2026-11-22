import Database from "better-sqlite3";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

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
import { databaseSidecarPaths, inspectDatabaseStatePaths, inspectPrivatePath } from "../db/state-preflight.ts";
import { backoffSecondsFor, countStartupFailure, readCrashLoopFile } from "./crash-loop.ts";

/**
 * migrate-before-start — the startup verdict that is given before the control plane opens the database.
 *
 * Opening the database writes: it creates a missing file, switches a rollback-journal file to WAL, applies
 * an approved migration and retires its approval, and the control plane's constructor then appends audit
 * rows of its own (a refused reviewer-preferences file among them). A start the doctor will refuse for a
 * reason that was visible beforehand must refuse before any of that, or the official rollback to the pair
 * sealed before an approved migration refuses the database as stale (ROLLBACK_PAIR_STALE_DATABASE).
 *
 * What is judged here reads only files and read-only git, and, for the registered checkouts, a copy of the
 * database's own bytes held in memory. Nothing is opened for writing, no sidecar is created, no repository
 * index is refreshed, and a refusal is reported on stderr and in `crash-loop.json` only.
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

/** A database larger than this is not copied into memory to read its repository list. */
const SNAPSHOT_LIMIT_BYTES = 256 * 1024 * 1024;

const safeErrorMessage = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/[\r\n\t]/g, " ").slice(0, 500);

/**
 * The registered checkouts, read from a private in-memory copy of the main database file.
 *
 * A read-only connection to the file itself is not read-only to its neighbours: on a WAL database it
 * creates `-shm` (and `-wal`), which is the very change a refused start must not leave. The copy is
 * opened as a rollback-journal database (header bytes 18 and 19 set to 1 in the copy, never in the
 * file), so it needs no sidecar, and the committed state of the file is all it can show. A write-ahead
 * or hot journal that holds more than the file does makes the copy stale, so it is not read then.
 */
const registeredCheckouts = (databasePath: string): { checkouts: RegisteredCheckout[] } | { notJudged: string } => {
  if (!existsSync(databasePath)) return { checkouts: [] };
  for (const sidecar of databaseSidecarPaths(databasePath)) {
    if (existsSync(sidecar) && statSync(sidecar).size > 0 && !sidecar.endsWith("-shm")) {
      return { notJudged: `the database has a non-empty ${sidecar.slice(databasePath.length)} beside it, so its main file alone is not its state` };
    }
  }
  if (statSync(databasePath).size > SNAPSHOT_LIMIT_BYTES) {
    return { notJudged: "the database is too large to read a copy of" };
  }
  try {
    const bytes = Buffer.from(readFileSync(databasePath));
    if (bytes.length < 100 || !bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) {
      return { notJudged: "the database file has no SQLite header" };
    }
    bytes[18] = 1;
    bytes[19] = 1;
    const copy = new Database(bytes, { readonly: true });
    try {
      const rows = copy
        .prepare(
          `SELECT r.identity AS identity, r.checkout_path AS checkoutPath, r.project_id AS projectId,
                  COALESCE(p.suspended, 0) AS suspended
             FROM repositories r LEFT JOIN projects p ON p.project_id = r.project_id
            ORDER BY r.created_at, r.repository_id`,
        )
        .all() as Array<{ identity: string; checkoutPath: string; projectId: string | null; suspended: number }>;
      return { checkouts: rows.map((row) => ({ ...row, suspended: row.suspended === 1 })) };
    } finally {
      copy.close();
    }
  } catch (error) {
    return { notJudged: `the registered checkouts could not be read from the database file: ${safeErrorMessage(error)}` };
  }
};

/**
 * `Doctor.checkRepositories` and `checkWorktrees`, reduced to the findings that can block and run with no
 * write: whether each checkout's git answers, and whether it has a HEAD. Their drift and orphan findings
 * are not blocking and are left to the full report. `git status` runs with `--no-optional-locks`, so a
 * tracked file whose stat changed does not get its index rewritten.
 */
const checkoutFindings = async (checkouts: readonly RegisteredCheckout[]): Promise<Finding[]> => {
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

  const registered = registeredCheckouts(config.databasePath);
  if ("notJudged" in registered) notJudged.push(`repository and worktree probes: ${registered.notJudged}`);
  else findings.push(...(await checkoutFindings(registered.checkouts)));

  return { status: aggregate(findings), findings, notJudged };
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
 */
export const refuseStartBeforeOpening = async (
  config: StartGateConfig,
  nowIso: () => string = () => systemClock.nowIso(),
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
  try {
    const counted = countStartupFailure(stateDir, startedAt, {
      at: startedAt,
      reasonCode,
      stage: "before-open",
      doctorStatus: judged.status,
      blockingFindings,
      databaseWritten: false,
    });
    recorded = { failures: counted.next.failures, backoffSeconds: counted.backoffSeconds };
  } catch (error) {
    // The refusal still stands and is still reported on stderr; only its record could not be kept.
    recordError = safeErrorMessage(error);
  }
  return {
    decision: deny(reasonCode, "startup doctor refused this start before it opened the database", {
      beforeOpen: true,
      databaseWritten: false,
      doctorStatus: judged.status,
      blockingFindings,
      notJudged: judged.notJudged,
      ...(recordError ? { crashLoopRecordError: recordError } : {}),
    }),
    failures: recorded?.failures ?? prior.failures + 1,
    backoffSeconds: recorded?.backoffSeconds ?? backoffSecondsFor(prior.failures + 1),
  };
};

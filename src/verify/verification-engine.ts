import type { Clock } from "../core/clock.ts";
import { createHash, randomUUID } from "node:crypto";
import { verificationKindRunning } from "../bootstrap/repo-factory-producer.ts";
import { redactCredentialShapes, withholdCutFragment } from "../core/credential-shapes.ts";
import { canonicalJson, digestOf, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { type VerificationCommand, verificationCommandSchema } from "../contracts/verification-command.ts";
import { type ProjectManifest, commandsForMode, gateEntriesFor } from "../contracts/manifest.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore, EvidenceWriter } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind, type RunRow } from "../domain/types.ts";
import { git } from "../git/git.ts";
import { type Stats, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ClaimRegistry } from "../claims/claim-registry.ts";
import { WorktreeAction, WriteOperation, type ManagedWriteGuard } from "../guard/managed-write-guard.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import { residentBaseClone, residentClonePaths } from "../registry/resident-repositories.ts";
import {
  type CandidateSnapshot,
  candidateSnapshotDigest,
  duplicateRepositoryRoles,
  expectedCheckoutHead,
  verifySnapshotFreshness,
} from "../snapshot/candidate-snapshot.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import { CI_FAILED_CONCLUSIONS } from "./ci-verification-records.ts";
import { gateResolutionPreload } from "./gate-resolution-hook.ts";
import { type SandboxEnforcement, runSandboxed } from "./sandbox.ts";
import type { WorktreeAuthorization, WorktreeManager } from "./worktree.ts";

export interface CiCheck {
  commandId: string;
  repositoryIdentity: string;
  head: string;
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "unknown";
  workflowDigest: string;
  creatorIdentity: string;
  completedAt: string;
  nonVacuous: boolean;
}

/**
 * Trusted CI evidence lookup (Integration §14.4). Kept as a port so the verification
 * engine has no dependency on the GitHub kernel; the daemon wires the real one in.
 */
export interface CiEvidenceSource {
  fetch(repositoryIdentity: string, head: string): Promise<CiCheck[]>;
  /** Workflow/config digests the project contract approved for this repository. */
  approvedWorkflowDigests(repositoryIdentity: string): Promise<string[]>;
  trustedCreators(): Promise<string[]>;
}

/**
 * #1257 — the reason a trusted check's FAIL row keeps, so a reader can tell a finished failure from
 * a check that had not finished. `unknown` is what the port reports when GitHub gave no conclusion,
 * which it does until the check completes. Any other non-success (`neutral`, `skipped`, a value not
 * listed) keeps the general code. The row's status stays FAIL in every case, so the gate is unchanged.
 */
const ciNonSuccessReason = (conclusion: string): ReasonCode =>
  CI_FAILED_CONCLUSIONS.has(conclusion) ? ReasonCode.VERIFICATION_CI_CHECK_FAILED
    : conclusion === "unknown" ? ReasonCode.VERIFICATION_CI_CHECK_PENDING
      : ReasonCode.VERIFICATION_COMMAND_FAILED;

export interface VerificationResultRecord {
  commandId: string;
  repositoryIdentity: string;
  source: "local" | "ci";
  exactHead: string;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  outputDigest: string;
  outputTruncated: boolean;
  status: "PASS" | "FAIL" | "TIMEOUT" | "ERROR" | "SKIPPED";
  reasonCode: string | null;
  /** Local sandbox measurement; CI evidence has no host-process RSS. */
  peakRssMb?: number | null;
  enforcement?: SandboxEnforcement;
  /**
   * What a reviewer may read of a local command's captured output: bounded and credential-redacted.
   * Absent on CI evidence (ACP captures no CI log) and on every result recorded before it existed:
   * such output was not retained, and nothing is reconstructed for it.
   */
  output?: VerificationOutputExcerpt;
}

/** Per stream, the first and last characters of the captured output that are kept. */
export const OUTPUT_EXCERPT_HEAD_CHARS = 1_000;
export const OUTPUT_EXCERPT_TAIL_CHARS = 3_000;

/**
 * A bounded, redacted excerpt of one official sandbox execution, bound to the execution it was taken
 * from. It is candidate-produced text: evidence to read, never an instruction or a verdict.
 */
export interface VerificationOutputExcerpt {
  schema: "acp.verification-output-excerpt.v1";
  candidateSnapshotDigest: string;
  contractDigest: string;
  commandId: string;
  repositoryIdentity: string;
  exactHead: string;
  /** Captured characters per stream, before redaction and excerpting. */
  stdoutChars: number;
  stderrChars: number;
  stdout: string;
  stderr: string;
  /** Characters were left out between each stream's head and tail. */
  truncated: boolean;
  /**
   * At least one run of text matched a listed credential shape and was replaced with `[redacted]`.
   * The shapes include any run of 60 or more base64 or hex characters, so a digest can be replaced
   * as well as a credential; what was replaced is evidence of neither.
   */
  redacted: boolean;
  /**
   * The sandbox stopped capturing at the command's maxOutputBytes, so the end of each stream is a cut
   * with the rest unseen; the trailing run of credential-alphabet characters at that cut (a possible
   * start of a shape too short to recognise) was withheld from it.
   */
  boundaryFragmentWithheld: boolean;
}

/**
 * Credential shapes in free text replaced with `[redacted]`, from the one shared list
 * (core/credential-shapes.ts), every shape applied: those the sandbox refuses as environment values
 * and those the audit log redacts, found anywhere in a line. A pattern filter, not a guarantee: a
 * secret in no listed shape passes.
 */
export const redactCredentialText = (text: string): { text: string; redacted: boolean } => {
  const scrubbed = redactCredentialShapes(text);
  return { text: scrubbed, redacted: scrubbed !== text };
};

const excerptOf = (text: string): { text: string; truncated: boolean } => {
  if (text.length <= OUTPUT_EXCERPT_HEAD_CHARS + OUTPUT_EXCERPT_TAIL_CHARS) return { text, truncated: false };
  const omitted = text.length - OUTPUT_EXCERPT_HEAD_CHARS - OUTPUT_EXCERPT_TAIL_CHARS;
  return {
    text: `${text.slice(0, OUTPUT_EXCERPT_HEAD_CHARS)}\n[... ${omitted} characters omitted ...]\n${text.slice(-OUTPUT_EXCERPT_TAIL_CHARS)}`,
    truncated: true,
  };
};

/**
 * The sandbox's own capture cut comes first and its far side is never seen, so when the capture was
 * cut the trailing credential-alphabet run is withheld before anything else. Then the whole stream is
 * redacted, so the excerpt's own cut can never shorten a credential below its shape; then it is cut;
 * then the excerpt is redacted again, because a cut can give a shape the word boundary it lacked.
 */
const excerptStream = (captured: string, captureTruncated: boolean): { text: string; truncated: boolean; redacted: boolean } => {
  const text = captureTruncated ? withholdCutFragment(captured).text : captured;
  const whole = redactCredentialText(text);
  const cut = excerptOf(whole.text);
  const again = redactCredentialText(cut.text);
  return { text: again.text, truncated: cut.truncated, redacted: whole.redacted || again.redacted };
};

/**
 * `captureTruncated` is the sandbox's `outputTruncated`. Capture stops for both streams at once, so
 * either may end at the cut, and both have their cut edge withheld.
 */
export const verificationOutputExcerpt = (
  binding: Pick<VerificationOutputExcerpt, "candidateSnapshotDigest" | "contractDigest" | "commandId" | "repositoryIdentity" | "exactHead">,
  stdout: string,
  stderr: string,
  captureTruncated: boolean,
): VerificationOutputExcerpt => {
  const out = excerptStream(stdout, captureTruncated);
  const err = excerptStream(stderr, captureTruncated);
  return {
    schema: "acp.verification-output-excerpt.v1", ...binding, stdoutChars: stdout.length, stderrChars: stderr.length,
    stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated, redacted: out.redacted || err.redacted,
    boundaryFragmentWithheld: captureTruncated,
  };
};

export interface VerificationReport {
  runId: string;
  candidateSnapshotDigest: string;
  contractDigest: string;
  expectedInputs: number;
  observedInputs: number;
  results: VerificationResultRecord[];
  status: "PASS" | "FAIL" | "INCOMPLETE";
  reasonCode: string;
  gaps: string[];
}

export interface VerifyOptions {
  runId: string;
  snapshot: CandidateSnapshot;
  commands: readonly VerificationCommand[];
  /** Digest of the approved contract the commands came from (CP-HI-03). */
  contractDigest: string;
  /**
   * Deprecated caller assertions. They are checked against the registered run but never
   * select a command profile; the engine reads that authority from the run itself.
   */
  pinnedManifestDigest?: string | null;
  executionMode?: "SIMPLE" | "STANDARD" | "GUARDED";
  /** Commands the CTO proposed for an unregistered repository (§17.5). */
  runScoped?: boolean;
}

const memoryEvidenceReason = (
  peakRssMb: number | null | undefined,
  maxMemoryMb: number,
): ReasonCode | null => {
  if (peakRssMb == null) return ReasonCode.SANDBOX_RESOURCE_LIMIT_UNAVAILABLE;
  return peakRssMb > maxMemoryMb ? ReasonCode.SANDBOX_RESOURCE_LIMIT_EXCEEDED : null;
};

/** What a declared gate entry is at a candidate head (RF-S22). */
type GateEntryObservation =
  | { state: "FILE"; digest: string }
  | { state: "ABSENT" }
  | { state: "NOT_A_REGULAR_FILE"; mode: string; type: string }
  | { state: "UNREADABLE"; detail: string };

/** A symlink (120000), gitlink (160000) or tree is not a file whose bytes a pin can name. */
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

/**
 * Reads one gate entry's bytes at an exact commit, from git objects rather than a working tree.
 *
 * Unreplaced, as the producer's tree read is (`producedTreeDrift`): a replace ref changes what a
 * local read of an object returns. `git()` decodes stdout as UTF-8, which is lossy for bytes
 * that are not UTF-8, so the blob id is re-derived from the decoded text: only when it equals
 * the id `ls-tree` named are the bytes hashed below exactly the committed bytes. Without that, a
 * pinned file carrying a literal U+FFFD would share its digest with a candidate that put an
 * invalid byte in the same place.
 */
const gateEntryAt = async (checkoutPath: string, head: string, path: string): Promise<GateEntryObservation> => {
  const listed = await git(
    checkoutPath,
    ["--no-replace-objects", "ls-tree", "-z", "--full-tree", head, "--", path],
    { allowFailure: true },
  );
  if (listed.exitCode !== 0) return { state: "UNREADABLE", detail: listed.stderr.trim() };
  const entry = listed.stdout
    .split("\0")
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode = "", type = "", id = ""] = line.slice(0, tab).split(" ");
      return { mode, type, id, path: line.slice(tab + 1) };
    })
    .find((listedEntry) => listedEntry.path === path);
  if (!entry) return { state: "ABSENT" };
  if (entry.type !== "blob" || !REGULAR_FILE_MODES.has(entry.mode)) {
    return { state: "NOT_A_REGULAR_FILE", mode: entry.mode, type: entry.type };
  }
  // A failed read leaves stdout empty, which the blob-id comparison below refuses as well.
  const blob = await git(checkoutPath, ["--no-replace-objects", "cat-file", "blob", entry.id], {
    allowFailure: true,
  });
  const bytes = Buffer.from(blob.stdout, "utf8");
  const objectFormat = entry.id.length === 64 ? "sha256" : "sha1";
  const rederived = createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (rederived !== entry.id) {
    return {
      state: "UNREADABLE",
      detail: "the file's bytes could not be read exactly: it is not UTF-8 text, or its object is unreadable",
    };
  }
  return { state: "FILE", digest: sha256(bytes) };
};

type GateEntry = NonNullable<ProjectManifest["gateEntries"]>[number];

/**
 * Reads one gate entry as the command about to run will find it: the file in the materialised
 * verification worktree (#1082 R1-01). The object read above says what the candidate committed;
 * this says what preparation actually wrote, after attributes, filters and anything else between
 * the two. Every component of the path is lstat'd, so a symlink anywhere on it is refused rather
 * than followed, and the bytes are read raw.
 */
const materializedGateEntryAt = (worktreePath: string, path: string): GateEntryObservation => {
  const parts = path.split("/");
  for (const [index] of parts.entries()) {
    const current = join(worktreePath, ...parts.slice(0, index + 1));
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
        return { state: "ABSENT" };
      }
      return { state: "UNREADABLE", detail: (error as Error).message };
    }
    const last = index === parts.length - 1;
    if (stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory())) {
      return { state: "NOT_A_REGULAR_FILE", mode: (stat.mode & 0o170000).toString(8).padStart(6, "0"), type: "filesystem" };
    }
  }
  return { state: "FILE", digest: sha256(readFileSync(join(worktreePath, ...parts))) };
};

/** The refusal an observation earns against its pin, or null when it is the pinned file. */
const gateEntryRefusal = (
  observed: GateEntryObservation,
  entry: GateEntry,
  evidence: Record<string, unknown>,
  where: string,
): Decision<never> | null => {
  const base = { ...evidence, repositoryRole: entry.repositoryRole, path: entry.path, expected: entry.digest };
  if (observed.state === "UNREADABLE") {
    // Nothing was compared, so this must not read as "compared and differs" (#448).
    return deny(ReasonCode.CONTRACT_UNVERIFIED, `a gate entry the pinned manifest binds could not be read ${where}`, {
      ...base,
      detail: observed.detail,
    });
  }
  if (observed.state === "FILE" && observed.digest === entry.digest) return null;
  return deny(ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT, `a gate entry the pinned manifest binds differs ${where}`, {
    ...base,
    observed: observed.state === "FILE" ? observed.digest : null,
    observedState: observed.state,
    ...(observed.state === "NOT_A_REGULAR_FILE" ? { observedMode: observed.mode, observedType: observed.type } : {}),
  });
};

/**
 * PRD §17.
 *
 * Two properties matter more than the individual command outcomes. First, the
 * candidate is pinned before anything runs, so a source change invalidates the whole
 * evidence set rather than part of it. Second, the completeness gate counts expected
 * inputs — a missing command, a missing repository, a null result, a stale CI answer or
 * truncated output all block success instead of quietly reducing the bar (§17.7,
 * CP-HI-08).
 */
export class VerificationEngine {
  #ci: CiEvidenceSource | null = null;
  private extraDenyReadPaths: string[] = [];
  /** Injected manifest loader; kept as a function so the engine owns no registry. */
  private manifests: ((digest: string) => ProjectManifest | null) | null = null;
  /** Run lookup makes the dispatch-time pin the only command-selection authority. */
  private runs: ((runId: string) => RunRow | null) | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    /**
     * The capability that makes this engine the only writer of VERIFICATION evidence. It
     * is issued once by the composition root; holding the store is not enough to write
     * (#70, CP-HI-04).
     */
    private readonly evidenceWriter: EvidenceWriter<"VERIFICATION">,
    private readonly repositories: RepositoryRegistry,
    private readonly worktrees: WorktreeManager,
    private readonly claims: ClaimRegistry,
    private readonly guard: ManagedWriteGuard,
    private readonly telemetry: Telemetry,
  ) {}

  attachCi(source: CiEvidenceSource): void {
    this.#ci = source;
  }

  attachManifests(loader: (digest: string) => ProjectManifest | null): void {
    this.manifests = loader;
  }

  attachRuns(loader: (runId: string) => RunRow | null): void {
    this.runs = loader;
  }

  /**
   * RF-S22 (PRD §14.2 "Candidate Gate Logic 변경은 이전 Trusted Contract로 판정", RF-019).
   *
   * What this guarantees, and where (#1082). Each selected command's gate entries
   * (`gateEntriesFor`: the entry it runs as `node <entry>` and the helpers declared under it) are
   * checked twice: here, in git objects at the candidate head, before any worktree, sandbox or CI
   * read; and again in `runLocal`, in that command's materialised worktree, immediately before it
   * runs. Only commands that run locally carry gate entries -- LOCAL_COMMAND, and BOTH_REQUIRED,
   * whose CI evidence is collected in addition to a checked local run. The manifest refuses a gate
   * entry on a TRUSTED_CI-only command, because CI runs it where neither check can reach. The
   * source checkout itself is read under `withoutRepositoryPrograms`, so freshness runs none of the
   * programs that function lists, measured one by one -- not a claim about every git setting.
   * Post-merge verification and its cached receipts do not repeat either check.
   *
   * Obligations follow the selected procedure and the run's participants, not the manifest as a
   * whole: a command that is not selected, or whose repository is not in the run, holds the run
   * to nothing here, and a selected command whose repository cannot be resolved is the gap the
   * command loop already reports (#1082 R1-03).
   *
   * The basis is the run's pinned manifest, never the candidate's copy. `pinned` is loaded from
   * the trusted store by the run's dispatch-time digest, every snapshot repository has just been
   * required to carry that digest, and the freshness check that follows refuses a snapshot whose
   * repository's active manifest has since moved — so nothing runs unless it is the current
   * active contract. A candidate that deletes an entry from its committed manifest, rewrites an
   * entry's digest there, or carries a different manifest in its PLAN changes nothing read here.
   * A CONTRACT_CHANGE run is judged the same way: a new entry digest applies only once that
   * contract has been approved and activated.
   *
   * A pinned manifest that declares no entries passes this check vacuously. That is not RF-S22
   * compliance — none of its gate logic is pinned — and nothing here or in the report says
   * otherwise. Only declared files are bound, and they are the only files a gate command may load
   * in-process: `runLocal` launches it under ACP's loader (gate-resolution-hook.ts), which refuses
   * any other module, so an undeclared helper or candidate code fails the gate rather than deciding it.
   */
  private async pinnedGateEntriesHold(
    runId: string,
    commands: readonly VerificationCommand[],
    obligations: ReadonlyMap<string, readonly GateEntry[]>,
    snapshot: CandidateSnapshot,
  ): Promise<Decision<void>> {
    for (const command of commands) {
      const matching = snapshot.repositories.filter((repo) => repo.repositoryRole === command.repositoryRole);
      const repo = matching.length === 1 ? matching[0]! : null;
      const record = repo ? this.repositories.byIdentity(repo.identity) : null;
      if (!repo || !record) continue;
      for (const entry of obligations.get(command.id) ?? []) {
        const observed = await gateEntryAt(record.checkoutPath, repo.candidateHead, entry.path);
        const refused = gateEntryRefusal(
          observed,
          entry,
          { runId, commandId: command.id, identity: repo.identity, candidateHead: repo.candidateHead, checkedIn: "GIT_OBJECTS" },
          "at the candidate head",
        );
        if (refused) return refused;
      }
    }
    return allow(ReasonCode.OK, undefined);
  }

  async verify(options: VerifyOptions): Promise<Decision<VerificationReport>> {
    const { runId, snapshot } = options;
    const snapshotDigest = candidateSnapshotDigest(snapshot);
    const run = this.runs?.(runId) ?? null;
    if (!run) {
      return deny(ReasonCode.NOT_FOUND, "verification requires a registered run", { runId });
    }

    const duplicateRoles = duplicateRepositoryRoles(snapshot.repositories);
    if (duplicateRoles.length > 0) {
      return deny(
        ReasonCode.VERIFICATION_GAP,
        "candidate maps a verification repository role to more than one identity",
        { runId, duplicateRoles },
      );
    }

    // CP-HI-03 — the pinned contract, not whatever the candidate now contains.
    if (snapshot.contractDigest !== options.contractDigest || run.contractDigest !== options.contractDigest) {
      return deny(
        ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT,
        "candidate snapshot is pinned to a different contract than the one supplied",
        {
          snapshotContract: snapshot.contractDigest,
          runContract: run.contractDigest,
          supplied: options.contractDigest,
        },
      );
    }

    let commands: readonly VerificationCommand[];
    /** RF-S22 — the pinned gate entries each selected command runs; none for a run-scoped run. */
    const gateObligations = new Map<string, readonly GateEntry[]>();
    if (run.pinnedManifestDigest) {
      if (options.runScoped) {
        return deny(
          ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT,
          "a run with a pinned manifest cannot submit run-scoped commands",
          { runId, pinnedManifestDigest: run.pinnedManifestDigest },
        );
      }
      if (
        (options.pinnedManifestDigest != null && options.pinnedManifestDigest !== run.pinnedManifestDigest) ||
        (options.executionMode != null && options.executionMode !== run.executionMode)
      ) {
        return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "caller assertions do not match the registered run", {
          runId,
          registeredManifestDigest: run.pinnedManifestDigest,
          registeredExecutionMode: run.executionMode,
          suppliedManifestDigest: options.pinnedManifestDigest ?? null,
          suppliedExecutionMode: options.executionMode ?? null,
        });
      }

      // CP-HI-03 — the command set is derived from the dispatch-time manifest. A caller
      // may repeat it for compatibility, but it cannot select a weaker replacement.
      const pinned = this.manifests?.(run.pinnedManifestDigest) ?? null;
      if (!pinned) {
        // #448: the run's pinned digest exists, but the manifest it names cannot be produced
        // to compare against. That is not a disagreement between two known values — nothing
        // was compared — so it must not report as MISMATCH, which reads as "compared and
        // differs" to anyone matching on the code.
        return deny(ReasonCode.CONTRACT_UNVERIFIED, "pinned manifest is not retrievable", {
          runId,
          pinnedManifestDigest: run.pinnedManifestDigest,
        });
      }
      const expected = commandsForMode(pinned, run.executionMode);
      if (digestOf(expected) !== digestOf([...options.commands])) {
        return deny(
          ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT,
          "supplied verification commands do not match the run's pinned manifest",
          {
            runId,
            pinnedManifestDigest: run.pinnedManifestDigest,
            expected: expected.map((c) => c.id),
            supplied: options.commands.map((c) => c.id),
          },
        );
      }
      commands = expected;
      // Every repository in the candidate must also be pinned to that same manifest.
      const mismatched = snapshot.repositories.filter(
        (repo) => repo.manifestDigest !== run.pinnedManifestDigest,
      );
      if (mismatched.length > 0) {
        return deny(
          ReasonCode.CONTRACT_DIGEST_MISMATCH,
          "a repository in the candidate is pinned to a different manifest than the run",
          {
            runId,
            pinnedManifestDigest: run.pinnedManifestDigest,
            mismatched: mismatched.map((r) => ({ identity: r.identity, manifestDigest: r.manifestDigest })),
          },
        );
      }
      // RF-S22 — the gate logic the pinned manifest binds, before any command runs.
      for (const command of expected) gateObligations.set(command.id, gateEntriesFor(pinned, command));
      const gateLogic = await this.pinnedGateEntriesHold(runId, expected, gateObligations, snapshot);
      if (!gateLogic.allowed) return gateLogic as Decision<VerificationReport>;
    } else {
      if (!options.runScoped) {
        return deny(ReasonCode.VERIFICATION_GAP, "run-scoped commands require a temporary repository run", {
          runId,
        });
      }
      commands = options.commands;
    }

    const records = snapshot.repositories.map((repo) => ({
      repo,
      record: this.repositories.byIdentity(repo.identity),
    }));
    for (const { repo, record } of records) {
      if (!record) continue;
      if (record.trustClass !== "OWNER_TRUSTED") {
        return deny(ReasonCode.VERIFICATION_REPOSITORY_UNTRUSTED, "repository is not owner-trusted", {
          runId,
          identity: repo.identity,
          trustClass: record.trustClass,
        });
      }
      if (record.registration === "TEMPORARY" && record.temporaryForRun !== runId) {
        return deny(ReasonCode.VERIFICATION_GAP, "temporary repository is bound to a different run", {
          runId,
          identity: repo.identity,
          temporaryForRun: record.temporaryForRun,
        });
      }
    }
    if (!run.pinnedManifestDigest) {
      const invalidScopedRepository = records.find(
        ({ repo, record }) =>
          !record ||
          record.registration !== "TEMPORARY" ||
          record.temporaryForRun !== runId ||
          record.activeManifestDigest !== null ||
          repo.manifestDigest !== null,
      );
      if (invalidScopedRepository) {
        return deny(
          ReasonCode.VERIFICATION_GAP,
          "run-scoped commands require repositories temporary to this run with no pinned manifest",
          {
            runId,
            identity: invalidScopedRepository.repo.identity,
            registration: invalidScopedRepository.record?.registration ?? null,
            temporaryForRun: invalidScopedRepository.record?.temporaryForRun ?? null,
            activeManifestDigest: invalidScopedRepository.record?.activeManifestDigest ?? null,
            snapshotManifestDigest: invalidScopedRepository.repo.manifestDigest,
          },
        );
      }

      // §17.5 has no project manifest to pin at dispatch, so the first usable
      // run-scoped command set becomes this run's immutable verification contract.
      // A retry may re-submit it verbatim, but cannot replace a real failing suite with
      // a weaker argv after observing the first result.
      const scoped = this.pinRunScopedCommands(runId, commands);
      if (!scoped.allowed) return scoped as Decision<VerificationReport>;
      commands = scoped.value;
    }

    const verifiedOptions: VerifyOptions = { ...options, commands };

    const probes = records.map(({ repo, record }) => {
      return {
        identity: repo.identity,
        checkoutPath: record?.checkoutPath ?? "",
        residentClone: record ? residentBaseClone(this.db, record.repositoryId, record.checkoutPath) : null,
        activeManifestDigest: record?.activeManifestDigest ?? null,
      };
    });
    const fresh = await verifySnapshotFreshness(snapshot, probes.filter((p) => p.checkoutPath));
    if (!fresh.allowed) return fresh as Decision<VerificationReport>;

    if (commands.length === 0) {
      // §17.5 — no defensible verification method is a declared gap, not a pass.
      const report = this.buildReport(verifiedOptions, snapshotDigest, [], [
        "no verification command is configured for this candidate",
      ]);
      this.persist(runId, snapshotDigest, report);
      return deny(ReasonCode.VERIFICATION_GAP, "no verification command configured", {
        runId,
        snapshotDigest,
      });
    }

    const results: VerificationResultRecord[] = [];
    const gaps: string[] = [];

    for (const command of commands) {
      const matchingRepositories = snapshot.repositories.filter(
        (repository) => repository.repositoryRole === command.repositoryRole,
      );
      if (matchingRepositories.length !== 1) {
        gaps.push(
          `command '${command.id}' targets repositoryRole '${command.repositoryRole}' which does not map to exactly one candidate repository`,
        );
        continue;
      }
      const repo = matchingRepositories[0]!;
      const record = this.repositories.byIdentity(repo.identity);
      if (!record) {
        gaps.push(`repository '${repo.identity}' has no local binding`);
        continue;
      }

      if (command.evidenceMode !== "TRUSTED_CI") {
        const claim = this.ensureVerificationClaim(run, repo.identity);
        if (!claim.allowed) return claim as Decision<VerificationReport>;
        const local = await this.runLocal(
          run,
          snapshotDigest,
          command,
          repo.identity,
          record.checkoutPath,
          repo.candidateHead,
          repo.treeDigest,
          repo.sourceBranch ?? null,
          gateObligations.get(command.id) ?? [],
          expectedCheckoutHead(repo),
        );
        if (!local.allowed) return local as Decision<VerificationReport>;
        results.push(local.value);
      }
      if (command.evidenceMode !== "LOCAL_COMMAND") {
        results.push(await this.collectCi(runId, snapshotDigest, command, repo.identity, repo.candidateHead));
      }
    }

    // §16.2 — the commands ran against a detached worktree, but the source may have moved
    // while they ran. A PASS for a candidate that no longer exists is not evidence.
    const stillFresh = await verifySnapshotFreshness(snapshot, probes.filter((p) => p.checkoutPath));
    if (!stillFresh.allowed) {
      const staleReport = this.buildReport(verifiedOptions, snapshotDigest, results, [
        ...gaps,
        "the candidate changed while verification was running",
      ]);
      this.persist(runId, snapshotDigest, staleReport);
      return stillFresh as Decision<VerificationReport>;
    }

    const report = this.buildReport(verifiedOptions, snapshotDigest, results, gaps);
    this.persist(runId, snapshotDigest, report);

    this.telemetry.record({
      scope: "quality",
      name: "verification",
      runId,
      text: report.status,
      dims: { expected: report.expectedInputs, observed: report.observedInputs, gaps: gaps.length },
    });

    if (report.status === "PASS") return allow(ReasonCode.OK, report, { snapshotDigest });
    return deny(
      report.reasonCode as ReasonCode,
      report.status === "INCOMPLETE" ? "verification evidence is incomplete" : "verification failed",
      { runId, snapshotDigest, report },
    );
  }

  /** Persist and retrieve the §17.5 contract without treating a caller's argv as durable authority. */
  private pinRunScopedCommands(
    runId: string,
    supplied: readonly VerificationCommand[],
  ): Decision<readonly VerificationCommand[]> {
    const parsed = verificationCommandSchema.array().safeParse([...supplied]);
    if (!parsed.success) {
      return deny(ReasonCode.INVALID_ARGUMENT, "run-scoped verification commands are malformed", {
        runId,
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    const proposed = parsed.data;
    const proposedDigest = digestOf(proposed);

    // #664 — every denial below this line is a decision about the pin this body just
    // wrote (or found already written); none of it is housekeeping a caller relies on
    // regardless of the outcome, so a denial must roll the pin attempt back.
    return this.db.txDecision(() => {
      const current = this.db.get<{
        pinned_run_scoped_commands_digest: string | null;
        pinned_run_scoped_commands_json: string | null;
      }>(
        `SELECT pinned_run_scoped_commands_digest, pinned_run_scoped_commands_json
           FROM runs WHERE run_id = ?`,
        [runId],
      );
      if (!current) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });

      if (
        current.pinned_run_scoped_commands_digest === null &&
        current.pinned_run_scoped_commands_json === null
      ) {
        this.db.run(
          `UPDATE runs
              SET pinned_run_scoped_commands_digest = ?, pinned_run_scoped_commands_json = ?
            WHERE run_id = ?
              AND pinned_run_scoped_commands_digest IS NULL
              AND pinned_run_scoped_commands_json IS NULL`,
          [proposedDigest, canonicalJson(proposed), runId],
        );
      }

      const pinned = this.db.get<{
        pinned_run_scoped_commands_digest: string | null;
        pinned_run_scoped_commands_json: string | null;
      }>(
        `SELECT pinned_run_scoped_commands_digest, pinned_run_scoped_commands_json
           FROM runs WHERE run_id = ?`,
        [runId],
      );
      if (
        !pinned ||
        pinned.pinned_run_scoped_commands_digest === null ||
        pinned.pinned_run_scoped_commands_json === null
      ) {
        // #448: this guarded write just ran (or found a pin already there) and the row still
        // shows nothing durable. There is no persisted contract here to compare the candidate
        // against — absent, not disagreeing.
        return deny(ReasonCode.CONTRACT_UNVERIFIED, "run-scoped verification contract was not durably pinned", {
          runId,
        });
      }

      let persisted: readonly VerificationCommand[];
      try {
        const decoded: unknown = JSON.parse(pinned.pinned_run_scoped_commands_json);
        const parsedPersisted = verificationCommandSchema.array().safeParse(decoded);
        if (!parsedPersisted.success) {
          // #448: malformed, same as an absent pin — nothing valid was produced to compare.
          return deny(ReasonCode.CONTRACT_UNVERIFIED, "stored run-scoped verification contract is malformed", {
            runId,
          });
        }
        persisted = parsedPersisted.data;
      } catch {
        return deny(ReasonCode.CONTRACT_UNVERIFIED, "stored run-scoped verification contract is malformed", {
          runId,
        });
      }

      const persistedDigest = digestOf(persisted);
      if (persistedDigest !== pinned.pinned_run_scoped_commands_digest) {
        // #448: this is the persisted record failing its own self-check — its content does not
        // hash to the digest it was stored under — not the candidate's commands disagreeing
        // with anything. The candidate-vs-pin comparison is the one below, once a trustworthy
        // pin is actually in hand.
        return deny(ReasonCode.CONTRACT_UNVERIFIED, "stored run-scoped verification contract digest is invalid", {
          runId,
          stored: pinned.pinned_run_scoped_commands_digest,
          calculated: persistedDigest,
        });
      }
      if (proposedDigest !== persistedDigest) {
        return deny(
          ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT,
          "supplied run-scoped verification commands do not match the run's pinned contract",
          {
            runId,
            pinnedDigest: persistedDigest,
            suppliedDigest: proposedDigest,
            expected: persisted.map((command) => command.id),
            supplied: proposed.map((command) => command.id),
          },
        );
      }
      return allow(ReasonCode.OK, persisted);
    });
  }

  /**
   * S6-C — a disposable worktree of one of `run`'s repositories at `head`, for a control-plane step that
   * runs no candidate command: integrating a multi-task candidate at freeze. Its lifecycle is a command
   * worktree's exactly: the run's worktree claim, every add, remove, cleanup and prune authorised by the
   * guard, and a `verification_worktrees` row (its `command_id` the purpose, its digest the inputs), so
   * the guard's prune and the doctor's orphan sweep know it. Torn down before this answers, whatever
   * `use` answered; a teardown that did not complete leaves its row DESTROYING for the doctor. A claim
   * this took for it is released once the worktree is gone: a worker turn reads the run's held claims
   * as its own, and must not find this one there.
   */
  async withRunWorktree<T>(
    run: RunRow,
    input: { purpose: string; inputDigest: string; repositoryIdentity: string; head: string },
    use: (worktreePath: string) => Promise<Decision<T>>,
  ): Promise<Decision<T>> {
    const record = this.repositories.byIdentity(input.repositoryIdentity);
    if (!record) {
      return deny(ReasonCode.EVIDENCE_MISSING, "the repository has no local binding", { repositoryIdentity: input.repositoryIdentity });
    }
    const heldBefore = new Set(this.claims.heldByRun(run.runId).map((held) => held.claimId));
    const claim = this.ensureVerificationClaim(run, input.repositoryIdentity);
    if (!claim.allowed) return claim as Decision<T>;
    const taken = this.claims.heldByRun(run.runId).filter((held) => !heldBefore.has(held.claimId)).map((held) => held.claimId);
    let tornDown = true;
    const worktreeId = `${input.purpose}-${run.runId}-${input.head.slice(0, 8)}-${randomUUID().replaceAll("-", "")}`;
    const path = this.worktrees.pathFor(worktreeId);
    const authorization = this.worktreeAuthorization(run, input.repositoryIdentity, record.checkoutPath, path, null);
    this.recordVerificationWorktree({
      worktreeId,
      runId: run.runId,
      commandId: input.purpose,
      candidateSnapshotDigest: input.inputDigest,
      repositoryIdentity: input.repositoryIdentity,
      repositoryCheckoutPath: record.checkoutPath,
      worktreePath: path,
      head: input.head,
      ownerSessionId: run.ownerSessionId,
      ownerBindingGeneration: run.ownerBindingGeneration,
      ownerRoleKey: run.ownerRoleKey,
    });
    let worktree: Awaited<ReturnType<WorktreeManager["create"]>> | null = null;
    let outcome: Decision<T> = deny(ReasonCode.INTERNAL_ERROR, "the worktree step did not run", { worktreeId });
    try {
      worktree = await this.worktrees.create(record.checkoutPath, input.head, worktreeId, authorization);
      this.updateVerificationWorktree(worktreeId, "ACTIVE", "active_at");
      outcome = await use(worktree.path);
    } catch (error) {
      if (!isAcpError(error)) throw error;
      outcome = deny(error.reasonCode, error.message, error.evidence);
    } finally {
      if (worktree) {
        this.updateVerificationWorktree(worktreeId, "DESTROYING");
        try {
          await this.worktrees.destroy(record.checkoutPath, worktree.path, authorization);
          this.updateVerificationWorktree(worktreeId, "DESTROYED", "ended_at");
        } catch (error) {
          tornDown = false;
          if (!isAcpError(error)) throw error;
          // DESTROYING stays durable, as for a command's worktree: the doctor re-evaluates it.
          outcome = deny(error.reasonCode, `the disposable worktree was not torn down: ${error.message}`, { ...error.evidence, worktreeId });
        }
      } else {
        this.updateVerificationWorktree(worktreeId, "FAILED", "ended_at");
      }
    }
    // A worktree left behind keeps the claim its prune needs; it expires on its own.
    if (tornDown) for (const claimId of taken) this.claims.release(claimId, run.runId);
    return outcome;
  }

  /**
   * S6 review — a guarded write of refs under one private namespace of `run`'s repository (never a
   * branch, never HEAD), for keeping an integrated candidate from git gc. The guard fences a ref
   * write by a live claim of the run on that ref, so the run claims the namespace as its branch
   * first (the run owner's claim, as a verification worktree's is), then `apply` runs inside one
   * GIT_BRANCH grant naming it, and the claim this took is released at once: a worker turn reads
   * the run's held claims as its own, and a branch claim it did not make would refuse its turn.
   */
  async writeRunRefs(
    run: RunRow,
    input: { repositoryIdentity: string; namespace: string },
    apply: (checkoutPath: string) => Promise<Decision<void>>,
  ): Promise<Decision<void>> {
    const record = this.repositories.byIdentity(input.repositoryIdentity);
    if (!record) {
      return deny(ReasonCode.EVIDENCE_MISSING, "the repository has no local binding", { repositoryIdentity: input.repositoryIdentity });
    }
    if (!run.ownerSessionId || run.ownerBindingGeneration == null || !run.ownerRoleKey) {
      return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "a run ref write requires a pinned run owner", { runId: run.runId });
    }
    const held = this.claims.heldByRun(run.runId).some(
      (claim) => claim.repositoryIdentity === input.repositoryIdentity && claim.branch === input.namespace,
    );
    const taken: string[] = [];
    if (!held) {
      const acquired = this.claims.acquire({
        runId: run.runId,
        ownerSessionId: run.ownerSessionId,
        ownerBindingGeneration: run.ownerBindingGeneration,
        ownerRoleKey: run.ownerRoleKey,
        repositoryIdentity: input.repositoryIdentity,
        branch: input.namespace,
      });
      if (!acquired.allowed) return acquired as Decision<void>;
      taken.push(...acquired.value.map((claim) => claim.claimId));
    }
    const effect: { outcome: Decision<void> } = {
      outcome: deny(ReasonCode.INTERNAL_ERROR, "the run ref effect did not run", { runId: run.runId }),
    };
    let authorised: Decision<void>;
    try {
      authorised = await this.guard.authorize(
        {
          operation: WriteOperation.GIT_BRANCH,
          targetPath: record.checkoutPath,
          repositoryIdentity: input.repositoryIdentity,
          targetBranch: input.namespace,
          runId: run.runId,
          sessionId: run.ownerSessionId,
          bindingGeneration: run.ownerBindingGeneration,
          claimedClassification: "MANAGED",
          actor: "candidate-integration",
        },
        async () => {
          effect.outcome = await apply(record.checkoutPath);
        },
      );
    } finally {
      for (const claimId of taken) this.claims.release(claimId, run.runId);
    }
    if (!authorised.allowed) return authorised;
    return effect.outcome;
  }

  private async runLocal(
    run: RunRow,
    snapshotDigest: string,
    command: VerificationCommand,
    identity: string,
    checkoutPath: string,
    head: string,
    frozenTree: string,
    sourceBranch: string | null,
    gateEntries: readonly GateEntry[],
    /** Where the source checkout must stand for a self-contained copy (`expectedCheckoutHead`). */
    sourceHead: string,
  ): Promise<Decision<VerificationResultRecord>> {
    const runId = run.runId;
    const worktreeId = `verify-${runId}-${command.id}-${head.slice(0, 8)}-${randomUUID().replaceAll("-", "")}`;
    const path = this.worktrees.pathFor(worktreeId);
    const authorization = this.worktreeAuthorization(
      run,
      identity,
      checkoutPath,
      path,
      sourceBranch,
    );
    this.recordVerificationWorktree({
      worktreeId,
      runId,
      commandId: command.id,
      candidateSnapshotDigest: snapshotDigest,
      repositoryIdentity: identity,
      repositoryCheckoutPath: checkoutPath,
      worktreePath: path,
      head,
      ownerSessionId: run.ownerSessionId,
      ownerBindingGeneration: run.ownerBindingGeneration,
      ownerRoleKey: run.ownerRoleKey,
    });

    let worktree: Awaited<ReturnType<WorktreeManager["create"]>> | null = null;
    let outcome: Awaited<ReturnType<typeof runSandboxed>> | null = null;
    let gateRefusal: Decision<never> | null = null;
    try {
      worktree = await this.worktrees.create(checkoutPath, head, worktreeId, authorization, {
        // #246 C2v: a command that is one of Repo Factory's fixed git invocations runs git in the
        // checkout, and a linked worktree's git metadata lives in the original checkout, which the
        // sandbox denies below. Only those commands get a checkout with its own metadata; every
        // other command keeps the linked worktree it had.
        selfContained: verificationKindRunning(command.argv) !== null,
        // The tree the snapshot froze, which the self-contained copy must hold (RF-REVIEW-03).
        frozenTree,
        sourceHead,
      });
      this.updateVerificationWorktree(worktreeId, "ACTIVE", "active_at");
      // RF-S22 (#1082 R1-01) — the bytes this command is about to execute, read in its own
      // worktree after preparation and immediately before it runs. Every command gets a fresh
      // worktree, so nothing an earlier command ran can stand between this read and this run
      // except a writer that reaches this worktree from outside its own confinement. Such a
      // writer -- on a host without write confinement, or anything outside the sandbox -- can
      // still change the file between this read and the exec: the window is narrowed, not closed.
      for (const entry of gateEntries) {
        gateRefusal = gateEntryRefusal(
          materializedGateEntryAt(worktree.path, entry.path),
          entry,
          { runId, commandId: command.id, identity, candidateHead: head, checkedIn: "VERIFICATION_WORKTREE" },
          "in the materialised verification worktree",
        );
        if (gateRefusal) break;
      }
      if (gateRefusal) return gateRefusal;
      const worktreeRoot = realpathSync(worktree.path);
      outcome = await runSandboxed({
        // RF-S22 (#1082 R1-02, round 5) -- a command that runs a gate entry runs under ACP's loader,
        // which lets it load only its declared gate files, by the relative paths that name them,
        // and node builtins. The manifest admitted no option before the entry, so ACP's is the only
        // one. See gate-resolution-hook.ts.
        command: gateEntries.length === 0 ? command : {
          ...command,
          argv: [
            command.argv[0]!,
            gateResolutionPreload(gateEntries.map((entry) => join(worktreeRoot, ...entry.path.split("/")))),
            ...command.argv.slice(1),
          ],
        },
        worktreePath: worktree.path,
        // §33.3 — the control plane's own secret store and state must be unreadable to a
        // candidate, as must every other checkout on this machine.
        denyReadPaths: this.denyReadPaths(checkoutPath),
        // A gate command cannot spawn at all (RLIMIT_NPROC 1): the loader above binds what it
        // loads in-process only, and a spawned process would run outside it. Every other declared
        // command -- `npm test`, a test runner -- needs children, and runs under the supervisor's
        // polled process budget instead. See `ProcessLimitMode` in sandbox.ts. The choice follows
        // `gateEntries`, this command's obligations under the run's pinned manifest, which the
        // candidate cannot change; neither the command nor its environment carries a mode.
        processLimit: gateEntries.length > 0 ? "no-spawn" : "supervised-budget",
      });
    } finally {
      if (worktree) {
        this.updateVerificationWorktree(worktreeId, "DESTROYING");
        try {
          await this.worktrees.destroy(checkoutPath, worktree.path, authorization);
          this.updateVerificationWorktree(worktreeId, "DESTROYED", "ended_at");
        } catch (error) {
          // Keep DESTROYING durable: repair must see that teardown was interrupted and
          // re-evaluate ownership before touching the path.
          throw error;
        }
      } else {
        this.updateVerificationWorktree(worktreeId, "FAILED", "ended_at");
      }
    }
    if (!outcome) {
      throw new Error("verification sandbox did not produce an outcome");
    }
    const memoryFailure = memoryEvidenceReason(outcome.peakRssMb, command.maxMemoryMb);
    const passingMemoryFailure = outcome.status === "PASS" ? memoryFailure : null;

    const record: VerificationResultRecord = {
      commandId: command.id,
      repositoryIdentity: identity,
      source: "local",
      exactHead: head,
      startedAt: outcome.startedAt,
      endedAt: outcome.endedAt,
      exitCode: outcome.exitCode,
      outputDigest: outcome.outputDigest,
      outputTruncated: outcome.outputTruncated,
      // Truncated output or unmeasured/over-cap memory is not usable passing evidence.
      status:
        outcome.status === "PASS" && (outcome.outputTruncated || passingMemoryFailure !== null)
          ? "ERROR"
          : outcome.status,
      reasonCode: passingMemoryFailure ?? outcome.reasonCode,
      peakRssMb: outcome.peakRssMb,
      enforcement: outcome.enforcement,
      output: verificationOutputExcerpt(
        { candidateSnapshotDigest: snapshotDigest, contractDigest: run.contractDigest, commandId: command.id,
          repositoryIdentity: identity, exactHead: head },
        outcome.stdout,
        outcome.stderr,
        outcome.outputTruncated,
      ),
    };
    this.writeResultRow(runId, snapshotDigest, record);
    return allow(ReasonCode.OK, record);
  }

  /**
   * Integration §14.4 — a CI result counts only at the exact candidate head, from an
   * approved workflow digest, created by a trusted identity, with a non-vacuous job.
   */
  private async collectCi(
    runId: string,
    snapshotDigest: string,
    command: VerificationCommand,
    identity: string,
    head: string,
  ): Promise<VerificationResultRecord> {
    const now = this.clock.nowIso();
    const base: VerificationResultRecord = {
      commandId: command.id,
      repositoryIdentity: identity,
      source: "ci",
      exactHead: head,
      startedAt: now,
      endedAt: now,
      exitCode: null,
      outputDigest: digestOf({ commandId: command.id, head }),
      outputTruncated: false,
      status: "ERROR",
      reasonCode: ReasonCode.EVIDENCE_MISSING,
    };

    if (!this.#ci) {
      const record = { ...base, reasonCode: ReasonCode.EVIDENCE_MISSING };
      this.writeResultRow(runId, snapshotDigest, record);
      return record;
    }

    const [checks, approved, creators] = await Promise.all([
      this.#ci.fetch(identity, head),
      this.#ci.approvedWorkflowDigests(identity),
      this.#ci.trustedCreators(),
    ]);

    // Filter to this command and this repository, but *not* by head: a result for another
    // head must be reported as a head mismatch rather than as missing evidence.
    const candidates = checks.filter(
      (c) => c.commandId === command.id && c.repositoryIdentity === identity,
    );
    const exactHead = candidates.filter((candidate) => candidate.head === head);
    // Integration §14.4 — the *current exact-head* result. An obsolete red result must
    // not hide a later green result, and a result from another head is only diagnostic
    // when there is no exact candidate evidence at all.
    const ordered = [...exactHead].sort(
      (a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime(),
    );
    const match = ordered[0];
    if (!match) {
      const record = {
        ...base,
        reasonCode:
          candidates.length > 0 ? ReasonCode.VERIFICATION_CI_HEAD_MISMATCH : ReasonCode.EVIDENCE_MISSING,
      };
      this.writeResultRow(runId, snapshotDigest, record);
      return record;
    }
    if (!approved.includes(match.workflowDigest)) {
      const record = { ...base, reasonCode: ReasonCode.VERIFICATION_CI_WORKFLOW_DIGEST_MISMATCH };
      this.writeResultRow(runId, snapshotDigest, record);
      return record;
    }
    if (!creators.includes(match.creatorIdentity) || !match.nonVacuous) {
      const record = { ...base, reasonCode: ReasonCode.GATE_CREATOR_UNTRUSTED };
      this.writeResultRow(runId, snapshotDigest, record);
      return record;
    }

    const record: VerificationResultRecord = {
      ...base,
      startedAt: match.completedAt,
      endedAt: match.completedAt,
      status: match.conclusion === "success" ? "PASS" : "FAIL",
      reasonCode: match.conclusion === "success" ? null : ciNonSuccessReason(match.conclusion),
      outputDigest: digestOf(match),
    };
    this.writeResultRow(runId, snapshotDigest, record);
    return record;
  }

  private ensureVerificationClaim(
    run: RunRow,
    repositoryIdentity: string,
  ): Decision<void> {
    const existing = this.claims.heldByRun(run.runId).some(
      (claim) => claim.repositoryIdentity === repositoryIdentity,
    );
    if (existing) return allow(ReasonCode.OK, undefined);
    if (!run.ownerSessionId || run.ownerBindingGeneration == null || !run.ownerRoleKey) {
      return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "verification worktree requires a pinned run owner", {
        runId: run.runId,
        repositoryIdentity,
      });
    }
    const acquired = this.claims.acquire({
      runId: run.runId,
      ownerSessionId: run.ownerSessionId,
      ownerBindingGeneration: run.ownerBindingGeneration,
      ownerRoleKey: run.ownerRoleKey,
      repositoryIdentity,
      branch: null,
      // ClaimRegistry stores repository-relative paths as non-empty components; this
      // run-specific coordination path is only the worktree-lifecycle lease, not an
      // assertion about candidate files or the branch a later GitHub write will target.
      declaredPaths: [`__verification_worktree__/${run.runId}`],
    });
    if (!acquired.allowed) return acquired as Decision<void>;
    return allow(ReasonCode.OK, undefined);
  }

  private worktreeAuthorization(
    run: RunRow,
    repositoryIdentity: string,
    checkoutPath: string,
    path: string,
    sourceBranch: string | null,
  ): WorktreeAuthorization {
    const common = {
      guard: this.guard,
      request: {
        operation: WriteOperation.GIT_WORKTREE,
        repositoryIdentity,
        // This is the disposable tree being created, not the registered source checkout.
        // Repository identity supplies the claim scope; using the checkout here would make
        // every concurrent verification of the same repository collide by construction.
        targetWorktreeId: path,
        targetBranch: sourceBranch,
        runId: run.runId,
        sessionId: run.ownerSessionId,
        bindingGeneration: run.ownerBindingGeneration,
        claimedClassification: "MANAGED" as const,
        actor: "verification-engine",
      },
    };
    return {
      add: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.ADD } },
      remove: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.REMOVE } },
      cleanup: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.CLEANUP } },
      prune: { ...common, request: { ...common.request, targetPath: checkoutPath, worktreeAction: WorktreeAction.PRUNE } },
    };
  }

  private recordVerificationWorktree(input: {
    worktreeId: string;
    runId: string;
    commandId: string;
    candidateSnapshotDigest: string;
    repositoryIdentity: string;
    repositoryCheckoutPath: string;
    worktreePath: string;
    head: string;
    ownerSessionId: string | null;
    ownerBindingGeneration: number | null;
    ownerRoleKey: string | null;
  }): void {
    if (!input.ownerSessionId || input.ownerBindingGeneration == null || !input.ownerRoleKey) {
      throw new Error("verification worktree requires a pinned run owner");
    }
    this.db.run(
      `INSERT INTO verification_worktrees
         (worktree_id, run_id, command_id, candidate_snapshot_digest, repository_identity,
          repository_checkout_path, worktree_path, head, owner_session_id,
          owner_binding_generation, owner_role_key, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATING', ?)`,
      [
        input.worktreeId,
        input.runId,
        input.commandId,
        input.candidateSnapshotDigest,
        input.repositoryIdentity,
        input.repositoryCheckoutPath,
        input.worktreePath,
        input.head,
        input.ownerSessionId,
        input.ownerBindingGeneration,
        input.ownerRoleKey,
        this.clock.nowIso(),
      ],
    );
  }

  private updateVerificationWorktree(
    worktreeId: string,
    state: "ACTIVE" | "DESTROYING" | "DESTROYED" | "FAILED",
    timestampColumn?: "active_at" | "ended_at",
  ): void {
    if (timestampColumn) {
      this.db.run(
        `UPDATE verification_worktrees SET state = ?, ${timestampColumn} = ? WHERE worktree_id = ?`,
        [state, this.clock.nowIso(), worktreeId],
      );
      return;
    }
    this.db.run(`UPDATE verification_worktrees SET state = ? WHERE worktree_id = ?`, [state, worktreeId]);
  }

  private buildReport(
    options: VerifyOptions,
    snapshotDigest: string,
    results: VerificationResultRecord[],
    gaps: string[],
  ): VerificationReport {
    // §17.7 — count what evidence *should* exist, not what happened to arrive.
    const expectedInputs = options.commands
      .filter((c) => c.required)
      .reduce((n, c) => n + (c.evidenceMode === "BOTH_REQUIRED" ? 2 : 1), 0);
    const requiredIds = new Set(options.commands.filter((c) => c.required).map((c) => c.id));
    const observedInputs = results.filter((r) => requiredIds.has(r.commandId)).length;
    const commandsById = new Map(options.commands.map((command) => [command.id, command]));
    const localMemoryFailure = (record: VerificationResultRecord): ReasonCode | null => {
      if (record.source !== "local") return null;
      const command = commandsById.get(record.commandId);
      return command ? memoryEvidenceReason(record.peakRssMb, command.maxMemoryMb) : null;
    };

    // This is a second fail-closed gate over the sandbox result. A future sandbox regression
    // must not turn a missing RSS observation into authoritative PASS evidence.
    const failed = results.filter(
      (record) =>
        requiredIds.has(record.commandId) &&
        (record.status !== "PASS" || localMemoryFailure(record) !== null),
    );
    const incomplete = gaps.length > 0 || observedInputs !== expectedInputs;

    const status: VerificationReport["status"] = incomplete
      ? "INCOMPLETE"
      : failed.length > 0
        ? "FAIL"
        : "PASS";

    const reasonCode = incomplete
      ? gaps.length > 0
        ? ReasonCode.VERIFICATION_GAP
        : ReasonCode.VERIFICATION_INCOMPLETE
      : failed.length > 0
        ? (failed[0]!.reasonCode ?? localMemoryFailure(failed[0]!) ?? ReasonCode.VERIFICATION_COMMAND_FAILED)
        : ReasonCode.OK;

    return {
      runId: options.runId,
      candidateSnapshotDigest: snapshotDigest,
      contractDigest: options.contractDigest,
      expectedInputs,
      observedInputs,
      results,
      status,
      reasonCode,
      gaps,
    };
  }

  private persist(runId: string, snapshotDigest: string, report: VerificationReport): void {
    this.artifacts.putEvidence(
      this.evidenceWriter,
      runId,
      ArtifactKind.VERIFICATION,
      report,
      snapshotDigest,
    );
    this.audit.record({
      kind: "VERIFICATION_COMPLETED",
      runId,
      reasonCode: report.reasonCode as ReasonCode,
      evidence: {
        candidateSnapshotDigest: snapshotDigest,
        status: report.status,
        expectedInputs: report.expectedInputs,
        observedInputs: report.observedInputs,
        gaps: report.gaps,
        results: report.results.map((r) => ({
          commandId: r.commandId,
          source: r.source,
          status: r.status,
          exactHead: r.exactHead,
        })),
      },
    });
  }

  private writeResultRow(
    runId: string,
    snapshotDigest: string,
    record: VerificationResultRecord,
  ): void {
    this.db.run(
      `INSERT OR REPLACE INTO verification_results
         (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source,
          exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `${snapshotDigest}:${record.commandId}:${record.repositoryIdentity}:${record.source}`,
        runId, snapshotDigest, record.commandId, record.repositoryIdentity, record.source,
        record.exactHead, record.startedAt, record.endedAt, record.exitCode, record.outputDigest,
        record.outputTruncated ? 1 : 0, record.status, record.reasonCode,
      ],
    );
  }

  /**
   * Absolute paths a candidate command must not read (§33.3). #1227 — a resident's clone too: once its
   * repository is registered at the worker checkout no registry row names the clone, and it is still
   * the resident's own tree.
   */
  private denyReadPaths(ownCheckout: string): string[] {
    const others = this.repositories
      .list()
      .map((r) => r.checkoutPath)
      .filter(Boolean);
    return [...new Set([ownCheckout, ...others, ...residentClonePaths(this.db), ...this.extraDenyReadPaths])];
  }

  /** Wired by the composition root: the secret store and state directory. */
  setDenyReadPaths(paths: readonly string[]): void {
    this.extraDenyReadPaths = [...paths];
  }

  latestReport(runId: string, snapshotDigest: string): VerificationReport | null {
    return (
      this.artifacts.latestForSnapshot<VerificationReport>(
        runId,
        ArtifactKind.VERIFICATION,
        snapshotDigest,
      )?.content ?? null
    );
  }
}

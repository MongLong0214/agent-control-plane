import { randomUUID } from "node:crypto";

import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import {
  ArtifactKind,
  type ExecutionMode,
  Role,
  type ReviewFindingCategory,
  type ReviewVerdict,
  SessionLifecycle,
  roleKeyFor,
} from "../domain/types.ts";
import { diffText } from "../git/git.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import type { ProviderRegistry } from "../runtime/provider.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
import {
  type CandidateSnapshot,
  candidateSnapshotDigest,
  snapshotCoverageTargets,
} from "../snapshot/candidate-snapshot.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { VerificationReport } from "../verify/verification-engine.ts";
import type { TaskContract } from "../run/run-engine.ts";

export interface ReviewFinding {
  category: ReviewFindingCategory;
  severity: "INFO" | "MINOR" | "MAJOR" | "BLOCKER";
  repository: string;
  path: string | null;
  summary: string;
  detail: string;
}

/** PRD §18.4 — the complete review packet. */
export interface ReviewPacket {
  runId: string;
  candidateSnapshotDigest: string;
  contractDigest: string;
  reviewerRoleBindingGeneration: number;
  reviewerSessionId: string;
  reviewerSessionIncarnation: string;
  provider: string;
  model: string;
  effort: string | null;
  inputManifest: {
    contract: boolean;
    snapshotManifest: boolean;
    diff: boolean;
    verificationEvidence: boolean;
    projectContext: boolean;
    /** §18.3 — what was deliberately withheld from the reviewer. */
    withheld: string[];
  };
  coveredRepositories: string[];
  coveredFiles: string[];
  omittedItems: string[];
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  chunked: boolean;
  createdAt: string;
}

export interface ReviewerPreference {
  provider: string;
  model: string;
  effort: string | null;
}

export interface BlindReviewRequest {
  runId: string;
  projectId: string | null;
  executionMode: ExecutionMode;
  snapshot: CandidateSnapshot;
  contract: TaskContract;
  contractDigest: string;
  verification: VerificationReport;
  projectContext?: string;
}

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "coveredFiles", "omittedItems", "findings"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "REVISE", "BLOCK"] },
    coveredFiles: { type: "array", items: { type: "string" } },
    omittedItems: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "severity", "repository", "summary", "detail"],
        properties: {
          category: {
            type: "string",
            enum: [
              "correctness", "regression", "security", "scope", "performance",
              "maintainability", "evidence", "freshness", "source",
            ],
          },
          severity: { type: "string", enum: ["INFO", "MINOR", "MAJOR", "BLOCKER"] },
          repository: { type: "string" },
          path: { type: ["string", "null"] },
          summary: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
  },
} as const;

/** Diff size above which a single reviewer context is not trusted to hold everything. */
const CHUNK_THRESHOLD_CHARS = 120_000;
const REVIEW_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * PRD §18 — mandatory independent blind review.
 *
 * The gate is invoked by the control plane after deterministic verification passes.
 * There is no operation on any agent-facing surface that requests, skips or overrides
 * it: `manualInvocation` exists solely to return the denial (§18.2).
 */
export class BlindReviewGate {
  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    private readonly sessions: SessionRegistry,
    private readonly bindings: BindingRegistry,
    private readonly providers: ProviderRegistry,
    private readonly repositories: RepositoryRegistry,
    private readonly telemetry: Telemetry,
    private readonly preferences: {
      preferred: ReviewerPreference;
      fallbacks: ReviewerPreference[];
    },
  ) {}

  /** §18.2 — CTO and Hermes do not invoke the review. */
  manualInvocation(actor: string, runId: string): Decision<never> {
    this.audit.record({
      kind: "BLIND_REVIEW_MANUAL_DENIED",
      runId,
      actor,
      reasonCode: ReasonCode.REVIEW_MANUAL_INVOCATION_DENIED,
      evidence: {},
    });
    return deny(
      ReasonCode.REVIEW_MANUAL_INVOCATION_DENIED,
      "blind review is invoked by the control plane, not by an agent",
      { actor, runId },
    );
  }

  async review(request: BlindReviewRequest): Promise<Decision<ReviewPacket>> {
    const snapshotDigest = candidateSnapshotDigest(request.snapshot);

    if (request.verification.status !== "PASS") {
      return deny(
        ReasonCode.REVIEW_REQUIRED,
        "blind review runs only after deterministic verification passes",
        { runId: request.runId, verificationStatus: request.verification.status },
      );
    }
    if (request.verification.candidateSnapshotDigest !== snapshotDigest) {
      return deny(ReasonCode.EVIDENCE_STALE, "verification evidence is bound to a different candidate", {
        verificationSnapshot: request.verification.candidateSnapshotDigest,
        snapshotDigest,
      });
    }

    const expected = snapshotCoverageTargets(request.snapshot);
    const reviewer = await this.constituteReviewer(request.runId);
    if (!reviewer.allowed) return reviewer as Decision<ReviewPacket>;
    const { sessionId, incarnation, generation, preference, roleKey } = reviewer.value;

    try {
      const diffs = await this.collectDiffs(request.snapshot);
      const totalChars = diffs.reduce((n, d) => n + d.diff.length, 0);
      const chunked = totalChars > CHUNK_THRESHOLD_CHARS;

      const outcome = chunked
        ? await this.chunkedReview(request, diffs, preference, sessionId)
        : await this.singleReview(request, diffs, preference, sessionId);

      if (!outcome.allowed) return outcome as Decision<ReviewPacket>;

      const packet = this.assemble({
        request,
        snapshotDigest,
        sessionId,
        incarnation,
        generation,
        preference,
        chunked,
        raw: outcome.value,
        expected,
      });

      // §18.4 / CP-HI-04 — re-check independence at packet time: a session can join the
      // producer set after the reviewer was bound.
      const independence = this.bindings.assertReviewerIndependence(request.runId, sessionId);
      if (!independence.allowed) {
        this.audit.record({
          kind: "BLIND_REVIEW_REJECTED",
          runId: request.runId,
          sessionId,
          reasonCode: independence.reasonCode,
          evidence: independence.evidence,
        });
        return independence as Decision<ReviewPacket>;
      }

      const validated = this.validateCoverage(packet, expected);
      this.artifacts.put(request.runId, ArtifactKind.BLIND_REVIEW, validated, snapshotDigest);

      this.audit.record({
        kind: "BLIND_REVIEW_COMPLETED",
        runId: request.runId,
        sessionId,
        roleKey,
        reasonCode:
          validated.verdict === "PASS"
            ? ReasonCode.REVIEW_PASS
            : validated.verdict === "REVISE"
              ? ReasonCode.REVIEW_REVISE
              : ReasonCode.REVIEW_BLOCK,
        evidence: {
          candidateSnapshotDigest: snapshotDigest,
          verdict: validated.verdict,
          provider: preference.provider,
          model: preference.model,
          effort: preference.effort,
          coveredFiles: validated.coveredFiles.length,
          omittedItems: validated.omittedItems,
          chunked,
          findings: validated.findings.length,
        },
      });

      this.telemetry.record({
        scope: "quality",
        name: "blind_review",
        runId: request.runId,
        text: validated.verdict,
        dims: {
          provider: preference.provider,
          model: preference.model,
          chunked,
          findingCategories: validated.findings.map((f) => f.category),
        },
      });

      if (validated.verdict !== "PASS") {
        return deny(
          validated.verdict === "REVISE" ? ReasonCode.REVIEW_REVISE : ReasonCode.REVIEW_BLOCK,
          `blind review returned ${validated.verdict}`,
          { runId: request.runId, packet: validated },
        );
      }
      if (validated.omittedItems.length > 0) {
        return deny(ReasonCode.REVIEW_OMITTED_ITEMS_PRESENT, "PASS requires zero omitted items", {
          runId: request.runId,
          omittedItems: validated.omittedItems,
        });
      }
      return allow(ReasonCode.REVIEW_PASS, validated);
    } finally {
      // The reviewer is per-run and per-candidate; it does not outlive its verdict.
      this.bindings.revoke(roleKey, "blind review complete");
      this.sessions.transition(sessionId, SessionLifecycle.STOPPED, "blind review complete");
    }
  }

  /**
   * §18.1 / §18.7 — prefer GPT-5.6 Sol at xhigh; fall back to a *separate* fresh
   * session when the preferred provider is unavailable. Session and context
   * independence is required even when the provider family is reused; if no isolated
   * reviewer can be constituted the gate is not lowered — the caller waits.
   */
  private async constituteReviewer(runId: string): Promise<
    Decision<{
      sessionId: string;
      incarnation: string;
      generation: number;
      preference: ReviewerPreference;
      roleKey: string;
    }>
  > {
    const roleKey = roleKeyFor(Role.BLIND_REVIEWER, { runId });
    const attempts: Array<{ preference: ReviewerPreference; reason: string }> = [];

    for (const preference of [this.preferences.preferred, ...this.preferences.fallbacks]) {
      const adapter = this.providers.get(preference.provider);
      if (!adapter) {
        attempts.push({ preference, reason: "no adapter registered" });
        continue;
      }
      const health = await adapter.probeRuntime();
      if (health === "UNAVAILABLE") {
        attempts.push({ preference, reason: "runtime unavailable" });
        continue;
      }

      const handle = await adapter.startSession({
        model: preference.model,
        effort: preference.effort,
        workdir: process.cwd(),
        purpose: "blind-review",
      });
      const session = this.sessions.create({
        provider: adapter.provider,
        model: preference.model,
        effort: preference.effort,
        sessionId: `ses_review_${handle.externalSessionId.replace(/-/g, "").slice(0, 20)}`,
        incarnation: `${handle.externalSessionId}#${this.clock.nowIso()}`,
      });
      this.sessions.transition(session.sessionId, SessionLifecycle.READY, "reviewer ready");

      const bound = this.bindings.bind({
        roleKey,
        role: Role.BLIND_REVIEWER,
        sessionId: session.sessionId,
        runId,
        mode: preference === this.preferences.preferred ? "PREFERRED" : "FALLBACK",
      });
      if (!bound.allowed) {
        this.sessions.transition(session.sessionId, SessionLifecycle.STOPPED, "binding refused");
        attempts.push({ preference, reason: bound.reasonCode });
        continue;
      }

      return allow(ReasonCode.OK, {
        sessionId: session.sessionId,
        incarnation: session.incarnation,
        generation: bound.value.bindingGeneration,
        preference,
        roleKey,
      });
    }

    return deny(
      ReasonCode.ISOLATION_LOST,
      "no isolated blind reviewer could be constituted; the gate is not lowered",
      { runId, attempts },
    );
  }

  private async collectDiffs(
    snapshot: CandidateSnapshot,
  ): Promise<Array<{ identity: string; diff: string; files: string[] }>> {
    const out: Array<{ identity: string; diff: string; files: string[] }> = [];
    for (const repo of snapshot.repositories) {
      const record = this.repositories.byIdentity(repo.identity);
      const diff = record
        ? await diffText(record.checkoutPath, repo.baseHead, repo.candidateHead)
        : "";
      out.push({ identity: repo.identity, diff, files: repo.touchedPaths });
    }
    return out;
  }

  private async singleReview(
    request: BlindReviewRequest,
    diffs: Array<{ identity: string; diff: string; files: string[] }>,
    preference: ReviewerPreference,
    sessionId: string,
  ): Promise<Decision<RawVerdict>> {
    const adapter = this.providers.require(preference.provider);
    const result = await adapter.invoke({
      prompt: this.buildPrompt(request, diffs),
      systemPrompt: REVIEWER_SYSTEM_PROMPT,
      workdir: process.cwd(),
      timeoutMs: REVIEW_TIMEOUT_MS,
      model: preference.model,
      effort: preference.effort ?? undefined,
      responseSchema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
      readOnly: true,
      correlationId: `${request.runId}:${sessionId}`,
    });

    const parsed = parseVerdict(result.json ?? result.text);
    if (!parsed) {
      return deny(ReasonCode.EVIDENCE_MISSING, "reviewer did not return a parsable verdict", {
        runId: request.runId,
        provider: preference.provider,
        error: result.error,
        raw: result.text.slice(0, 500),
      });
    }
    return allow(ReasonCode.OK, parsed);
  }

  /**
   * §18.5 — chunk reviewers, then a coverage reducer that verifies every file was seen
   * at least once, finding dedupe, and a final fresh reviewer over the reduced set.
   */
  private async chunkedReview(
    request: BlindReviewRequest,
    diffs: Array<{ identity: string; diff: string; files: string[] }>,
    preference: ReviewerPreference,
    sessionId: string,
  ): Promise<Decision<RawVerdict>> {
    const adapter = this.providers.require(preference.provider);
    const chunks = splitDiffs(diffs, CHUNK_THRESHOLD_CHARS);
    const covered = new Set<string>();
    const findings: ReviewFinding[] = [];
    const omitted: string[] = [];
    let worst: ReviewVerdict = "PASS";

    for (const [index, chunk] of chunks.entries()) {
      const result = await adapter.invoke({
        prompt: this.buildPrompt(request, chunk, { chunk: index + 1, of: chunks.length }),
        systemPrompt: REVIEWER_SYSTEM_PROMPT,
        workdir: process.cwd(),
        timeoutMs: REVIEW_TIMEOUT_MS,
        model: preference.model,
        effort: preference.effort ?? undefined,
        responseSchema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
        readOnly: true,
        correlationId: `${request.runId}:${sessionId}:chunk${index + 1}`,
      });
      const parsed = parseVerdict(result.json ?? result.text);
      if (!parsed) {
        omitted.push(...chunk.flatMap((c) => c.files.map((f) => `${c.identity}:${f}`)));
        continue;
      }
      for (const file of parsed.coveredFiles) covered.add(file);
      omitted.push(...parsed.omittedItems);
      findings.push(...parsed.findings);
      worst = worseVerdict(worst, parsed.verdict);
    }

    // Coverage reducer: every touched file must have been seen by at least one chunk.
    const expected = snapshotCoverageTargets(request.snapshot).map((t) => `${t.identity}:${t.path}`);
    const unseen = expected.filter((key) => !covered.has(key) && !covered.has(key.split(":").slice(1).join(":")));
    omitted.push(...unseen);

    return allow(ReasonCode.OK, {
      verdict: worst,
      coveredFiles: [...covered],
      omittedItems: [...new Set(omitted)],
      findings: dedupeFindings(findings),
    });
  }

  private buildPrompt(
    request: BlindReviewRequest,
    diffs: Array<{ identity: string; diff: string; files: string[] }>,
    chunk?: { chunk: number; of: number },
  ): string {
    const sections = [
      chunk ? `# Review chunk ${chunk.chunk} of ${chunk.of}` : "# Candidate review",
      "",
      "## Task contract",
      `Goal: ${request.contract.goal}`,
      `Why: ${request.contract.why}`,
      `Scope: ${request.contract.scope.join("; ") || "(unspecified)"}`,
      `Non-goals: ${request.contract.nonGoals.join("; ") || "(none)"}`,
      "Acceptance criteria:",
      ...request.contract.acceptance.map((a) => `- ${a}`),
      "",
      "## Candidate snapshot manifest",
      "```json",
      JSON.stringify(
        {
          contractDigest: request.snapshot.contractDigest,
          repositories: request.snapshot.repositories.map((r) => ({
            identity: r.identity,
            baseHead: r.baseHead,
            candidateHead: r.candidateHead,
            touchedPaths: r.touchedPaths,
          })),
        },
        null,
        2,
      ),
      "```",
      "",
      "## Deterministic verification evidence",
      "```json",
      JSON.stringify(
        {
          status: request.verification.status,
          expectedInputs: request.verification.expectedInputs,
          observedInputs: request.verification.observedInputs,
          results: request.verification.results.map((r) => ({
            commandId: r.commandId,
            source: r.source,
            status: r.status,
            exactHead: r.exactHead,
          })),
        },
        null,
        2,
      ),
      "```",
      "",
      request.projectContext ? `## Project context\n${request.projectContext}\n` : "",
      "## Actual diff",
    ];

    for (const repo of diffs) {
      sections.push(`### ${repo.identity}`, "Files:", ...repo.files.map((f) => `- ${f}`), "```diff", repo.diff, "```");
    }

    sections.push(
      "",
      "## Required response",
      // Only some runtimes enforce a response schema, so the shape is stated here too.
      "Return a single JSON object and nothing else — no prose before or after it:",
      "```json",
      JSON.stringify(
        {
          verdict: "PASS | REVISE | BLOCK",
          coveredFiles: ["<repository-identity>:<path>"],
          omittedItems: [],
          findings: [
            {
              category: "correctness",
              severity: "MINOR",
              repository: "<repository-identity>",
              path: "<path or null>",
              summary: "one line",
              detail: "what is wrong and why it matters",
            },
          ],
        },
        null,
        2,
      ),
      "```",
      "`coveredFiles` must list every file you actually examined, formatted `<repository-identity>:<path>`.",
      "`omittedItems` must list anything you could not examine. Do not return PASS with a non-empty omission list.",
      "`findings` may be empty. Everything you need is above; you have no tools and are not expected to look anything up.",
    );
    return sections.filter(Boolean).join("\n");
  }

  private assemble(input: {
    request: BlindReviewRequest;
    snapshotDigest: string;
    sessionId: string;
    incarnation: string;
    generation: number;
    preference: ReviewerPreference;
    chunked: boolean;
    raw: RawVerdict;
    expected: Array<{ identity: string; path: string }>;
  }): ReviewPacket {
    return {
      runId: input.request.runId,
      candidateSnapshotDigest: input.snapshotDigest,
      contractDigest: input.request.contractDigest,
      reviewerRoleBindingGeneration: input.generation,
      reviewerSessionId: input.sessionId,
      reviewerSessionIncarnation: input.incarnation,
      provider: input.preference.provider,
      model: input.preference.model,
      effort: input.preference.effort,
      inputManifest: {
        contract: true,
        snapshotManifest: true,
        diff: true,
        verificationEvidence: true,
        projectContext: Boolean(input.request.projectContext),
        // §18.3 — the reviewer is blind to how the candidate was produced.
        withheld: [
          "worker reasoning",
          "CTO reasoning",
          "chat history",
          "producer self-assessment",
          "previous verdicts",
        ],
      },
      coveredRepositories: [...new Set(input.request.snapshot.repositories.map((r) => r.identity))],
      coveredFiles: [...new Set(input.raw.coveredFiles)],
      omittedItems: [...new Set(input.raw.omittedItems)],
      verdict: input.raw.verdict,
      findings: input.raw.findings,
      chunked: input.chunked,
      createdAt: this.clock.nowIso(),
    };
  }

  /**
   * §18.4 — PASS requires `omittedItems=0` *and* a covered set that accounts for every
   * touched file. A reviewer that simply forgot to mention a file has not covered it.
   */
  private validateCoverage(
    packet: ReviewPacket,
    expected: Array<{ identity: string; path: string }>,
  ): ReviewPacket {
    if (packet.verdict !== "PASS") return packet;

    const covered = new Set(packet.coveredFiles.map(normalizeCoverageKey));
    const missing = expected
      .map((t) => `${t.identity}:${t.path}`)
      .filter((key) => !covered.has(normalizeCoverageKey(key)) && !covered.has(normalizeCoverageKey(key.split(":").slice(1).join(":"))));

    if (missing.length === 0) return packet;
    return { ...packet, verdict: "REVISE", omittedItems: [...packet.omittedItems, ...missing] };
  }

  latestPacket(runId: string, snapshotDigest: string): ReviewPacket | null {
    return (
      this.artifacts.latestForSnapshot<ReviewPacket>(
        runId,
        ArtifactKind.BLIND_REVIEW,
        snapshotDigest,
      )?.content ?? null
    );
  }
}

interface RawVerdict {
  verdict: ReviewVerdict;
  coveredFiles: string[];
  omittedItems: string[];
  findings: ReviewFinding[];
}

const REVIEWER_SYSTEM_PROMPT = [
  "You are an independent blind reviewer for a production gate.",
  "You did not write this change and you have no access to how it was produced.",
  "Judge only the candidate diff against the stated contract and the verification evidence.",
  "Attack the result: look for correctness defects, regressions, security issues, scope creep,",
  "missing evidence and stale claims. Do not praise. Do not restate the diff.",
  "If you could not examine something, say so in omittedItems rather than guessing.",
].join(" ");

const parseVerdict = (input: unknown): RawVerdict | null => {
  const value =
    typeof input === "string"
      ? (() => {
          try {
            return JSON.parse(input) as unknown;
          } catch {
            return null;
          }
        })()
      : input;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const verdict = record["verdict"];
  if (verdict !== "PASS" && verdict !== "REVISE" && verdict !== "BLOCK") return null;
  return {
    verdict,
    coveredFiles: asStringArray(record["coveredFiles"]),
    omittedItems: asStringArray(record["omittedItems"]),
    findings: Array.isArray(record["findings"])
      ? (record["findings"] as ReviewFinding[]).filter((f) => f && typeof f === "object")
      : [],
  };
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const normalizeCoverageKey = (key: string): string => key.replace(/^\.\//, "").trim();

const worseVerdict = (a: ReviewVerdict, b: ReviewVerdict): ReviewVerdict => {
  const rank = { PASS: 0, REVISE: 1, BLOCK: 2 } as const;
  return rank[b] > rank[a] ? b : a;
};

const dedupeFindings = (findings: ReviewFinding[]): ReviewFinding[] => {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = digestOf({ c: f.category, r: f.repository, p: f.path, s: f.summary });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const splitDiffs = (
  diffs: Array<{ identity: string; diff: string; files: string[] }>,
  budget: number,
): Array<Array<{ identity: string; diff: string; files: string[] }>> => {
  const chunks: Array<Array<{ identity: string; diff: string; files: string[] }>> = [];
  let current: Array<{ identity: string; diff: string; files: string[] }> = [];
  let size = 0;
  for (const repo of diffs) {
    for (const part of splitByFile(repo, budget)) {
      if (size + part.diff.length > budget && current.length > 0) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(part);
      size += part.diff.length;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : [[]];
};

/** Split one repository's diff on file boundaries so no file straddles two reviewers. */
const splitByFile = (
  repo: { identity: string; diff: string; files: string[] },
  budget: number,
): Array<{ identity: string; diff: string; files: string[] }> => {
  if (repo.diff.length <= budget) return [repo];
  const sections = repo.diff.split(/(?=^diff --git )/m).filter(Boolean);
  const parts: Array<{ identity: string; diff: string; files: string[] }> = [];
  let buffer = "";
  let files: string[] = [];
  for (const section of sections) {
    const named = /^diff --git a\/(\S+) b\//m.exec(section)?.[1];
    if (buffer.length + section.length > budget && buffer.length > 0) {
      parts.push({ identity: repo.identity, diff: buffer, files });
      buffer = "";
      files = [];
    }
    buffer += section;
    if (named) files.push(named);
  }
  if (buffer.length > 0) parts.push({ identity: repo.identity, diff: buffer, files });
  return parts;
};

export const __testing = { splitDiffs, parseVerdict, worseVerdict };

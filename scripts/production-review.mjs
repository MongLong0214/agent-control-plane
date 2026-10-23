#!/usr/bin/env node
/**
 * Independent production-readiness review by GPT-6.1 Sol.
 *
 * Splits the implementation into the areas the PRD gives distinct authority to, and asks
 * for structured findings per area. The reviewer reads the repository itself under a
 * read-only sandbox, so it sees the real code rather than an excerpt someone chose.
 *
 * What it reads, and where it writes (#1189, `scripts/lib/audit-run.mjs`): one pinned commit, in a
 * disposable detached checkout of that commit, never the live working tree. A dirty working tree
 * whose HEAD is the requested commit, or a ref that names no commit, is refused before any reviewer
 * starts. Every run writes a new directory holding `manifest.json` (run id, commit and tree,
 * selected areas, reviewer identity, per-area execution and artifacts) and a `summary.json` that
 * counts only the reports that manifest attributes. A reviewer that failed, timed out or was
 * interrupted has no verdict, and nothing an earlier run wrote can stand in for it.
 *
 * What it is not. A frontier PR review and this broad, one-off diagnostic serve different purposes:
 * frontier judges one change within its bounded attempts; this reads whole areas of one commit for
 * defects nobody asked about. It is not meant to run on every PR. Running it is not a way around
 * frontier's three-attempt limit and does not count as an additional approving review; its exit
 * status says whether the reviewers ran, its findings verdict says what they found, and neither is
 * a merge approval.
 *
 * Usage:
 *   node scripts/production-review.mjs                          # every area, at HEAD
 *   node scripts/production-review.mjs core guard               # named areas only
 *   node scripts/production-review.mjs --rev=<commit-ish>       # another recorded commit
 *   node scripts/production-review.mjs --out=evidence/review-round3   # must not exist yet
 *   node scripts/production-review.mjs --allow-dirty            # HEAD, recording that uncommitted work was not reviewed
 *   node scripts/production-review.mjs --area-timeout-ms=600000 # per-area bound (default 45 minutes)
 *
 * The default output directory is `evidence/local/audit-runs/production-review-<run id>/`. A named
 * one is refused if it exists: filed issues cite a round's evidence path, and
 * `scripts/ssot-report.mjs` reconciles the tracker against it, so a later run must not rewrite it.
 * Exit status: 0 every selected area returned a well-formed report, 1 at least one did not,
 * 2 refused before starting, 130 interrupted.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runAudit } from "./lib/audit-run.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// The model is pinned by owner directive; see the record on this file before changing it.
const MODEL = "gpt-6.1-sol";
const REASONING_EFFORT = "xhigh";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "filesExamined", "findings", "omittedItems"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "REVISE", "BLOCK"] },
    filesExamined: { type: "array", items: { type: "string" } },
    omittedItems: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        // Structured outputs require `required` to list every property, so `line` is
        // listed here and made nullable rather than optional.
        required: [
          "severity",
          "category",
          "file",
          "line",
          "summary",
          "detail",
          "suggestedFix",
        ],
        properties: {
          severity: { type: "string", enum: ["BLOCKER", "MAJOR", "MINOR", "INFO"] },
          category: {
            type: "string",
            enum: [
              "invariant-violation",
              "correctness",
              "security",
              "concurrency",
              "evidence",
              "scope",
              "maintainability",
              "performance",
              "prd-conformance",
            ],
          },
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          summary: { type: "string" },
          detail: { type: "string" },
          suggestedFix: { type: "string" },
        },
      },
    },
  },
};

const AREAS = {
  core: {
    title: "Trusted core: persistence, constraints, transactions, immutable evidence",
    files: [
      "src/db/schema.sql",
      "src/db/database.ts",
      "src/db/artifacts.ts",
      "src/db/audit.ts",
      "src/core/digest.ts",
      "src/core/errors.ts",
      "src/domain/run-state.ts",
    ],
    prd: "§29 state machine, §30 persistence model (esp. §30.2 constraints and §30.3 transaction sections), §30.4 exclusions, §31.5 redaction, §40 Reliability and Explainability",
  },
  guard: {
    title: "CP-HI-01 managed write guard",
    files: ["src/guard/managed-write-guard.ts", "src/guard/workspace-probe.ts"],
    prd: "§4 CP-HI-01, §6 DIRECT vs MANAGED, §23.2 claim rejects, §39 CP-S01–CP-S03 and CP-S14",
  },
  verify: {
    title: "Candidate snapshot, verification engine, sandbox isolation",
    files: [
      "src/snapshot/candidate-snapshot.ts",
      "src/verify/sandbox.ts",
      "src/verify/worktree.ts",
      "src/verify/verification-engine.ts",
      "src/contracts/verification-command.ts",
      "src/contracts/manifest.ts",
    ],
    prd: "§4 CP-HI-03 and CP-HI-06 and CP-HI-08, §16 candidate snapshot, §17 verification engine (esp. §17.4 sandbox, §17.5 unregistered repos, §17.7 completeness gate), §33.3 secret separation, Integration §12 and §14.4 and §15",
  },
  review: {
    title: "Mandatory independent blind review gate",
    files: ["src/review/blind-review.ts", "src/run/candidate-pipeline.ts"],
    prd: "§4 CP-HI-04, §18 in full (esp. §18.2 automatic invocation, §18.3 withheld inputs, §18.4 packet, §18.5 large change coverage reduction, §18.6 revision loop, §18.7 degraded assurance)",
  },
  binding: {
    title: "Sessions, role binding generations, message fencing, outbox",
    files: [
      "src/session/session-registry.ts",
      "src/session/binding-registry.ts",
      "src/outbox/outbox.ts",
      "src/outbox/envelope.ts",
      "src/domain/types.ts",
    ],
    prd: "§9.3 and §9.4, §11.1 owner pinning, §15.7 atomic failover and message fencing, §27.5 outbox, §30.2 constraints 1–6, §34.1 and §34.4",
  },
  continuity: {
    title: "Provider capacity and role continuity",
    files: [
      "src/capacity/capacity-monitor.ts",
      "src/continuity/continuity-kernel.ts",
      "src/runtime/provider.ts",
      "src/runtime/cli-adapters.ts",
      "src/runtime/scripted-adapter.ts",
    ],
    prd: "§14 in full (esp. §14.2 refresh triggers, §14.3 capacity model and no UNKNOWN routing, §14.5 dynamic reserve), §15.1–§15.8, §39 CP-S16–CP-S24",
  },
  github: {
    title: "Trusted GitHub kernel, gate provenance, merge idempotency",
    files: [
      "src/github/github-kernel.ts",
      "src/github/branch-contract.ts",
      "src/github/credential-store.ts",
    ],
    prd: "§4 CP-HI-05, §24 in full, §33.3, Integration §9 branch strategy and §14 CI trust and §16 idempotency",
  },
  runtime: {
    title: "Run engine, task graph, CEO gate, CTO lifecycle",
    files: [
      "src/run/run-engine.ts",
      "src/run/task-graph.ts",
      "src/ceo/production-gate.ts",
      "src/cto/cto-lifecycle.ts",
      "src/registry/project-registry.ts",
      "src/registry/repository-registry.ts",
      "src/claims/claim-registry.ts",
    ],
    prd: "§9 and §10 and §11 and §12 and §13, §19 CEO operation, §20 escalation, §21 human gate, §22 priority, §23 resource claims, §29 state machine",
  },
  ops: {
    title: "Doctor, watchdog, repair, daemon, ingress, bootstrap contract",
    files: [
      "src/doctor/doctor.ts",
      "src/doctor/watchdog.ts",
      "src/doctor/repair.ts",
      "src/daemon/daemon.ts",
      "src/daemon/single-instance.ts",
      "src/ingress/ingress-guard.ts",
      "src/ingress/telegram.ts",
      "src/buzz/buzz-adapter.ts",
      "src/bootstrap/activation.ts",
      "src/bootstrap/repo-factory-result.ts",
      "src/mcp/hermes-server.ts",
      "src/mcp/cto-server.ts",
    ],
    prd: "§25 doctor and watchdog and repair, §26 Repo Factory integration, §27 ingress authentication, §28 runtime interface, §33 security boundary, §34.5 restart reconciliation, Integration §13 contracts",
  },
};

const prompt = (key, area, revision) =>
  [
    "You are an independent production-readiness reviewer. You did not write this code.",
    "Your job is to attack it, not to praise it. Report only defects you can point at in the code.",
    "",
    `Revision under review: commit ${revision.commit} (tree ${revision.tree}). Your working directory`,
    "is a disposable checkout of exactly that commit; review it, not any other state of the repository.",
    "",
    `# Area under review: ${area.title}`,
    "",
    "## Files to review (read them all)",
    ...area.files.map((f) => `- ${f}`),
    "",
    "## Governing specification",
    "The two PRDs are vendored in this repository and are the only normative input:",
    "- docs/prd/AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md",
    "- docs/prd/REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.1_FINAL.md",
    "",
    `Sections that govern this area: ${area.prd}`,
    "",
    "## What to look for, in priority order",
    "1. A hard invariant (CP-HI-01..08) that the code does not actually enforce, or that a",
    "   plausible sequence of calls can bypass. Name the call sequence.",
    "2. Correctness or concurrency defects: race conditions, check-then-act windows,",
    "   transaction boundaries that do not cover what the PRD requires, error paths that",
    "   silently succeed.",
    "3. Security: a credential reachable from somewhere it must not be, an isolation claim",
    "   the code does not deliver, an authentication or replay check that can be skipped.",
    "4. Evidence integrity: anything that could report a pass without the evidence the PRD",
    "   demands, or accept stale evidence. CP-HI-08 forbids silent degradation.",
    "5. PRD non-conformance: behaviour that contradicts a MUST, or a required behaviour",
    "   that is simply absent.",
    "6. Over-engineering the PRD forbids: a generic policy DSL, event sourcing, an",
    "   unnecessary abstraction, an unconsumed field or a future-only feature (§13.3, §30.4,",
    "   §35.3).",
    "",
    "## Rules",
    "- Ground every finding in a specific file and, where you can, a line.",
    "- Do not report style preferences, naming, or test coverage gaps as findings.",
    "- Do not invent problems to appear thorough. An area with no defect should return PASS",
    "  with an empty findings array.",
    "- BLOCKER means it must not ship. MAJOR means it will cause a real failure. MINOR is a",
    "  genuine but bounded defect. INFO is an observation worth recording.",
    "- If you could not examine something you were asked to, list it in omittedItems.",
    "",
    "Return only the JSON object required by the output schema.",
  ].join("\n");

/**
 * The model `codex exec` says it is running, read only from its own configuration header, which
 * it writes to stderr before anything else: `OpenAI Codex v…`, `--------`, `key: value` lines,
 * `--------`. Only that first block is read — blank lines may precede it, nothing else may — and
 * never anything after it, and never stdout, which carries the reviewer's own final message. A
 * header that is absent, does not open the stream, is interrupted by a line that is not
 * `key: value`, is never closed, or does not hold exactly one `model:` line names no model, and
 * the area is then MODEL_UNVERIFIED. Measured: searching the whole output let a model-less
 * genuine header be "completed" by a sample header the reviewer copied from the PRD to stdout,
 * and an unclosed block take a later `model:` line from the session. ANSI styling and a leading
 * `[timestamp]` on each line are tolerated.
 */
const HEADER_RULE = "--------";
const observedModelOf = (stderr) => {
  const lines = stderr
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, "").trimEnd());
  let index = 0;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  if (!(lines[index] ?? "").startsWith("OpenAI Codex v") || lines[index + 1] !== HEADER_RULE) return null;
  const models = [];
  for (index += 2; index < lines.length; index += 1) {
    if (lines[index] === HEADER_RULE) return models.length === 1 ? models[0] : null;
    const entry = /^([a-z][a-z ]*): (.*)$/.exec(lines[index]);
    if (entry === null) return null; // session content before the header closed
    if (entry[1] === "model") models.push(/^\S+$/.test(entry[2]) ? entry[2] : null);
  }
  return null; // never closed
};

const reviewArea = async (key, area, ctx) => {
  const schemaFile = `${key}.schema.json`;
  const schemaPath = join(ctx.outDir, schemaFile);
  writeFileSync(schemaPath, JSON.stringify(SCHEMA));
  const child = await ctx.runChild("codex", [
    "exec",
    "-m",
    ctx.model,
    "-c",
    `model_reasoning_effort="${REASONING_EFFORT}"`,
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "--output-schema",
    schemaPath,
    "-o",
    ctx.reportPath,
    prompt(key, area, ctx.revision),
  ]);
  // codex writes the report itself; it is read only if the child completed.
  return { child, candidate: { kind: "file" }, artifacts: [schemaFile], observedModel: observedModelOf(child.stderr) };
};

// Areas are independent — disjoint file sets, no shared state — so they run concurrently.
// Each is its own `codex exec` process; the only shared resource is provider quota, which
// the caller decides to spend.
await runAudit({
  tool: "production-review",
  script: "scripts/production-review.mjs",
  repoRoot,
  areas: AREAS,
  sequential: false,
  reviewer: { cli: "codex", model: MODEL, reasoningEffort: REASONING_EFFORT, sandbox: "read-only" },
  reviewArea,
});

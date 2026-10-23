#!/usr/bin/env node
/**
 * Independent production-readiness review by Grok, reasoning effort `xhigh`.
 *
 * The model is selected here and passed with `-m`, never left to the CLI's configured default:
 * a default that moves would change the reviewer while every manifest still looked the same.
 * `--model=<id>` selects another. The model that actually ran is read from the CLI's own JSON
 * envelope (`model`); an area whose envelope names no model, or a different one, is
 * MODEL_UNVERIFIED and never counts as PASS.
 *
 * Same shape as `scripts/production-review.mjs` (GPT-6.1 Sol) on purpose: the areas are the
 * ones the PRD gives distinct authority to, the reviewer reads the repository itself rather
 * than an excerpt someone chose, and the findings come back structured so they can be filed
 * without a human paraphrasing them.
 *
 * Two reviewers of different lineage matter more than two rounds from one: a shared blind
 * spot is the failure mode a second round cannot catch.
 *
 * What it reads, and where it writes (#1189, `scripts/lib/audit-run.mjs`): one pinned commit, in a
 * disposable detached checkout of that commit, never the live working tree. A dirty working tree
 * whose HEAD is the requested commit, or a ref that names no commit, is refused before any reviewer
 * starts. Every run writes a new directory holding `manifest.json` (run id, commit and tree,
 * selected areas, reviewer identity, per-area execution and artifacts) and a `summary.json` that
 * counts only the reports that manifest attributes. A reviewer that failed, timed out, stopped
 * early or was interrupted has no verdict, and nothing an earlier run wrote can stand in for it.
 *
 * What it is not. A frontier PR review and this broad, one-off diagnostic serve different purposes:
 * frontier judges one change within its bounded attempts; this reads whole areas of one commit for
 * defects nobody asked about. It is not meant to run on every PR. Running it is not a way around
 * frontier's three-attempt limit and does not count as an additional approving review; its exit
 * status says whether the reviewers ran, its findings verdict says what they found, and neither is
 * a merge approval.
 *
 * Usage:
 *   node scripts/grok-review.mjs                              # every area, at HEAD
 *   node scripts/grok-review.mjs guard review                 # named areas
 *   node scripts/grok-review.mjs --rev=<commit-ish>           # another recorded commit
 *   node scripts/grok-review.mjs --out=evidence/review-grok-2 # must not exist yet
 *   node scripts/grok-review.mjs --allow-dirty                # HEAD, recording that uncommitted work was not reviewed
 *   node scripts/grok-review.mjs --area-timeout-ms=600000     # per-area bound (default 45 minutes)
 *   node scripts/grok-review.mjs --model=grok-4.7             # another model (default grok-4.6)
 *
 * The default output directory is `evidence/local/audit-runs/grok-review-<run id>/`.
 * Exit status: 0 every selected area returned a well-formed report, 1 at least one did not,
 * 2 refused before starting, 130 interrupted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runAudit } from "./lib/audit-run.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// The installed CLI's own default id when this was written; `--model=<id>` overrides it per run.
const DEFAULT_MODEL = "grok-4.6";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "filesExamined", "findings", "omittedItems"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "REVISE", "BLOCK"] },
    filesExamined: { type: "array", items: { type: "string" } },
    omittedItems: {
      type: "array",
      items: { type: "string" },
      description: "Anything you were asked to examine and could not. An empty list is a claim of complete coverage.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "category", "file", "line", "summary", "detail", "suggestedFix"],
        properties: {
          severity: { type: "string", enum: ["BLOCKER", "MAJOR", "MINOR", "INFO"] },
          category: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          summary: { type: "string" },
          detail: { type: "string" },
          suggestedFix: { type: "string" },
        },
      },
    },
  },
};

/** The nine areas, and what each reviewer must actually try to break. */
const AREAS = {
  guard: {
    focus: "CP-HI-01 the managed write guard, its in-flight fence, the source-read lease, and claims",
    paths: ["src/guard/**", "src/claims/**", "tests/unit/guard-*.test.ts"],
    prd: "§4 CP-HI-01, §6.1, §23.2",
  },
  core: {
    focus: "the database as the enforcement layer, the immutable artifact store, and the evidence-producer capability",
    paths: ["src/db/**", "src/core/**", "src/domain/**", "tests/unit/core-*.test.ts", "tests/unit/evidence-capability.test.ts"],
    prd: "§29, §30.2, §30.3, §34.3, CP-HI-03, CP-HI-06",
  },
  verify: {
    focus: "verification isolation, the pinned contract, resource limits, and candidate freshness",
    paths: ["src/verify/**", "src/snapshot/**", "src/contracts/**", "tests/unit/verify-*.test.ts"],
    prd: "§4 CP-HI-03, §17.4",
  },
  review: {
    focus: "CP-HI-04 blind review independence, coverage completeness, and reviewer isolation",
    paths: ["src/review/**", "src/run/candidate-pipeline.ts", "tests/unit/review-*.test.ts", "tests/integration/pipeline.test.ts"],
    prd: "§18, §4 CP-HI-04, §34.3",
  },
  github: {
    focus: "the trusted GitHub kernel: gate provenance, merge fencing, receipts, and idempotency",
    paths: ["src/github/**", "tests/scenarios/github-*.test.ts", "tests/unit/github-*.test.ts"],
    prd: "§24, CP-HI-05, CP-HI-07",
  },
  runtime: {
    focus: "the run state machine, task graph, owner authority and the CEO production gate",
    paths: ["src/run/**", "src/ceo/**", "tests/unit/run-gate-*.test.ts", "tests/unit/runtime-*.test.ts"],
    prd: "§29, §21, §23.2, §42",
  },
  continuity: {
    focus: "capacity admission, continuity coverage, failover, and the provider adapters",
    paths: ["src/capacity/**", "src/continuity/**", "src/runtime/**", "tests/unit/continuity-*.test.ts"],
    prd: "§14, §15",
  },
  binding: {
    focus: "role bindings as fencing tokens, session identity and authentication, and the outbox",
    paths: ["src/session/**", "src/outbox/**", "src/buzz/**", "tests/unit/binding-*.test.ts", "tests/unit/outbox-*.test.ts"],
    prd: "§9.4, §10.1, §15.7, CP-HI-04",
  },
  ops: {
    focus: "the MCP servers, ingress, bootstrap activation, the doctor, repair and the daemon",
    paths: ["src/mcp/**", "src/ingress/**", "src/bootstrap/**", "src/doctor/**", "src/daemon/**", "tests/scenarios/doctor-*.test.ts", "tests/unit/ops-*.test.ts"],
    prd: "§21, §25, §26, §27, §33.1",
  },
};

const PRD = join("docs", "prd", "AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md");

const prompt = (key, area, revision, preamble) => `You are performing an independent, adversarial production-readiness
review of one area of a repository you did not write. You are the final reviewer before this
project is made public, and the people who built it are asking you to find what they missed —
not to confirm what they believe.

Revision under review: commit ${revision.commit} (tree ${revision.tree}). Your working directory
is a disposable checkout of exactly that commit; review it, not any other state of the repository.

**Area: ${key}** — ${area.focus}
Relevant PRD sections: ${area.prd}
Start with: ${area.paths.join(", ")}

The implementation SSOT is \`docs/prd/AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md\` (${preamble} bytes;
read the sections named above). \`docs/adr/\` holds the decisions the implementation rests on.
\`docs/ACCEPTANCE.md\` states what the authors claim is met.

What this system is: a single local runtime authority that turns managed project intent into
verified production-ready results. Its Hard Invariants (PRD §4, CP-HI-01..08) are the whole
product — a plausible-looking gate that can be bypassed is worse than no gate, because a run
completes carrying a claim nobody checked.

How to review, in order of what matters:

1. **Attack the invariants in your area.** For each, find the call sequence, interleaving or
   input that gets past it. Trace it in the code and cite \`file:line\`. A refusal that depends
   on a caller behaving well is not enforcement.
2. **Check that the enforcement is where it claims to be.** This codebase says the database
   enforces §30.2 constraints, that evidence is immutable, that a producer cannot be forged,
   that a merge lands on a proven base. Verify each claim against the code rather than the
   comment above it.
3. **Distrust the tests.** An earlier audit found 26 tests that pass with their enforcement
   deleted. For any invariant you judge sound, name the test that would fail if it regressed —
   and if that test would still pass with the check removed, that is a finding.
4. **Look for the fail-closed choice that broke the product, and the fail-open one that kept it
   working.** Both are defects. Several deliberate trade-offs are recorded on GitHub issue #247
   (\`gh issue view 247\`); disagree with them if the reasoning does not hold.
5. **Say what you could not establish.** \`omittedItems\` is not a formality: an empty list
   means you examined everything you were asked to.

Severity: BLOCKER = an invariant is bypassable, or the product cannot perform its function.
MAJOR = a real defect with a bounded blast radius. MINOR = correctness or clarity. INFO =
observation. Do not inflate; a BLOCKER you cannot demonstrate with a concrete sequence is a
MAJOR at most, and say so.

Read the code. Do not run the test suite — this checkout has no installed dependencies, and
execution evidence comes from the repository's own gates, not from this review. Do not modify any
file.

Return only the structured JSON the schema describes.`;

const reviewArea = async (key, area, ctx) => {
  const preamble = readFileSync(join(ctx.checkoutDir, PRD), "utf8").length;
  const args = [
    "-p", prompt(key, area, ctx.revision, preamble),
    "-m", ctx.model,
    "--output-format", "json",
    "--json-schema", JSON.stringify(SCHEMA),
    "--reasoning-effort", "xhigh",
    "--permission-mode", "plan",
    "--disable-web-search",
    "--no-subagents",
    "--max-turns", "120",
    "--cwd", ctx.checkoutDir,
    // In the run's own temporary directory: a socket path has a length limit the output
    // directory's would exceed, and the socket is not evidence.
    "--leader-socket", join(ctx.scratchDir, `${key}.leader.sock`),
  ];
  const child = await ctx.runChild("grok", args);
  const artifacts = [];
  let candidate;
  let observedModel = null;
  try {
    // The CLI prints one JSON envelope whose answer is `text` (measured, not assumed:
    // `result` does not exist on it). With --json-schema that text *is* the JSON report,
    // but the field also carries narration, so the report is the last JSON object in it.
    const start = child.stdout.indexOf("{");
    if (start === -1) throw new Error("grok printed no JSON envelope");
    const envelope = JSON.parse(child.stdout.slice(start));
    // The CLI's own top-level field only. The report (`structuredOutput`, `text`) is the reviewer's
    // words, so a model named anywhere inside it is never evidence of the model that ran.
    if (envelope !== null && typeof envelope === "object" && !Array.isArray(envelope) && typeof envelope.model === "string" && envelope.model !== "") {
      observedModel = envelope.model;
    }
    if (envelope.total_cost_usd) {
      writeFileSync(join(ctx.outDir, `${key}.cost`), String(envelope.total_cost_usd));
      artifacts.push(`${key}.cost`);
    }
    if (envelope.stopReason && envelope.stopReason !== "end_turn") {
      // A cancelled run has partial narration and no verdict; treating it as a review
      // would let an interrupted reviewer read as a clean one.
      candidate = { kind: "invalid", reason: `grok stopped with ${envelope.stopReason}` };
    } else {
      // `structuredOutput` is the schema-validated answer. `text` is not it: with a
      // schema the CLI streams a snapshot per turn and concatenates them, so parsing text
      // yields "unexpected character after JSON" — measured, three reviews were recorded as
      // ERROR before this was understood.
      const report = envelope.structuredOutput ??
        JSON.parse(typeof envelope.text === "string" ? envelope.text.slice(envelope.text.lastIndexOf('{"verdict"')) : "{}");
      candidate = { kind: "value", value: report };
    }
  } catch (parseError) {
    candidate = { kind: "unparsable", reason: parseError instanceof Error ? parseError.message : String(parseError) };
  }
  // A parsed report is used only if the child also exited 0: a CLI that printed a verdict and
  // then failed has not been shown to have finished the review.
  return { child, candidate, artifacts, observedModel };
};

/**
 * The summary is derived from the per-area files on disk, never from this run's in-memory
 * results alone — and, since #1189, only from the files this run's manifest attributes to itself.
 *
 * Writing `results` directly once meant a partial re-run — `grok-review.mjs binding github` —
 * rewrote the whole summary while only knowing about the areas it had just run, and recorded
 * every other area as ERROR/0: sixteen real findings, including a BLOCK, read as nothing having
 * happened. Reading every file in a shared directory fixed that and opened the opposite hole: an
 * area this run never selected, written by some earlier run against some other commit, counted
 * as a current PASS. Each run now has its own directory, so an area another run reviewed stays in
 * that run's summary, an unselected area here is NOT_RUN, and a report whose bytes no longer
 * match what this run recorded is STALE. None of those is PASS.
 */
// Sequential on purpose. Concurrent `grok` processes contend over the leader socket and
// cancel each other — measured, and a cancelled review is worse than a slow one because its
// partial output looks like a verdict.
await runAudit({
  tool: "grok-review",
  script: "scripts/grok-review.mjs",
  repoRoot,
  areas: AREAS,
  sequential: true,
  reviewer: {
    cli: "grok",
    model: DEFAULT_MODEL,
    modelSelectable: true,
    reasoningEffort: "xhigh",
    permissionMode: "plan",
  },
  reviewArea,
});

#!/usr/bin/env node
/**
 * Independent production-readiness review by Grok (grok-4.6-build, reasoning effort `xhigh`,
 * which is the CLI's maximum — `max` is rejected).
 *
 * Same shape as `scripts/production-review.mjs` (GPT-5.6 Sol) on purpose: the areas are the
 * ones the PRD gives distinct authority to, the reviewer reads the repository itself rather
 * than an excerpt someone chose, and the findings come back structured so they can be filed
 * without a human paraphrasing them.
 *
 * Two reviewers of different lineage matter more than two rounds from one: a shared blind
 * spot is the failure mode a second round cannot catch.
 *
 * Usage:
 *   node scripts/grok-review.mjs                              # every area
 *   node scripts/grok-review.mjs guard review                 # named areas
 *   node scripts/grok-review.mjs --out=evidence/review-grok   # default shown
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const outArg = process.argv.find((a) => a.startsWith("--out="));
const outDir = join(repoRoot, outArg ? outArg.slice("--out=".length) : join("evidence", "review-grok"));
mkdirSync(outDir, { recursive: true });

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

const PREAMBLE = readFileSync(join(repoRoot, "docs", "prd", "AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md"), "utf8").length;

const prompt = (key, area) => `You are performing an independent, adversarial production-readiness
review of one area of a repository you did not write. You are the final reviewer before this
project is made public, and the people who built it are asking you to find what they missed —
not to confirm what they believe.

**Area: ${key}** — ${area.focus}
Relevant PRD sections: ${area.prd}
Start with: ${area.paths.join(", ")}

The implementation SSOT is \`docs/prd/AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md\` (${PREAMBLE} bytes;
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

Read the code. Do not run the test suite — other agents are editing this repository right now,
so a red test tells you nothing about the code you are reading. Do not modify any file.

Return only the structured JSON the schema describes.`;

const run = (key, area) =>
  new Promise((resolve) => {
    const started = Date.now();
    const args = [
      "-p", prompt(key, area),
      "--output-format", "json",
      "--json-schema", JSON.stringify(SCHEMA),
      "--reasoning-effort", "xhigh",
      "--permission-mode", "plan",
      "--disable-web-search",
      "--no-subagents",
      "--max-turns", "120",
      "--cwd", repoRoot,
      "--leader-socket", join(outDir, `${key}.leader.sock`),
    ];
    const child = execFile(
      "grok",
      args,
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60 * 1000 },
      (err, stdout, stderr) => {
        const seconds = Math.round((Date.now() - started) / 1000);
        writeFileSync(join(outDir, `${key}.log`), `${stdout}\n--- stderr ---\n${stderr}`);
        let verdict = "ERROR";
        let findings = 0;
        try {
          // The CLI prints one JSON envelope whose answer is `text` (measured, not assumed:
          // `result` does not exist on it). With --json-schema that text *is* the JSON report,
          // but the field also carries narration, so the report is the last JSON object in it.
          const envelope = JSON.parse(stdout.slice(stdout.indexOf("{")));
          const answer = typeof envelope.text === "string" ? envelope.text : "";
          const opening = answer.lastIndexOf("{\"verdict\"");
          const report = JSON.parse(opening >= 0 ? answer.slice(opening) : answer);
          if (envelope.stopReason && envelope.stopReason !== "end_turn") {
            // A cancelled run has partial narration and no verdict; treating it as a review
            // would let an interrupted reviewer read as a clean one.
            throw new Error(`grok stopped with ${envelope.stopReason}`);
          }
          writeFileSync(join(outDir, `${key}.json`), JSON.stringify(report, null, 2));
          verdict = report.verdict ?? "ERROR";
          findings = (report.findings ?? []).length;
          if (envelope.total_cost_usd) {
            writeFileSync(join(outDir, `${key}.cost`), String(envelope.total_cost_usd));
          }
        } catch (parseError) {
          writeFileSync(
            join(outDir, `${key}.json`),
            JSON.stringify({ verdict: "ERROR", error: parseError instanceof Error ? parseError.message : String(parseError), stderr: stderr.slice(0, 4000) }, null, 2),
          );
        }
        console.log(
          `${key.padEnd(11)} ${verdict.padEnd(7)} findings=${String(findings).padEnd(3)} ${seconds}s${err ? ` (exec: ${err.message.slice(0, 60)})` : ""}`,
        );
        resolve({ key, verdict, findings, seconds });
      },
    );
    child.stdin?.end();
  });

const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const keys = requested.length > 0 ? requested : Object.keys(AREAS);
for (const key of keys) {
  if (!AREAS[key]) {
    console.error(`unknown area: ${key}`);
    process.exit(2);
  }
}

// Sequential on purpose. Concurrent `grok` processes contend over the leader socket and
// cancel each other — measured, and a cancelled review is worse than a slow one because its
// partial output looks like a verdict.
const results = [];
for (const key of keys) results.push(await run(key, AREAS[key]));
writeFileSync(join(outDir, "summary.json"), JSON.stringify({ reviewer: "grok", results }, null, 2));
const blocked = results.filter((r) => r.verdict !== "PASS");
console.log(`\n${results.length} areas reviewed by grok; ${blocked.length} not PASS`);
if (existsSync(join(outDir, "guard.cost"))) {
  console.log("per-area cost recorded alongside each report");
}

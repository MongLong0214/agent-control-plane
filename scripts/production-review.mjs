#!/usr/bin/env node
/**
 * Independent production-readiness review by GPT-5.6 Sol.
 *
 * Splits the implementation into the areas the PRD gives distinct authority to, and asks
 * for structured findings per area. The reviewer reads the repository itself under a
 * read-only sandbox, so it sees the real code rather than an excerpt someone chose.
 *
 * Usage:
 *   node scripts/production-review.mjs            # every area
 *   node scripts/production-review.mjs core guard # named areas only
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(repoRoot, "evidence", "review");
mkdirSync(outDir, { recursive: true });

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
        required: ["severity", "category", "file", "summary", "detail", "suggestedFix"],
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

const prompt = (key, area) =>
  [
    "You are an independent production-readiness reviewer. You did not write this code.",
    "Your job is to attack it, not to praise it. Report only defects you can point at in the code.",
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

const run = (key, area) =>
  new Promise((resolve) => {
    const schemaPath = join(outDir, `${key}.schema.json`);
    const outPath = join(outDir, `${key}.json`);
    const logPath = join(outDir, `${key}.log`);
    writeFileSync(schemaPath, JSON.stringify(SCHEMA));

    const started = Date.now();
    const child = execFile(
      "codex",
      [
        "exec",
        "-m",
        "gpt-5.6-sol",
        "-c",
        'model_reasoning_effort="xhigh"',
        "-s",
        "read-only",
        "--skip-git-repo-check",
        "--output-schema",
        schemaPath,
        "-o",
        outPath,
        prompt(key, area),
      ],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60 * 1000 },
      (err, stdout, stderr) => {
        writeFileSync(logPath, `${stdout ?? ""}\n--- stderr ---\n${stderr ?? ""}`);
        const seconds = Math.round((Date.now() - started) / 1000);
        const ok = existsSync(outPath);
        let verdict = "NO_OUTPUT";
        let findings = 0;
        if (ok) {
          try {
            const parsed = JSON.parse(readFileSync(outPath, "utf8"));
            verdict = parsed.verdict;
            findings = (parsed.findings ?? []).length;
          } catch {
            verdict = "UNPARSABLE";
          }
        }
        console.log(
          `${key.padEnd(11)} ${verdict.padEnd(10)} findings=${String(findings).padEnd(3)} ${seconds}s${err ? ` (exec error: ${err.message.slice(0, 80)})` : ""}`,
        );
        resolve({ key, verdict, findings, seconds });
      },
    );
    child.stdin?.end();
  });

const requested = process.argv.slice(2);
const keys = requested.length > 0 ? requested : Object.keys(AREAS);

const results = [];
// Sequential: xhigh reasoning across nine areas in parallel would spike the same quota
// bucket the control plane is supposed to protect.
for (const key of keys) {
  if (!AREAS[key]) {
    console.error(`unknown area: ${key}`);
    process.exit(2);
  }
  results.push(await run(key, AREAS[key]));
}

writeFileSync(join(outDir, "summary.json"), JSON.stringify({ results }, null, 2));
const blocked = results.filter((r) => r.verdict !== "PASS");
console.log(`\n${results.length} areas reviewed; ${blocked.length} not PASS`);

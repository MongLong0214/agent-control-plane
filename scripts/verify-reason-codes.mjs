#!/usr/bin/env node
/**
 * Verifies the reason-code catalogue.
 *
 * Reason codes are part of the external contract (PRD §40 Explainability): once a code
 * is published, callers match on the string. This check enforces the two properties that
 * keeps that promise mechanical — every entry's value equals its key, and no previously
 * published code has been removed or renamed.
 *
 * Dependency-free on purpose. Verification runs in a disposable worktree with no
 * installed packages and no network (PRD §17.4), so a command that needs `node_modules`
 * cannot run there; that work belongs to CI as TRUSTED_CI evidence.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../src/core/reason-codes.ts", import.meta.url)),
  "utf8",
);

const body = /export const ReasonCode = \{([\s\S]*?)\n\} as const;/.exec(source);
if (!body) {
  console.error("verify-reason-codes: could not locate the ReasonCode catalogue");
  process.exit(1);
}

const entries = [...body[1].matchAll(/^\s{2}([A-Z0-9_]+):\s*"([^"]+)",$/gm)].map((m) => ({
  key: m[1],
  value: m[2],
}));

if (entries.length === 0) {
  console.error("verify-reason-codes: catalogue parsed as empty");
  process.exit(1);
}

const failures = [];

for (const { key, value } of entries) {
  if (key !== value) failures.push(`${key} has value "${value}"; a code's value must equal its key`);
}

const seen = new Set();
for (const { key } of entries) {
  if (seen.has(key)) failures.push(`${key} is declared twice`);
  seen.add(key);
}

/**
 * Codes that are already relied upon by tests, docs and the MCP surface. Removing or
 * renaming one is a breaking change to the external contract, so it fails here rather
 * than surfacing later as a caller that no longer matches.
 */
const PUBLISHED = [
  "OK",
  "WRITE_REQUIRES_MANAGED_RUN",
  "WRITE_BINDING_GENERATION_STALE",
  "WRITE_TARGET_OUTSIDE_RUN_SCOPE",
  "WRITE_PATH_NOT_CLAIMED",
  "DIRECT_READ_ONLY_ALLOWED",
  "REVIEWER_SESSION_IS_PRODUCER",
  "FINAL_CEO_SESSION_NOT_INDEPENDENT",
  "TRUSTED_CREDENTIAL_UNAVAILABLE",
  "GATE_CREATOR_UNTRUSTED",
  "GATE_PAYLOAD_PROVENANCE_INVALID",
  "SNAPSHOT_STALE",
  "EVIDENCE_STALE",
  "COVERAGE_INCOMPLETE",
  "VERIFICATION_GAP",
  "VERIFICATION_CI_HEAD_MISMATCH",
  "VERIFICATION_CI_WORKFLOW_DIGEST_MISMATCH",
  "REVIEW_REVISE",
  "REVIEW_OMITTED_ITEMS_PRESENT",
  "REVIEW_MANUAL_INVOCATION_DENIED",
  "MERGE_HEAD_STALE",
  "MERGE_BASE_STALE",
  "MERGE_GATE_MISSING",
  "MERGE_IDEMPOTENT_REPLAY",
  "POST_MERGE_VERIFICATION_FAILED",
  "HOTFIX_PROPAGATION_INCOMPLETE",
  "CAPACITY_UNKNOWN_NOT_ROUTABLE",
  "CAPACITY_ADMISSION_SUSPENDED",
  "COVERAGE_NONE",
  "CONTINUITY_SURVIVAL_NO_COMPLETION",
  "RESTORE_WOULD_PREEMPT_INFLIGHT_OWNER",
  "INGRESS_ACTOR_NOT_ALLOWLISTED",
  "INGRESS_REPLAY_IGNORED",
  "UNTRUSTED_CONTENT_IS_DATA",
  "OUTBOX_STALE_GENERATION_REJECTED",
  "REPAIR_REQUIRES_OWNER",
  "BOOTSTRAP_RESULT_OVERCLAIMS_ACTIVATION",
  "BOOTSTRAP_CONTRACT_DRIFT",
  "DAEMON_ALREADY_RUNNING",
];

for (const code of PUBLISHED) {
  if (!seen.has(code)) failures.push(`published reason code ${code} is missing`);
}

if (failures.length > 0) {
  console.error(`verify-reason-codes: ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`verify-reason-codes: ${entries.length} codes, all keys match values, none missing`);

#!/usr/bin/env node
/**
 * Verifies the terminology contract in docs/TERMINOLOGY.md.
 *
 * The owner's decision of 2026-08-14 fixed the meaning of eight contested words. Most of
 * them are words this repository legitimately uses all day — `session`, `actor`, `run`,
 * `gate`, `evidence`, `binding`. Banning the words would produce thousands of hits and be
 * switched off within a week, which is the normal fate of a check that cries wolf.
 *
 * So this checks collocations, not words. `session` is fine; `session` next to
 * `transcript`/`history`/`conversation` is the banned sense, because that is the sense the
 * decision reassigned to `conversational actor`. Each rule below therefore encodes the
 * *confusion* the decision was written to prevent, and states the replacement term, so a
 * failure tells the author what to write instead rather than only what not to write.
 *
 * A line may opt out with a trailing `terminology-ok: <reason>` comment. Opting out is
 * recorded rather than silent: the count is printed on every run.
 *
 * Dependency-free on purpose, matching scripts/verify-reason-codes.mjs — verification runs
 * in a disposable worktree with no node_modules and no network (PRD §17.4).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Each rule: the wrong usage, why it is wrong, and what to say instead.
 * `pattern` runs per line, case-insensitively.
 */
const RULES = [
  {
    id: "session-as-conversational-actor",
    pattern:
      /\bsessions?\b[^.\n]{0,40}\b(transcript|conversation history|chat history|same conversation)\b|\b(transcript|conversation history|chat history)\b[^.\n]{0,40}\bsessions?\b/i,
    says: "`session` used for the thing that owns a transcript",
    instead:
      "a session is a replaceable model runtime; the transcript owner is a `conversational actor`",
  },
  {
    id: "session-identity-continuity",
    pattern: /\b(same|identical|unchanged|persistent|long-lived)\s+session\b/i,
    says: "`session` described as the thing that stays the same",
    instead:
      "sessions are meant to be replaced by failover without owner approval; if you mean the counterpart that survives replacement, that is a `conversational actor`",
  },
  {
    id: "actor-as-channel-identity",
    pattern: /\bactor\b[^.\n]{0,24}\b(pubkey|allowlist(ed)?)\b/i,
    says: "a channel identity called an `actor` right next to allowlist membership",
    instead:
      "call it a `channel identity`; `actor` means the holder of an `assignments.role_key`, and this collocation is the one that reads allowlist membership as authority",
  },
  {
    id: "buzz-actor-qualified",
    // Staged, not enforced yet — see STAGED below.
    pattern: /\bbuzz\s+actor\b(?!_id)/i,
    says: "the transport-qualified `Buzz actor`",
    instead: "`Buzz channel identity`",
  },
  {
    id: "hermes-called-ssot",
    pattern: /hermes[^.\n]{0,40}\bssot\b|\bssot\b[^.\n]{0,20}hermes/i,
    says: "Hermes bridge state called SSOT",
    instead: "agent-control-plane is the SSOT; that is `Hermes legacy state`",
  },
  {
    id: "tmux-called-cto",
    // Deliberately narrow: an appositive ("the CTO process", "that tmux window is the CTO"),
    // not mere co-occurrence. A line listing `Hermes/CTO/operator` as callers of a process is
    // not calling a process a CTO, and an earlier draft of this rule failed on exactly that.
    pattern:
      /\bCTO\s+(tmux|pane|process|window)\b|\b(tmux|pane)\s+(session|window|pane)\b[^.\n]{0,24}\b(is|as)\s+(the\s+)?CTO\b/i,
    says: "a tmux session or process called a CTO",
    instead:
      "the CTO is the conversational actor holding PRIMARY_CTO; a tmux window attached to it is an `attachment`",
  },
  {
    id: "handwritten-report-called-evidence",
    pattern: /\b(hand-?written|manually written|hand-?authored)\b[^.\n]{0,30}\bevidence\b/i,
    says: "a hand-written file called evidence",
    instead:
      "`evidence` is a content-addressed `run_artifacts` row that goes stale automatically (CP-HI-06); a hand-written file is a `report`",
  },
  {
    id: "status-json-called-gate",
    pattern: /STATUS\.json[^.\n]{0,30}\bgate\b|\bgate\b[^.\n]{0,20}STATUS\.json/i,
    says: "a Hermes STATUS.json string called a gate",
    instead:
      "the gate is the `acp-production-gate` check verified by creator identity; that string is a `phase marker`",
  },
  {
    id: "routing-called-binding",
    pattern: /\b(routing|route|channel)\s+binding\b/i,
    says: "a routing or channel mapping called a binding",
    instead: "a `binding` is one `assignments` row; a transport mapping is a `route`",
  },
];

/**
 * Rules that are written and counted but do not yet fail the build.
 *
 * `buzz-actor-qualified` has 20 hits, and every file holding one is under simultaneous
 * modification by an unmerged lane (buzzcli, verifysec, telegram). Renaming on main today
 * buys no safety and costs four rebases on branches a round from merging. The rule ships
 * now so the count is visible and cannot drift upward unnoticed; it moves out of this set
 * in the follow-up that does the rename, once those lanes are in.
 *
 * Staging is recorded here rather than by deleting the rule, because a deleted rule leaves
 * no trace that the decision was ever made.
 */
const STAGED = new Set(["buzz-actor-qualified"]);
const STAGED_BASELINE = { "buzz-actor-qualified": 20 };

const SCAN_ROOTS = ["src", "docs"];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".md", ".sql"]);
// The contract itself quotes every banned usage in order to ban it.
const EXEMPT_FILES = new Set(["docs/TERMINOLOGY.md"]);

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) out.push(full);
  }
  return out;
};

const files = SCAN_ROOTS.flatMap((root) => {
  try {
    return walk(join(repoRoot, root));
  } catch {
    return [];
  }
});

const failures = [];
const staged = {};
let waived = 0;
let scannedLines = 0;

for (const file of files) {
  const rel = relative(repoRoot, file);
  if (EXEMPT_FILES.has(rel)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  scannedLines += lines.length;
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      if (STAGED.has(rule.id)) {
        staged[rule.id] = (staged[rule.id] ?? 0) + 1;
        continue;
      }
      if (/terminology-ok:/.test(line)) {
        waived += 1;
        continue;
      }
      failures.push({ rel, line: index + 1, rule, text: line.trim().slice(0, 120) });
    }
  });
}

// A staged rule still fails if its count grows: the rename is deferred, not abandoned.
for (const [id, baseline] of Object.entries(STAGED_BASELINE)) {
  const found = staged[id] ?? 0;
  if (found > baseline) {
    const rule = RULES.find((r) => r.id === id);
    failures.push({
      rel: "(repository-wide)",
      line: 0,
      rule,
      text: `${found} occurrences, up from the recorded baseline of ${baseline}`,
    });
  }
}

if (failures.length > 0) {
  console.error(
    `verify-terminology: ${failures.length} usage(s) contradict docs/TERMINOLOGY.md\n`,
  );
  for (const f of failures) {
    console.error(`  ${f.rel}:${f.line}  [${f.rule.id}]`);
    console.error(`    ${f.text}`);
    console.error(`    ${f.rule.says}`);
    console.error(`    instead: ${f.rule.instead}\n`);
  }
  console.error(
    "If a hit is genuinely correct, append `terminology-ok: <reason>` to that line.",
  );
  process.exit(1);
}

const enforced = RULES.length - STAGED.size;
console.log(
  `verify-terminology: ${enforced} enforced rules over ${files.length} files ` +
    `(${scannedLines} lines), 0 violations, ${waived} waived`,
);
for (const [id, count] of Object.entries(staged)) {
  console.log(`verify-terminology: staged rule ${id} at ${count} occurrence(s), not yet failing`);
}

#!/usr/bin/env node
/**
 * #664 — `tx()` treats a denied `Decision` as an ordinary return value and commits it.
 * A body that writes and then decides against itself leaves the write behind unless it
 * opts into `txDecision()` instead, which rolls back on a denial exactly as a throw would.
 *
 * "I looked" is not the same as a check (the issue's own words). This is the check: it
 * finds every `db.tx(() => { ... })` body in `src/` that writes and later returns a
 * denied `Decision`, and requires each one to be either:
 *
 *   - converted to `txDecision()`, or
 *   - named in EXEMPT below, with the reason the write must survive a denial anyway
 *     (a body that writes unconditional housekeeping a later decision only reads, the
 *     same shape github-kernel.ts's claim-expiry sweep and managed-write-guard.ts's
 *     renewal sweep both are).
 *
 * A site that is neither is the exact trap #664 reported: nobody decided anything for
 * it, and `tx()`'s default (commit) is silently wrong for it.
 *
 * This is a textual census, not a type checker. It keys exemptions by a stable string
 * found in the body rather than a file:line, because a line number goes stale the moment
 * something above it grows (measured elsewhere in this repo) — see
 * scripts/verify-append-only-tables-are-closed.mjs for the same lesson learned once already.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

const WRITE_PATTERN = /\.run\(|\.exec\(/;
const DENY_PATTERN = /return deny\(/;

/**
 * Every plain `tx()` body this census has confirmed writes unconditional housekeeping
 * that a denial must not undo. Each entry is keyed by a substring unique to that body,
 * not by file:line.
 */
const EXEMPT = [
  {
    file: "github/github-kernel.ts",
    marker: "UPDATE resource_claims SET status = 'EXPIRED'",
    reason:
      "assertClaim's expiry sweep must land regardless of the decision, so the guard and " +
      "the partial unique index agree in the same transaction (#664 comment thread).",
  },
  {
    file: "guard/managed-write-guard.ts",
    marker: "the run holds no live claim on this repository, so the write cannot be fenced",
    reason:
      "renewRequiredClaims sweeps overdue claims before deciding, the same shape as " +
      "github-kernel.ts's assertClaim; the sweep must survive every denial in this body.",
  },
  {
    file: "ingress/ingress-guard.ts",
    marker: "this message's turn was already claimed and its outcome was never recorded",
    reason:
      "claimTurn's only write is inside the branch that returns allow; every deny in this " +
      "body is reached only when nothing was written, so there is nothing to roll back.",
  },
];

/** Recursively list `.ts` files under `dir`, skipping test files. */
const listTsFiles = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
};

/** Find `db.tx(() => {` / `db.txDecision(() => {` call sites and their bracket-balanced body. */
const findTxSites = (text) => {
  const lines = text.split("\n");
  const sites = [];
  const opener = /\.(tx|txDecision)\(\(\)\s*=>\s*\{\s*$/;
  for (let i = 0; i < lines.length; i += 1) {
    const match = opener.exec(lines[i]);
    if (!match) continue;
    let depth = 1;
    let end = i;
    for (let j = i + 1; j < lines.length && depth > 0; j += 1) {
      const line = lines[j];
      for (const ch of line) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
      if (depth === 0) end = j;
    }
    sites.push({
      kind: match[1],
      startLine: i + 1,
      endLine: end + 1,
      body: lines.slice(i, end + 1).join("\n"),
    });
  }
  return sites;
};

const files = listTsFiles(SRC);
const trapped = [];
const exempted = [];
const converted = [];
const matchedExemptMarkers = new Set();

for (const path of files) {
  const rel = relative(SRC, path);
  const text = readFileSync(path, "utf8");
  for (const site of findTxSites(text)) {
    // The first write is the earliest point at which a rollback would have something to
    // undo. Any denial reachable after it — not just the textually-first denial in the
    // body — is the trap, so this checks "does some denial follow the first write",
    // not "does the first denial follow the first write".
    const firstWriteIndex = site.body.search(WRITE_PATTERN);
    const denyAfterWrite =
      firstWriteIndex !== -1 &&
      [...site.body.matchAll(new RegExp(DENY_PATTERN, "g"))].some(
        (m) => m.index > firstWriteIndex,
      );
    if (!denyAfterWrite) continue;

    if (site.kind === "txDecision") {
      converted.push({ file: rel, line: site.startLine });
      continue;
    }

    const exemption = EXEMPT.find((e) => e.file === rel && site.body.includes(e.marker));
    if (exemption) {
      matchedExemptMarkers.add(exemption.marker);
      exempted.push({ file: rel, line: site.startLine, reason: exemption.reason });
    } else {
      trapped.push({ file: rel, line: site.startLine });
    }
  }
}

const unmatchedExemptions = EXEMPT.filter((e) => !matchedExemptMarkers.has(e.marker));

process.stdout.write(
  `#664 tx-denial census: ${converted.length} using txDecision, ${exempted.length} documented ` +
    `exemption(s), ${trapped.length} undocumented trap(s).\n`,
);

// Both are reported, rather than exiting on the first: a marker drifting out of the
// body it named and a genuinely new trap can happen in the same change, and stopping
// at whichever this script checks first would hide the other one from the reader.
if (trapped.length > 0) {
  process.stdout.write("\nUndocumented: a plain tx() body writes, then can return a denial.\n");
  for (const t of trapped) process.stdout.write(`  ${t.file}:${t.line}\n`);
  process.stdout.write(
    "\nEither convert the call to txDecision(), or add it to EXEMPT in this script with the " +
      "reason the write must survive a denial.\n",
  );
}

if (unmatchedExemptions.length > 0) {
  process.stdout.write("\nAn EXEMPT entry named a body this census could not find (a stale exemption):\n");
  for (const e of unmatchedExemptions) process.stdout.write(`  ${e.file}: "${e.marker}"\n`);
  process.stdout.write(
    "\nAn exemption nothing consults is a place for the next reader to believe something was " +
      "decided; remove it or fix the marker.\n",
  );
}

if (trapped.length > 0 || unmatchedExemptions.length > 0) {
  process.stdout.write(
    `\nRESULT: FAIL — ${trapped.length} undocumented tx-denial trap(s), ` +
      `${unmatchedExemptions.length} stale exemption(s).\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `RESULT: PASS — every tx() body that writes and can deny is either txDecision or a named, ` +
    `matched exemption.\n`,
);

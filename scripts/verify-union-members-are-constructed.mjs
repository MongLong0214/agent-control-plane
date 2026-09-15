#!/usr/bin/env node
/**
 * A member of a string-literal union that nothing in `src/` constructs is a gap, not a value.
 *
 * Measured three times on 2026-09-15, all in one file. `ProbeSignal` named five ways a probe
 * becomes unanswerable, `classifyProbeSignal` mapped all five to INCONCLUSIVE, and a test walked
 * all five — and `TIMEOUT`, `SESSION_STORAGE_BUSY` and `CHILD_IDENTITY_DRIFT` appeared nowhere
 * else in `src/`. The tests proved the mapping was right, never that a run could reach the state:
 * a total function over a set whose members nothing builds. `TIMEOUT` was worse than unreachable —
 * the loop it belonged to had no deadline at all, so the failure mode the safety list names first
 * ended in a process that never returned.
 *
 * That shape is invisible to every check this repository already has. The type compiles, the
 * switch is exhaustive, the test is green, and the union is a promise about states the code cannot
 * enter. `tsc` cannot see it because constructing a member is not required to satisfy a type.
 *
 * So this counts constructions. For each member of each registered union, it looks for that exact
 * quoted literal in `src/` **outside the type declaration itself**. Zero occurrences means nothing
 * can produce it.
 *
 * Opt-in, not a sweep. A repository-wide scan of every union would spend its first week on
 * exceptions — values that arrive from outside, wire protocols, vocabularies a database owns — and
 * a check whose exception list is longer than its findings stops being read. Unions earn a place
 * here when a member going unconstructed would be a defect rather than a fact about the world.
 *
 * What this does not check: that the construction is reachable, correct, or on a path any run
 * takes. A member constructed once in dead code passes. It answers one question — can this state
 * be produced at all — and that is the question the three misses above all failed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Each entry names the file that declares the union and the exported type name. The members are
 * read out of the declaration rather than listed here: a second copy of the member list is the
 * thing that goes stale, and it would go stale in the direction that hides a new member.
 */
const WATCHED_UNIONS = [
  { file: "src/acceptance/disposable-realm.ts", type: "ProbeSignal" },
];

/**
 * Members that are declared and deliberately not constructed yet, each with the reason. An entry
 * here is a recorded gap, not an exemption from the idea — it is the `Limit:` a commit would carry,
 * put where the check can read it and where removing the gap removes the entry.
 */
const UNCONSTRUCTED_BY_DESIGN = new Map([
  [
    "ProbeSignal.CHILD_IDENTITY_DRIFT",
    "#655 condition 5's fifth mode. Producing it needs a probe child, and the disposable realm " +
      "starts none: the live window has no driver yet. The census and settings for that child " +
      "landed on 2026-09-15; the driver that starts it has not.",
  ],
]);

const sourceFiles = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
};

/** The declaration's own text, so its members are not counted as their own constructions. */
const declarationOf = (text, type) => {
  const start = text.indexOf(`export type ${type} =`);
  if (start === -1) return null;
  const end = text.indexOf(";", start);
  return end === -1 ? null : text.slice(start, end + 1);
};

const files = sourceFiles(join(root, "src"));
const findings = [];
let members = 0;

for (const watched of WATCHED_UNIONS) {
  const declaringPath = join(root, watched.file);
  const declaringText = readFileSync(declaringPath, "utf8");
  const declaration = declarationOf(declaringText, watched.type);
  if (declaration === null) {
    findings.push(`  ${watched.file}: no \`export type ${watched.type} =\` declaration found`);
    continue;
  }
  const names = [...declaration.matchAll(/"([A-Za-z0-9_]+)"/g)].map((match) => match[1]);
  if (names.length === 0) {
    findings.push(`  ${watched.file}: \`${watched.type}\` declares no string-literal members`);
    continue;
  }
  for (const member of names) {
    members += 1;
    const quoted = `"${member}"`;
    const sites = [];
    for (const path of files) {
      const text = path === declaringPath
        ? readFileSync(path, "utf8").split(declaration).join("")
        : readFileSync(path, "utf8");
      if (text.includes(quoted)) sites.push(relative(root, path));
    }
    if (sites.length > 0) continue;
    const key = `${watched.type}.${member}`;
    const reason = UNCONSTRUCTED_BY_DESIGN.get(key);
    if (reason === undefined) {
      findings.push(
        `  ${watched.type}.${member}: declared in ${watched.file} and constructed nowhere in src/.\n` +
          `    Produce it, or name it in UNCONSTRUCTED_BY_DESIGN with the reason it cannot be produced yet.`,
      );
    }
  }
}

// A stale entry is the same defect pointed the other way: it reads as a recorded gap while the gap
// is closed, and the next person removes the producer rather than the entry.
for (const [key] of UNCONSTRUCTED_BY_DESIGN) {
  const [type, member] = key.split(".");
  const watched = WATCHED_UNIONS.find((entry) => entry.type === type);
  if (!watched) {
    findings.push(`  STALE ENTRY  ${key}: names a union this check does not watch`);
    continue;
  }
  const declaringPath = join(root, watched.file);
  const declaration = declarationOf(readFileSync(declaringPath, "utf8"), type) ?? "";
  const quoted = `"${member}"`;
  const constructed = files.some((path) => {
    const text = path === declaringPath
      ? readFileSync(path, "utf8").split(declaration).join("")
      : readFileSync(path, "utf8");
    return text.includes(quoted);
  });
  if (constructed) findings.push(`  STALE ENTRY  ${key}: it is constructed now; remove the entry`);
}

const watched = WATCHED_UNIONS.map((entry) => entry.type).join(", ");
process.stdout.write(
  `verify-union-members-are-constructed: ${members} member(s) across ${WATCHED_UNIONS.length} union(s) ` +
    `(${watched}); ${UNCONSTRUCTED_BY_DESIGN.size} recorded as unconstructed by design.\n`,
);
if (findings.length > 0) {
  process.stdout.write(`${findings.join("\n")}\n`);
  process.stdout.write("RESULT: FAIL — a declared state nothing can produce is a promise the code cannot keep.\n");
  process.exitCode = 1;
} else {
  process.stdout.write(
    "RESULT: PASS — every watched member is constructed somewhere, or recorded with its reason.\n" +
      "Constructed is not reachable: this counts occurrences, not paths a run takes.\n",
  );
}
